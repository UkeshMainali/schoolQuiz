// One student record (result.html?id=<attemptId>[&source=archive]). Teacher only.
// Shows marks, answers and activity, and offers the per-record actions:
// grade / recalculate, accept / decline / pending review, print, allow
// retake (keeps the old attempt), archive / restore and delete.

import { db, doc, getDoc, setDoc } from "./firebase.js";
import { watchTeacher } from "./auth.js";
import { loadAnswerKey, gradeAttempt, buildResultDoc, needsGrading } from "./grading.js";
import { setReviewStatus, archiveRecords, restoreRecords, deleteRecords, allowRetake, SOURCES } from "./records.js";
import { buildBackup } from "./backup.js";
import { buildReport, printHtml } from "./print.js";
import {
  loadSettings, escapeHtml, formatDateTime, toDate, friendlyError, showNotice, hideNotice, confirmDialog, downloadFile, historyLink
} from "./utilities.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const attemptId = params.get("id");
const source = params.get("source") === "archive" ? "archive" : "active";
const isArchive = source === "archive";

const EVENT_LABELS = {
  tab_hidden: "Switched tab or minimised the browser",
  window_blur: "Switched to another window or app",
  fullscreen_exit: "Left fullscreen",
  copy_blocked: "Tried to copy",
  paste_blocked: "Tried to paste",
  print_attempt: "Tried to print",
  devtools_shortcut: "Pressed a developer-tools shortcut",
  printscreen_key: "Pressed Print Screen",
  screenshot_shortcut: "Pressed a screenshot shortcut",
  context_menu: "Tried to open the right-click menu"
};
const REVIEW = {
  pending: '<span class="badge badge-muted">Pending review</span>',
  accepted: '<span class="badge badge-info">Accepted</span>',
  declined: '<span class="badge badge-danger-outline">Declined</span>'
};

let attempt, result, quiz, key, settings;

if (isArchive) {
  $("backLink").textContent = "← Back to archive";
}

watchTeacher(() => load(), () => { location.replace("dashboard.html"); });

async function load() {
  if (!attemptId) { fail("No student record was selected."); return; }
  try {
    settings = await loadSettings();
    const cols = SOURCES[source];
    const [aSnap, rSnap] = await Promise.all([getDoc(doc(db, cols.attempts, attemptId)), getDoc(doc(db, cols.results, attemptId))]);
    if (!aSnap.exists()) {
      fail(isArchive ? "This record is not in the archive. It may have been restored or deleted." : "This record was not found. It may have been archived or deleted.");
      return;
    }
    attempt = { id: aSnap.id, ...aSnap.data() };
    result = rSnap.exists() ? { id: rSnap.id, ...rSnap.data() } : null;
    const qSnap = await getDoc(doc(db, "quizzes", attempt.quizId));
    quiz = qSnap.exists() ? { id: qSnap.id, ...qSnap.data() } : null;
    key = await loadAnswerKey(attempt.quizId, { refresh: true });
    render();
  } catch (err) {
    console.error(err);
    fail(`Could not load this record. ${friendlyError(err)}`);
  }
}

function fail(message) {
  $("loading").hidden = true;
  showNotice($("notice"), message, "error");
}

function note(text, type = "info") { showNotice($("notice"), text, type); }

const historyUrl = () => historyLink(attempt.grade, attempt.section, attempt.rollNo);

function render() {
  $("loading").hidden = true;
  $("content").hidden = false;
  document.title = `${attempt.studentName} – Result`;
  $("studentName").textContent = attempt.studentName;
  $("studentMeta").innerHTML = `Roll no. ${escapeHtml(attempt.rollNo)} · Grade ${escapeHtml(attempt.grade)} · Section ${escapeHtml(attempt.section)} · ${escapeHtml(attempt.quizTitle)}`;

  const submitted = attempt.status === "submitted";
  const stale = submitted && !isArchive && needsGrading(attempt, result, quiz || key);
  const missingResult = submitted && !result;
  const g = key ? gradeAttempt(attempt, key, result?.overrides || {}, settings.passPercent) : null;
  // Show the saved result when it is current; otherwise the live calculation.
  const shown = submitted && result && !stale ? result : g;
  const review = submitted ? (attempt.reviewStatus || "pending") : null;

  const badges = [];
  if (isArchive) badges.push('<span class="badge badge-muted">Archived</span>');
  if (attempt.previousAttempt) badges.push('<span class="badge">Previous attempt</span>');
  if (!submitted) badges.push('<span class="badge">In progress</span>');
  else if (stale || missingResult) badges.push(`<span class="badge badge-warning">${result ? "Needs regrading" : "Not graded yet"}</span>`);
  else badges.push(result.passed ? '<span class="badge badge-success">Pass</span>' : '<span class="badge badge-danger">Fail</span>');
  if (review) badges.push(REVIEW[review]);
  $("statusBadge").innerHTML = badges.join("");

  if (!key) note("The answer key for this quiz is missing, so it cannot be graded. Add the question bank again on the Quizzes tab.", "warning");
  else if (!submitted) note("This student has not submitted yet. The marks below are a preview of the answers saved so far.", "info");
  else if (review === "declined") note(`This submission was declined${attempt.reviewedBy ? ` by ${attempt.reviewedBy}` : ""}. It is not counted in averages or analysis.`, "warning");
  else if (stale || missingResult) note(`${result ? "The answer key or pass mark changed after this was graded." : "This submission has not been graded yet."} The values below are calculated now; press ${result ? "Recalculate" : "Grade"} to save them.`, "warning");
  else hideNotice($("notice"));

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
    ["Graded", result && !stale ? `${formatDateTime(result.gradedAt)}${result.gradedBy ? ` by ${result.gradedBy}` : ""}` : "—"],
    ["Review", review ? `${{ pending: "Pending review", accepted: "Accepted", declined: "Declined" }[review]}${attempt.reviewedAt ? `, ${formatDateTime(attempt.reviewedAt)}` : ""}` : "—"],
    ["Pass mark", shown ? `${shown.passPercent}%` : "—"],
    ...(isArchive ? [["Archived", `${formatDateTime(attempt.archivedAt)}${attempt.archivedBy ? ` by ${attempt.archivedBy}` : ""}`]] : []),
    ...(attempt.originalId ? [["Original record", attempt.originalId]] : [])
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");

  renderActions(submitted, review, !!(stale || missingResult));
  renderAnswers(g, submitted && !isArchive && review !== "declined");
  renderActivity();
}

function renderActions(submitted, review, needsSave) {
  const b = (act, label, cls = "") => `<button type="button" class="btn ${cls}" data-act="${act}">${label}</button>`;
  const m = (act, label, cls = "") => `<button type="button" data-act="${act}" class="${cls}">${label}</button>`;
  const review_ = [];
  if (!isArchive && submitted && key && review !== "declined" && needsSave) review_.push(b("grade", "Grade now", "btn-primary"));
  if (!isArchive && submitted) {
    if (review !== "accepted") review_.push(b("accept", "Accept", needsSave ? "" : "btn-primary"));
    if (review !== "declined") review_.push(b("decline", "Decline"));
  }
  const more = [];
  if (!isArchive && submitted && key && review !== "declined" && !needsSave) more.push(m("grade", result ? "Recalculate marks" : "Grade now"));
  if (!isArchive && submitted && review !== "pending") more.push(m("pending", "Mark pending review"));
  if (!isArchive && !attempt.previousAttempt) more.push(m("retake", "Allow retake"));
  more.push(m(isArchive ? "restore" : "archive", isArchive ? "Restore to results" : "Archive"));
  more.push(m("delete", isArchive ? "Delete permanently…" : "Delete…", "danger"));
  $("actions").innerHTML = `
    ${review_.length ? `<div class="action-group">${review_.join("")}</div>` : ""}
    <div class="action-group">
      ${b("print", "Print report")}
      <a class="btn" href="${historyUrl()}">Student history</a>
    </div>
    <details class="menu action-more">
      <summary class="btn">More</summary>
      <div class="menu-list">${more.join("")}</div>
    </details>`;
}

function duration(start, end) {
  const s = toDate(start), e = toDate(end);
  if (!s || !e) return "—";
  const mins = Math.round((e - s) / 60000);
  return mins < 1 ? "Less than a minute" : `${mins} minute${mins === 1 ? "" : "s"}`;
}

function renderAnswers(g, canOverride) {
  if (!g) { $("answersBody").innerHTML = '<tr><td colspan="6" class="empty">No answer key available.</td></tr>'; return; }
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
    if (canOverride && d.type === "short_answer" && d.given !== null) {
      const current = d.overridden ? (d.status === "correct" ? "correct" : "incorrect") : "auto";
      resultCell += `
        <div><select class="override" data-q="${escapeHtml(d.questionId)}" aria-label="Change marking">
          <option value="auto"${current === "auto" ? " selected" : ""}>Automatic</option>
          <option value="correct"${current === "correct" ? " selected" : ""}>Mark correct</option>
          <option value="incorrect"${current === "incorrect" ? " selected" : ""}>Mark incorrect</option>
        </select></div>`;
    }
    return `<tr>
      <td>${d.position}</td>
      <td>${escapeHtml(q.text)}${q.lessonTitle && quiz?.merged ? `<div class="small muted">${escapeHtml(q.lessonTitle)}</div>` : ""}${q.explanation ? `<div class="small muted">${escapeHtml(q.explanation)}</div>` : ""}</td>
      <td>${given}</td>
      <td>${correct}</td>
      <td>${resultCell}</td>
      <td class="num">${d.marksAwarded} / ${d.marks}</td>
    </tr>`;
  }).join("");
  if (g.missingQuestions.length) {
    $("answersBody").insertAdjacentHTML("beforeend", `<tr><td colspan="6" class="small error-text">${g.missingQuestions.length} question(s) this student saw are no longer in the answer key and were not counted: ${g.missingQuestions.map(escapeHtml).join(", ")}</td></tr>`);
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
    <p class="small muted">Only what the browser could detect. Not proof of cheating, and phones or other devices are not detected.</p>`;
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
    note("Marking changed and saved.", "success");
  } catch (err) {
    note(`Could not save. ${friendlyError(err)}`, "error");
  }
}

const record = () => ({ id: attempt.id, attempt, result });

$("actions").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  btn.closest("details")?.removeAttribute("open");
  btn.disabled = true;
  try {
    await ACTIONS[btn.dataset.act]?.();
  } catch (err) {
    console.error(err);
    note(`The action did not finish. ${friendlyError(err)}`, "error");
  } finally {
    btn.disabled = false;
  }
});

const ACTIONS = {
  async grade() {
    await saveResult(result?.overrides || {});
    render();
    note("Graded and saved.", "success");
  },
  async accept() { await review("accepted"); },
  async pending() { await review("pending"); },
  async decline() {
    const ok = await confirmDialog({ title: "Decline this submission?", text: "It stays in the records but is not graded and is left out of averages and analysis. You can accept it later.", okText: "Decline" });
    if (ok) await review("declined", "Declined by teacher");
  },
  async print() {
    const html = await buildReport([{ id: attempt.id, attempt, result, archived: isArchive }], {
      title: "Quiz report",
      includeAnswers: true,
      quizzes: new Map(quiz ? [[quiz.id, quiz]] : []),
      passPercent: settings.passPercent
    });
    printHtml(html);
  },
  async retake() {
    const ok = await confirmDialog({
      title: "Allow this student to take the quiz again?",
      text: `${attempt.studentName}'s current attempt for "${attempt.quizTitle}" is kept as a previous attempt (it stays in the results and the student history). The student can then start the quiz again with the same details while the quiz is open.`,
      okText: "Allow retake"
    });
    if (!ok) return;
    await allowRetake(record());
    note("Done. The old attempt is kept as a previous attempt, and the student can start again.", "success");
    setTimeout(() => location.replace(historyUrl()), 1200);
  },
  async archive() {
    const ok = await confirmDialog({ title: "Archive this record?", text: "It moves to the Archive tab. Nothing is deleted, and you can restore it at any time.", okText: "Archive" });
    if (!ok) return;
    await archiveRecords([record()]);
    location.replace(`result.html?id=${encodeURIComponent(attempt.id)}&source=archive`);
  },
  async restore() {
    const { renamed } = await restoreRecords([record()]);
    if (renamed) { note("Restored. The student already had a newer attempt for this quiz, so this one was restored under a new ID. Open it from the Results tab.", "success"); return; }
    location.replace(`result.html?id=${encodeURIComponent(attempt.id)}`);
  },
  async delete() {
    const res = await confirmDialog({
      title: isArchive ? "Permanently delete this record?" : "Delete this record?",
      text: "The attempt and its result are permanently removed. This cannot be undone. Archive instead if you may need it later.",
      okText: "Delete", danger: true,
      option: { label: "Download a backup file of this record first (recommended)", checked: true }
    });
    if (!res) return;
    if (res.option) downloadFile(`record_${attempt.id.replace(/[^A-Za-z0-9_.-]+/g, "-")}_backup.json`, buildBackup([record()], source), "application/json");
    await deleteRecords(source, [record()]);
    $("content").hidden = true;
    note("The record was deleted.", "success");
  }
};

async function review(status, text = "") {
  await setReviewStatus([record()], status, text);
  Object.assign(attempt, { reviewStatus: status, reviewedAt: new Date(), reviewNote: text });
  render();
  note(`Marked as ${{ pending: "pending review", accepted: "accepted", declined: "declined" }[status]}.`, "success");
}
