// Teacher dashboard (dashboard.html): sign-in, tabs and wiring between the
// parts of the dashboard. Every Firestore read and write made from here is
// allowed only for an authorised teacher by firestore.rules; the sign-in
// check below only decides what to display.

import { watchTeacher, teacherSignIn, teacherSignOut, resetPassword } from "./auth.js";
import { clearKeyCache } from "./grading.js";
import { friendlyError, showNotice, hideNotice, storage } from "./utilities.js";
import { loadTeacherData, appNotice } from "./teacherState.js";
import { RecordsView } from "./recordsView.js";
import { AnalyticsView } from "./analyticsView.js";
import { QuizAdmin } from "./quizAdmin.js";
import { SettingsAdmin } from "./settingsAdmin.js";
import { BackupImport } from "./backupImport.js";
import { HistoryView, parseHistoryHash } from "./studentHistory.js";

const $ = (id) => document.getElementById(id);
const TAB_KEY = "cq_dash_tab";

// ------------------------------------------------------------------- auth UI

function showView(name) {
  ["loginView", "deniedView", "appView"].forEach((id) => { $(id).hidden = id !== name; });
  $("authLoading").hidden = true;
}

let started = false;
watchTeacher(
  (user) => {
    $("userEmail").textContent = user.email || "";
    $("userInitial").textContent = (user.email || "?").charAt(0).toUpperCase();
    $("userBox").hidden = false;
    showView("appView");
    if (!started) { started = true; start(); }
  },
  (reason, user, err) => {
    $("userBox").hidden = !user;
    $("userEmail").textContent = user?.email || "";
    if (started) { location.reload(); return; } // signed out in another tab
    if (reason === "not-authorized") {
      $("deniedUid").textContent = user.uid;
      showView("deniedView");
    } else {
      showView("loginView");
      if (reason === "error") showNotice($("loginNotice"), `Could not check your account. ${friendlyError(err)}`, "error");
    }
  }
);

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("loginEmail").value;
  const password = $("loginPassword").value;
  if (!email.trim() || !password) { showNotice($("loginNotice"), "Please enter your email and password.", "error"); return; }
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Signing in…";
  hideNotice($("loginNotice"));
  try {
    await teacherSignIn(email, password);
    $("loginPassword").value = "";
  } catch (err) {
    showNotice($("loginNotice"), friendlyError(err), "error");
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Sign in";
  }
});

$("togglePassword").addEventListener("click", () => {
  const show = $("loginPassword").type === "password";
  $("loginPassword").type = show ? "text" : "password";
  $("togglePassword").textContent = show ? "Hide" : "Show";
  $("togglePassword").setAttribute("aria-pressed", String(show));
  $("togglePassword").setAttribute("aria-label", show ? "Hide password" : "Show password");
});

$("forgotBtn").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  if (!email) { showNotice($("loginNotice"), "Type your email above first, then press Forgot password.", "info"); return; }
  try {
    await resetPassword(email);
    showNotice($("loginNotice"), "If this email has an account, a password reset link has been sent.", "success");
  } catch (err) {
    showNotice($("loginNotice"), friendlyError(err), "error");
  }
});

[$("signOutBtn"), $("deniedSignOut")].forEach((b) => b.addEventListener("click", async () => {
  started = false;
  await teacherSignOut();
  clearKeyCache();
  location.reload();
}));

// --------------------------------------------------------------------- app

const parts = {};
// Records views load lazily: the first time their tab is opened, and again
// after another tab changed their data (e.g. records were archived).
const stale = { results: true, archive: true };

async function start() {
  try {
    await loadTeacherData();
  } catch (err) {
    console.error(err);
    appNotice(`Could not load quizzes and settings. ${friendlyError(err)} Press Refresh on a tab to try again.`, "error");
  }
  parts.results = new RecordsView($("tab-results"), { source: "active" });
  parts.archive = new RecordsView($("archiveRecords"), { source: "archive" });
  parts.history = new HistoryView($("tab-history"));
  parts.analysis = new AnalyticsView($("tab-analysis"));
  parts.quizzes = new QuizAdmin($("tab-quizzes"));
  parts.settings = new SettingsAdmin($("tab-settings"));
  parts.backup = new BackupImport($("backupImportCard"), {
    onImported: (target) => { stale[target === "archive" ? "archive" : "results"] = true; dataChanged(); refreshVisible(); }
  });

  parts.results.onChanged = (kind) => {
    dataChanged();
    if (kind === "move") stale.archive = true;
  };
  parts.archive.onChanged = (kind) => {
    parts.history.invalidate();
    if (kind === "move") { stale.results = true; parts.analysis.invalidate(); }
  };

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => openTab(tab.dataset.tab)));
  window.addEventListener("hashchange", openFromHash);
  if (!openFromHash()) openTab(storage.get(TAB_KEY) || "results");
}

function dataChanged() {
  parts.analysis.invalidate();
  parts.history.invalidate();
}

/** "#history=6|A|12" (links from results, analysis and old student.html links) opens that student's history. */
function openFromHash() {
  const student = parseHistoryHash(location.hash);
  if (!student) return false;
  openTab("history", { skipShow: true });
  parts.history.openStudent(student);
  return true;
}

function currentTab() {
  return document.querySelector(".tab.active")?.dataset.tab || "results";
}

function refreshVisible() { openTab(currentTab()); }

const PAGES = {
  results: ["Results", "Grade, review, print and export submissions."],
  history: ["Student history", "Every quiz a student has taken, with overall performance."],
  analysis: ["Analysis", "How grades, sections, quizzes and questions are doing."],
  quizzes: ["Quizzes", "Add quizzes from question banks and manage them."],
  archive: ["Archive & backup", "Archived records, and restoring from a backup file."],
  settings: ["School settings", "Grades, sections, class sizes and the pass mark."]
};

let currentTabName = null;
function openTab(name, { skipShow = false } = {}) {
  if (!document.querySelector(`.tab[data-tab="${name}"]`)) name = "results";
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  $("pageTitle").textContent = PAGES[name][0];
  $("pageSub").textContent = PAGES[name][1];
  document.title = `${PAGES[name][0]} · Teacher Dashboard`;
  if (currentTabName && name !== currentTabName) window.scrollTo(0, 0);
  if (currentTabName && name !== currentTabName) hideNotice($("appNotice")); // a notice belongs to the tab it came from
  currentTabName = name;
  storage.set(TAB_KEY, name);
  if (name === "results" && stale.results) { stale.results = false; parts.results.load(); }
  if (name === "archive" && stale.archive) { stale.archive = false; parts.archive.load(); }
  if (name === "history" && !skipShow) parts.history.show();
  if (name === "analysis") parts.analysis.show();
  if (name === "quizzes") parts.quizzes.show();
  if (name === "settings") parts.settings.show();
}
