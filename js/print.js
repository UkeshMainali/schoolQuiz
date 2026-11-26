// Print-ready reports. Every report is ONE document, so the browser's print
// dialog ("Save as PDF") produces a single combined PDF.
//
// One builder serves every report, grouped by student (grade + section +
// roll number, never by name):
//   - one attempt with answers      -> individual quiz report (summary first, then answers)
//   - many attempts, no answers     -> results report: per student a quiz table + overall performance
//   - many attempts, with answers   -> answer sheets: per student the summary, then each quiz's answers
// Student history reports use the same builder.

import { loadAnswerKey, gradeAttempt, needsGrading } from "./grading.js";
import { performance, groupByStudent } from "./analytics.js";
import { escapeHtml, formatDateTime, toDate } from "./utilities.js";
import { nameFor, studentFor } from "./students.js";

const REVIEW_LABELS = { accepted: "Accepted", declined: "Declined", pending: "Pending review" };
const fmt = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);
const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/** Detail lines for one record: saved result if current, else calculated now. */
export function recordDetails(attempt, result, key, quiz, passPercent) {
  const current = result && attempt.status === "submitted" && !needsGrading(attempt, result, quiz || key);
  let summary = current ? result : null;
  if (!summary && key) summary = gradeAttempt(attempt, key, result?.overrides || {}, passPercent);
  const keyById = new Map((key?.questions || []).map((q) => [q.id, q]));
  let details = summary?.details || [];
  if (!details.length) {
    // No answer key and no result: show the raw answers.
    details = (attempt.order || Object.keys(attempt.answers || {})).map((qid, i) => ({
      questionId: qid, position: i + 1, given: attempt.answers?.[qid] ?? null, givenText: attempt.answers?.[qid] ?? "",
      correctAnswer: "", status: "unknown", marks: "", marksAwarded: ""
    }));
  }
  details = details.map((d) => {
    const kq = keyById.get(d.questionId);
    let given = d.givenText || d.given || "";
    if (d.given && kq && kq.type !== "short_answer") given = `${d.given}. ${d.givenText || ""}`;
    let correct = d.correctAnswer || "";
    if (kq && kq.type !== "short_answer" && kq.correctOptionId) correct = `${kq.correctOptionId}. ${d.correctAnswer || ""}`;
    return { ...d, text: d.text || kq?.text || d.questionId, lessonTitle: d.lessonTitle || kq?.lessonTitle || "", givenDisplay: given, correctDisplay: correct };
  });
  return { summary, details, graded: !!current };
}

/** Turns { attempt, result } into the fields the report and the performance figures need. */
function toEntry(e, key, quiz, passPercent) {
  const a = e.attempt;
  const computed = recordDetails(a, e.result, key, quiz, passPercent);
  const submitted = a.status === "submitted";
  const grading = !submitted ? "in_progress" : computed.graded ? "graded" : e.result ? "stale" : "ungraded";
  const s = computed.graded ? computed.summary : null;
  return {
    id: e.id || a.id, attempt: a, result: e.result, computed,
    quizId: a.quizId, quizTitle: a.quizTitle || quiz?.title || a.quizId, merged: !!quiz?.merged,
    studentName: nameFor(a), studentId: studentFor(a)?.id || a.studentId || "", rollNo: a.rollNo, grade: a.grade, section: a.section,
    grading, review: submitted ? (a.reviewStatus || "pending") : null,
    obtained: s ? s.obtainedMarks : null, total: s ? s.totalMarks : (computed.summary?.totalMarks ?? quiz?.totalMarks ?? null),
    percentage: s ? s.percentage : null, passed: s ? !!s.passed : null,
    submittedMs: toDate(a.submittedAt)?.getTime() || 0,
    previous: !!a.previousAttempt,
    archived: !!e.archived
  };
}

function statusText(r, perf) {
  if (r.grading === "in_progress") return "In progress";
  const parts = [];
  if (r.grading === "graded") parts.push(r.passed ? "Pass" : "Fail");
  else parts.push(r.grading === "stale" ? "Needs regrading" : "Not graded");
  parts.push(REVIEW_LABELS[r.review]);
  const why = perf?.notCounted(r);
  if (why === "Earlier attempt") parts.push("earlier attempt");
  if (r.archived) parts.push("archived");
  return parts.join(" · ");
}

function marksText(r) {
  if (r.grading === "graded") return `${num(r.obtained)} / ${num(r.total)}`;
  const s = r.computed.summary;
  return s && r.grading !== "in_progress" ? `(${num(s.obtainedMarks)} / ${num(s.totalMarks)})` : "—";
}

function studentHead(g) {
  return `
    <div class="r-student">
      <div class="r-name">${escapeHtml(g.names.join(" / "))}</div>
      <div class="r-meta">
        <span><b>Roll no.</b> ${escapeHtml(g.rollNo)}</span>
        <span><b>Grade</b> ${escapeHtml(g.grade)}</span>
        <span><b>Section</b> ${escapeHtml(g.section)}</span>
      </div>
    </div>`;
}

function statGrid(items) {
  return `<div class="r-stats">${items.map(([label, value, sub]) => `
    <div class="r-stat"><div class="r-stat-label">${escapeHtml(label)}</div><div class="r-stat-value">${escapeHtml(value)}</div>${sub ? `<div class="r-stat-sub">${escapeHtml(sub)}</div>` : ""}</div>`).join("")}</div>`;
}

/** Summary of ONE quiz attempt (individual report). */
function quizSummary(r) {
  const s = r.computed.summary;
  const graded = r.grading === "graded";
  const provisional = !graded && s && r.grading !== "in_progress";
  return `
    <div class="r-quiz-title">${escapeHtml(r.quizTitle)}</div>
    ${statGrid([
      ["Marks obtained", graded ? num(r.obtained) : provisional ? num(s.obtainedMarks) : "—", provisional ? "not final" : ""],
      ["Total marks", fmt(r.total === null ? null : num(r.total))],
      ["Percentage", graded ? `${r.percentage}%` : provisional ? `${s.percentage}%` : "—", provisional ? "not final" : ""],
      ["Status", statusText(r)],
      ["Submitted", r.submittedMs ? formatDateTime(r.attempt.submittedAt) : "Not submitted"]
    ])}
    ${s ? `<div class="r-note">Correct ${s.correctCount} · Incorrect ${s.incorrectCount} · Unanswered ${s.unansweredCount}${graded ? ` · Pass mark ${s.passPercent}%` : ""}</div>` : ""}`;
}

/** Overall performance of one student. */
function overallBlock(perf) {
  const excluded = perf.attempts - perf.counted;
  return `
    <div class="r-subhead">Overall performance</div>
    ${statGrid([
      ["Quizzes attempted", String(perf.attempted)],
      ["Counted", String(perf.counted), perf.pending ? `${perf.finalized} accepted, ${perf.pending} pending review` : perf.counted ? "all accepted" : ""],
      ["Marks", perf.counted ? `${num(perf.obtained)} / ${num(perf.possible)}` : "—"],
      ["Overall percentage", fmt(perf.overallPercent, "%"), "total marks ÷ total possible"],
      ["Average quiz percentage", fmt(perf.averagePercent, "%"), "mean of quiz percentages"]
    ])}
    ${excluded ? `<div class="r-note">${excluded} attempt${excluded === 1 ? " is" : "s are"} not counted (marked "not counted" below): declined, not graded yet, in progress, or an earlier attempt of the same quiz.</div>` : ""}`;
}

function quizTable(rows, perf) {
  return `
    <table class="r-table">
      <thead><tr><th class="r-c-quiz">Quiz</th><th class="r-c-date">Submitted</th><th class="r-c-num">Marks</th><th class="r-c-num">%</th><th class="r-c-status">Status</th></tr></thead>
      <tbody>${rows.map((r) => {
        const why = perf.notCounted(r);
        return `<tr class="${why ? "r-excluded" : ""}">
          <td>${escapeHtml(r.quizTitle)}</td>
          <td class="r-c-date">${r.submittedMs ? escapeHtml(formatDateTime(r.attempt.submittedAt)) : "—"}</td>
          <td class="r-c-num">${escapeHtml(marksText(r))}</td>
          <td class="r-c-num">${r.grading === "graded" ? `${r.percentage}%` : "—"}</td>
          <td class="r-c-status">${escapeHtml(statusText(r, perf))}${why ? `<div class="r-why">Not counted: ${escapeHtml(why.toLowerCase())}</div>` : ""}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
}

/** Question-by-question answers. The thead line repeats on every page the answers continue on. */
function answersBlock(r, label) {
  const { details } = r.computed;
  const items = details.map((d) => {
    const mark = d.status === "correct" ? "✓" : d.status === "incorrect" ? "✗" : d.status === "unanswered" ? "–" : "";
    return `<tr><td>
      <div class="qa">
        <div class="qa-num">${d.position}</div>
        <div class="qa-body">
          <div class="qa-q">${escapeHtml(d.text)}${d.lessonTitle && r.merged ? `<span class="qa-lesson">${escapeHtml(d.lessonTitle)}</span>` : ""}</div>
          <div class="qa-answers">
            <div class="qa-a qa-${d.status}"><span class="qa-label">Student's answer</span>${d.givenDisplay ? escapeHtml(d.givenDisplay) : '<span class="qa-none">No answer</span>'}</div>
            <div class="qa-a"><span class="qa-label">Correct answer</span>${escapeHtml(d.correctDisplay) || '<span class="qa-none">—</span>'}</div>
          </div>
        </div>
        <div class="qa-marks"><span class="qa-mark qa-${d.status}">${mark}</span>${d.marks === "" ? "" : `${num(Number(d.marksAwarded))}<span class="qa-max">/${num(Number(d.marks))}</span>`}</div>
      </div>
    </td></tr>`;
  }).join("");
  return `
    <table class="qa-list">
      <thead><tr><th>${escapeHtml(label)}</th></tr></thead>
      <tbody>${items || '<tr><td class="qa-none">No answers recorded.</td></tr>'}</tbody>
    </table>`;
}

function studentSection(g, includeAnswers) {
  const rows = [...g.rows].sort((a, b) =>
    String(a.quizTitle).localeCompare(String(b.quizTitle), undefined, { numeric: true }) || (a.submittedMs - b.submittedMs));
  const perf = performance(rows);
  const name = g.names.join(" / ");
  if (rows.length === 1) {
    const r = rows[0];
    return `
      <section class="r-group">
        <div class="r-keep">${studentHead(g)}${quizSummary(r)}</div>
        ${includeAnswers ? answersBlock(r, `Answers · ${name} · ${r.quizTitle}`) : ""}
      </section>`;
  }
  return `
    <section class="r-group">
      <div class="r-keep">${studentHead(g)}${overallBlock(perf)}</div>
      <div class="r-subhead">Quizzes</div>
      ${quizTable(rows, perf)}
      ${includeAnswers ? rows.map((r) => `
        <div class="r-attempt">
          <div class="r-keep">
            <div class="r-attempt-title">${escapeHtml(r.quizTitle)} <span>${escapeHtml(marksText(r))}${r.grading === "graded" ? ` · ${r.percentage}%` : ""} · ${escapeHtml(statusText(r, perf))}</span></div>
          </div>
          ${answersBlock(r, `${name} · ${r.quizTitle}`)}
        </div>`).join("") : ""}
    </section>`;
}

/**
 * Builds a report. entries: [{ attempt, result }]. quizzes: Map quizId -> quiz.
 * includeAnswers: add each attempt's questions and answers.
 * Loads each needed answer key once.
 */
export async function buildReport(entries, { title, subtitle = "", quizzes = new Map(), passPercent = 40, includeAnswers = true }) {
  const keys = new Map();
  for (const quizId of new Set(entries.map((e) => e.attempt.quizId))) {
    try { keys.set(quizId, await loadAnswerKey(quizId)); } catch { keys.set(quizId, null); }
  }
  const rows = entries.map((e) => toEntry(e, keys.get(e.attempt.quizId), quizzes.get(e.attempt.quizId), passPercent));
  const groups = groupByStudent(rows);
  const body = groups.map((g) => studentSection(g, includeAnswers)).join("");
  return `
    <div class="print-doc${includeAnswers ? " with-answers" : ""}">
      <header class="print-head">
        <h1>${escapeHtml(title)}</h1>
        <div>${subtitle ? `${escapeHtml(subtitle)} · ` : ""}${groups.length} student${groups.length === 1 ? "" : "s"} · ${entries.length} attempt${entries.length === 1 ? "" : "s"} · Printed ${escapeHtml(formatDateTime(new Date()))}</div>
      </header>
      ${body}
    </div>`;
}

/** Puts the report on the page and opens the browser print dialog. */
export function printHtml(html) {
  let root = document.getElementById("printRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "printRoot";
    document.body.appendChild(root);
  }
  root.innerHTML = html;
  document.documentElement.classList.add("printing");
  const cleanup = () => {
    document.documentElement.classList.remove("printing");
    root.innerHTML = "";
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Give the browser a moment to lay out a long report before printing.
  setTimeout(() => window.print(), 50);
}
