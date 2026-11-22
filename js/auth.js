// Authentication helpers.
//   Students: anonymous Firebase sign-in (no account or password needed).
//   Teacher:  email/password sign-in + a document at teachers/{uid}.
// The real protection is in firestore.rules; these helpers only decide which
// screen to show.

import {
  auth, db, doc, getDoc, signInAnonymously, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail
} from "./firebase.js";

/** Resolves with the current user once Firebase has restored the session. */
export function waitForAuth() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

/** Makes sure a student has an (anonymous) session. Reuses an existing one. */
export async function ensureStudentAuth() {
  const user = await waitForAuth();
  if (user) return user;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

/** True when the signed-in user has a teachers/{uid} document. */
export async function isAuthorizedTeacher(user) {
  if (!user || user.isAnonymous) return false;
  try {
    const snap = await getDoc(doc(db, "teachers", user.uid));
    return snap.exists();
  } catch (err) {
    if (err?.code === "permission-denied") return false;
    throw err;
  }
}

export async function teacherSignIn(email, password) {
  // If this browser was used by a student, drop the anonymous session first.
  if (auth.currentUser?.isAnonymous) await signOut(auth);
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export function teacherSignOut() {
  return signOut(auth);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email.trim());
}

/**
 * Calls onTeacher(user) when an authorised teacher is signed in, otherwise
 * onSignedOut(reason). reason is "signed-out" | "not-authorized" | "error".
 */
export function watchTeacher(onTeacher, onSignedOut) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user || user.isAnonymous) { onSignedOut("signed-out"); return; }
    try {
      if (await isAuthorizedTeacher(user)) onTeacher(user);
      else onSignedOut("not-authorized", user);
    } catch (err) {
      onSignedOut("error", user, err);
    }
  });
}
