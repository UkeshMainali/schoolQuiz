// One student record (result.html?id=<attemptId>[&source=archive]). Staff only.
// Shows marks, answers and activity, and offers the per-record actions:
// grade / recalculate, accept / decline / pending review and allow retake
// (keeps the old attempt) for the Admin and the class's teachers; print,
// archive / restore and delete for the Admin only (teachers send a request).
// firestore.rules decide what can really be read or changed.

import { db, doc, getDoc, setDoc, onSnapshot } from "./firebase.js";
import { watchStaff } from "./auth.js";
import { signalClasses } from "./live.js";
import { isAdmin, NO_PERMISSION } from "./roles.js";
import { lookupStudent } from "./students.js";
import { openRequestDialog } from "./requests.js";
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
  context_menu: "Tried to open the right-click menu",
  windows_key: "Pressed the Windows key",
  switch_shortcut: "Pressed Alt+Tab or another switch shortcut",
  alt_shortcut: "Pressed an Alt shortcut",
  function_key: "Pressed a function key (F1 to F12)",
  tab_key: "Pressed Tab",
  ctrl_shortcut: "Pressed a Ctrl shortcut",
  shortcut_c: "Tried to copy (Ctrl+C)",
  shortcut_v: "Tried to paste (Ctrl+V)",
  shortcut_x: "Tried to cut (Ctrl+X)",
  shortcut_a: "Tried to select everything (Ctrl+A)",
  shortcut_p: "Tried to print (Ctrl+P)",
  shortcut_s: "Tried to save the page (Ctrl+S)",
  shortcut_u: "Tried to view the page code (Ctrl+U)"
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

watchStaff(() => {
  document.body.classList.toggle("is-admin", isAdmin());
  if (isArchive && !isAdmin()) { fail(NO_PERMISSION); return; }
  load();
}, () => { location.replace("dashboard.html"); });

/** The student's current registered name (null if not registered or not visible). */
async function currentStudent(a) {
  try {
    if (a.studentId) {
      const s = await getDoc(doc(db, "students", a.studentId));
      if (s.exists()) return { id: s.id, ...s.data() };
    }
    const found = await lookupStudent(a.grade, a.section, a.rollNo);
    if (found.state === "found" && (!a.studentId || found.student.id === a.studentId)) {
      return { id: found.student.id, name: found.student.name, grade: a.grade, section: a.section, rollNo: a.rollNo };
    }
  } catch (err) {
    console.warn("Student not loaded", err);
  }
  return null;
}
let student = null;

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
    // A missing or unreadable answer key (e.g. the quiz was deleted) must not
    // hide the record: the saved result still holds every answer.
    [key, student] = await Promise.all([
      loadAnswerKey(attempt.quizId, { refresh: true }).catch((err) => { console.warn("Answer key not readable", err); return null; }),
      currentStudent(attempt)
    ]);
    render();
    watchRecord(cols);
  } catch (err) {
    console.error(err);
    fail(`Could not load this record. ${friendlyError(err)}`);
  }
}

/**
 * Live updates: when the student submits, or someone else grades or reviews
 * this record, the page updates by itself (2 documents are watched).
 */
let watching = false;
function watchRecord(cols) {
  if (watching) return;
  watching = true;
  let firstA = true, firstR = true;
  const busy = () => document.activeElement?.classList.contains("override") || document.querySelector(".modal-backdrop, details.menu[open]");
  const rerender = () => {
    if (busy()) { setTimeout(rerender, 2000); return; }
    render();
  };
  onSnapshot(doc(db, cols.attempts, attemptId), (snap) => {
    if (firstA) { firstA = false; return; }
    if (snap.metadata.hasPendingWrites) return;
    if (!snap.exists()) { note(isArchive ? "This record was restored or deleted." : "This record was archived, deleted or moved for a retake.", "warning"); return; }
    attempt = { id: snap.id, ...snap.data() };
    rerender();
  }, (err) => console.warn("Live record updates stopped", err));
  onSnapshot(doc(db, cols.results, attemptId), (snap) => {
    if (firstR) { firstR = false; return; }
    if (snap.metadata.hasPendingWrites) return;
    result = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    rerender();
  }, (err) => console.warn("Live result updates stopped", err));
}

function fail(message) {
  $("loading").hidden = true;
  showNotice($("notice"), message, "error");
}

function note(text, type = "info") { showNotice($("notice"), text, type); }

const historyUrl = () => student?.id ? `dashboard.html#student=${encodeURIComponent(student.id)}` : historyLink(attempt.grade, attempt.section, attempt.rollNo);
const shownName = () => student?.name || attempt.studentName || "";

function render() {
  $("loading").hidden = true;
  $("content").hidden = false;
  document.title = `${shownName()} – Result`;
  $("studentName").textContent = shownName();
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

  if (!key) note(result?.details?.length
    ? "The answer key of this quiz is not available (the quiz may have been deleted). The answers saved when it was graded are shown."
    : "The answer key for this quiz is missing, so it cannot be graded. Add the question bank again on the Quizzes tab.", "warning");
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
    ...(student?.name && attempt.studentName && student.name !== attempt.studentName ? [["Name typed at the time", attempt.studentName]] : []),
    ...(student?.id ? [["Student ID", student.id]] : []),
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
  if (isAdmin()) {
    more.push(m(isArchive ? "restore" : "archive", isArchive ? "Restore to results" : "Archive"));
    more.push(m("delete", isArchive ? "Delete permanently…" : "Delete…", "danger"));
  } else {
    more.push(m("request", "Ask the Admin…"));
  }
  $("actions").innerHTML = `
    ${review_.length ? `<div class="action-group">${review_.join("")}</div>` : ""}
    <div class="action-group">
      ${isAdmin() ? b("print", "Print report") : ""}
      <a class="btn" href="${historyUrl()}">Student record</a>
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
  if (!g && result?.details?.length) { renderSavedAnswers(result); return; }
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

/** The answers as saved when the test was graded (used when the answer key is gone). */
function renderSavedAnswers(r) {
  const badge = { correct: '<span class="badge badge-success">Correct</span>', incorrect: '<span class="badge badge-danger">Incorrect</span>', unanswered: '<span class="badge">Unanswered</span>' };
  $("answersBody").innerHTML = r.details.map((d) => `<tr>
    <td>${escapeHtml(d.position)}</td>
    <td>${escapeHtml(d.text || d.questionId)}</td>
    <td>${d.given === null ? '<span class="muted">—</span>' : escapeHtml(d.type === "short_answer" ? d.givenText : `${d.given}. ${d.givenText}`)}</td>
    <td>${escapeHtml(d.correctAnswer)}</td>
    <td>${badge[d.status] || ""}${d.overridden ? ' <span class="small muted">(changed by teacher)</span>' : ""}</td>
    <td class="num">${escapeHtml(d.marksAwarded)} / ${escapeHtml(d.marks)}</td>
  </tr>`).join("");
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
    <p class="small muted">Browser-detected only. Not proof of cheating.</p>`;
}

async function saveResult(overrides) {
  const data = buildResultDoc(attempt, key, overrides, settings.passPercent);
  await setDoc(doc(db, "results", attempt.id), data);
  signalClasses([attempt], "graded");
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
    const ok = await confirmDialog({ title: "Decline this submission?", text: "It is left out of grades and averages. You can accept it later.", okText: "Decline" });
    if (ok) await review("declined", "Declined by teacher");
  },
  async request() {
    await openRequestDialog({
      types: ["print_records", "export_records", "archive_records", "delete_records", "rename_student", "other"],
      records: [{ id: attempt.id, studentName: shownName(), quizTitle: attempt.quizTitle, grade: attempt.grade, section: attempt.section, rollNo: attempt.rollNo }]
    });
  },
  async print() {
    if (!isAdmin()) { note(NO_PERMISSION, "error"); return; }
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
      text: `The current attempt is kept as a previous attempt.`,
      okText: "Allow retake"
    });
    if (!ok) return;
    await allowRetake(record());
    note("Done. The old attempt is kept as a previous attempt, and the student can start again.", "success");
    setTimeout(() => location.replace(historyUrl()), 1200);
  },
  async archive() {
    if (!isAdmin()) { note(NO_PERMISSION, "error"); return; }
    const ok = await confirmDialog({ title: "Archive this record?", text: "You can restore it later.", okText: "Archive" });
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
    if (!isAdmin()) { note(NO_PERMISSION, "error"); return; }
    const res = await confirmDialog({
      title: isArchive ? "Permanently delete this record?" : "Delete this record?",
      text: "This cannot be undone.",
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
