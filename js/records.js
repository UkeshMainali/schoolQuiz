// Teacher-side data access for student records.
//
// A "record" is one quiz attempt plus its result (if graded):
//   active:   attempts/{id}         + results/{id}
//   archived: archivedAttempts/{id} + archivedResults/{id}
// Archiving MOVES a record between these collections; nothing is lost.
//
// Queries use only equality filters (grade, section, quizId, rollNo), which
// Firestore serves from its automatic single-field indexes, so no composite
// index is needed. Results are fetched only for the attempts on screen.

import {
  db, auth, doc, getDocs, collection, query, where, limit, startAfter, writeBatch,
  serverTimestamp, documentId, getCountFromServer, orderBy
} from "./firebase.js";

export const SOURCES = {
  active: { attempts: "attempts", results: "results" },
  archive: { attempts: "archivedAttempts", results: "archivedResults" }
};

// Writes per Firestore batch. The hard limit is 500; staying well below it
// leaves room for the 2-4 writes each record needs.
const BATCH_WRITES = 400;

function scopeFilters(scope = {}) {
  const parts = [];
  if (scope.grade) parts.push(where("grade", "==", String(scope.grade)));
  if (scope.section) parts.push(where("section", "==", String(scope.section)));
  if (scope.quizId) parts.push(where("quizId", "==", scope.quizId));
  if (scope.rollNo) parts.push(where("rollNo", "==", String(scope.rollNo)));
  return parts;
}

/**
 * One page of attempts for a scope, ordered by document id (stable for
 * paging). Returns { items, cursor, hasMore }.
 */
export async function queryAttempts(source, scope, { pageSize = 300, cursor = null } = {}) {
  const parts = [...scopeFilters(scope), orderBy(documentId())];
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(pageSize));
  const snap = await getDocs(query(collection(db, SOURCES[source].attempts), ...parts));
  return {
    items: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    cursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
    hasMore: snap.docs.length === pageSize
  };
}

/** Number of attempts in a scope (1 read per 1000 counted). */
export async function countAttempts(source, scope) {
  const snap = await getCountFromServer(query(collection(db, SOURCES[source].attempts), ...scopeFilters(scope)));
  return snap.data().count;
}

/** Loads documents by id from one collection, 30 ids per query. */
async function getByIds(collectionName, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await getDocs(query(collection(db, collectionName), where(documentId(), "in", chunk)));
    snap.docs.forEach((d) => out.set(d.id, { id: d.id, ...d.data() }));
  }
  return out;
}

export function fetchResults(source, attemptIds) {
  return getByIds(SOURCES[source].results, attemptIds);
}

/** Which of these ids already exist in the active or archived attempts. */
export async function findExistingIds(ids) {
  const [a, b] = await Promise.all([getByIds("attempts", ids), getByIds("archivedAttempts", ids)]);
  return { active: new Set(a.keys()), archive: new Set(b.keys()) };
}

/**
 * Applies operations in batches. ops: [{ type: "set"|"update"|"delete", col, id, data }]
 * grouped per record so that a record is never half moved. Returns the
 * number of records completed; throws with .completed set on failure.
 */
async function runGrouped(groups, onProgress) {
  let done = 0;
  let batch = writeBatch(db);
  let writes = 0;
  let pending = [];
  const commit = async () => {
    if (!writes) return;
    await batch.commit();
    done += pending.length;
    onProgress?.(done, groups.length);
    batch = writeBatch(db);
    writes = 0;
    pending = [];
  };
  try {
    for (const group of groups) {
      if (writes + group.ops.length > BATCH_WRITES) await commit();
      group.ops.forEach((op) => {
        const ref = doc(db, op.col, op.id);
        if (op.type === "set") batch.set(ref, op.data);
        else if (op.type === "update") batch.update(ref, op.data);
        else batch.delete(ref);
      });
      writes += group.ops.length;
      pending.push(group);
    }
    await commit();
  } catch (err) {
    err.completed = done;
    throw err;
  }
  return done;
}

const teacherName = () => auth.currentUser?.email || auth.currentUser?.uid || "";

function stripId(obj) {
  if (!obj) return null;
  const { id, ...rest } = obj; // eslint-disable-line no-unused-vars
  return rest;
}

/** Accept / decline / reset to pending. records: [{ id }] (active only). */
export function setReviewStatus(records, status, note = "") {
  const data = status === "pending"
    ? { reviewStatus: "pending", reviewedAt: serverTimestamp(), reviewedBy: teacherName(), reviewNote: "" }
    : { reviewStatus: status, reviewedAt: serverTimestamp(), reviewedBy: teacherName(), reviewNote: String(note || "").slice(0, 300) };
  return runGrouped(records.map((r) => ({ ops: [{ type: "update", col: "attempts", id: r.id, data }] })));
}

/** Permanently deletes records (attempt + result) from one source. */
export function deleteRecords(source, records, onProgress) {
  const cols = SOURCES[source];
  return runGrouped(records.map((r) => ({
    ops: [{ type: "delete", col: cols.attempts, id: r.id }, { type: "delete", col: cols.results, id: r.id }]
  })), onProgress);
}

/** Moves active records into the archive. records: [{ id, attempt, result }] */
export function archiveRecords(records, onProgress) {
  const stamp = { archivedAt: serverTimestamp(), archivedBy: teacherName() };
  return runGrouped(records.map((r) => ({
    ops: [
      { type: "set", col: "archivedAttempts", id: r.id, data: { ...stripId(r.attempt), ...stamp } },
      ...(r.result ? [{ type: "set", col: "archivedResults", id: r.id, data: stripId(r.result) }] : []),
      { type: "delete", col: "attempts", id: r.id },
      { type: "delete", col: "results", id: r.id }
    ]
  })), onProgress);
}

/**
 * Moves archived records back to the active results. If a student has a new
 * attempt with the same id (they retook the quiz), the restored record gets
 * a new id instead of overwriting anything. Returns { restored, renamed }.
 */
export async function restoreRecords(records, onProgress) {
  const existing = await findExistingIds(records.map((r) => r.id));
  let renamed = 0;
  const groups = records.map((r) => {
    let targetId = r.id;
    if (existing.active.has(r.id)) { targetId = `${r.id}~restored-${Date.now().toString(36)}`; renamed++; }
    const { archivedAt, archivedBy, ...attempt } = stripId(r.attempt); // eslint-disable-line no-unused-vars
    return {
      ops: [
        { type: "set", col: "attempts", id: targetId, data: targetId === r.id ? attempt : { ...attempt, originalId: r.id } },
        ...(r.result ? [{ type: "set", col: "results", id: targetId, data: { ...stripId(r.result), attemptId: targetId } }] : []),
        { type: "delete", col: "archivedAttempts", id: r.id },
        { type: "delete", col: "archivedResults", id: r.id }
      ]
    };
  });
  const restored = await runGrouped(groups, onProgress);
  return { restored, renamed };
}

/**
 * Lets a student take a quiz again while KEEPING the old attempt: the old
 * record is moved to "<id>~<time>" (marked as a previous attempt), which
 * frees the student's slot for a new attempt.
 */
export function allowRetake(record) {
  const newId = `${record.id}~${Date.now().toString(36)}`;
  const mark = { previousAttempt: true, originalId: record.id, retakeAllowedAt: serverTimestamp(), retakeAllowedBy: teacherName() };
  return runGrouped([{
    ops: [
      { type: "set", col: "attempts", id: newId, data: { ...stripId(record.attempt), ...mark } },
      ...(record.result ? [{ type: "set", col: "results", id: newId, data: { ...stripId(record.result), attemptId: newId } }] : []),
      { type: "delete", col: "attempts", id: record.id },
      { type: "delete", col: "results", id: record.id }
    ]
  }]);
}

/** Creates records from a backup file. records: [{ id, attempt, result }] */
export function importRecords(target, records, onProgress) {
  const cols = SOURCES[target];
  return runGrouped(records.map((r) => ({
    ops: [
      { type: "set", col: cols.attempts, id: r.id, data: { ...r.attempt, importedAt: serverTimestamp() } },
      ...(r.result ? [{ type: "set", col: cols.results, id: r.id, data: r.result }] : [])
    ]
  })), onProgress);
}
