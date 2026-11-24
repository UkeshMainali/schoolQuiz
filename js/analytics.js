// Performance summaries for the teacher dashboard. Pure functions over the
// result rows built in recordsView.js.
//
// Only GRADED submissions that were NOT DECLINED count towards marks.
// Marks are only averaged within one quiz; across quizzes the percentage is
// used, because quizzes have different numbers of questions and marks.

import { round } from "./utilities.js";

export const countable = (rows) => rows.filter((r) => r.grading === "graded" && r.review !== "declined");
export const studentKey = (r) => `${r.grade}|${r.section}|${r.rollNo}`;

function stats(values) {
  if (!values.length) return { count: 0, avg: null, max: null, min: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: values.length, avg: round(sum / values.length, 1), max: round(Math.max(...values), 1), min: round(Math.min(...values), 1) };
}

const singleQuiz = (rows) => new Set(rows.map((r) => r.quizId)).size <= 1;

export function overview(rows) {
  const graded = countable(rows);
  const one = singleQuiz(rows);
  const marks = stats(graded.map((r) => (one ? r.obtained : r.percentage)));
  const pct = stats(graded.map((r) => r.percentage));
  return {
    totalStudents: new Set(rows.map(studentKey)).size,
    totalSubmissions: rows.filter((r) => r.submitted).length,
    inProgress: rows.filter((r) => !r.submitted).length,
    declined: rows.filter((r) => r.review === "declined").length,
    ungraded: rows.filter((r) => r.submitted && r.review !== "declined" && r.grading !== "graded").length,
    graded: graded.length,
    unit: one ? "marks" : "percent",
    totalMarks: one && graded.length ? graded[0].total : null,
    average: marks.avg,
    highest: marks.max,
    lowest: marks.min,
    avgPercent: pct.avg,
    highestPercent: pct.max,
    lowestPercent: pct.min,
    passed: graded.filter((r) => r.passed).length,
    failed: graded.filter((r) => !r.passed).length
  };
}

/** Grouped summary: [{ key, label, students, submitted, graded, avgMarks, totalMarks, avgPercent, max, min, passed, failed }] */
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
      const graded = countable(list);
      const pct = stats(graded.map((r) => r.percentage));
      const one = singleQuiz(list);
      const marks = one ? stats(graded.map((r) => r.obtained)) : null;
      return {
        key,
        label: labelFn(key, list),
        students: new Set(list.map(studentKey)).size,
        submitted: list.filter((r) => r.submitted).length,
        graded: graded.length,
        avgMarks: marks ? marks.avg : null,
        totalMarks: one && graded.length ? graded[0].total : null,
        avgPercent: pct.avg,
        max: pct.max,
        min: pct.min,
        passed: graded.filter((r) => r.passed).length,
        failed: graded.filter((r) => !r.passed).length
      };
    });
}

/** Per student across quizzes: [{ key, name, rollNo, grade, section, attempted, completed, avgPercent, best, worst }] */
export function studentStats(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const k = studentKey(r);
    if (!map.has(k)) map.set(k, { key: k, names: new Set(), rollNo: r.rollNo, grade: r.grade, section: r.section, rows: [] });
    const s = map.get(k);
    s.names.add(r.studentName);
    s.rows.push(r);
  });
  return [...map.values()].map((s) => {
    const graded = countable(s.rows);
    const pct = stats(graded.map((r) => r.percentage));
    return {
      key: s.key, name: [...s.names].join(" / "), rollNo: s.rollNo, grade: s.grade, section: s.section,
      attempted: new Set(s.rows.map((r) => r.quizId)).size,
      completed: new Set(s.rows.filter((r) => r.submitted).map((r) => r.quizId)).size,
      graded: graded.length, avgPercent: pct.avg, best: pct.max, worst: pct.min
    };
  }).sort((a, b) => String(a.grade).localeCompare(String(b.grade), undefined, { numeric: true }) ||
    String(a.section).localeCompare(String(b.section)) || Number(a.rollNo) - Number(b.rollNo));
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
  const graded = countable(rows);
  return bands.map((b) => ({ ...b, count: graded.filter((r) => r.percentage >= b.min && r.percentage < b.max).length }));
}

/**
 * Per question (from saved result details), keyed by quiz + question:
 * [{ quizId, questionId, text, lesson, correct, incorrect, unanswered, answered, percentCorrect }]
 */
export function questionStats(rows) {
  const map = new Map();
  countable(rows).forEach((r) => {
    (r.details || []).forEach((d) => {
      const k = `${r.quizId}/${d.questionId}`;
      if (!map.has(k)) map.set(k, { quizId: r.quizId, quizTitle: r.quizTitle, questionId: d.questionId, text: d.text || d.questionId, lesson: d.lessonTitle || "", correct: 0, incorrect: 0, unanswered: 0 });
      const q = map.get(k);
      if (d.status in q) q[d.status]++;
    });
  });
  return [...map.values()].map((q) => {
    const n = q.correct + q.incorrect + q.unanswered;
    return { ...q, responses: n, percentCorrect: n ? round((q.correct / n) * 100, 0) : 0 };
  });
}

/**
 * Per lesson: share of marks earned on that lesson's questions. Questions of
 * single-lesson quizzes created before lesson tracking count under the quiz.
 */
export function lessonStats(rows) {
  const map = new Map();
  countable(rows).forEach((r) => {
    (r.details || []).forEach((d) => {
      const label = d.lessonTitle || r.quizTitle;
      if (!map.has(label)) map.set(label, { lesson: label, earned: 0, possible: 0, questions: new Set(), students: new Set() });
      const l = map.get(label);
      l.earned += Number(d.marksAwarded) || 0;
      l.possible += Number(d.marks) || 0;
      l.questions.add(`${r.quizId}/${d.questionId}`);
      l.students.add(studentKey(r));
    });
  });
  return [...map.values()].map((l) => ({
    lesson: l.lesson, questions: l.questions.size, students: l.students.size,
    percent: l.possible ? round((l.earned / l.possible) * 100, 1) : 0
  })).sort((a, b) => a.percent - b.percent);
}

/**
 * Overall performance of ONE student (rows already grouped by studentKey).
 * Rows need: id, quizId, grading, review, obtained, total, percentage, submittedMs.
 *
 * Counted = graded with the current answer key AND not declined (the same
 * rule as everywhere else). If a student has more than one counted attempt
 * for the same quiz (a retake), only the latest one counts, so a quiz is
 * never counted twice.
 *   overallPercent = total obtained / total possible x 100   (weighted by marks)
 *   averagePercent = mean of the counted quiz percentages     (each quiz equal)
 */
export function performance(rows) {
  const eligible = rows.filter((r) => r.grading === "graded" && r.review !== "declined" && r.total > 0);
  const latest = new Map();
  eligible.forEach((r) => {
    const cur = latest.get(r.quizId);
    if (!cur || (r.submittedMs || 0) > (cur.submittedMs || 0)) latest.set(r.quizId, r);
  });
  const counted = [...latest.values()];
  const countedIds = new Set(counted.map((r) => r.id));
  const obtained = counted.reduce((s, r) => s + Number(r.obtained || 0), 0);
  const possible = counted.reduce((s, r) => s + Number(r.total || 0), 0);
  const notCounted = (r) => {
    if (countedIds.has(r.id)) return "";
    if (r.grading === "in_progress") return "In progress";
    if (r.review === "declined") return "Declined";
    if (r.grading !== "graded") return r.grading === "stale" ? "Needs regrading" : "Not graded";
    return "Earlier attempt";
  };
  return {
    attempted: new Set(rows.map((r) => r.quizId)).size,
    attempts: rows.length,
    countedIds,
    counted: counted.length,
    finalized: counted.filter((r) => r.review === "accepted").length,
    pending: counted.filter((r) => r.review !== "accepted").length,
    obtained: round(obtained, 2),
    possible: round(possible, 2),
    overallPercent: possible ? round((obtained / possible) * 100, 1) : null,
    averagePercent: counted.length ? round(counted.reduce((s, r) => s + Number(r.percentage || 0), 0) / counted.length, 1) : null,
    notCounted
  };
}

/** Groups rows by student (grade + section + roll number, never by name). */
export function groupByStudent(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const k = studentKey(r);
    if (!map.has(k)) map.set(k, { key: k, grade: r.grade, section: r.section, rollNo: r.rollNo, names: [], rows: [] });
    const g = map.get(k);
    if (!g.names.includes(r.studentName)) g.names.push(r.studentName);
    g.rows.push(r);
  });
  return [...map.values()].sort((a, b) =>
    String(a.grade).localeCompare(String(b.grade), undefined, { numeric: true }) ||
    String(a.section).localeCompare(String(b.section), undefined, { numeric: true }) ||
    Number(a.rollNo) - Number(b.rollNo));
}
