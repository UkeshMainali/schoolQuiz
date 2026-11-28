// Student homepage (index.html): remembered details + list of quizzes for
// the student's grade, each with its own completion status.

import { ensureStudentAuth } from "./auth.js";
import { loadActiveQuizzes, checkAttempt } from "./submission.js";
import { lookupStudent, registerStudent } from "./students.js";
import {
  loadSettings, sectionsFor, validateRoll, rollLimit, normalizeName, makeAttemptId, escapeHtml,
  friendlyError, showNotice, hideNotice, storage, formatDateTime, pluralize,
  ACTIVE_KEY, skeleton, PENDING_KEY, PROFILE_KEY, quizDuration, durationLabel
} from "./utilities.js";

const $ = (id) => document.getElementById(id);

let settings = null;
let profile = storage.get(PROFILE_KEY);
let quizzes = [];
let statuses = new Map();
let pendingStart = null;

// ------------------------------------------------------------------ profile
// The student types roll number, grade and section. The registered name is
// looked up in the student records and filled in (not editable). A student
// who is not registered yet types their name once and is registered.

let lookup = { state: "idle", key: "", student: null }; // idle | checking | found | new | conflict | error
let lookupTimer = null;

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
  scheduleLookup();
}

function setFieldError(id, message) {
  $(id).classList.toggle("invalid", !!message);
  const box = document.querySelector(`[data-error-for="${id}"]`);
  if (box) { box.textContent = message || ""; box.hidden = !message; }
}

/** Valid roll + grade + section from the form, or null. */
function formClass() {
  const grade = $("grade").value, section = $("section").value;
  const { roll, error } = validateRoll($("rollNo").value, settings, grade, section);
  if (!grade || !section || error) return null;
  return { grade, section, roll };
}

function scheduleLookup() {
  clearTimeout(lookupTimer);
  const c = formClass();
  const key = c ? `${c.grade}_${c.section}_${c.roll}` : "";
  if (key === lookup.key && lookup.state !== "error") return;
  lookup = { state: c ? "checking" : "idle", key, student: null };
  renderLookup();
  if (c) lookupTimer = setTimeout(() => runLookup(c, key), 350);
}

async function runLookup(c, key) {
  try {
    const res = await lookupStudent(c.grade, c.section, c.roll);
    if (lookup.key !== key) return; // the student changed the form meanwhile
    lookup = { state: res.state, key, student: res.student || null };
  } catch (err) {
    if (lookup.key !== key) return;
    console.error(err);
    lookup = { state: "error", key, student: null, message: friendlyError(err) };
  }
  renderLookup();
}

function renderLookup() {
  const box = $("lookupStatus");
  const nameField = $("nameField");
  const name = $("fullName");
  const btn = $("saveProfileBtn");
  const st = lookup.state;
  box.className = "lookup-status";
  box.hidden = st === "idle";
  nameField.hidden = !(st === "found" || st === "new");
  setFieldError("fullName", "");
  if (st === "checking") {
    box.innerHTML = '<span class="spinner" aria-hidden="true"></span> Looking for your record…';
  } else if (st === "found") {
    box.classList.add("is-found");
    box.innerHTML = '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> We found your record.';
    $("fullNameLabel").textContent = "Your name";
    name.value = lookup.student.name;
    name.readOnly = true;
    name.classList.add("is-locked");
    $("nameHint").textContent = "Not your name? Check your roll number, grade and section. If they are right, ask your teacher to correct it.";
    $("nameHint").hidden = false;
  } else if (st === "new") {
    box.classList.add("is-new");
    box.innerHTML = '<i class="fa-solid fa-user-plus" aria-hidden="true"></i> No record yet for this roll number. Type your full name to register.';
    $("fullNameLabel").textContent = "Full name";
    if (name.readOnly) name.value = profile && !profile.studentId ? profile.name || "" : "";
    name.readOnly = false;
    name.classList.remove("is-locked");
    $("nameHint").hidden = true;
  } else if (st === "conflict") {
    box.classList.add("is-error");
    box.textContent = "These details do not match a student record correctly. Check your roll number, grade and section, or ask your teacher.";
  } else if (st === "error") {
    box.classList.add("is-error");
    box.textContent = `Could not check your record. ${lookup.message || ""}`;
  }
  btn.disabled = !(st === "found" || st === "new");
  btn.textContent = st === "found" ? "Yes, this is me" : st === "new" ? "Register and see my quizzes" : "Continue";
}

function showProfileForm(editing, message = "") {
  hideNotice($("notice"));
  $("homeView").hidden = true;
  $("profileCard").hidden = false;
  $("profileTitle").textContent = editing ? "Check your details" : "Welcome! Find yourself";
  $("profileIntro").textContent = message || "Enter your roll number, grade and section.";
  $("cancelProfileBtn").hidden = !editing;
  fillSelect($("grade"), settings.grades.map((g) => ({ value: g, label: `Grade ${g}` })), "Choose grade");
  $("rollNo").value = editing && profile ? profile.roll : "";
  $("grade").value = editing && profile && settings.grades.includes(profile.grade) ? profile.grade : (settings.grades.length === 1 ? settings.grades[0] : "");
  $("fullName").value = "";
  $("fullName").readOnly = true;
  lookup = { state: "idle", key: "", student: null };
  ["rollNo", "grade", "section", "fullName"].forEach((id) => setFieldError(id, ""));
  updateSectionOptions(editing && profile ? profile.section : "");
  $("rollNo").focus();
}

async function onSaveProfile(e) {
  e.preventDefault();
  // Use the latest limits: the teacher may have changed them since the page opened.
  settings = await loadSettings();
  const errors = {
    rollNo: validateRoll($("rollNo").value, settings, $("grade").value, $("section").value).error,
    grade: !$("grade").value ? "Please choose your grade." : "",
    section: !$("section").value ? "Please choose your section." : ""
  };
  Object.entries(errors).forEach(([id, msg]) => setFieldError(id, msg));
  const c = formClass();
  if (!c) { const bad = Object.keys(errors).find((id) => errors[id]); if (bad) $(bad).focus(); return; }
  if (`${c.grade}_${c.section}_${c.roll}` !== lookup.key) { scheduleLookup(); return; }
  const btn = $("saveProfileBtn");
  if (lookup.state === "found") {
    profile = { name: lookup.student.name, studentId: lookup.student.id, roll: c.roll, grade: c.grade, section: c.section };
  } else if (lookup.state === "new") {
    const name = normalizeName($("fullName").value);
    const err = !name ? "Please enter your full name." : name.length < 2 ? "Name is too short." : !/[A-Za-zऀ-ॿ]/.test(name) ? "Please enter your name in letters." : "";
    setFieldError("fullName", err);
    if (err) { $("fullName").focus(); return; }
    btn.disabled = true;
    btn.textContent = "Registering…";
    try {
      const reg = await registerStudent({ name, grade: c.grade, section: c.section, roll: c.roll });
      if (reg.existing) {
        // Someone registered this roll number a moment ago: never join them silently.
        lookup = { state: "found", key: lookup.key, student: { id: reg.id, name: reg.name } };
        renderLookup();
        showNotice($("notice"), "This roll number was just registered. Check the name below: press \"Yes, this is me\" only if it is you.", "warning");
        return;
      }
      profile = { name: reg.name, studentId: reg.id, roll: c.roll, grade: c.grade, section: c.section };
    } catch (err2) {
      console.error(err2);
      showNotice($("notice"), `Could not register. ${friendlyError(err2)}`, "error");
      renderLookup();
      return;
    }
  } else return;
  storage.set(PROFILE_KEY, profile);
  await showHome();
}

/** A saved profile is only valid if its grade and section still exist and its roll number is allowed. */
function profileIsValid(p) {
  return p && p.name && p.roll && settings.grades.includes(p.grade) && sectionsFor(settings, p.grade).includes(p.section)
    && !validateRoll(p.roll, settings, p.grade, p.section).error;
}

/**
 * Checks the saved profile against the student records (one read): picks up
 * a name the Admin corrected, and asks the student to confirm their details
 * if their record changed or they have not registered yet.
 * Returns true when the quiz list can be shown.
 */
async function syncProfile() {
  let res;
  try { res = await lookupStudent(profile.grade, profile.section, profile.roll); } catch (err) { console.warn("Lookup failed; using saved details", err); return true; }
  if (res.state === "found" && (!profile.studentId || profile.studentId === res.student.id)) {
    if (!profile.studentId) {
      showProfileForm(true, "Please confirm your details once.");
      $("cancelProfileBtn").hidden = true;
      return false;
    }
    if (profile.name !== res.student.name) { profile.name = res.student.name; storage.set(PROFILE_KEY, profile); }
    return true;
  }
  if (res.state === "new" && !profile.studentId) {
    showProfileForm(true, "Please register once: check your details and press Register.");
    $("cancelProfileBtn").hidden = true;
    return false;
  }
  showProfileForm(true, "Your student record has changed. Please enter your details again, or ask your teacher.");
  $("cancelProfileBtn").hidden = true;
  return false;
}

// --------------------------------------------------------------- quiz list

async function showHome({ sync = true } = {}) {
  if (sync && !(await syncProfile())) return;
  $("profileCard").hidden = true;
  $("homeView").hidden = false;
  $("profileName").textContent = profile.name;
  $("profileMeta").textContent = `Roll no. ${profile.roll} · Grade ${profile.grade} · Section ${profile.section}`;
  $("quizList").innerHTML = skeleton("list", { rows: 4 });
  $("progressText").textContent = "";
  try {
    quizzes = await loadActiveQuizzes(profile.grade, profile.section);
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
    $("quizList").innerHTML = `<div class="card empty">There are no quizzes for Grade ${escapeHtml(profile.grade)}, Section ${escapeHtml(profile.section)} right now. Please wait for your teacher to open one, then refresh this page.</div>`;
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
            ${quizDuration(q) ? `<span class="quiz-item-time"><i class="fa-solid fa-stopwatch" aria-hidden="true"></i>${escapeHtml(durationLabel(quizDuration(q)))}</span>` : ""}
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
    ["Quiz", quiz.title], ["Questions", quiz.questionCount],
    ...(quizDuration(quiz) ? [["Time limit", `${durationLabel(quizDuration(quiz), { long: true })} (starts when you press Begin)`]] : []),
    ["Name", profile.name],
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
    student: { name: profile.name, roll: profile.roll, grade: profile.grade, section: profile.section, studentId: profile.studentId || "" }
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
$("cancelProfileBtn").addEventListener("click", () => showHome({ sync: false }));
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
$("fullName").addEventListener("input", () => setFieldError("fullName", ""));

init();
