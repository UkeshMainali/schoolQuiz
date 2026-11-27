// Shared state for the teacher pages: school settings, quiz tabs, the quiz
// list and the student directory. They are kept up to date by Firestore
// listeners (live updates): the first snapshot is the normal load, and after
// that only changed documents are read.

import { db, collection, getDocs, doc, onSnapshot } from "./firebase.js";
import { loadSettings, normalizeSettings, showNotice, hideNotice } from "./utilities.js";
import { loadCategories, categoriesRef, cleanCategories } from "./quizCategories.js";
import { loadStudents, watchStudents } from "./students.js";
import { quizForMyClasses } from "./roles.js";

export const teacher = {
  settings: null,
  quizzes: new Map(), // quizId -> quiz list document (no questions for new quizzes)
  categories: [], // quiz tabs: [{ id, name }] from settings/quizCategories
  listeners: new Set()
};

export async function loadTeacherData() {
  const [settings] = await Promise.all([loadSettings(), watchQuizzes(), reloadCategories(), watchStudentDirectory()]);
  teacher.settings = settings;
  watchSettings();
}

let watching = false;
/** Live quiz list. Resolves after the first snapshot; falls back to one read if listening fails. */
function watchQuizzes() {
  return new Promise((resolve) => {
    let first = true;
    onSnapshot(collection(db, "quizzes"), (snap) => {
      teacher.quizzes = new Map(snap.docs.map((d) => quizEntry(d)));
      if (first) { first = false; resolve(); }
      notify("quizzes");
    }, (err) => {
      console.warn("Live quiz list unavailable", err);
      if (first) { first = false; reloadQuizzes().catch(() => {}).finally(resolve); }
    });
  });
}

/** Live student directory (names shown everywhere). */
function watchStudentDirectory() {
  return watchStudents(() => notify("students")).catch(async (err) => {
    console.warn("Live students unavailable", err);
    await reloadStudents();
  });
}

/** School settings and quiz tabs changed by the Admin (or in another tab) show at once. */
function watchSettings() {
  if (watching) return;
  watching = true;
  let firstS = true, firstC = true;
  onSnapshot(doc(db, "settings", "school"), (snap) => {
    if (firstS) { firstS = false; return; } // the same data loadSettings() just read
    if (snap.metadata.hasPendingWrites) return;
    teacher.settings = normalizeSettings(snap.exists() ? snap.data() : {});
    notify("settings");
  }, (err) => console.warn("Live settings unavailable", err));
  onSnapshot(categoriesRef(), (snap) => {
    if (firstC) { firstC = false; return; }
    if (snap.metadata.hasPendingWrites) return;
    teacher.categories = cleanCategories(snap.exists() ? snap.data().categories : []);
    notify("categories");
  }, (err) => console.warn("Live quiz tabs unavailable", err));
}

function quizEntry(d) {
  const data = d.data();
  // Older quizzes keep their questions inline; drop them from memory here.
  const { questions, ...meta } = data;
  if (Array.isArray(questions) && meta.questionCount === undefined) meta.questionCount = questions.length;
  if (Array.isArray(questions)) meta.legacyInline = true;
  return [d.id, { id: d.id, ...meta }];
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
  teacher.quizzes = new Map(snap.docs.map((d) => quizEntry(d)));
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
