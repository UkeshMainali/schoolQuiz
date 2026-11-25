// Small shared helpers used by both the student and teacher pages.

import { db, doc, getDoc } from "./firebase.js";
import "./controls.js"; // styled dropdowns and date pickers on every page

export const DEFAULT_SETTINGS = {
  grades: ["6"],
  // Sections are stored per grade: { "6": ["A", "B"], "7": ["Manaslu"] }.
  sectionsByGrade: { "6": ["A", "B", "C", "D"] },
  passPercent: 40,
  // Optional number of students per section, e.g. { "6-A": 35 }. It is the
  // highest roll number students of that section may enter, and is used to
  // show how many students have not submitted yet.
  classSizes: {}
};

/** Grade and section names: letters, numbers, spaces and dashes. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,29}$/;

/**
 * Reads settings/school once and merges it with the defaults.
 * Older settings had one "sections" list shared by every grade; those are
 * read as the sections of each grade, so nothing needs migrating.
 */
export async function loadSettings() {
  let data = {};
  try {
    const snap = await getDoc(doc(db, "settings", "school"));
    data = snap.exists() ? snap.data() : {};
  } catch (err) {
    console.warn("Could not load settings, using defaults", err);
  }
  return normalizeSettings(data);
}

export function normalizeSettings(data = {}) {
  const grades = cleanList(data.grades, DEFAULT_SETTINGS.grades);
  const legacy = cleanList(data.sections, null);
  const sectionsByGrade = {};
  grades.forEach((g) => {
    const own = data.sectionsByGrade && data.sectionsByGrade[g];
    sectionsByGrade[g] = cleanList(own, null) || legacy || DEFAULT_SETTINGS.sectionsByGrade[g] || ["A"];
  });
  const pass = Number(data.passPercent);
  return {
    grades,
    sectionsByGrade,
    passPercent: pass >= 1 && pass <= 100 ? pass : DEFAULT_SETTINGS.passPercent,
    classSizes: data.classSizes && typeof data.classSizes === "object" ? data.classSizes : {}
  };
}

/** The sections of one grade (empty list for an unknown grade). */
export function sectionsFor(settings, grade) {
  return (settings.sectionsByGrade && settings.sectionsByGrade[grade]) || [];
}

/** Every section name used by any grade. */
export function allSections(settings) {
  return [...new Set(Object.values(settings.sectionsByGrade || {}).flat())];
}

function cleanList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const list = [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  return list.length ? list : fallback;
}

/** "012" -> "12". Roll numbers are stored as plain digit strings. */
export function normalizeRoll(value) {
  const digits = String(value ?? "").trim();
  if (!/^\d{1,6}$/.test(digits)) return null;
  return String(parseInt(digits, 10));
}

/**
 * Highest roll number allowed in one section: the "Students" number set in
 * School settings (classSizes["6-A"]), or null when none is set.
 */
export function rollLimit(settings, grade, section) {
  const n = Number(settings?.classSizes?.[`${grade}-${section}`]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Checks a typed roll number against the section's limit.
 * Returns { roll: "12", error: "" } or { roll: null, error: "message" }.
 * Accepts only whole numbers from 1 (leading zeros are dropped: "07" -> "7").
 */
export function validateRoll(value, settings, grade, section) {
  const raw = String(value ?? "").trim();
  const max = grade && section ? rollLimit(settings, grade, section) : null;
  const range = max ? ` This section allows roll numbers from 1 to ${max}.` : "";
  if (!raw) return { roll: null, error: "Please enter your roll number." };
  if (!/^\d+$/.test(raw)) {
    return { roll: null, error: `Invalid roll number. Use a whole number with digits only, for example 12.${range}` };
  }
  if (raw.length > 6) return { roll: null, error: `Invalid roll number.${range || " Use at most 6 digits."}` };
  const n = parseInt(raw, 10);
  if (n < 1) return { roll: null, error: `Invalid roll number. Roll numbers start at 1.${range}` };
  if (max && n > max) return { roll: null, error: `Invalid roll number.${range}` };
  return { roll: String(n), error: "" };
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

export function formatDate(value) {
  const d = toDate(value);
  return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
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
      if (typeof cell === "number") return String(cell);
      let s = String(cell ?? "");
      // Text starting with = + - @ would run as a formula in Excel or Sheets.
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","))
    .join("\r\n");
}

export function downloadFile(filename, content, type = "text/csv;charset=utf-8") {
  // The byte-order mark helps Excel read CSV as UTF-8; JSON files go without it.
  const blob = new Blob(type.startsWith("text/csv") ? ["\ufeff", content] : [content], { type });
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
export const PROFILE_KEY = "cq_profile"; // remembered student details { name, roll, grade, section }
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
 * Promise-based confirmation dialog, created on demand (no markup needed).
 *   check:   optional sentence the user must tick before OK is enabled
 *   option:  optional { label, checked } checkbox; its value is returned
 * Resolves with false (cancelled) or { ok: true, option: boolean }.
 */
export function confirmDialog({ title, text, okText = "OK", danger = false, check = "", option = null }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cdTitle">
      <h2 id="cdTitle"></h2>
      <p class="cd-text"></p>
      ${option ? '<label class="check"><input type="checkbox" class="cd-option"> <span></span></label>' : ""}
      ${check ? '<label class="check cd-check-label"><input type="checkbox" class="cd-check"> <span></span></label>' : ""}
      <div class="actions">
        <button type="button" class="btn cd-cancel">Cancel</button>
        <button type="button" class="btn ${danger ? "btn-danger-solid" : "btn-primary"} cd-ok"></button>
      </div>
    </div>`;
  backdrop.querySelector("#cdTitle").textContent = title;
  backdrop.querySelector(".cd-text").textContent = text;
  const ok = backdrop.querySelector(".cd-ok");
  ok.textContent = okText;
  if (option) {
    backdrop.querySelector(".cd-option + span").textContent = option.label;
    backdrop.querySelector(".cd-option").checked = !!option.checked;
  }
  if (check) {
    backdrop.querySelector(".cd-check + span").textContent = check;
    ok.disabled = true;
    backdrop.querySelector(".cd-check").addEventListener("change", (e) => { ok.disabled = !e.target.checked; });
  }
  document.body.appendChild(backdrop);
  (check ? backdrop.querySelector(".cd-check") : ok).focus();
  return new Promise((resolve) => {
    const done = (value) => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(value); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    backdrop.querySelector(".cd-cancel").addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done({ ok: true, option: option ? backdrop.querySelector(".cd-option").checked : false }));
  });
}

/**
 * Small form dialog with one text field or one dropdown.
 *   field: { type: "text", label, value, maxLength } or { type: "select", label, value, options: [{ value, label }] }
 *   validate(value) returns an error message or "".
 *   check: optional confirmation checkbox text that must be ticked first.
 * Resolves with the entered/chosen value, or null when cancelled.
 */
export function inputDialog({ title, text = "", field, okText = "OK", danger = false, check = "", validate = () => "" }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const control = field.type === "select"
    ? `<select id="idField">${field.options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("")}</select>`
    : `<input type="text" id="idField" maxlength="${field.maxLength || 60}" autocomplete="off">`;
  backdrop.innerHTML = `
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="idTitle" novalidate>
      <h2 id="idTitle"></h2>
      ${text ? '<p class="cd-text"></p>' : ""}
      <div class="field"><label for="idField"></label>${control}<div class="error-text" hidden></div></div>
      ${check ? '<label class="check cd-check-label"><input type="checkbox" class="cd-check"> <span></span></label>' : ""}
      <div class="actions">
        <button type="button" class="btn cd-cancel">Cancel</button>
        <button type="submit" class="btn ${danger ? "btn-danger-solid" : "btn-primary"} cd-ok"></button>
      </div>
    </form>`;
  const q = (sel) => backdrop.querySelector(sel);
  q("#idTitle").textContent = title;
  if (text) q(".cd-text").textContent = text;
  q('label[for="idField"]').textContent = field.label;
  q("#idField").value = field.value ?? "";
  const ok = q(".cd-ok");
  ok.textContent = okText;
  if (check) {
    q(".cd-check + span").textContent = check;
    ok.disabled = true;
    q(".cd-check").addEventListener("change", (e) => { ok.disabled = !e.target.checked; });
  }
  document.body.appendChild(backdrop);
  if (field.type === "select") setTimeout(() => (backdrop.querySelector(".cselect-button") || q("#idField")).focus(), 0);
  else { q("#idField").focus(); q("#idField").select(); }
  return new Promise((resolve) => {
    const done = (value) => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(value); };
    const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".cselect.is-open")) done(null); };
    document.addEventListener("keydown", onKey);
    q(".cd-cancel").addEventListener("click", () => done(null));
    q("form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      const value = field.type === "select" ? q("#idField").value : q("#idField").value.trim();
      const err = validate(value);
      const box = q(".error-text");
      box.textContent = err || "";
      box.hidden = !err;
      q("#idField").classList.toggle("invalid", !!err);
      if (!err) done(value);
    });
  });
}

/** Runs async work over items in chunks, reporting progress. */
export async function inChunks(items, size, fn, onProgress) {
  let done = 0;
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    await fn(chunk);
    done += chunk.length;
    onProgress?.(done, items.length);
  }
  return done;
}

export function pluralize(n, word, plural = `${word}s`) {
  return `${n} ${n === 1 ? word : plural}`;
}

/** Link that opens one student's history (dashboard "Student history" tab). */
export const historyLink = (grade, section, roll) =>
  `dashboard.html#history=${[grade, section, roll].map(encodeURIComponent).join("|")}`;

// Dropdown menus (details.menu) open to the left by default; flip one that
// would run off the screen edge (narrow phones, menus near the left side).
if (typeof document !== "undefined") {
  document.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches?.("details.menu") || !d.open) return;
    const list = d.querySelector(".menu-list");
    if (!list) return;
    list.style.left = ""; list.style.right = "";
    const r = list.getBoundingClientRect();
    if (r.left < 8) {
      list.style.left = "0"; list.style.right = "auto";
      const over = list.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
      if (over > 0) list.style.left = `${-over}px`;
    }
  }, true);
}
