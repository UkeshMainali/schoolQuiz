// Student start page (index.html): details form and quiz selection.

import { ensureStudentAuth } from "./auth.js";
import { loadActiveQuizzes, checkAttempt } from "./submission.js";
import {
  loadSettings, normalizeRoll, normalizeName, makeAttemptId, escapeHtml,
  friendlyError, showNotice, hideNotice, storage, ACTIVE_KEY, PENDING_KEY
} from "./utilities.js";

const $ = (id) => document.getElementById(id);
const els = {
  loading: $("loading"), notice: $("notice"),
  resumeCard: $("resumeCard"), resumeText: $("resumeText"), notMeBtn: $("notMeBtn"),
  startCard: $("startCard"), form: $("studentForm"),
  fullName: $("fullName"), rollNo: $("rollNo"), grade: $("grade"), section: $("section"),
  quizSelect: $("quizSelect"), startBtn: $("startBtn"),
  confirmModal: $("confirmModal"), confirmDetails: $("confirmDetails"),
  confirmBack: $("confirmBack"), confirmStart: $("confirmStart")
};

let quizzes = [];
let pendingStart = null;

function fillSelect(select, values, placeholder) {
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
    values.map((v) => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.label)}</option>`).join("");
}

function updateQuizOptions() {
  const grade = els.grade.value;
  const list = quizzes
    .filter((q) => !q.grade || !grade || String(q.grade) === grade)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
  const previous = els.quizSelect.value;
  fillSelect(els.quizSelect, list.map((q) => ({
    value: q.id, label: `${q.title} (${q.questionCount} questions)`
  })), list.length ? "Choose a quiz" : "No quiz available for this grade");
  if (list.some((q) => q.id === previous)) els.quizSelect.value = previous;
  else if (list.length === 1) els.quizSelect.value = list[0].id;
}

function setFieldError(id, message) {
  const input = $(id);
  const box = document.querySelector(`[data-error-for="${id}"]`);
  input.classList.toggle("invalid", !!message);
  if (box) { box.textContent = message || ""; box.hidden = !message; }
}

function validate() {
  const name = normalizeName(els.fullName.value);
  const roll = normalizeRoll(els.rollNo.value);
  const errors = {
    fullName: !name ? "Please enter your full name." : name.length < 2 ? "Name is too short." : "",
    rollNo: !els.rollNo.value.trim() ? "Please enter your roll number." : roll === null ? "Roll number must be digits only, for example 12." : "",
    grade: !els.grade.value ? "Please choose your grade." : "",
    section: !els.section.value ? "Please choose your section." : "",
    quizSelect: !els.quizSelect.value ? "Please choose a quiz." : ""
  };
  Object.entries(errors).forEach(([id, msg]) => setFieldError(id, msg));
  const firstBad = Object.keys(errors).find((k) => errors[k]);
  if (firstBad) { $(firstBad).focus(); return null; }
  return { name, roll, grade: els.grade.value, section: els.section.value, quizId: els.quizSelect.value };
}

async function onSubmit(e) {
  e.preventDefault();
  hideNotice(els.notice);
  const v = validate();
  if (!v) return;
  const quiz = quizzes.find((q) => q.id === v.quizId);
  const attemptId = makeAttemptId(v.quizId, v.grade, v.section, v.roll);

  els.startBtn.disabled = true;
  els.startBtn.textContent = "Checking…";
  try {
    const result = await checkAttempt(attemptId);
    if (result.state === "taken") {
      showNotice(els.notice, `A quiz for roll number ${v.roll} (Grade ${v.grade}, Section ${v.section}) has already been started on another device. If this is a mistake, please tell your teacher.`, "error");
      return;
    }
    if (result.state === "mine" && result.attempt.status === "submitted") {
      showNotice(els.notice, "You have already submitted this quiz. You cannot take it again. Ask your teacher if you think this is a mistake.", "warning");
      return;
    }
    if (result.state === "mine") {
      // Same browser started this attempt earlier: continue it.
      storage.set(ACTIVE_KEY, { attemptId, quizId: v.quizId, quizTitle: quiz.title, studentName: result.attempt.studentName });
      location.href = "quiz.html";
      return;
    }
    pendingStart = { attemptId, quiz, student: v };
    els.confirmDetails.innerHTML = [
      ["Name", v.name], ["Roll number", v.roll], ["Grade", v.grade], ["Section", v.section], ["Quiz", quiz.title]
    ].map(([k, val]) => `<dt>${k}</dt><dd>${escapeHtml(val)}</dd>`).join("");
    els.confirmModal.hidden = false;
    els.confirmStart.focus();
  } catch (err) {
    showNotice(els.notice, friendlyError(err), "error");
  } finally {
    els.startBtn.disabled = false;
    els.startBtn.textContent = "Start quiz";
  }
}

function confirmStart() {
  if (!pendingStart) return;
  const { quiz, student } = pendingStart;
  storage.set(PENDING_KEY, {
    quizId: quiz.id,
    student: { name: student.name, roll: student.roll, grade: student.grade, section: student.section }
  });
  storage.remove(ACTIVE_KEY);
  location.href = "quiz.html";
}

async function showResumeIfAny() {
  const active = storage.get(ACTIVE_KEY);
  if (!active?.attemptId) return false;
  try {
    const result = await checkAttempt(active.attemptId);
    if (result.state === "mine" && result.attempt.status === "in_progress") {
      els.resumeText.textContent = `${result.attempt.studentName}, you have an unfinished quiz: "${result.attempt.quizTitle}". Your answers have been saved.`;
      els.resumeCard.hidden = false;
      return true;
    }
  } catch {
    // Offline: still offer to continue; the quiz page keeps a local copy.
    els.resumeText.textContent = `${active.studentName || "You"} have an unfinished quiz: "${active.quizTitle || ""}".`;
    els.resumeCard.hidden = false;
    return true;
  }
  storage.remove(ACTIVE_KEY);
  return false;
}

async function init() {
  try {
    await ensureStudentAuth();
    const [settings, list] = await Promise.all([loadSettings(), loadActiveQuizzes()]);
    quizzes = list;
    els.loading.hidden = true;

    if (await showResumeIfAny()) return;

    fillSelect(els.grade, settings.grades.map((g) => ({ value: g, label: `Grade ${g}` })), "Choose grade");
    fillSelect(els.section, settings.sections.map((s) => ({ value: s, label: `Section ${s}` })), "Choose section");
    if (settings.grades.length === 1) els.grade.value = settings.grades[0];
    updateQuizOptions();
    els.startCard.hidden = false;
    if (!quizzes.length) {
      showNotice(els.notice, "No quiz is open right now. Please wait for your teacher to open one, then refresh this page.", "info");
      els.startBtn.disabled = true;
    }
  } catch (err) {
    els.loading.hidden = true;
    showNotice(els.notice, `Could not load the quiz. ${friendlyError(err)}`, "error");
    console.error(err);
  }
}

els.form.addEventListener("submit", onSubmit);
els.grade.addEventListener("change", updateQuizOptions);
els.confirmBack.addEventListener("click", () => { els.confirmModal.hidden = true; pendingStart = null; });
els.confirmStart.addEventListener("click", confirmStart);
els.notMeBtn.addEventListener("click", () => {
  storage.remove(ACTIVE_KEY);
  els.resumeCard.hidden = true;
  location.reload();
});
["fullName", "rollNo", "grade", "section", "quizSelect"].forEach((id) =>
  $(id).addEventListener("input", () => setFieldError(id, "")));

init();
