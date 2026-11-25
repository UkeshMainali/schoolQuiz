// Quiz tabs (categories) for the Quizzes page.
//
// Storage (no new collection, no security rule change needed):
//   settings/quizCategories  { categories: [{ id, name }], updatedAt }   tab names, in display order
//   quizzes/{id}.categoryId  the tab a quiz belongs to
//
// A quiz with no categoryId, or one whose tab was removed, has "No tab": it
// shows under All quizzes, so quizzes created before tabs existed need no migration.
// Tabs are edited in a transaction, so two open dashboards cannot overwrite
// each other's changes. Deleting a tab first moves its quizzes, then removes
// the name: quizzes and student records are never deleted.

import { db, doc, getDoc, runTransaction, writeBatch, serverTimestamp } from "./firebase.js";

export const ALL = "__all";
export const UNCATEGORIZED = "";
export const UNCATEGORIZED_NAME = "No tab"; // quizzes without a tab show only under All quizzes
const MOVES_PER_BATCH = 400;
const ref = () => doc(db, "settings", "quizCategories");

const clean = (list) => (Array.isArray(list) ? list : [])
  .filter((c) => c && typeof c.id === "string" && c.id && typeof c.name === "string" && c.name.trim())
  .map((c) => ({ id: c.id, name: c.name.trim() }));

export async function loadCategories() {
  const snap = await getDoc(ref());
  return clean(snap.exists() ? snap.data().categories : []);
}

/** Error message for a tab name, or "". */
export function nameProblem(name, categories, exceptId = null) {
  const n = String(name || "").trim();
  if (!n) return "Enter a name for the tab.";
  if (n.length > 40) return "Use at most 40 characters.";
  const lower = n.toLowerCase();
  if (["all quizzes", "all", UNCATEGORIZED_NAME.toLowerCase()].includes(lower)) return `"${n}" is reserved. Choose another name.`;
  if (categories.some((c) => c.id !== exceptId && c.name.toLowerCase() === lower)) return `A tab called "${n}" already exists.`;
  return "";
}

/** Applies change(list) to the saved list inside a transaction; returns the new list. */
async function update(change) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref());
    const next = change(clean(snap.exists() ? snap.data().categories : []));
    tx.set(ref(), { categories: next, updatedAt: serverTimestamp() });
    return next;
  });
}

export async function addCategory(name) {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const list = await update((list) => {
    const err = nameProblem(name, list);
    if (err) throw new Error(err);
    return [...list, { id, name: name.trim() }];
  });
  return { list, id };
}

export async function renameCategory(id, name) {
  return update((list) => {
    if (!list.some((c) => c.id === id)) throw new Error("This tab no longer exists. Press Refresh.");
    const err = nameProblem(name, list, id);
    if (err) throw new Error(err);
    return list.map((c) => (c.id === id ? { ...c, name: name.trim() } : c));
  });
}

/** Sets categoryId on quizzes (in batches). Only that field and updatedAt change. */
export async function moveQuizzes(quizIds, categoryId) {
  for (let i = 0; i < quizIds.length; i += MOVES_PER_BATCH) {
    const batch = writeBatch(db);
    quizIds.slice(i, i + MOVES_PER_BATCH).forEach((id) => batch.update(doc(db, "quizzes", id), { categoryId, updatedAt: serverTimestamp() }));
    await batch.commit();
  }
}

/** Moves the tab's quizzes to moveTo (another tab id, or "" for no tab), then removes the tab. */
export async function deleteCategory(id, quizIds, moveTo = UNCATEGORIZED) {
  if (moveTo === id) throw new Error("Choose a different tab for the quizzes.");
  if (quizIds.length) await moveQuizzes(quizIds, moveTo);
  return update((list) => list.filter((c) => c.id !== id));
}

/** The tab id a quiz is shown under ("" when it has none or its tab is gone). */
export function categoryOf(quiz, categories) {
  const id = quiz.categoryId || "";
  return id && categories.some((c) => c.id === id) ? id : UNCATEGORIZED;
}

export function categoryName(id, categories) {
  return id ? categories.find((c) => c.id === id)?.name || UNCATEGORIZED_NAME : UNCATEGORIZED_NAME;
}
