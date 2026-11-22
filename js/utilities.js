// Small shared helpers used by both the student and teacher pages.

import { db, doc, getDoc } from "./firebase.js";

export const DEFAULT_SETTINGS = {
  grades: ["6"],
  sections: ["A", "B", "C", "D"],
  passPercent: 40,
  // Optional expected class sizes, e.g. { "6-A": 35 }, used to show how many
  // students have not submitted yet.
  classSizes: {}
};

/** Reads settings/school once and merges it with the defaults. */
export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "school"));
    const data = snap.exists() ? snap.data() : {};
    return {
      ...DEFAULT_SETTINGS,
      ...data,
      grades: cleanList(data.grades, DEFAULT_SETTINGS.grades),
      sections: cleanList(data.sections, DEFAULT_SETTINGS.sections),
      classSizes: data.classSizes && typeof data.classSizes === "object" ? data.classSizes : {}
    };
  } catch (err) {
    console.warn("Could not load settings, using defaults", err);
    return { ...DEFAULT_SETTINGS };
  }
}

function cleanList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const list = value.map((v) => String(v).trim()).filter(Boolean);
  return list.length ? list : fallback;
}

/** "012" -> "12". Roll numbers are stored as plain digit strings. */
export function normalizeRoll(value) {
  const digits = String(value ?? "").trim();
  if (!/^\d{1,6}$/.test(digits)) return null;
  return String(parseInt(digits, 10));
}

/** Collapses spaces and capitalises each word: "  ram   sharma " -> "Ram Sharma". */
export function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Deterministic attempt id: one attempt per student per quiz. */
export function makeAttemptId(quizId, grade, section, roll) {
  return `${quizId}_${grade}_${section}_${roll}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Accepts a Firestore Timestamp, Date or millis. */
export function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return null;
}

export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

export function round(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Turns Firebase error codes into sentences a teacher or student can act on. */
export function friendlyError(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) return "You do not have permission to do this.";
  if (code.includes("unavailable") || code.includes("network-request-failed") || !navigator.onLine)
    return "Cannot reach the server. Please check the internet connection and try again.";
  if (code.includes("deadline-exceeded")) return "The server took too long to respond. Please try again.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found") || code.includes("invalid-email"))
    return "Incorrect email or password.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait a minute and try again.";
  if (code.includes("operation-not-allowed")) return "This sign-in method is not enabled in Firebase. See the README setup steps.";
  if (code.includes("admin-restricted-operation")) return "Anonymous sign-in is not enabled in Firebase. See the README setup steps.";
  return "Something went wrong. Please try again.";
}

/** Shows a message in an element with class "notice". type: info | success | error | warning */
export function showNotice(el, text, type = "info") {
  if (!el) return;
  el.textContent = text;
  el.className = `notice notice-${type}`;
  el.hidden = !text;
}

export function hideNotice(el) {
  if (el) { el.hidden = true; el.textContent = ""; }
}

/** Rejects if the promise does not settle within ms. */
export function withTimeout(promise, ms, message = "timeout") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: "deadline-exceeded" })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/** Builds a CSV string from an array of row arrays. */
export function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => {
      const s = String(cell ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))
    .join("\r\n");
}

export function downloadFile(filename, content, type = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿", content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// localStorage keys used by the student pages.
export const ACTIVE_KEY = "cq_active";   // { attemptId, quizId, quizTitle, studentName }
export const PENDING_KEY = "cq_pending"; // { quizId, student } before the attempt exists
export const progressKey = (attemptId) => `cq_progress_${attemptId}`;

/** localStorage wrapper that never throws (private mode, full storage). */
export const storage = {
  get(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

/**
 * Promise-based confirmation using the page's #confirmModal markup
 * (title #confirmTitle, text #confirmText, buttons #confirmOk / #confirmCancel).
 */
export function confirmDialog({ title, text, okText = "OK", danger = false }) {
  const modal = document.getElementById("confirmModal");
  const ok = document.getElementById("confirmOk");
  const cancel = document.getElementById("confirmCancel");
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmText").textContent = text;
  ok.textContent = okText;
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  modal.hidden = false;
  ok.focus();
  return new Promise((resolve) => {
    const done = (value) => {
      modal.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
}
