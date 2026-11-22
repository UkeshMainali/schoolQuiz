// Simple performance summaries for the teacher dashboard. Pure functions that
// work on the merged result rows built in dashboard.js.

import { round } from "./utilities.js";

/** Only rows with a current grade count towards marks statistics. */
export const gradedRows = (rows) => rows.filter((r) => r.status === "graded");

function stats(values) {
  if (!values.length) return { count: 0, avg: null, max: null, min: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: values.length, avg: round(sum / values.length, 1), max: Math.max(...values), min: Math.min(...values) };
}

export function studentKey(r) {
  return `${r.grade}|${r.section}|${r.rollNo}`;
}

/**
 * Overview numbers. When every row belongs to one quiz, marks are shown;
 * otherwise percentages (marks from different quizzes cannot be compared).
 */
export function overview(rows) {
  const graded = gradedRows(rows);
  const singleQuiz = new Set(rows.map((r) => r.quizId)).size <= 1;
  const values = graded.map((r) => (singleQuiz ? r.obtained : r.percentage));
  const s = stats(values);
  return {
    totalStudents: new Set(rows.map(studentKey)).size,
    totalSubmissions: rows.filter((r) => r.status !== "in_progress").length,
    inProgress: rows.filter((r) => r.status === "in_progress").length,
    ungraded: rows.filter((r) => r.status === "ungraded").length,
    graded: graded.length,
    unit: singleQuiz ? "marks" : "percent",
    totalMarks: singleQuiz && graded.length ? graded[0].total : null,
    average: s.avg,
    highest: s.max,
    lowest: s.min,
    passed: graded.filter((r) => r.passed).length,
    failed: graded.filter((r) => !r.passed).length
  };
}

/** Grouped table: [{ label, students, submitted, avg, max, min, passed, failed, avgPercent }] */
export function groupBy(rows, keyFn, labelFn = (k) => k) {
  const groups = new Map();
  rows.forEach((r) => {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  return [...groups.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .map(([key, list]) => {
      const graded = gradedRows(list);
      const marks = stats(graded.map((r) => r.obtained));
      const pct = stats(graded.map((r) => r.percentage));
      return {
        key,
        label: labelFn(key),
        students: new Set(list.map(studentKey)).size,
        submitted: list.filter((r) => r.status !== "in_progress").length,
        graded: graded.length,
        avg: marks.avg, max: marks.max, min: marks.min,
        avgPercent: pct.avg,
        passed: graded.filter((r) => r.passed).length,
        failed: graded.filter((r) => !r.passed).length
      };
    });
}

/** Number of graded students in each percentage band. */
export function scoreBands(rows) {
  const bands = [
    { label: "90–100%", min: 90, max: 101 },
    { label: "75–89%", min: 75, max: 90 },
    { label: "60–74%", min: 60, max: 75 },
    { label: "40–59%", min: 40, max: 60 },
    { label: "Below 40%", min: -1, max: 40 }
  ];
  const graded = gradedRows(rows);
  return bands.map((b) => ({ ...b, count: graded.filter((r) => r.percentage >= b.min && r.percentage < b.max).length }));
}

/**
 * Per-question results for one quiz (from the saved result details):
 * [{ questionId, text, correct, incorrect, unanswered, percentCorrect }]
 * sorted hardest first.
 */
export function questionStats(rows, answerKey) {
  const textById = new Map((answerKey?.questions || []).map((q) => [q.id, q.text]));
  const map = new Map();
  gradedRows(rows).forEach((r) => {
    (r.details || []).forEach((d) => {
      if (!map.has(d.questionId)) map.set(d.questionId, { questionId: d.questionId, correct: 0, incorrect: 0, unanswered: 0 });
      map.get(d.questionId)[d.status]++;
    });
  });
  return [...map.values()].map((q) => {
    const n = q.correct + q.incorrect + q.unanswered;
    return { ...q, text: textById.get(q.questionId) || q.questionId, percentCorrect: n ? round((q.correct / n) * 100, 0) : 0 };
  }).sort((a, b) => a.percentCorrect - b.percentCorrect);
}
