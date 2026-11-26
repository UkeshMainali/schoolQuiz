// Authentication helpers.
//   Students: anonymous Firebase sign-in (no account or password needed).
//   Staff:    email/password sign-in + a document at teachers/{uid} that
//             holds the role ("admin" or "teacher"). Teachers may type their
//             username; it is looked up in usernames/{username}.
// The real protection is in firestore.rules; these helpers only decide which
// screen to show.

import {
  auth, db, doc, getDoc, getDocFromServer, signInAnonymously, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, writeBatch, serverTimestamp, collection, addDoc,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider
} from "./firebase.js";
import { session, setSession } from "./roles.js";

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

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/** Username or email -> the email Firebase knows the account by. */
async function emailFor(login) {
  const value = String(login || "").trim();
  if (value.includes("@")) return value;
  const name = value.toLowerCase();
  if (!USERNAME_PATTERN.test(name)) throw Object.assign(new Error("bad username"), { code: "auth/invalid-credential" });
  const snap = await getDoc(doc(db, "usernames", name));
  if (!snap.exists()) throw Object.assign(new Error("unknown username"), { code: "auth/invalid-credential" });
  return snap.data().email;
}

export async function teacherSignIn(login, password) {
  // If this browser was used by a student, drop the anonymous session first.
  if (auth.currentUser?.isAnonymous) await signOut(auth);
  const email = await emailFor(login);
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export function teacherSignOut() {
  return signOut(auth);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email.trim());
}

/** Lets a signed-in staff member change their own password. */
export async function changeOwnPassword(current, next) {
  const user = auth.currentUser;
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
  await updatePassword(user, next);
}

/**
 * Reads teachers/{uid} and works out the state of this account:
 *   { state: "staff", profile } | "needs-setup" (old account, no Admin yet) |
 *   "not-authorized" | "disabled" | "legacy" (old account, Admin already exists)
 */
export async function staffState(user) {
  if (!user || user.isAnonymous) return { state: "signed-out" };
  let snap;
  try {
    snap = await getDocFromServer(doc(db, "teachers", user.uid));
  } catch (err) {
    if (err?.code === "permission-denied") return { state: "not-authorized" };
    // offline: fall back to the cached copy
    snap = await getDoc(doc(db, "teachers", user.uid));
  }
  if (!snap.exists()) return { state: "not-authorized" };
  const data = snap.data();
  if (!data.role) {
    const admin = await getDoc(doc(db, "system", "admin")).catch(() => null);
    return { state: admin?.exists() ? "legacy" : "needs-setup" };
  }
  if (data.status === "disabled") return { state: "disabled" };
  if (data.role !== "admin" && data.role !== "teacher") return { state: "not-authorized" };
  return { state: "staff", profile: { uid: user.uid, email: user.email || "", ...data } };
}

/**
 * One-time step: the account that used the dashboard before roles existed
 * becomes the Admin. Allowed by the rules only while no Admin exists.
 */
export async function claimAdmin(user, name) {
  const batch = writeBatch(db);
  batch.update(doc(db, "teachers", user.uid), {
    role: "admin", teacherId: user.uid, status: "active", name: name || "Admin",
    email: user.email || "", updatedAt: serverTimestamp()
  });
  batch.set(doc(db, "system", "admin"), { uid: user.uid, at: serverTimestamp() });
  await batch.commit();
}

/**
 * Calls onStaff(profile) when an authorised Admin or teacher is signed in,
 * otherwise onSignedOut(state, user, err).
 */
export function watchStaff(onStaff, onSignedOut) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user || user.isAnonymous) { onSignedOut("signed-out"); return; }
    try {
      const res = await staffState(user);
      if (res.state === "staff") { setSession(res.profile); onStaff(res.profile, user); }
      else onSignedOut(res.state, user);
    } catch (err) {
      onSignedOut("error", user, err);
    }
  });
}

/** Kept for older pages: true when a staff member is signed in. */
export function watchTeacher(onTeacher, onSignedOut) {
  return watchStaff((profile, user) => onTeacher(user, profile), onSignedOut);
}

/** Adds a line to the activity log (best effort: never blocks the action). */
export async function logActivity(action, text, target = "") {
  try {
    await addDoc(collection(db, "activity"), {
      actorUid: session.uid,
      actorId: session.teacherId,
      actorName: session.name || session.username || session.email || "",
      role: session.role,
      action: String(action).slice(0, 60),
      text: String(text).slice(0, 300),
      target: String(target || "").slice(0, 200),
      at: serverTimestamp()
    });
  } catch (err) {
    console.warn("Activity not logged", err);
  }
}
