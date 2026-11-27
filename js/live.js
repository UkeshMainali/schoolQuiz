// Live updates for the dashboard: the page updates by itself when students
// start or submit a quiz, or when someone else grades or reviews a record.
//
// Firestore charges one read per document a listener receives, so the
// listeners here are kept small on purpose:
//   - attempts that are IN PROGRESS (status == "in_progress"): a student who
//     starts a quiz is "added", one who submits is "removed". Usually only a
//     handful of documents, and only equality filters, so no extra index.
//   - Admin: the single newest result (gradedAt) and the single newest
//     review (reviewedAt), one document each, to notice grading by teachers.
//   - Teachers: one tiny "signal" document per class, live/{grade_section}.
//     Whoever grades, reviews, archives or deletes records of a class
//     touches it (one write per action, not per record), so a teacher's
//     page updates when the Admin or a co-teacher changes their class.
//     No index is needed for any of these.
// The views then re-read only what they show (see dashboard.js).
//
// Quizzes, settings, students and requests have their own listeners in
// teacherState.js, students.js and requests.js.

import { db, auth, doc, setDoc, serverTimestamp, collection, query, where, orderBy, limit, onSnapshot } from "./firebase.js";
import { session, classPairs } from "./roles.js";

export const live = {
  inProgress: new Map(), // attemptId -> attempt data (students taking a quiz right now)
  status: "connecting",  // "connecting" | "live" | "offline"
  lastChangeAt: null
};

const listeners = new Set();
const unsubs = [];
let started = false;
let offlineSources = new Set();

/** fn(event): { type: "records", ids: [attemptId], why } | { type: "progress" } | { type: "status" } */
export function onLive(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event) {
  if (event.type === "records") live.lastChangeAt = new Date();
  listeners.forEach((fn) => { try { fn(event); } catch (e) { console.error(e); } });
}

function setOnline(source, fromCache) {
  if (fromCache) offlineSources.add(source); else offlineSources.delete(source);
  const next = offlineSources.size ? "offline" : "live";
  if (next !== live.status) { live.status = next; emit({ type: "status" }); }
}

const me = () => [session.name, session.username, auth.currentUser?.email, auth.currentUser?.uid].filter(Boolean);
const ms = (t) => (t?.toMillis ? t.toMillis() : 0);

/** Starts the listeners once, after the profile is known. */
export function startLive() {
  if (started) return;
  started = true;
  const pairs = classPairs({}); // null for the Admin
  const scopes = pairs === null ? [null] : pairs;
  if (!scopes.length) { live.status = "live"; emit({ type: "status" }); return; }
  scopes.forEach((sc, i) => {
    const classFilters = sc ? [where("grade", "==", sc.grade), where("section", "==", sc.section)] : [];
    watchInProgress(`ip${i}`, classFilters);
    if (sc) {
      watchSignal(sc);
    } else {
      watchNewest(`res${i}`, "results", classFilters, "gradedAt", (d) => !me().includes(d.gradedBy || ""));
      watchNewest(`rev${i}`, "attempts", classFilters, "reviewedAt", (d) => !me().includes(d.reviewedBy || ""));
    }
  });
}

const signalKey = (grade, section) => `${grade}_${section}`;

/** Teachers: the class's signal document changed (not by me) -> its records changed. */
function watchSignal(sc) {
  let first = true;
  unsubs.push(onSnapshot(doc(db, "live", signalKey(sc.grade, sc.section)), (snap) => {
    if (first) { first = false; return; }
    if (snap.metadata.hasPendingWrites || !snap.exists()) return;
    const d = snap.data();
    if (d.by === auth.currentUser?.uid) return;
    // Unknown ids: the class's records on screen are re-read.
    emit({ type: "records", ids: [`?_${sc.grade}_${sc.section}_?`], why: d.what || "changed" });
  }, (err) => console.warn("Live class updates stopped:", err?.message || err)));
}

/**
 * Tells other open dashboards that records of these classes changed.
 * pairs: [{ grade, section }]. One small write per class; failures are ignored
 * (the change itself is already saved).
 */
export function signalClasses(pairs, what = "changed") {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const keys = new Set((pairs || []).filter((p) => p && p.grade && p.section).map((p) => signalKey(p.grade, p.section)));
  keys.forEach((key) => {
    setDoc(doc(db, "live", key), { at: serverTimestamp(), by: uid, what: String(what).slice(0, 20) })
      .catch((err) => console.info("Live signal not sent", key, err?.code || err));
  });
}

export function stopLive() {
  unsubs.splice(0).forEach((u) => { try { u(); } catch { /* ignore */ } });
  started = false;
}

function watchInProgress(source, classFilters) {
  let first = true;
  const q = query(collection(db, "attempts"), ...classFilters, where("status", "==", "in_progress"));
  unsubs.push(onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    setOnline(source, snap.metadata.fromCache);
    const ids = [];
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      if (ch.type === "removed") { live.inProgress.delete(id); ids.push(id); }
      else {
        if (ch.type === "added" && !live.inProgress.has(id)) ids.push(id);
        live.inProgress.set(id, { id, ...ch.doc.data() });
      }
    });
    if (first) { first = false; emit({ type: "progress" }); return; }
    if (snap.metadata.hasPendingWrites) return;
    if (ids.length) emit({ type: "records", ids, why: "attempt" });
    else if (snap.docChanges().length) emit({ type: "progress" });
  }, (err) => {
    console.warn("Live updates (quizzes in progress) stopped:", err?.message || err);
    setOnline(source, true);
  }));
}

/** Listens to the newest document by `field` and reports when a new one (not written by me) arrives. */
function watchNewest(source, col, classFilters, field, notMine) {
  let lastKey = null;
  const q = query(collection(db, col), ...classFilters, orderBy(field, "desc"), limit(1));
  unsubs.push(onSnapshot(q, (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    const d = snap.docs[0];
    const key = d ? `${d.id}|${ms(d.data()[field])}` : "";
    const changed = lastKey !== null && key !== lastKey;
    lastKey = key;
    if (changed && d && notMine(d.data())) emit({ type: "records", ids: [d.id], why: col === "results" ? "graded" : "reviewed" });
  }, (err) => {
    // Teachers without the optional composite index: submissions still update live.
    if (err?.code === "failed-precondition") console.info(`Optional index missing for live ${field} updates. ${err.message}`);
    else console.warn(`Live updates (${field}) stopped:`, err?.message || err);
  }));
}

/** Small "Live" pill: green when connected, grey while reconnecting. */
export function liveBadgeHtml() {
  const on = live.status === "live";
  return `<span class="live-dot ${on ? "on" : ""}" aria-hidden="true"></span>${on ? "Live" : live.status === "offline" ? "Reconnecting…" : "Connecting…"}`;
}

