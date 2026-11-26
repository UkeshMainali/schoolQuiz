// Student identities.
//
//   students/{studentId}               name, grade, section, rollNo (the stable id never changes)
//   studentIndex/{grade_section_roll}  { studentId, name, grade, section, rollNo }
//
// The index lets the student page find a registered student from roll
// number + grade + section (roll numbers are only unique inside a section),
// and makes duplicate registration impossible: an index document can only
// be created once. Attempts store the studentId; their copied studentName
// is kept as history, and every page shows the CURRENT name from here.

import {
  db, doc, getDoc, getDocs, collection, query, where, writeBatch, serverTimestamp, auth
} from "./firebase.js";
import { isAdmin, classPairs, session } from "./roles.js";

export const studentKey = (grade, section, roll) => `${grade}_${section}_${roll}`;

export const directory = {
  byId: new Map(),   // studentId -> student
  byKey: new Map(),  // "6_A_12" -> student
  loaded: false
};

function put(s) {
  directory.byId.set(s.id, s);
  directory.byKey.set(studentKey(s.grade, s.section, s.rollNo), s);
}

/** Loads every student the user may see (Admin: all; teacher: their classes). */
export async function loadStudents() {
  directory.byId.clear();
  directory.byKey.clear();
  const pairs = classPairs({});
  const snaps = pairs === null
    ? [await getDocs(collection(db, "students"))]
    : await Promise.all(pairs.map((p) => getDocs(query(collection(db, "students"), where("grade", "==", p.grade), where("section", "==", p.section)))));
  snaps.forEach((snap) => snap.docs.forEach((d) => put({ id: d.id, ...d.data() })));
  directory.loaded = true;
}

/** The registered student an attempt belongs to (by id, else by grade/section/roll), or null. */
export function studentFor(a) {
  if (!a) return null;
  if (a.studentId && directory.byId.has(a.studentId)) return directory.byId.get(a.studentId);
  if (a.studentId) return null; // linked to a student we cannot see (or deleted)
  return directory.byKey.get(studentKey(a.grade, a.section, a.rollNo)) || null;
}

/** Current name for an attempt or result; the name typed at the time if not registered. */
export function nameFor(a) {
  return studentFor(a)?.name || a?.studentName || "";
}

export function allStudents() { return [...directory.byId.values()]; }

// ----------------------------------------------------------- student page

/**
 * Looks up roll number + grade + section.
 * { state: "found", student: { id, name } } | { state: "new" } | { state: "conflict" }
 */
export async function lookupStudent(grade, section, roll) {
  const snap = await getDoc(doc(db, "studentIndex", studentKey(grade, section, roll)));
  if (!snap.exists()) return { state: "new" };
  const d = snap.data();
  if (!d.studentId || !d.name || String(d.grade) !== String(grade) || String(d.section) !== String(section) || String(d.rollNo) !== String(roll)) {
    return { state: "conflict" };
  }
  return { state: "found", student: { id: d.studentId, name: d.name } };
}

/**
 * A new student registers. If someone registered the same roll number a
 * moment earlier, that registration is returned instead ({ existing: true }).
 */
export async function registerStudent({ name, grade, section, roll }) {
  const ref = doc(collection(db, "students"));
  const batch = writeBatch(db);
  batch.set(ref, {
    name, nameLower: name.toLowerCase(), grade, section, rollNo: roll, status: "active",
    createdAt: serverTimestamp(), createdBy: "student", createdUid: auth.currentUser.uid
  });
  batch.set(doc(db, "studentIndex", studentKey(grade, section, roll)), { studentId: ref.id, name, grade, section, rollNo: roll });
  try {
    await batch.commit();
    return { id: ref.id, name, existing: false };
  } catch (err) {
    if (err?.code === "permission-denied") {
      const again = await lookupStudent(grade, section, roll).catch(() => null);
      if (again?.state === "found") return { ...again.student, existing: true };
    }
    throw err;
  }
}

// ------------------------------------------------------------- Admin only

function stamp() { return { updatedAt: serverTimestamp(), updatedBy: session.teacherId }; }

/**
 * Links older attempts of one grade + section + roll number (made before
 * students had ids) to a student, so they stay with that student when the
 * student's class or roll number changes.
 */
export async function linkOldAttempts(student) {
  let linked = 0;
  for (const col of ["attempts", "archivedAttempts"]) {
    const snap = await getDocs(query(collection(db, col),
      where("grade", "==", student.grade), where("section", "==", student.section), where("rollNo", "==", student.rollNo)));
    const todo = snap.docs.filter((d) => !d.data().studentId);
    for (let i = 0; i < todo.length; i += 400) {
      const batch = writeBatch(db);
      todo.slice(i, i + 400).forEach((d) => batch.update(d.ref, { studentId: student.id }));
      await batch.commit();
    }
    linked += todo.length;
  }
  return linked;
}

/** Admin adds a student by hand. Throws "taken" if the roll number is registered. */
export async function createStudent({ name, grade, section, rollNo }) {
  const key = studentKey(grade, section, rollNo);
  if ((await getDoc(doc(db, "studentIndex", key))).exists()) throw Object.assign(new Error("taken"), { code: "taken" });
  const ref = doc(collection(db, "students"));
  const data = { name, nameLower: name.toLowerCase(), grade, section, rollNo, status: "active", createdAt: serverTimestamp(), createdBy: "admin", ...stamp() };
  const batch = writeBatch(db);
  batch.set(ref, data);
  batch.set(doc(db, "studentIndex", key), { studentId: ref.id, name, grade, section, rollNo });
  await batch.commit();
  const s = { id: ref.id, ...data };
  put(s);
  return s;
}

/**
 * Changes a student's name and/or class. The student keeps their id, so all
 * attempts stay linked. The old name is remembered in previousNames.
 */
export async function updateStudent(student, { name, grade, section, rollNo }) {
  if (!isAdmin()) throw Object.assign(new Error("admin only"), { code: "permission-denied" });
  const oldKey = studentKey(student.grade, student.section, student.rollNo);
  const newKey = studentKey(grade, section, rollNo);
  const moving = oldKey !== newKey;
  if (moving) {
    if ((await getDoc(doc(db, "studentIndex", newKey))).exists()) throw Object.assign(new Error("taken"), { code: "taken" });
    await linkOldAttempts(student);
  }
  const previousNames = [...new Set([...(student.previousNames || []), ...(name !== student.name ? [student.name] : [])])].slice(-10);
  const changes = { name, nameLower: name.toLowerCase(), grade, section, rollNo, previousNames, ...stamp() };
  const batch = writeBatch(db);
  batch.update(doc(db, "students", student.id), changes);
  if (moving) batch.delete(doc(db, "studentIndex", oldKey));
  batch.set(doc(db, "studentIndex", newKey), { studentId: student.id, name, grade, section, rollNo });
  await batch.commit();
  directory.byKey.delete(oldKey);
  const s = { ...student, ...changes, updatedAt: new Date() };
  put(s);
  return s;
}

/** Removes a student's identity. Their quiz records are kept (and keep their typed name). */
export async function deleteStudent(student) {
  if (!isAdmin()) throw Object.assign(new Error("admin only"), { code: "permission-denied" });
  const key = studentKey(student.grade, student.section, student.rollNo);
  const batch = writeBatch(db);
  batch.delete(doc(db, "students", student.id));
  const idx = await getDoc(doc(db, "studentIndex", key));
  if (idx.exists() && idx.data().studentId === student.id) batch.delete(idx.ref);
  await batch.commit();
  directory.byId.delete(student.id);
  if (directory.byKey.get(key)?.id === student.id) directory.byKey.delete(key);
}

const ROLL_RE = /^[1-9][0-9]{0,5}$/;
const CLASS_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,29}$/;

/**
 * One-time setup for records made before student ids existed: creates a
 * student for every grade + section + roll number found in the results and
 * the archive (using the most recent name), and links each attempt to it.
 * Safe to run again: only unlinked attempts are touched.
 * Returns { created, linked, skipped }.
 */
export async function migrateStudents(onProgress = () => {}) {
  if (!isAdmin()) throw Object.assign(new Error("admin only"), { code: "permission-denied" });
  onProgress("Reading students…");
  await loadStudents();
  const unlinked = [];
  for (const col of ["attempts", "archivedAttempts"]) {
    onProgress(`Reading ${col === "attempts" ? "results" : "the archive"}…`);
    const snap = await getDocs(collection(db, col));
    snap.docs.forEach((d) => { const a = d.data(); if (!a.studentId) unlinked.push({ ref: d.ref, col, ...a }); });
  }
  // Group by grade + section + roll number; the newest attempt's name wins.
  const groups = new Map();
  let skipped = 0;
  unlinked.forEach((a) => {
    const roll = String(a.rollNo ?? "");
    if (!ROLL_RE.test(roll) || !CLASS_RE.test(String(a.grade ?? "")) || !CLASS_RE.test(String(a.section ?? ""))) { skipped++; return; }
    const key = studentKey(a.grade, a.section, roll);
    if (!groups.has(key)) groups.set(key, { grade: String(a.grade), section: String(a.section), rollNo: roll, attempts: [] });
    groups.get(key).attempts.push(a);
  });
  const when = (a) => (a.submittedAt?.toMillis?.() || a.startedAt?.toMillis?.() || 0);
  let created = 0, linked = 0;
  const writes = []; // [{ type, ref, data }]
  for (const [key, g] of groups) {
    let student = directory.byKey.get(key);
    if (!student) {
      const sorted = g.attempts.slice().sort((x, y) => when(y) - when(x));
      const name = String(sorted[0].studentName || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (name.length < 2) { skipped += g.attempts.length; continue; }
      const otherNames = [...new Set(sorted.map((a) => String(a.studentName || "").trim()).filter((n) => n && n !== name))].slice(0, 10);
      const ref = doc(collection(db, "students"));
      const data = { name, nameLower: name.toLowerCase(), grade: g.grade, section: g.section, rollNo: g.rollNo, status: "active", createdAt: serverTimestamp(), createdBy: "migration", previousNames: otherNames };
      writes.push({ type: "pair", ops: [
        { type: "set", ref, data },
        { type: "set", ref: doc(db, "studentIndex", key), data: { studentId: ref.id, name, grade: g.grade, section: g.section, rollNo: g.rollNo } }
      ] });
      student = { id: ref.id, ...data };
      put(student);
      created++;
    }
    g.attempts.forEach((a) => {
      writes.push({ type: "one", ops: [{ type: "update", ref: a.ref, data: { studentId: student.id } }] });
      linked++;
    });
  }
  // Commit in batches; a student and its index always go in the same batch.
  let batch = writeBatch(db), n = 0, done = 0;
  for (const w of writes) {
    if (n + w.ops.length > 400) { await batch.commit(); done += n; onProgress(`Saving… ${done} of ${writes.length + created} changes`); batch = writeBatch(db); n = 0; }
    w.ops.forEach((op) => { if (op.type === "set") batch.set(op.ref, op.data); else batch.update(op.ref, op.data); });
    n += w.ops.length;
  }
  if (n) await batch.commit();
  await loadStudents();
  return { created, linked, skipped };
}

/** True once migrateStudents has finished (settings/migrations.students). */
export async function studentsMigrated() {
  const snap = await getDoc(doc(db, "settings", "migrations"));
  return snap.exists() && snap.data().students === true;
}

export async function markStudentsMigrated(summary) {
  const batch = writeBatch(db);
  batch.set(doc(db, "settings", "migrations"), { students: true, studentsAt: serverTimestamp(), studentsSummary: summary }, { merge: true });
  await batch.commit();
}
