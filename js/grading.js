// Grading. Runs ONLY in the authenticated teacher dashboard: it needs the
// answer key, which Firestore rules allow only the teacher to read.

import {
  db, doc, getDoc, writeBatch, serverTimestamp, auth
} from "./firebase.js";
import { round } from "./utilities.js";
import { signalClasses } from "./live.js";

const keyCache = new Map();

/** Loads answerKeys/{quizId} once per dashboard session. */
export async function loadAnswerKey(quizId, { refresh = false } = {}) {
  if (!refresh && keyCache.has(quizId)) return keyCache.get(quizId);
  const snap = await getDoc(doc(db, "answerKeys", quizId));
  const key = snap.exists() ? { id: snap.id, ...snap.data() } : null;
  keyCache.set(quizId, key);
  return key;
}

export function clearKeyCache() { keyCache.clear(); }

/** Identifies which version of the answer key a result was graded with. */
export function keyStamp(key) {
  const t = key?.importedAt?.toMillis ? key.importedAt.toMillis() : 0;
  return `${key?.version ?? "1"}-${t}`;
}

export function normalizeText(value, { caseSensitive = false, trimWhitespace = true } = {}) {
  let s = String(value ?? "");
  if (trimWhitespace) s = s.trim().replace(/\s+/g, " ");
  if (!caseSensitive) s = s.toLowerCase();
  return s;
}

/**
 * True when `given` is a correct answer to the answer-key question `kq`.
 * The ONE place answers are checked: student grading (gradeAttempt) and
 * Live Classroom Mode both use it, so they always agree.
 *   mcq / true_false: the chosen option id equals correctOptionId
 *   short_answer: matches one accepted answer (case and spaces as configured)
 */
export function isCorrectAnswer(kq, given) {
  if (!kq || !isAnswered(given)) return false;
  if (kq.type === "short_answer") {
    const opts = { caseSensitive: kq.caseSensitive === true, trimWhitespace: kq.trimWhitespace !== false };
    const g = normalizeText(given, opts);
    return (kq.acceptedAnswers || []).some((a) => normalizeText(a, opts) === g);
  }
  return String(given) === String(kq.correctOptionId);
}

function isAnswered(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/**
 * Pure function: compares one attempt with the answer key.
 * overrides: { [questionId]: true | false } set by the teacher by hand
 * (mainly for short answers with spelling mistakes).
 */
export function gradeAttempt(attempt, key, overrides = {}, defaultPassPercent = 40) {
  const keyById = new Map((key?.questions || []).map((q) => [q.id, q]));
  const answers = attempt.answers || {};
  const order = Array.isArray(attempt.order) && attempt.order.length ? attempt.order : [...keyById.keys()];

  let obtained = 0, total = 0, correctCount = 0, incorrectCount = 0, unansweredCount = 0;
  const details = [];
  const missing = [];

  order.forEach((qid, position) => {
    const kq = keyById.get(qid);
    if (!kq) { missing.push(qid); return; }
    const given = answers[qid];
    const answered = isAnswered(given);
    let correct = answered && isCorrectAnswer(kq, given);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, qid) && answered;
    if (overridden) correct = overrides[qid] === true;

    const marks = Number(kq.marks) || 1;
    total += marks;
    if (!answered) unansweredCount++;
    else if (correct) { correctCount++; obtained += marks; }
    else incorrectCount++;

    const optionText = (id) => (kq.options || []).find((o) => o.id === id)?.text ?? "";
    details.push({
      questionId: qid,
      position: position + 1,
      type: kq.type || "mcq",
      // Stored so results stay readable and printable even if the quiz is
      // later deleted or archived.
      text: kq.text || "",
      lessonId: kq.lessonId || "",
      lessonTitle: kq.lessonTitle || "",
      given: answered ? String(given) : null,
      givenText: answered ? (kq.type === "short_answer" ? String(given) : optionText(given)) : "",
      correctAnswer: kq.type === "short_answer" ? (kq.acceptedAnswers || []).join(" / ") : optionText(kq.correctOptionId),
      status: !answered ? "unanswered" : correct ? "correct" : "incorrect",
      marks,
      marksAwarded: answered && correct ? marks : 0,
      overridden
    });
  });

  const passPercent = Number(key?.passPercent) > 0 ? Number(key.passPercent) : defaultPassPercent;
  const percentage = total > 0 ? round((obtained / total) * 100, 1) : 0;
  return {
    obtainedMarks: round(obtained, 2),
    totalMarks: round(total, 2),
    percentage,
    correctCount,
    incorrectCount,
    unansweredCount,
    passPercent,
    passed: percentage >= passPercent,
    details,
    missingQuestions: missing
  };
}

/** True if this submitted attempt has no result, or was graded with an older key. */
export function needsGrading(attempt, result, key) {
  if (attempt.status !== "submitted") return false;
  if (!result) return true;
  if (key && result.keyStamp !== keyStamp(key)) return true;
  return false;
}

/** Builds the results/{attemptId} document. */
export function buildResultDoc(attempt, key, overrides, defaultPassPercent) {
  const g = gradeAttempt(attempt, key, overrides, defaultPassPercent);
  return {
    attemptId: attempt.id,
    quizId: attempt.quizId,
    quizTitle: attempt.quizTitle,
    studentName: attempt.studentName,
    nameLower: attempt.nameLower,
    rollNo: attempt.rollNo,
    grade: attempt.grade,
    section: attempt.section,
    ...g,
    overrides: overrides || {},
    keyStamp: keyStamp(key),
    submittedAt: attempt.submittedAt || null,
    focusLossCount: attempt.focusLossCount || 0,
    fullscreenExitCount: attempt.fullscreenExitCount || 0,
    gradedAt: serverTimestamp(),
    gradedBy: auth.currentUser?.email || auth.currentUser?.uid || ""
  };
}

/**
 * Grades the given attempts and writes results/{attemptId}. The result id
 * equals the attempt id, so grading again overwrites instead of duplicating.
 * existingResults: Map attemptId -> result (to keep teacher overrides).
 * Returns { graded, skipped: [{attempt, reason}], results: Map }.
 */
export async function gradeAttempts(attempts, existingResults, defaultPassPercent, onProgress) {
  const skipped = [];
  const written = new Map();
  const toWrite = [];
  for (const attempt of attempts) {
    if (attempt.status !== "submitted") continue;
    const key = await loadAnswerKey(attempt.quizId);
    if (!key) { skipped.push({ attempt, reason: "No answer key for this quiz. Import the question bank again." }); continue; }
    const overrides = existingResults.get(attempt.id)?.overrides || {};
    toWrite.push({ attempt, data: buildResultDoc(attempt, key, overrides, defaultPassPercent) });
  }
  // Firestore batches hold at most 500 writes; use smaller ones.
  for (let i = 0; i < toWrite.length; i += 200) {
    const chunk = toWrite.slice(i, i + 200);
    const batch = writeBatch(db);
    chunk.forEach(({ attempt, data }) => batch.set(doc(db, "results", attempt.id), data));
    await batch.commit();
    signalClasses(chunk.map(({ attempt }) => attempt), "graded");
    chunk.forEach(({ attempt, data }) => written.set(attempt.id, { ...data, id: attempt.id, gradedAt: new Date() }));
    onProgress?.(Math.min(i + chunk.length, toWrite.length), toWrite.length);
  }
  return { graded: written.size, skipped, results: written };
}
