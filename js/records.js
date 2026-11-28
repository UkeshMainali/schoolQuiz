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
  db, auth, doc, getDoc, getDocs, collection, query, where, limit, startAfter, writeBatch,
  serverTimestamp, documentId, getCountFromServer, orderBy
} from "./firebase.js";
import { classPairs, session } from "./roles.js";
import { signalClasses } from "./live.js";

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
  if (scope.studentId) parts.push(where("studentId", "==", scope.studentId));
  return parts;
}

/**
 * The Firestore queries a scope needs. The Admin queries any scope directly.
 * A teacher's query must name one of their grades AND sections (the rules
 * refuse anything wider), so a wider scope becomes one query per class.
 */
export function splitScope(scope = {}) {
  const pairs = classPairs(scope);
  if (pairs === null) return [scope];
  return pairs.map((p) => ({ ...scope, grade: p.grade, section: p.section }));
}

/** True when a scope needs more than one query (teachers): it cannot be paged, only loaded whole. */
export function isSplitScope(scope) {
  return splitScope(scope).length !== 1;
}

/**
 * One page of attempts for a scope, ordered by document id (stable for
 * paging). Returns { items, cursor, hasMore }.
 */
export async function queryAttempts(source, scope, { pageSize = 300, cursor = null } = {}) {
  const scopes = splitScope(scope);
  if (scopes.length !== 1) {
    // Several classes: read them all (teachers have few records).
    const all = await queryAllAttempts(source, scope, { max: 5000 });
    return { items: all.items, cursor: null, hasMore: false };
  }
  scope = scopes[0];
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

/**
 * Grade, section, roll and quiz from an attempt id "<quizId>_<grade>_<section>_<roll>"
 * (a previous attempt adds "~<time>"). Used by live updates to skip changes
 * outside the records on screen without reading them.
 */
export function attemptIdParts(id) {
  const parts = String(id || "").split("~")[0].split("_");
  if (parts.length < 4) return null;
  const rollNo = parts.pop(), section = parts.pop(), grade = parts.pop();
  return { quizId: parts.join("_"), grade, section, rollNo };
}

/** True when an attempt id can belong to this scope (unknown id format: true). */
export function idInScope(id, scope = {}) {
  const p = attemptIdParts(id);
  if (!p) return true;
  // "?" stands for "any" (live.js reports a whole class as "?_<grade>_<section>_?").
  const same = (part, want) => !want || part === "?" || part === String(want);
  return same(p.grade, scope.grade) && same(p.section, scope.section) && same(p.quizId, scope.quizId) && same(p.rollNo, scope.rollNo);
}

/** Number of attempts in a scope (1 read per 1000 counted). */
export async function countAttempts(source, scope) {
  const counts = await Promise.all(splitScope(scope).map(async (sc) => {
    const snap = await getCountFromServer(query(collection(db, SOURCES[source].attempts), ...scopeFilters(sc)));
    return snap.data().count;
  }));
  return counts.reduce((a, b) => a + b, 0);
}

/** Loads documents by id from one collection: 30 ids per query, up to 6 queries at a time. */
async function getByIds(collectionName, ids) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const snap = await getDocs(query(collection(db, collectionName), where(documentId(), "in", chunk)));
      snap.docs.forEach((d) => out.set(d.id, { id: d.id, ...d.data() }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, worker));
  return out;
}

/**
 * Every attempt in a scope (up to max) with its result, for sorting, searching,
 * summaries and bulk actions over the whole scope. Attempts are read 500 at a
 * time; the results of each block are fetched while the next block loads.
 * Returns { items, results, capped }.
 */
export async function queryAllAttempts(source, scope, { max = 5000, onProgress } = {}) {
  let items = [];
  let more = false;
  const results = new Map();
  const pending = [];
  const scopes = splitScope(scope);
  const split = classPairs(scope) !== null;
  for (const sc of scopes) {
    let cursor = null;
    more = true;
    while (more && items.length < max) {
      const page = await queryAttempts(source, sc, { pageSize: Math.min(500, max - items.length), cursor });
      items = items.concat(page.items);
      cursor = page.cursor;
      more = page.hasMore;
      if (!split) pending.push(fetchResults(source, page.items.map((a) => a.id)).then((m) => m.forEach((v, k) => results.set(k, v))));
      onProgress?.(items.length);
    }
    // Teachers read the results of each class with one query (same filters).
    if (split) pending.push(getDocs(query(collection(db, SOURCES[source].results), ...scopeFilters(sc)))
      .then((snap) => snap.docs.forEach((d) => results.set(d.id, { id: d.id, ...d.data() }))));
    if (items.length >= max) break;
  }
  await Promise.all(pending);
  return { items, results, capped: more && items.length >= max };
}

/** Results by attempt id. Teachers read them one by one (the rules check each class). */
export async function fetchResults(source, attemptIds) {
  if (classPairs({}) === null) return getByIds(SOURCES[source].results, attemptIds);
  const out = new Map();
  for (let i = 0; i < attemptIds.length; i += 20) {
    const snaps = await Promise.all(attemptIds.slice(i, i + 20).map((id) => getDoc(doc(db, SOURCES[source].results, id)).catch(() => null)));
    snaps.forEach((snap) => { if (snap?.exists()) out.set(snap.id, { id: snap.id, ...snap.data() }); });
  }
  return out;
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
    signalGroups(groups);
    throw err;
  }
  signalGroups(groups);
  return done;
}

/** Live updates: tell other dashboards which classes changed (see live.js). */
function signalGroups(groups) {
  const pairs = [];
  groups.forEach((g) => g.ops.forEach((op) => {
    if (!/ttempts$|esults$/i.test(op.col)) return;
    const p = attemptIdParts(op.id);
    if (p) pairs.push(p);
  }));
  signalClasses(pairs, "records");
}

const teacherName = () => session.name || session.username || auth.currentUser?.email || auth.currentUser?.uid || "";

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

/**
 * Submits timed attempts whose time ran out but that the student never sent
 * (the browser was closed, the device was off). Only the status changes: the
 * answers saved before the deadline are kept exactly as they are. The rules
 * allow this only after the deadline plus the grace period.
 */
export function submitExpiredAttempts(records) {
  const data = { status: "submitted", submittedAt: serverTimestamp(), autoSubmitted: true, submittedBy: auth.currentUser?.uid || "" };
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
      // Lets the rules check that the original was moved, not deleted.
      { type: "set", col: "retakes", id: record.id, data: { copyId: newId, at: serverTimestamp(), by: teacherName() } },
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

/**
 * Every record of one student: attempts linked by studentId, plus older
 * attempts of their grade + section + roll number not linked yet.
 * student: { id?, grade, section, rollNo }. Returns [{ source, attempt, result }].
 */
export async function fetchStudentRecords(student, { archive = false } = {}) {
  const sources = archive ? ["active", "archive"] : ["active"];
  const out = new Map();
  for (const source of sources) {
    const scopes = [];
    if (student.id) scopes.push({ studentId: student.id });
    if (student.grade && student.section && student.rollNo) scopes.push({ grade: student.grade, section: student.section, rollNo: student.rollNo, unlinked: true });
    for (const sc of scopes) {
      const { unlinked, ...scope } = sc;
      const { items, results } = await queryAllAttempts(source, scope, { max: 2000 });
      items.forEach((a) => {
        if (unlinked && a.studentId && a.studentId !== student.id) return; // another student's
        out.set(`${source}:${a.id}`, { source, id: a.id, attempt: a, result: results.get(a.id) || null });
      });
    }
  }
  return [...out.values()];
}

/** Active records by attempt id (missing or not allowed ones are left out). */
export async function fetchRecordsByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const snaps = await Promise.all(chunk.map((id) => getDoc(doc(db, "attempts", id)).catch(() => null)));
    const found = snaps.filter((s) => s?.exists());
    const results = await fetchResults("active", found.map((s) => s.id));
    found.forEach((s) => out.push({ source: "active", id: s.id, attempt: { id: s.id, ...s.data() }, result: results.get(s.id) || null }));
  }
  return out;
}
