// Student-side Firestore operations for quiz attempts.
// A student writes only to attempts/{attemptId}; rules lock it after submit.

import {
  db, auth, doc, getDoc, getDocFromServer, getDocs, setDoc, updateDoc, collection, query, where,
  serverTimestamp
} from "./firebase.js";
import { withTimeout } from "./utilities.js";

/**
 * Open quizzes for one grade (plus older quizzes that have no grade).
 * Reads only the small list documents, not the questions. The grade is
 * filtered here rather than in the query so that quizzes created before
 * grades existed (no "grade" field at all) are still found. Starting a quiz
 * of another grade is refused by the security rules.
 */
export async function loadActiveQuizzes(grade, section) {
  const snap = await getDocs(query(collection(db, "quizzes"), where("active", "==", true)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((q) => !q.archived && (!q.grade || String(q.grade) === String(grade)))
    // A quiz for some sections only (teachers' quizzes) is shown to those sections.
    .filter((q) => !Array.isArray(q.sections) || !q.sections.length || !section || q.sections.includes(String(section)));
}

/**
 * One quiz with its questions. New quizzes keep questions in
 * quizContent/{id}; older ones have them inside quizzes/{id}.
 * Returns null if the quiz does not exist or is not open.
 */
export async function loadQuiz(quizId) {
  const snap = await getDoc(doc(db, "quizzes", quizId));
  if (!snap.exists()) return null;
  const quiz = { id: snap.id, ...snap.data() };
  if (!Array.isArray(quiz.questions)) {
    const content = await getDoc(doc(db, "quizContent", quizId));
    quiz.questions = content.exists() ? content.data().questions || [] : [];
  }
  return quiz;
}

/**
 * Checks attempts/{attemptId}.
 * Returns { state: "none" } | { state: "mine", attempt } | { state: "taken" }
 * "taken" means someone else (another browser) already started this quiz with
 * the same grade, section and roll number.
 */
export async function checkAttempt(attemptId) {
  try {
    const snap = await getDoc(doc(db, "attempts", attemptId));
    if (!snap.exists()) return { state: "none" };
    return { state: "mine", attempt: { id: snap.id, ...snap.data() } };
  } catch (err) {
    if (err?.code === "permission-denied") return { state: "taken" };
    throw err;
  }
}

export async function createAttempt(attemptId, { quiz, student, order, optionOrder }) {
  const data = {
    uid: auth.currentUser.uid,
    quizId: quiz.id,
    quizTitle: quiz.title,
    studentName: student.name,
    nameLower: student.name.toLowerCase(),
    ...(student.studentId ? { studentId: student.studentId } : {}),
    rollNo: student.roll,
    grade: student.grade,
    section: student.section,
    status: "in_progress",
    questionCount: quiz.questionCount,
    order,
    optionOrder,
    answers: {},
    answeredCount: 0,
    currentIndex: 0,
    focusLossCount: 0,
    fullscreenExitCount: 0,
    events: [],
    startedAt: serverTimestamp(),
    lastSavedAt: serverTimestamp(),
    submittedAt: null
  };
  await withTimeout(setDoc(doc(db, "attempts", attemptId), data), 15000);
  return { id: attemptId, ...data };
}

function progressFields(state) {
  return {
    answers: state.answers,
    answeredCount: Object.values(state.answers).filter((v) => String(v ?? "").trim() !== "").length,
    currentIndex: state.currentIndex,
    focusLossCount: state.focusLossCount,
    fullscreenExitCount: state.fullscreenExitCount,
    events: state.events.slice(-200),
    lastSavedAt: serverTimestamp()
  };
}

/** Saves progress (answers + warnings). One write. */
export async function saveProgress(attemptId, state) {
  await withTimeout(updateDoc(doc(db, "attempts", attemptId), progressFields(state)), 15000);
}

/**
 * Final submission in ONE write. If the first try times out but actually
 * reached the server, a retry is denied by the rules (attempt already
 * submitted), so we re-read the attempt to confirm instead of failing.
 */
export async function submitAttempt(attemptId, state) {
  const ref = doc(db, "attempts", attemptId);
  try {
    await withTimeout(updateDoc(ref, {
      ...progressFields(state),
      status: "submitted",
      submittedAt: serverTimestamp()
    }), 20000);
    return { ok: true };
  } catch (err) {
    try {
      // Must ask the server: the local cache would already show our pending write.
      const snap = await withTimeout(getDocFromServer(ref), 10000);
      if (snap.exists() && snap.data().status === "submitted") return { ok: true, alreadySubmitted: true };
    } catch { /* fall through */ }
    throw err;
  }
}
