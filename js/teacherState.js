// Shared state for the teacher pages: school settings and the quiz list.
// Loaded once per page and refreshed only when the teacher changes something
// or presses Refresh, to avoid repeated Firestore reads.

import { db, collection, getDocs } from "./firebase.js";
import { loadSettings, showNotice, hideNotice } from "./utilities.js";
import { loadCategories } from "./quizCategories.js";
import { loadStudents } from "./students.js";
import { quizForMyClasses } from "./roles.js";

export const teacher = {
  settings: null,
  quizzes: new Map(), // quizId -> quiz list document (no questions for new quizzes)
  categories: [], // quiz tabs: [{ id, name }] from settings/quizCategories
  listeners: new Set()
};

export async function loadTeacherData() {
  const [settings] = await Promise.all([loadSettings(), reloadQuizzes(), reloadCategories(), reloadStudents()]);
  teacher.settings = settings;
}

/** Student names and ids (shown instead of the names typed on old quizzes). */
export async function reloadStudents() {
  try {
    await loadStudents();
  } catch (err) {
    console.warn("Could not load students", err);
  }
  notify("students");
}

/** Reads the quiz tabs. A failure leaves the previous list (quizzes still show under Uncategorized). */
export async function reloadCategories() {
  try {
    teacher.categories = await loadCategories();
  } catch (err) {
    console.warn("Could not load quiz tabs", err);
  }
  notify("categories");
}

export function setCategories(list) {
  teacher.categories = list;
  notify("categories");
}

/** Reads the quiz list documents (small: questions live in quizContent). */
export async function reloadQuizzes() {
  const snap = await getDocs(collection(db, "quizzes"));
  teacher.quizzes = new Map(snap.docs.map((d) => {
    const data = d.data();
    // Older quizzes keep their questions inline; drop them from memory here.
    const { questions, ...meta } = data;
    if (Array.isArray(questions) && meta.questionCount === undefined) meta.questionCount = questions.length;
    if (Array.isArray(questions)) meta.legacyInline = true;
    return [d.id, { id: d.id, ...meta }];
  }));
  notify("quizzes");
}

export function setSettings(settings) {
  teacher.settings = settings;
  notify("settings");
}

/** Other parts of the dashboard can react when quizzes or settings change. */
export function onTeacherChange(fn) { teacher.listeners.add(fn); }
function notify(what) { teacher.listeners.forEach((fn) => { try { fn(what); } catch (e) { console.error(e); } }); }

export function sortedQuizzes({ grade = "", includeArchived = false } = {}) {
  return [...teacher.quizzes.values()]
    .filter((q) => includeArchived || !q.archived)
    .filter((q) => quizForMyClasses(q)) // teachers: their quizzes and those for their classes
    .filter((q) => !grade || !q.grade || String(q.grade) === String(grade))
    .sort((a, b) => String(a.grade).localeCompare(String(b.grade), undefined, { numeric: true }) ||
      String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
}

export function quizTitle(quizId, fallback = "") {
  return teacher.quizzes.get(quizId)?.title || fallback || quizId;
}

const noticeEl = () => document.getElementById("appNotice") || document.getElementById("notice"); // result.html uses #notice
export function appNotice(text, type = "info") {
  const el = noticeEl();
  if (!el) return;
  showNotice(el, text, type);
  if (type === "success") {
    clearTimeout(appNotice.timer);
    appNotice.timer = setTimeout(() => hideNotice(el), 8000);
  }
}
export function clearAppNotice() { hideNotice(noticeEl()); }
