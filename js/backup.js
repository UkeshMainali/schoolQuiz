// Backup files (JSON) and CSV export for student records.
//
// Backup format (schemaVersion 2.0):
// {
//   "format": "classroom-quiz-backup",
//   "schemaVersion": "2.0",
//   "exportedAt": "2026-11-23T10:00:00.000Z",
//   "source": "active" | "archive",
//   "count": 2,
//   "records": [ { "id": "<attempt id>", "attempt": { ... }, "result": { ... } | null } ]
// }
// Firestore timestamps are written as { "__timestamp": "<ISO date>" } and
// turned back into timestamps on import, so original dates are kept.

import { Timestamp } from "./firebase.js";
import { toCsv, toDate } from "./utilities.js";
import { loadAnswerKey } from "./grading.js";
import { recordDetails } from "./print.js";

export const BACKUP_FORMAT = "classroom-quiz-backup";
export const BACKUP_VERSION = "2.0";
const ID_RE = /^[^/]{1,1400}$/;

function encode(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value.toDate === "function" && typeof value.toMillis === "function") return { __timestamp: value.toDate().toISOString() };
  if (value instanceof Date) return { __timestamp: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (k !== "id") out[k] = encode(v);
    return out;
  }
  return value;
}

function decode(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === "object") {
    if (typeof value.__timestamp === "string" && Object.keys(value).length === 1) {
      const d = new Date(value.__timestamp);
      return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

/** records: [{ id, attempt, result }] -> JSON string */
export function buildBackup(records, source) {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source,
    count: records.length,
    records: records.map((r) => ({ id: r.id, attempt: encode(r.attempt), result: r.result ? encode(r.result) : null }))
  }, null, 1);
}

/**
 * Validates a backup file. Returns { records, skipped: [reason], meta, error }.
 * Records keep their original ids, timestamps and answers.
 */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, "")); }
  catch (e) { return { error: `This is not a valid JSON file (${e.message}).` }; }
  if (!data || data.format !== BACKUP_FORMAT) {
    return { error: "This file is not a Classroom Quiz results backup. (Question banks are imported on the Quizzes tab.)" };
  }
  const major = String(data.schemaVersion || "").split(".")[0];
  if (major !== "2") return { error: `Backup version "${data.schemaVersion}" is not supported by this version of the app.` };
  if (!Array.isArray(data.records)) return { error: "The backup has no records list." };

  const records = [];
  const skipped = [];
  const seen = new Set();
  data.records.forEach((r, i) => {
    const label = `Record ${i + 1}${r && r.id ? ` (${r.id})` : ""}`;
    if (!r || typeof r.id !== "string" || !ID_RE.test(r.id)) { skipped.push(`${label}: missing or invalid id.`); return; }
    if (seen.has(r.id)) { skipped.push(`${label}: appears twice in the file.`); return; }
    const a = r.attempt;
    if (!a || typeof a !== "object" || !a.quizId || !a.studentName || a.rollNo === undefined || !a.grade || !a.section) {
      skipped.push(`${label}: student or quiz information is missing.`);
      return;
    }
    seen.add(r.id);
    records.push({ id: r.id, attempt: decode(a), result: r.result ? decode(r.result) : null });
  });
  return { records, skipped, meta: { exportedAt: data.exportedAt, source: data.source, count: data.count } };
}

// ------------------------------------------------------------------- CSV
//
// Two CSV exports, both one row per line with a header row:
//   Summary  - one row per attempt: student, quiz, marks, percentage, statuses.
//   Detailed - one row per question per attempt: the summary columns repeated
//              on every row, then the question, both answers and the marks.
//              "Attempt ID" ties the rows of one submission together, and
//              "Student ID" (grade-section-roll) ties a student's attempts together.

const csvDate = (value) => {
  const d = toDate(value);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const studentId = (r) => `${r.grade}-${r.section}-${r.rollNo}`;
const summaryColumns = ["Student ID", "Student name", "Roll no.", "Grade", "Section", "Quiz ID", "Quiz", "Attempt ID", "Submitted at",
  "Marks obtained", "Total marks", "Percentage", "Result", "Grading status", "Review status"];
const summaryCells = (r) => [
  studentId(r), r.studentName, r.rollNo, r.grade, r.section, r.quizId, r.quizTitle, r.id,
  r.submittedMs ? csvDate(r.attempt.submittedAt) : "",
  r.obtained ?? "", r.total ?? "", r.percentage ?? "", r.passed === null ? "" : r.passed ? "Pass" : "Fail",
  r.gradingLabel, r.reviewLabel
];

/** Summary CSV: one row per attempt, no questions or answers. rows: dashboard rows. */
export function summaryCsv(rows) {
  return toCsv([summaryColumns, ...rows.map(summaryCells)]);
}

/** Detailed CSV: one row per question of every attempt. Loads each answer key once. */
export async function detailedCsv(rows, { quizzes = new Map(), passPercent = 40 } = {}) {
  const keys = new Map();
  for (const quizId of new Set(rows.map((r) => r.quizId))) {
    try { keys.set(quizId, await loadAnswerKey(quizId)); } catch { keys.set(quizId, null); }
  }
  const out = [[...summaryColumns, "Question no.", "Question ID", "Lesson", "Question", "Student's answer", "Correct answer",
    "Question result", "Marks awarded", "Maximum marks"]];
  rows.forEach((r) => {
    const { details } = recordDetails(r.attempt, r.result, keys.get(r.quizId), quizzes.get(r.quizId), passPercent);
    const base = summaryCells(r);
    if (!details.length) { out.push([...base, "", "", "", "", "", "", "", "", ""]); return; }
    details.forEach((d) => out.push([
      ...base, d.position, d.questionId, d.lessonTitle || "", d.text, d.givenDisplay, d.correctDisplay,
      { correct: "Correct", incorrect: "Incorrect", unanswered: "Unanswered" }[d.status] || "", d.marksAwarded, d.marks
    ]));
  });
  return toCsv(out);
}
