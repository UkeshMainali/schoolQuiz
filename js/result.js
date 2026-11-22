// Individual student result (result.html?id=attemptId). Teacher only.

import { db, doc, getDoc, setDoc, writeBatch } from "./firebase.js";
import { watchTeacher } from "./auth.js";
import { loadAnswerKey, gradeAttempt, buildResultDoc, needsGrading } from "./grading.js";
import {
  loadSettings, escapeHtml, formatDateTime, toDate, friendlyError, showNotice, confirmDialog
} from "./utilities.js";

const $ = (id) => document.getElementById(id);
const attemptId = new URLSearchParams(location.search).get("id");

const EVENT_LABELS = {
  tab_hidden: "Switched tab or minimised the browser",
  window_blur: "Switched to another window or app",
  fullscreen_exit: "Left fullscreen",
  copy_blocked: "Tried to copy",
  paste_blocked: "Tried to paste",
  print_attempt: "Tried to print",
  devtools_shortcut: "Pressed a developer-tools shortcut",
  printscreen_key: "Pressed Print Screen"
};

let attempt, result, quiz, key, settings;

watchTeacher(
  () => load(),
  () => { location.replace("dashboard.html"); }
);

async function load() {
  if (!attemptId) { fail("No student was selected."); return; }
  try {
    settings = await loadSettings();
    const [aSnap, rSnap] = await Promise.all([
      getDoc(doc(db, "attempts", attemptId)),
      getDoc(doc(db, "results", attemptId))
    ]);
    if (!aSnap.exists()) { fail("This attempt was not found. It may have been deleted to allow a retake."); return; }
    attempt = { id: aSnap.id, ...aSnap.data() };
    result = rSnap.exists() ? { id: rSnap.id, ...rSnap.data() } : null;
    const qSnap = await getDoc(doc(db, "quizzes", attempt.quizId));
    quiz = qSnap.exists() ? { id: qSnap.id, ...qSnap.data() } : null;
    key = await loadAnswerKey(attempt.quizId, { refresh: true });
    render();
  } catch (err) {
    console.error(err);
    fail(`Could not load this result. ${friendlyError(err)}`);
  }
}

function fail(message) {
  $("loading").hidden = true;
  showNotice($("notice"), message, "error");
}

function render() {
  $("loading").hidden = true;
  $("content").hidden = false;
  document.title = `${attempt.studentName} – Result`;
  $("studentName").textContent = attempt.studentName;
  $("studentMeta").textContent = `Roll no. ${attempt.rollNo} · Grade ${attempt.grade} · Section ${attempt.section} · ${attempt.quizTitle}`;

  const submitted = attempt.status === "submitted";
  const stale = submitted && needsGrading(attempt, result, quiz || key);
  const g = key ? gradeAttempt(attempt, key, result?.overrides || {}, settings.passPercent) : null;
  // Show the saved result when it is current; otherwise the live calculation.
  const shown = submitted && result && !stale ? result : g;

  let badge;
  if (!submitted) badge = '<span class="badge">In progress</span>';
  else if (stale) badge = `<span class="badge badge-warning">${result ? "Needs regrading" : "Not graded yet"}</span>`;
  else badge = result.passed ? '<span class="badge badge-success">Pass</span>' : '<span class="badge badge-danger">Fail</span>';
  $("statusBadge").innerHTML = badge;

  if (!key) showNotice($("notice"), "The answer key for this quiz is missing, so it cannot be graded. Import the question bank again.", "warning");
  else if (!submitted) showNotice($("notice"), "This student has not submitted yet. The marks below are a preview of the answers saved so far.", "info");
  else if (stale) showNotice($("notice"), `${result ? "The answer key changed after this was graded." : "This submission has not been graded yet."} The values below are calculated now; press Grade now to save them.`, "warning");
  else $("notice").hidden = true;

  $("gradeBtn").hidden = !(submitted && stale && key);

  const cards = shown ? [
    ["Obtained marks", shown.obtainedMarks],
    ["Total marks", shown.totalMarks],
    ["Percentage", `${shown.percentage}%`],
    ["Correct", shown.correctCount],
    ["Incorrect", shown.incorrectCount],
    ["Unanswered", shown.unansweredCount]
  ] : [];
  $("resultCards").innerHTML = cards.map(([l, v]) => `
    <div class="summary-card"><div class="summary-label">${l}</div><div class="summary-value">${escapeHtml(v)}</div></div>`).join("");

  $("infoGrid").innerHTML = [
    ["Quiz", attempt.quizTitle],
    ["Started", formatDateTime(attempt.startedAt)],
    ["Submitted", submitted ? formatDateTime(attempt.submittedAt) : "Not yet"],
    ["Time taken", duration(attempt.startedAt, attempt.submittedAt)],
    ["Graded", result && !stale ? formatDateTime(result.gradedAt) : "—"],
    ["Pass mark", shown ? `${shown.passPercent}%` : "—"]
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");

  renderAnswers(g, submitted);
  renderActivity();
}

function duration(start, end) {
  const s = toDate(start), e = toDate(end);
  if (!s || !e) return "—";
  const mins = Math.round((e - s) / 60000);
  return mins < 1 ? "Less than a minute" : `${mins} minute${mins === 1 ? "" : "s"}`;
}

function renderAnswers(g, submitted) {
  if (!g) { $("answersBody").innerHTML = `<tr><td colspan="6" class="empty">No answer key available.</td></tr>`; return; }
  const keyById = new Map(key.questions.map((q) => [q.id, q]));
  const statusBadge = {
    correct: '<span class="badge badge-success">Correct</span>',
    incorrect: '<span class="badge badge-danger">Incorrect</span>',
    unanswered: '<span class="badge">Unanswered</span>'
  };
  $("answersBody").innerHTML = g.details.map((d) => {
    const q = keyById.get(d.questionId);
    const given = d.given === null ? '<span class="muted">—</span>'
      : d.type === "short_answer" ? escapeHtml(d.givenText) : `${escapeHtml(d.given)}. ${escapeHtml(d.givenText)}`;
    const correct = d.type === "short_answer" ? escapeHtml(d.correctAnswer) : `${escapeHtml(q.correctOptionId)}. ${escapeHtml(d.correctAnswer)}`;
    let resultCell = statusBadge[d.status] + (d.overridden ? ' <span class="small muted">(changed by teacher)</span>' : "");
    if (submitted && d.type === "short_answer" && d.given !== null) {
      const current = d.overridden ? (d.status === "correct" ? "correct" : "incorrect") : "auto";
      resultCell += `
        <div><select class="override" data-q="${escapeHtml(d.questionId)}" aria-label="Override marking">
          <option value="auto"${current === "auto" ? " selected" : ""}>Automatic</option>
          <option value="correct"${current === "correct" ? " selected" : ""}>Mark correct</option>
          <option value="incorrect"${current === "incorrect" ? " selected" : ""}>Mark incorrect</option>
        </select></div>`;
    }
    return `<tr>
      <td>${d.position}</td>
      <td>${escapeHtml(q.text)}${q.explanation ? `<div class="small muted">${escapeHtml(q.explanation)}</div>` : ""}</td>
      <td>${given}</td>
      <td>${correct}</td>
      <td>${resultCell}</td>
      <td class="num">${d.marksAwarded} / ${d.marks}</td>
    </tr>`;
  }).join("");
  if (g.missingQuestions.length) {
    $("answersBody").insertAdjacentHTML("beforeend", `<tr><td colspan="6" class="small" style="color:var(--danger)">${g.missingQuestions.length} question(s) this student saw are no longer in the answer key and were not counted: ${g.missingQuestions.map(escapeHtml).join(", ")}</td></tr>`);
  }
  document.querySelectorAll(".override").forEach((sel) => sel.addEventListener("change", () => saveOverride(sel.dataset.q, sel.value)));
}

function renderActivity() {
  const events = Array.isArray(attempt.events) ? attempt.events : [];
  const flagged = (attempt.focusLossCount || 0) >= 3;
  $("activity").innerHTML = `
    <div class="${flagged ? "notice notice-warning" : ""}">
      Left the quiz page <b>${attempt.focusLossCount || 0}</b> time(s) · Left fullscreen <b>${attempt.fullscreenExitCount || 0}</b> time(s)
    </div>
    ${events.length ? `<div class="table-wrap"><table class="data-table compact">
      <thead><tr><th>Time</th><th>Event</th><th class="num">On question</th></tr></thead>
      <tbody>${events.slice().reverse().map((e) => `<tr><td class="small">${escapeHtml(formatDateTime(new Date(e.at)))}</td><td>${escapeHtml(EVENT_LABELS[e.type] || e.type)}</td><td class="num">${escapeHtml(e.q ?? "")}</td></tr>`).join("")}</tbody>
    </table></div>` : '<p class="muted">No unusual activity was recorded.</p>'}
    <p class="small muted">These records only show what the browser could detect. They are not proof of cheating, and they cannot detect phones, screenshots or other devices.</p>`;
}

async function saveResult(overrides) {
  const data = buildResultDoc(attempt, key, overrides, settings.passPercent);
  await setDoc(doc(db, "results", attempt.id), data);
  result = { id: attempt.id, ...data, gradedAt: new Date() };
}

async function saveOverride(qid, value) {
  const overrides = { ...(result?.overrides || {}) };
  if (value === "auto") delete overrides[qid];
  else overrides[qid] = value === "correct";
  try {
    await saveResult(overrides);
    render();
    showNotice($("notice"), "Marking updated and saved.", "success");
  } catch (err) {
    showNotice($("notice"), `Could not save. ${friendlyError(err)}`, "error");
  }
}

$("gradeBtn").addEventListener("click", async () => {
  $("gradeBtn").disabled = true;
  try {
    await saveResult(result?.overrides || {});
    render();
    showNotice($("notice"), "Graded and saved.", "success");
  } catch (err) {
    showNotice($("notice"), `Could not grade. ${friendlyError(err)}`, "error");
  } finally { $("gradeBtn").disabled = false; }
});

$("printBtn").addEventListener("click", () => window.print());

$("retakeBtn").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Allow this student to retake the quiz?",
    text: `${attempt.studentName}'s attempt and result for "${attempt.quizTitle}" will be permanently deleted. The student can then start the quiz again with the same details.`,
    okText: "Delete and allow retake", danger: true
  });
  if (!ok) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "attempts", attempt.id));
    batch.delete(doc(db, "results", attempt.id));
    await batch.commit();
    location.replace("dashboard.html");
  } catch (err) {
    showNotice($("notice"), `Could not delete. ${friendlyError(err)}`, "error");
  }
});
