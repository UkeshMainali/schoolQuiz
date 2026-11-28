// Quiz page (quiz.html): one question at a time, local + periodic saving,
// final submission.

import { ensureStudentAuth } from "./auth.js";
import { loadQuiz, checkAttempt, createAttempt, saveProgress, submitAttempt, startTimer, syncClock } from "./submission.js";
import { buildRandomOrder } from "./randomizer.js";
import { startAntiCheat, requestFullscreen, isFullscreen, fullscreenSupported } from "./antiCheat.js";
import {
  makeAttemptId, escapeHtml, friendlyError, loadSettings, validateRoll, showNotice, hideNotice, storage, formatDateTime,
  ACTIVE_KEY, PENDING_KEY, progressKey, toDate, quizDuration, durationLabel, attemptDeadline, formatClock
} from "./utilities.js";
import { SHORT_ANSWER_MAX_LENGTH } from "./questionBank.js";
import { lookupStudent } from "./students.js";

const SAVE_INTERVAL_MS = 30000; // at most one progress write every 30 s per student
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TYPE_LABELS = { mcq: "Multiple choice", true_false: "True or false", short_answer: "Short answer" };

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  "loading", "notice", "errorCard", "errorText", "errorRetry", "introCard", "introTitle", "introDetails",
  "beginBtn", "questionScreen", "quizTitle", "questionCounter", "saveStatus", "progressBar",
  "fullscreenBanner", "fullscreenBtn", "questionCard", "questionType", "questionMarks", "questionText",
  "questionImage", "answerArea", "prevBtn", "nextBtn", "reviewBtn", "navigatorGrid", "reviewScreen",
  "reviewSummary", "reviewWarning", "reviewGrid", "backToQuizBtn", "submitBtn", "doneCard", "doneText",
  "submitModal", "submitModalText", "submitError", "submitCancel", "submitConfirm", "leaveModal",
  "leaveText", "leaveOk", "offlineBanner", "firstUnansweredBtn", "obscureCover", "questionLesson",
  "quizTimer", "quizTimerText", "timerAnnounce", "timeUpModal", "timeUpText", "timeUpRetry"
].map((id) => [id, $(id)]));

const state = {
  attemptId: null,
  quiz: null,
  questionsById: new Map(),
  order: [],
  optionOrder: {},
  answers: {},
  currentIndex: 0,
  focusLossCount: 0,
  fullscreenExitCount: 0,
  events: [],
  student: null,
  started: false,       // student pressed Begin
  submitted: false,
  submitting: false,
  dirty: false,         // changes not yet saved to Firestore
  saving: false,
  lastRemoteSave: 0,
  // Time limit (timed quizzes only). deadlineMs is on the SERVER's clock;
  // offsetMs = server clock − device clock, measured when the timer starts
  // and after every reload, so changing the device clock gives no extra time.
  timeLimitMin: 0,
  deadlineMs: null,
  offsetMs: 0,
  timeUp: false,        // the time ran out: answers are locked, the quiz is being submitted
  warned: {}
};

let stopAntiCheat = null;
let saveTimer = null;
let tickTimer = null;

// ------------------------------------------------------------------ helpers

const quizCacheKey = (quizId) => `cq_quiz_${quizId}`;

function showOnly(section) {
  ["loading", "errorCard", "introCard", "questionScreen", "reviewScreen", "doneCard"]
    .forEach((id) => { els[id].hidden = id !== section; });
}

function showError(message, retry = true) {
  els.errorText.textContent = message;
  els.errorRetry.hidden = !retry;
  showOnly("errorCard");
}

function isAnswered(qid) {
  const v = state.answers[qid];
  return v !== undefined && v !== null && String(v).trim() !== "";
}

function answeredCount() {
  return state.order.filter(isAnswered).length;
}

function recordEvent(type) {
  state.events.push({ type, at: new Date().toISOString(), q: state.currentIndex + 1 });
  if (state.events.length > 200) state.events = state.events.slice(-200);
  persistLocal();
  state.dirty = true;
}

/** Saves everything to localStorage on every change (no Firestore cost). */
function persistLocal() {
  if (!state.attemptId) return;
  storage.set(progressKey(state.attemptId), {
    answers: state.answers,
    currentIndex: state.currentIndex,
    focusLossCount: state.focusLossCount,
    fullscreenExitCount: state.fullscreenExitCount,
    events: state.events,
    order: state.order,
    optionOrder: state.optionOrder,
    quizId: state.quiz?.id,
    student: state.student,
    timer: state.timeLimitMin ? { limit: state.timeLimitMin, deadlineMs: state.deadlineMs, offsetMs: state.offsetMs } : null,
    updatedAt: Date.now()
  });
}

function setSaveStatus(text, kind = "") {
  els.saveStatus.textContent = text;
  els.saveStatus.dataset.kind = kind;
}

/** Writes progress to Firestore if anything changed. */
async function saveRemote({ force = false } = {}) {
  if (!state.attemptId || state.submitted || state.submitting || state.saving) return;
  if (!state.dirty && !force) return;
  if (!navigator.onLine) { setSaveStatus("Saved on this device", "offline"); return; }
  state.saving = true;
  state.dirty = false;
  setSaveStatus("Saving…");
  try {
    await saveProgress(state.attemptId, state);
    state.lastRemoteSave = Date.now();
    setSaveStatus("All answers saved", "ok");
  } catch (err) {
    state.dirty = true;
    setSaveStatus("Saved on this device", "offline");
    if (err?.code === "permission-denied") await handleLockedAttempt();
  } finally {
    state.saving = false;
  }
}

/** The attempt can no longer be changed (submitted elsewhere or deleted). */
async function handleLockedAttempt() {
  try {
    const res = await checkAttempt(state.attemptId);
    if (res.state === "mine" && res.attempt.status === "submitted") { finishSubmitted(res.attempt); return; }
    // Answers sent after the deadline are refused: submit what the server has.
    if (res.state === "mine" && state.deadlineMs && serverNow() >= state.deadlineMs) { autoSubmit(); return; }
    if (res.state === "none") {
      stopMonitoring();
      clearLocal();
      showError("This quiz attempt was reset by your teacher. Please go back to the start page.", false);
    }
  } catch { /* offline: try later */ }
}

function clearLocal() {
  storage.remove(ACTIVE_KEY);
  storage.remove(PENDING_KEY);
  if (state.attemptId) storage.remove(progressKey(state.attemptId));
}

function stopMonitoring() {
  clearInterval(tickTimer);
  stopAntiCheat?.();
  stopAntiCheat = null;
  setObscured(false);
  clearInterval(saveTimer);
  document.body.classList.remove("quiz-active");
  if (isFullscreen()) document.exitFullscreen?.().catch(() => {});
}

// ------------------------------------------------------------------ loading

function applyQuiz(quiz) {
  state.quiz = quiz;
  state.questionsById = new Map((quiz.questions || []).map((q) => [q.id, q]));
}

/** Merges local progress (newest, written on every click) with the server copy. */
function applyProgress(attempt, local) {
  state.order = attempt.order;
  state.optionOrder = attempt.optionOrder || {};
  state.answers = { ...(attempt.answers || {}) };
  state.currentIndex = attempt.currentIndex || 0;
  state.focusLossCount = attempt.focusLossCount || 0;
  state.fullscreenExitCount = attempt.fullscreenExitCount || 0;
  state.events = Array.isArray(attempt.events) ? attempt.events : [];
  const remoteTime = toDate(attempt.lastSavedAt)?.getTime() || 0;
  if (local && local.updatedAt >= remoteTime - 5000) {
    state.answers = { ...state.answers, ...(local.answers || {}) };
    state.currentIndex = Number.isInteger(local.currentIndex) ? local.currentIndex : state.currentIndex;
    state.focusLossCount = Math.max(state.focusLossCount, local.focusLossCount || 0);
    state.fullscreenExitCount = Math.max(state.fullscreenExitCount, local.fullscreenExitCount || 0);
    if (Array.isArray(local.events) && local.events.length >= state.events.length) state.events = local.events;
    state.dirty = true;
  }
  // Ignore anything that does not belong to this attempt's questions.
  Object.keys(state.answers).forEach((qid) => { if (!state.order.includes(qid)) delete state.answers[qid]; });
  state.currentIndex = Math.min(Math.max(0, state.currentIndex), state.order.length - 1);
}

function validQuiz(quiz) {
  return quiz && Array.isArray(quiz.questions) && quiz.questions.length > 0;
}

async function init() {
  showOnly("loading");
  hideNotice(els.notice);
  const active = storage.get(ACTIVE_KEY);
  const pending = storage.get(PENDING_KEY);
  if (!active?.attemptId && !pending?.quizId) { location.replace("index.html"); return; }

  try {
    await ensureStudentAuth();
  } catch (err) {
    if (active?.attemptId && tryOfflineResume(active)) return;
    showError(`Could not connect. ${friendlyError(err)}`);
    return;
  }

  try {
    if (active?.attemptId) await resumeAttempt(active.attemptId);
    else await startNewAttempt(pending);
  } catch (err) {
    console.error(err);
    if (active?.attemptId && tryOfflineResume(active)) return;
    showError(`Could not load the quiz. ${friendlyError(err)}`);
  }
}

/** If the network is down after a refresh, continue from the local copy. */
function tryOfflineResume(active) {
  const local = storage.get(progressKey(active.attemptId));
  const quiz = storage.get(quizCacheKey(active.quizId));
  if (!local || !validQuiz(quiz) || !Array.isArray(local.order)) return false;
  state.attemptId = active.attemptId;
  state.student = local.student;
  applyQuiz(quiz);
  applyProgress({ order: local.order, optionOrder: local.optionOrder, answers: {}, currentIndex: 0 }, { ...local, updatedAt: Infinity });
  if (local.timer?.limit) {
    state.timeLimitMin = local.timer.limit;
    state.deadlineMs = local.timer.deadlineMs || null;
    state.offsetMs = local.timer.offsetMs || 0;
  }
  state.dirty = true;
  showIntro(true);
  showNotice(els.notice, "You are offline. You can keep answering; your answers will be sent when the internet is back.", "warning");
  return true;
}

async function resumeAttempt(attemptId) {
  const res = await checkAttempt(attemptId);
  if (res.state === "taken" || res.state === "none") {
    storage.remove(ACTIVE_KEY);
    showError(res.state === "none"
      ? "This quiz attempt no longer exists. Please start again from the start page."
      : "This quiz attempt belongs to another device.", false);
    return;
  }
  const attempt = res.attempt;
  state.attemptId = attemptId;
  if (attempt.status === "submitted") { finishSubmitted(attempt); return; }

  const quiz = await loadQuiz(attempt.quizId).catch((err) => {
    if (err?.code === "permission-denied") return "closed";
    throw err;
  });
  if (quiz === "closed" || !quiz) {
    showError("This quiz has been closed by your teacher. Your saved answers are kept. Please tell your teacher.", false);
    return;
  }
  if (!validQuiz(quiz)) { showError("This quiz has no questions. Please tell your teacher.", false); return; }
  quiz.id = attempt.quizId;
  applyQuiz(quiz);
  storage.set(quizCacheKey(quiz.id), quiz);
  if (attempt.order.some((qid) => !state.questionsById.has(qid))) {
    showError("This quiz was changed by your teacher after you started. Please tell your teacher.", false);
    return;
  }
  state.student = { name: attempt.studentName, roll: attempt.rollNo, grade: attempt.grade, section: attempt.section };
  applyProgress(attempt, storage.get(progressKey(attemptId)));
  state.timeLimitMin = Number(attempt.timeLimitMin) || 0;
  state.deadlineMs = attemptDeadline(attempt);
  if (state.deadlineMs) {
    // The timer is already running: measure the server clock again (a reload never resets it).
    const local = storage.get(progressKey(attemptId));
    state.offsetMs = local?.timer?.offsetMs || 0;
    try { state.offsetMs = (await syncClock(attemptId)).offsetMs; } catch (err) { console.warn("Clock check failed; using the last known offset", err); }
  }
  persistLocal();
  if (state.deadlineMs && remainingMs() <= 0) { autoSubmit(); return; }
  showIntro(true);
}

async function startNewAttempt(pending) {
  const { quizId, student } = pending;
  const quiz = await loadQuiz(quizId).catch((err) => {
    if (err?.code === "permission-denied") return null;
    throw err;
  });
  if (!quiz) { storage.remove(PENDING_KEY); showError("This quiz is not available right now.", false); return; }
  if (!validQuiz(quiz)) { showError("This quiz has no questions. Please tell your teacher.", false); return; }
  quiz.id = quizId;
  applyQuiz(quiz);

  if (quiz.grade && String(quiz.grade) !== String(student.grade)) {
    storage.remove(PENDING_KEY);
    showError(`This quiz is for Grade ${quiz.grade} students only.`, false);
    return;
  }
  // Roll number limit for the section, read fresh (the security rules check it too).
  const rollCheck = validateRoll(student.roll, await loadSettings(), student.grade, student.section);
  if (rollCheck.error) {
    storage.remove(PENDING_KEY);
    showError(`${rollCheck.error} Go back to the start page and correct your details, or ask your teacher.`, false);
    return;
  }
  if (Array.isArray(quiz.sections) && quiz.sections.length && !quiz.sections.includes(String(student.section))) {
    storage.remove(PENDING_KEY);
    showError(`This quiz is for Section ${quiz.sections.join(", ")} only.`, false);
    return;
  }
  // Use the registered name and id (the Admin may have corrected the name).
  const reg = await lookupStudent(student.grade, student.section, student.roll);
  if (reg.state === "found" && (!student.studentId || student.studentId === reg.student.id)) {
    student.studentId = reg.student.id;
    student.name = reg.student.name;
  } else if (reg.state !== "new" || student.studentId) {
    storage.remove(PENDING_KEY);
    showError("Your student record has changed. Go back to the start page and check your details, or ask your teacher.", false);
    return;
  }
  const attemptId = makeAttemptId(quizId, student.grade, student.section, student.roll);
  const existing = await checkAttempt(attemptId);
  if (existing.state === "taken") {
    storage.remove(PENDING_KEY);
    showError(`A quiz for roll number ${student.roll} has already been started on another device. Please tell your teacher.`, false);
    return;
  }
  if (existing.state === "mine") {
    storage.set(ACTIVE_KEY, { attemptId, quizId, quizTitle: quiz.title, studentName: existing.attempt.studentName });
    storage.remove(PENDING_KEY);
    await resumeAttempt(attemptId);
    return;
  }

  const { order, optionOrder } = buildRandomOrder(quiz);
  const attempt = await createAttempt(attemptId, { quiz, student, order, optionOrder });
  storage.set(ACTIVE_KEY, { attemptId, quizId, quizTitle: quiz.title, studentName: student.name });
  storage.remove(PENDING_KEY);
  storage.set(quizCacheKey(quizId), quiz);
  state.attemptId = attemptId;
  state.student = student;
  state.timeLimitMin = Number(attempt.timeLimitMin) || 0;
  state.deadlineMs = null;
  applyProgress({ ...attempt, lastSavedAt: Date.now() }, null);
  persistLocal();
  showIntro(false);
}

// -------------------------------------------------------------------- intro

function showIntro(resuming) {
  document.title = state.quiz.title;
  els.introTitle.textContent = state.quiz.title;
  const s = state.student || {};
  els.introDetails.innerHTML = [
    ["Name", s.name], ["Roll number", s.roll], ["Grade", s.grade], ["Section", s.section],
    ["Questions", state.order.length], ["Total marks", state.quiz.totalMarks ?? "—"],
    ...(state.timeLimitMin ? [["Time limit", durationLabel(state.timeLimitMin, { long: true })]] : [])
  ].map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v ?? "")}</dd>`).join("");
  const timedNote = document.getElementById("timedRule");
  if (timedNote) timedNote.remove();
  if (state.timeLimitMin) {
    const li = document.createElement("li");
    li.id = "timedRule";
    li.className = "timed-rule";
    li.innerHTML = state.deadlineMs
      ? `<b>Your timer is running.</b> It kept running while you were away. When it reaches zero, your answers are submitted automatically.`
      : `<b>This quiz has a time limit of ${escapeHtml(durationLabel(state.timeLimitMin, { long: true }))}.</b> The timer starts when you press Begin and keeps running if you leave or refresh the page. When it reaches zero, your answers are submitted automatically.`;
    document.querySelector(".rules-list").prepend(li);
  }
  const left = state.deadlineMs ? ` · ${formatClock(remainingMs())} left` : "";
  els.beginBtn.textContent = resuming ? `Continue quiz (${answeredCount()} of ${state.order.length} answered${left})` : (state.timeLimitMin ? "Begin quiz and start the timer" : "Begin quiz");
  showOnly("introCard");
}

/** Hides the question while the quiz window is not the active window. */
function setObscured(on) {
  document.body.classList.toggle("obscured", !!on);
  els.obscureCover.hidden = !on;
}

/** Faint name + roll number behind the question: a shared photo shows who took it. */
function setWatermark() {
  const s = state.student || {};
  const text = `${s.name || ""} · Roll ${s.roll || ""} · ${s.grade || ""}-${s.section || ""}`;
  els.questionCard.dataset.watermark = text;
}

async function begin() {
  if (state.timeUp || state.submitted) return;
  // Timed quiz: start the timer on the server first. The countdown begins
  // here, at the real start, never on the intro page.
  if (state.timeLimitMin && !state.deadlineMs) {
    els.beginBtn.disabled = true;
    const label = els.beginBtn.textContent;
    els.beginBtn.textContent = "Starting the timer…";
    try {
      if (navigator.onLine === false) throw Object.assign(new Error("offline"), { code: "unavailable" });
      const res = await startTimer(state.attemptId, state);
      if (!res.startMs) throw new Error("The start time was not saved.");
      state.deadlineMs = res.startMs + state.timeLimitMin * 60000;
      state.offsetMs = res.offsetMs;
      state.dirty = false;
      state.lastRemoteSave = Date.now();
      persistLocal();
    } catch (err) {
      console.error(err);
      els.beginBtn.disabled = false;
      els.beginBtn.textContent = label;
      if (err?.code === "permission-denied") { await handleLockedAttempt(); return; }
      showNotice(els.notice, `The timer could not be started, so the quiz has not begun. A timed quiz needs the internet to start. ${friendlyError(err)}`, "error");
      return;
    }
    els.beginBtn.disabled = false;
    hideNotice(els.notice);
  }
  if (fullscreenSupported()) await requestFullscreen();
  state.started = true;
  document.body.classList.add("quiz-active");
  stopAntiCheat = startAntiCheat({
    isActive: () => state.started && !state.submitted,
    onLeave: (reason) => {
      state.focusLossCount++;
      recordEvent(reason);
      saveRemote();
    },
    onObscure: (on) => setObscured(on),
    onReturn: () => {
      els.leaveText.textContent = `You left the quiz page. This has been recorded (${state.focusLossCount} time${state.focusLossCount === 1 ? "" : "s"}) and your teacher can see it.`;
      els.leaveModal.hidden = false;
    },
    onFullscreenExit: () => {
      state.fullscreenExitCount++;
      recordEvent("fullscreen_exit");
      els.fullscreenBanner.hidden = false;
    },
    onFullscreenEnter: () => { els.fullscreenBanner.hidden = true; },
    onEvent: (type) => recordEvent(type)
  });
  saveTimer = setInterval(() => saveRemote(), SAVE_INTERVAL_MS);
  if (state.deadlineMs) startCountdown();
  setWatermark();
  renderQuestion();
  showOnly("questionScreen");
  setSaveStatus(state.dirty ? "Saved on this device" : "All answers saved", state.dirty ? "offline" : "ok");
  if (state.dirty) saveRemote();
}

// ----------------------------------------------------------------- question

function renderQuestion() {
  const total = state.order.length;
  const qid = state.order[state.currentIndex];
  const q = state.questionsById.get(qid);

  els.quizTitle.textContent = state.quiz.title;
  els.questionCounter.textContent = `Question ${state.currentIndex + 1} of ${total}`;
  els.progressBar.style.width = `${((state.currentIndex + 1) / total) * 100}%`;
  els.questionType.textContent = TYPE_LABELS[q.type] || "Question";
  els.questionMarks.textContent = `${q.marks} mark${q.marks === 1 ? "" : "s"}`;
  els.questionText.textContent = q.text;
  const showLesson = q.lessonTitle && state.quiz.merged;
  els.questionLesson.hidden = !showLesson;
  els.questionLesson.textContent = showLesson ? q.lessonTitle : "";
  if (q.image) { els.questionImage.src = q.image; els.questionImage.hidden = false; }
  else { els.questionImage.hidden = true; els.questionImage.removeAttribute("src"); }

  if (q.type === "short_answer") {
    els.answerArea.innerHTML = `
      <label class="sr-only" for="shortAnswer">Your answer</label>
      <input type="text" id="shortAnswer" class="short-answer" maxlength="${SHORT_ANSWER_MAX_LENGTH}"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type your answer here">`;
    const input = $("shortAnswer");
    input.value = state.answers[qid] || "";
    input.addEventListener("input", () => setAnswer(qid, input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(1); } });
  } else {
    const byId = new Map((q.options || []).map((o) => [o.id, o]));
    const ids = (state.optionOrder[qid] || []).filter((id) => byId.has(id));
    // Any option added later still appears (at the end).
    (q.options || []).forEach((o) => { if (!ids.includes(o.id)) ids.push(o.id); });
    els.answerArea.innerHTML = `<div class="options" role="radiogroup" aria-label="Answer options">${ids.map((id, i) => `
      <label class="option${state.answers[qid] === id ? " selected" : ""}">
        <input type="radio" name="answer" value="${escapeHtml(id)}"${state.answers[qid] === id ? " checked" : ""}>
        <span class="option-letter">${LETTERS[i]}</span>
        <span class="option-text">${escapeHtml(byId.get(id).text)}</span>
      </label>`).join("")}</div>`;
    els.answerArea.querySelectorAll('input[name="answer"]').forEach((input) => {
      input.addEventListener("change", () => {
        setAnswer(qid, input.value);
        els.answerArea.querySelectorAll(".option").forEach((l) =>
          l.classList.toggle("selected", l.querySelector("input").checked));
      });
    });
  }

  els.prevBtn.disabled = state.currentIndex === 0;
  const last = state.currentIndex === total - 1;
  els.nextBtn.hidden = last;
  els.reviewBtn.classList.toggle("btn-success", last);
  renderNavigator(els.navigatorGrid);
}

function renderNavigator(container) {
  container.innerHTML = state.order.map((qid, i) => {
    const cls = [isAnswered(qid) ? "answered" : "unanswered", i === state.currentIndex ? "current" : ""].join(" ");
    return `<button type="button" class="nav-num ${cls}" data-index="${i}" aria-label="Question ${i + 1}, ${isAnswered(qid) ? "answered" : "not answered"}">${i + 1}</button>`;
  }).join("");
}

function setAnswer(qid, value) {
  if (state.submitted || state.timeUp) return;
  const v = typeof value === "string" ? value.slice(0, SHORT_ANSWER_MAX_LENGTH) : value;
  if (String(v).trim() === "") delete state.answers[qid];
  else state.answers[qid] = v;
  state.dirty = true;
  persistLocal();
  setSaveStatus("Saved on this device", "pending");
  updateNavigatorState();
}

function updateNavigatorState() {
  els.navigatorGrid.querySelectorAll(".nav-num").forEach((b) => {
    const qid = state.order[Number(b.dataset.index)];
    b.classList.toggle("answered", isAnswered(qid));
    b.classList.toggle("unanswered", !isAnswered(qid));
  });
}

function go(delta) {
  const next = state.currentIndex + delta;
  if (next < 0) return;
  if (next >= state.order.length) { openReview(); return; }
  goTo(next);
}

function goTo(index) {
  state.currentIndex = index;
  persistLocal();
  renderQuestion();
  showOnly("questionScreen");
  window.scrollTo({ top: 0 });
}

// ------------------------------------------------------------------- review

/** Indexes (in the student's order) of questions without an answer. */
function unansweredIndexes() {
  return state.order.map((qid, i) => (isAnswered(qid) ? -1 : i)).filter((i) => i >= 0);
}

function remainingMessage(missing) {
  return missing === 1
    ? "Please answer the 1 remaining question before submitting."
    : `Please answer all ${missing} remaining questions before submitting.`;
}

function openReview() {
  const total = state.order.length;
  const done = answeredCount();
  const missing = unansweredIndexes();
  els.reviewSummary.textContent = `You have answered ${done} of ${total} questions.`;
  if (missing.length) {
    els.reviewWarning.textContent = `${remainingMessage(missing.length)} Unanswered: question${missing.length === 1 ? "" : "s"} ${missing.map((i) => i + 1).join(", ")} (shown in orange).`;
    els.reviewWarning.hidden = false;
  } else {
    els.reviewWarning.hidden = true;
  }
  // Every question must be answered: the button stays disabled until then,
  // and doSubmit() checks again (the button state alone is not trusted).
  els.submitBtn.disabled = missing.length > 0;
  els.firstUnansweredBtn.hidden = missing.length === 0;
  renderNavigator(els.reviewGrid);
  showOnly("reviewScreen");
  window.scrollTo({ top: 0 });
  saveRemote();
}

function openSubmitModal() {
  if (unansweredIndexes().length) { openReview(); return; }
  els.submitModalText.textContent = "You have answered every question. After submitting you cannot change your answers.";
  els.submitError.hidden = true;
  els.submitConfirm.disabled = false;
  els.submitConfirm.textContent = "Yes, submit";
  els.submitCancel.disabled = false;
  els.submitModal.hidden = false;
  els.submitConfirm.focus();
}

async function doSubmit() {
  if (state.submitting || state.submitted || state.timeUp) return; // ignore double clicks (and the timer has its own submit)
  // Re-check right before sending: never submit with unanswered questions.
  const missing = unansweredIndexes();
  if (missing.length) {
    els.submitModal.hidden = true;
    openReview();
    showNotice(els.notice, remainingMessage(missing.length), "error");
    return;
  }
  // Check the roll number against the section's current limit before sending.
  // If the teacher lowered the limit after the quiz started, nothing is
  // changed or lost: the answers stay saved until the teacher fixes it.
  if (navigator.onLine !== false && state.student) {
    state.submitting = true; // blocks double clicks while the settings load
    const rollCheck = validateRoll(state.student.roll, await loadSettings(), state.student.grade, state.student.section);
    state.submitting = false;
    if (rollCheck.error) {
      showNotice(els.submitError, `${rollCheck.error} Your quiz cannot be submitted with roll number ${state.student.roll}. Your answers are saved. Please tell your teacher.`, "error");
      return;
    }
  }
  state.submitting = true;
  persistLocal();
  els.submitConfirm.disabled = true;
  els.submitCancel.disabled = true;
  els.submitConfirm.innerHTML = '<span class="spinner"></span> Submitting…';
  els.submitError.hidden = true;
  // Wait for any progress save already in flight.
  while (state.saving) await new Promise((r) => setTimeout(r, 200));
  try {
    await submitAttempt(state.attemptId, state);
    finishSubmitted({ submittedAt: new Date() });
  } catch (err) {
    console.error(err);
    state.submitting = false;
    els.submitConfirm.disabled = false;
    els.submitCancel.disabled = false;
    els.submitConfirm.textContent = "Try again";
    const msg = err?.code === "permission-denied"
      ? "This quiz can no longer be submitted. It may have been reset or closed by your teacher. Please tell your teacher."
      : `Your quiz was NOT submitted yet. ${friendlyError(err)} Your answers are safe on this device. It will try again automatically when the internet is back.`;
    showNotice(els.submitError, msg, "error");
    if (err?.code !== "permission-denied") retryWhenOnline();
  }
}

let retryArmed = false;
function retryWhenOnline() {
  if (retryArmed) return;
  retryArmed = true;
  const handler = () => {
    retryArmed = false;
    window.removeEventListener("online", handler);
    if (!state.submitted && !els.submitModal.hidden) setTimeout(doSubmit, 1500);
  };
  window.addEventListener("online", handler);
}

function finishSubmitted(attempt) {
  const timedOut = state.timeUp || !!attempt.autoSubmitted;
  state.submitted = true;
  state.submitting = false;
  stopMonitoring();
  els.quizTimer.hidden = true;
  els.timeUpModal.hidden = true;
  document.body.classList.remove("timed");
  clearLocal();
  if (state.quiz?.id) storage.remove(quizCacheKey(state.quiz.id));
  els.submitModal.hidden = true;
  els.leaveModal.hidden = true;
  els.fullscreenBanner.hidden = true;
  const when = formatDateTime(attempt.submittedAt);
  const name = state.student?.name || attempt.studentName || "";
  els.doneText.textContent = timedOut
    ? `Time is up${name ? `, ${name}` : ""}. Your answers were submitted automatically${when !== "—" ? ` at ${when}` : ""}.`
    : `Thank you${name ? `, ${name}` : ""}. Your answers were received${when !== "—" ? ` at ${when}` : ""}.`;
  showOnly("doneCard");
}

// -------------------------------------------------------------------- timer
// The countdown is worked out from timestamps on every tick (never by
// counting ticks), so a sleeping tab, a slow device or a reload cannot add
// time. The server refuses late answers and starts the clock itself, so
// changing this code or the device clock gives no extra time either.

function serverNow() { return Date.now() + state.offsetMs; }
function remainingMs() { return state.deadlineMs ? state.deadlineMs - serverNow() : Infinity; }

function startCountdown() {
  clearInterval(tickTimer);
  document.body.classList.add("timed");
  els.quizTimer.hidden = false;
  const left = remainingMs();
  // Low-time warnings that already passed before a reload are not repeated.
  [300000, 60000].forEach((t) => { if (left <= t) state.warned[t] = true; });
  tickTimer = setInterval(tick, 500);
  tick();
}

function tick() {
  if (!state.deadlineMs || state.submitted) return;
  const left = remainingMs();
  const total = state.timeLimitMin * 60000;
  els.quizTimerText.textContent = formatClock(left);
  // Warn at 5 minutes (or at 20% of a short quiz), danger in the last minute.
  const warnAt = Math.min(300000, Math.max(60000, total * 0.2));
  els.quizTimer.classList.toggle("is-low", left <= warnAt && left > 60000);
  els.quizTimer.classList.toggle("is-danger", left <= 60000);
  const announce = (t, text) => {
    if (left <= t && !state.warned[t]) { state.warned[t] = true; els.timerAnnounce.textContent = text; showNotice(els.notice, text, "warning"); }
  };
  announce(300000, "5 minutes left. Your answers will be submitted automatically when the time is up.");
  announce(60000, "1 minute left.");
  // Send the latest answers shortly before the end so none are lost.
  if (left <= 60000 && !state.warned.save60) { state.warned.save60 = true; saveRemote(); }
  if (left <= 15000 && !state.warned.save15) { state.warned.save15 = true; saveRemote(); }
  if (left <= 0) autoSubmit();
}

let autoRetryTimer = null;
let autoRetryDelay = 5000;

/** The time is over: lock the answers and submit once (never twice). */
async function autoSubmit() {
  if (state.submitted) return;
  if (state.autoSubmitting) return;
  state.autoSubmitting = true;
  state.timeUp = true;
  clearTimeout(autoRetryTimer);
  clearInterval(tickTimer);
  els.quizTimerText.textContent = "0:00";
  els.quizTimer.classList.add("is-danger");
  els.submitModal.hidden = true;
  els.leaveModal.hidden = true;
  els.timeUpRetry.hidden = true;
  els.timeUpText.textContent = "Submitting your answers…";
  els.timeUpModal.hidden = false;
  setObscured(false);
  // A manual submit or a progress save may be on its way: let it finish first.
  while (state.submitting || state.saving) await new Promise((r) => setTimeout(r, 200));
  if (state.submitted) return;
  persistLocal();
  try {
    let res;
    try {
      res = await submitAttempt(state.attemptId, state, { timeUp: true });
    } catch (err) {
      if (err?.code !== "permission-denied") throw err;
      // Answers changed after the deadline (e.g. offline for a long time) are
      // not accepted: submit with the answers the server already has.
      res = await submitAttempt(state.attemptId, state, { timeUp: true, keepServerAnswers: true });
    }
    state.autoSubmitting = false;
    finishSubmitted({ submittedAt: new Date(), autoSubmitted: true, ...(res?.attempt || {}) });
  } catch (err) {
    console.error(err);
    state.autoSubmitting = false;
    if (err?.code === "permission-denied") {
      // Already submitted elsewhere, reset by the teacher, or the clock check
      // is a little early: look at the attempt, then try again shortly.
      const res = await checkAttempt(state.attemptId).catch(() => null);
      if (res?.state === "mine" && res.attempt.status === "submitted") { finishSubmitted(res.attempt); return; }
      if (res?.state === "none") { stopMonitoring(); clearLocal(); els.timeUpModal.hidden = true; showError("This quiz attempt was reset by your teacher. Please go back to the start page.", false); return; }
    }
    els.timeUpText.textContent = navigator.onLine === false
      ? "You are offline. Your answers are safe on this device and will be submitted as soon as the internet is back. Keep this page open."
      : `Your answers were not submitted yet. ${friendlyError(err)} Trying again…`;
    els.timeUpRetry.hidden = false;
    autoRetryTimer = setTimeout(autoSubmit, autoRetryDelay);
    autoRetryDelay = Math.min(60000, autoRetryDelay * 2);
  }
}

// ------------------------------------------------------------------- events

els.beginBtn.addEventListener("click", begin);
els.prevBtn.addEventListener("click", () => go(-1));
els.nextBtn.addEventListener("click", () => go(1));
els.reviewBtn.addEventListener("click", openReview);
els.backToQuizBtn.addEventListener("click", () => goTo(state.currentIndex));
els.submitBtn.addEventListener("click", openSubmitModal);
els.firstUnansweredBtn.addEventListener("click", () => {
  const first = unansweredIndexes()[0];
  if (first !== undefined) goTo(first);
});
els.obscureCover.addEventListener("click", () => { window.focus(); setObscured(false); });
els.submitCancel.addEventListener("click", () => { els.submitModal.hidden = true; });
els.submitConfirm.addEventListener("click", doSubmit);
els.leaveOk.addEventListener("click", () => {
  els.leaveModal.hidden = true;
  if (fullscreenSupported() && !isFullscreen()) requestFullscreen();
});
els.fullscreenBtn.addEventListener("click", () => requestFullscreen());
els.errorRetry.addEventListener("click", init);
els.timeUpRetry.addEventListener("click", () => { autoRetryDelay = 5000; autoSubmit(); });
[els.navigatorGrid, els.reviewGrid].forEach((grid) => grid.addEventListener("click", (e) => {
  const b = e.target.closest(".nav-num");
  if (b) goTo(Number(b.dataset.index));
}));

function updateOnline() {
  els.offlineBanner.hidden = navigator.onLine || !state.attemptId || state.submitted;
  if (navigator.onLine && state.timeUp && !state.submitted) { autoRetryDelay = 5000; autoSubmit(); return; }
  if (navigator.onLine && state.started) saveRemote();
}
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { persistLocal(); }
  else if (state.deadlineMs && state.started) tick(); // catch up at once after the tab was in the background
});

init();
