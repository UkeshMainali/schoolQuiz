// Student homepage (index.html): remembered details + list of quizzes for
// the student's grade, each with its own completion status.

import { ensureStudentAuth } from "./auth.js";
import { loadActiveQuizzes, checkAttempt } from "./submission.js";
import {
  loadSettings, sectionsFor, validateRoll, rollLimit, normalizeName, makeAttemptId, escapeHtml,
  friendlyError, showNotice, hideNotice, storage, formatDateTime, pluralize,
  ACTIVE_KEY, skeleton, PENDING_KEY, PROFILE_KEY
} from "./utilities.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["fullName", "rollNo", "grade", "section"];

let settings = null;
let profile = storage.get(PROFILE_KEY);
let quizzes = [];
let statuses = new Map();
let pendingStart = null;

// ------------------------------------------------------------------ profile

function fillSelect(select, values, placeholder) {
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    values.map((v) => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.label)}</option>`).join("");
}

function updateSectionOptions(selected = "") {
  const grade = $("grade").value;
  const list = grade ? sectionsFor(settings, grade) : [];
  fillSelect($("section"), list.map((s) => ({ value: s, label: `Section ${s}` })),
    grade ? "Choose section" : "Choose grade first");
  $("section").disabled = !grade;
  if (list.includes(selected)) $("section").value = selected;
  else if (list.length === 1) $("section").value = list[0];
  checkRollLive();
}

/** Shows the allowed range for the chosen section and checks the typed roll number as it changes. */
function checkRollLive() {
  const grade = $("grade").value, section = $("section").value;
  const max = grade && section ? rollLimit(settings, grade, section) : null;
  $("rollHint").textContent = max ? `Grade ${grade}, Section ${section}: roll numbers 1 to ${max}.` : "";
  $("rollHint").hidden = !max;
  const typed = $("rollNo").value.trim();
  setFieldError("rollNo", typed ? validateRoll(typed, settings, grade, section).error : "");
}

function setFieldError(id, message) {
  $(id).classList.toggle("invalid", !!message);
  const box = document.querySelector(`[data-error-for="${id}"]`);
  if (box) { box.textContent = message || ""; box.hidden = !message; }
}

function showProfileForm(editing) {
  hideNotice($("notice"));
  $("homeView").hidden = true;
  $("profileCard").hidden = false;
  $("profileTitle").textContent = editing ? "Change your details" : "Welcome! Tell us who you are";
  $("profileIntro").textContent = editing
    ? "Fix any mistake here. Quizzes you already submitted keep the details you used then."
    : "This is saved on this device, so you only type it once. You can change it later.";
  $("cancelProfileBtn").hidden = !editing;
  fillSelect($("grade"), settings.grades.map((g) => ({ value: g, label: `Grade ${g}` })), "Choose grade");
  $("fullName").value = editing ? profile.name : "";
  $("rollNo").value = editing ? profile.roll : "";
  $("grade").value = editing && settings.grades.includes(profile.grade) ? profile.grade : (settings.grades.length === 1 ? settings.grades[0] : "");
  updateSectionOptions(editing ? profile.section : "");
  FIELDS.forEach((id) => setFieldError(id, ""));
  $("fullName").focus();
}

function readProfileForm() {
  const name = normalizeName($("fullName").value);
  const { roll, error: rollError } = validateRoll($("rollNo").value, settings, $("grade").value, $("section").value);
  const errors = {
    fullName: !name ? "Please enter your full name." : name.length < 2 ? "Name is too short." : "",
    rollNo: rollError,
    grade: !$("grade").value ? "Please choose your grade." : "",
    section: !$("section").value ? "Please choose your section." : ""
  };
  FIELDS.forEach((id) => setFieldError(id, errors[id]));
  const firstBad = FIELDS.find((id) => errors[id]);
  if (firstBad) { $(firstBad).focus(); return null; }
  return { name, roll, grade: $("grade").value, section: $("section").value };
}

async function onSaveProfile(e) {
  e.preventDefault();
  // Use the latest limits: the teacher may have changed them since the page opened.
  settings = await loadSettings();
  const p = readProfileForm();
  if (!p) return;
  profile = p;
  storage.set(PROFILE_KEY, profile);
  await showHome();
}

/** A saved profile is only valid if its grade and section still exist and its roll number is allowed. */
function profileIsValid(p) {
  return p && p.name && p.roll && settings.grades.includes(p.grade) && sectionsFor(settings, p.grade).includes(p.section)
    && !validateRoll(p.roll, settings, p.grade, p.section).error;
}

// --------------------------------------------------------------- quiz list

async function showHome() {
  $("profileCard").hidden = true;
  $("homeView").hidden = false;
  $("profileName").textContent = profile.name;
  $("profileMeta").textContent = `Roll no. ${profile.roll} · Grade ${profile.grade} · Section ${profile.section}`;
  $("quizList").innerHTML = skeleton("list", { rows: 4 });
  $("progressText").textContent = "";
  try {
    quizzes = await loadActiveQuizzes(profile.grade);
    quizzes.sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
    // One small read per quiz to show its status for this student.
    const results = await Promise.all(quizzes.map((q) =>
      checkAttempt(makeAttemptId(q.id, profile.grade, profile.section, profile.roll)).catch(() => ({ state: "unknown" }))));
    statuses = new Map(quizzes.map((q, i) => [q.id, results[i]]));
    renderQuizList();
  } catch (err) {
    console.error(err);
    $("quizList").innerHTML = "";
    showNotice($("notice"), `Could not load quizzes. ${friendlyError(err)}`, "error");
  }
}

function statusOf(quiz) {
  const s = statuses.get(quiz.id) || { state: "unknown" };
  if (s.state === "mine" && s.attempt.status === "submitted") return { key: "done", label: "Completed", badge: "badge-success", when: s.attempt.submittedAt };
  if (s.state === "mine") return { key: "progress", label: `In progress (${s.attempt.answeredCount || 0}/${s.attempt.questionCount})`, badge: "badge-warning" };
  if (s.state === "taken") return { key: "taken", label: "Started on another device", badge: "badge-danger" };
  if (s.state === "none") return { key: "new", label: "Not started", badge: "" };
  return { key: "unknown", label: "Status unavailable", badge: "" };
}

function renderQuizList() {
  if (!quizzes.length) {
    $("quizList").innerHTML = `<div class="card empty">There are no quizzes for Grade ${escapeHtml(profile.grade)} right now. Please wait for your teacher to open one, then refresh this page.</div>`;
    return;
  }
  const done = quizzes.filter((q) => statusOf(q).key === "done").length;
  $("progressText").textContent = `${done} of ${pluralize(quizzes.length, "quiz", "quizzes")} completed`;
  $("quizList").innerHTML = quizzes.map((q) => {
    const st = statusOf(q);
    const lessonInfo = q.merged && Array.isArray(q.lessons) && q.lessons.length > 1
      ? `${q.lessons.length} lessons: ${q.lessons.map((l) => l.title).join(", ")}`
      : (q.subject || q.description || "");
    let action;
    if (st.key === "done") action = `<span class="small muted">Submitted ${escapeHtml(formatDateTime(st.when))}</span>`;
    else if (st.key === "taken") action = `<span class="small muted">Ask your teacher for help</span>`;
    else action = `<button type="button" class="btn ${st.key === "progress" ? "btn-success" : "btn-primary"}" data-start="${escapeHtml(q.id)}">${st.key === "progress" ? "Continue" : "Start"}</button>`;
    return `
      <article class="quiz-item card${st.key === "done" ? " is-done" : ""}">
        <div class="quiz-item-main">
          <h2 class="quiz-item-title">${escapeHtml(q.title)}</h2>
          <div class="quiz-item-meta">
            <span>${q.grade ? `Grade ${escapeHtml(q.grade)}` : "All grades"}</span>
            <span>${pluralize(q.questionCount || 0, "question")}</span>
            <span>${pluralize(q.totalMarks || 0, "mark")}</span>
          </div>
          ${lessonInfo ? `<div class="small muted">${escapeHtml(lessonInfo)}</div>` : ""}
        </div>
        <div class="quiz-item-side">
          <span class="badge ${st.badge}">${escapeHtml(st.label)}</span>
          ${action}
        </div>
      </article>`;
  }).join("");
}

function onQuizListClick(e) {
  const btn = e.target.closest("[data-start]");
  if (!btn) return;
  const quiz = quizzes.find((q) => q.id === btn.dataset.start);
  if (!quiz) return;
  const attemptId = makeAttemptId(quiz.id, profile.grade, profile.section, profile.roll);
  if (statusOf(quiz).key === "progress") {
    storage.set(ACTIVE_KEY, { attemptId, quizId: quiz.id, quizTitle: quiz.title, studentName: profile.name });
    location.href = "quiz.html";
    return;
  }
  pendingStart = quiz;
  $("confirmDetails").innerHTML = [
    ["Quiz", quiz.title], ["Questions", quiz.questionCount], ["Name", profile.name],
    ["Roll number", profile.roll], ["Grade", profile.grade], ["Section", profile.section]
  ].map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  $("confirmModal").hidden = false;
  $("confirmStart").focus();
}

async function confirmStart() {
  if (!pendingStart) return;
  // Check the roll number again with fresh settings before starting.
  $("confirmStart").disabled = true;
  settings = await loadSettings();
  $("confirmStart").disabled = false;
  if (!profileIsValid(profile)) {
    $("confirmModal").hidden = true;
    pendingStart = null;
    showProfileForm(true);
    $("cancelProfileBtn").hidden = true;
    checkRollLive();
    showNotice($("notice"), "Your details no longer match the school settings. Please check them before starting.", "warning");
    return;
  }
  storage.set(PENDING_KEY, {
    quizId: pendingStart.id,
    student: { name: profile.name, roll: profile.roll, grade: profile.grade, section: profile.section }
  });
  storage.remove(ACTIVE_KEY);
  location.href = "quiz.html";
}

// --------------------------------------------------------------------- init

async function init() {
  try {
    await ensureStudentAuth();
    settings = await loadSettings();
    $("loading").hidden = true;
    if (profileIsValid(profile)) await showHome();
    else {
      const keep = profile;
      profile = keep && keep.name ? keep : null;
      showProfileForm(!!profile);
      if (profile) {
        $("cancelProfileBtn").hidden = true;
        checkRollLive();
        const gradeOk = settings.grades.includes(profile.grade) && sectionsFor(settings, profile.grade).includes(profile.section);
        showNotice($("notice"), gradeOk
          ? "Your roll number is not allowed for your section in the school settings. Please check it, or ask your teacher."
          : "Your grade or section has changed in the school settings. Please check your details.", "warning");
      }
    }
  } catch (err) {
    $("loading").hidden = true;
    showNotice($("notice"), `Could not load the quiz site. ${friendlyError(err)}`, "error");
    console.error(err);
  }
}

$("profileForm").addEventListener("submit", onSaveProfile);
$("grade").addEventListener("change", () => updateSectionOptions());
$("section").addEventListener("change", () => checkRollLive());
$("rollNo").addEventListener("input", () => checkRollLive());
$("cancelProfileBtn").addEventListener("click", () => showHome());
$("editProfileBtn").addEventListener("click", () => showProfileForm(true));
$("switchStudentBtn").addEventListener("click", () => {
  storage.remove(PROFILE_KEY);
  storage.remove(ACTIVE_KEY);
  storage.remove(PENDING_KEY);
  profile = null;
  showProfileForm(false);
});
$("quizList").addEventListener("click", onQuizListClick);
$("confirmBack").addEventListener("click", () => { $("confirmModal").hidden = true; pendingStart = null; });
$("confirmStart").addEventListener("click", confirmStart);
FIELDS.filter((id) => id !== "rollNo").forEach((id) => $(id).addEventListener("input", () => setFieldError(id, "")));

init();
