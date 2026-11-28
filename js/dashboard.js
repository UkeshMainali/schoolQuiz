// Staff dashboard (dashboard.html): sign-in, tabs and wiring between the
// parts of the dashboard, for the Admin and for teachers.
//
// What a signed-in person can open is decided from their profile in
// teachers/{uid}. Admin-only tabs are removed from the page for teachers and
// their code is never started. This only decides what is displayed: every
// Firestore read and write is checked by firestore.rules, so a teacher who
// edits this code or the URL still cannot read or change Admin data.

import { watchStaff, teacherSignIn, teacherSignOut, resetPassword, claimAdmin, changeOwnPassword, logActivity } from "./auth.js";
import { auth } from "./firebase.js";
import { clearKeyCache } from "./grading.js";
import { friendlyError, showNotice, hideNotice, storage, skeleton, formModal } from "./utilities.js";
import { loadTeacherData, appNotice } from "./teacherState.js";
import { session, isAdmin } from "./roles.js";
import { RecordsView } from "./recordsView.js";
import { AnalyticsView } from "./analyticsView.js";
import { QuizAdmin } from "./quizAdmin.js";
import { StudentRecordView, parseHistoryHash } from "./studentRecord.js";
import { RequestsView, requestsState, watchRequests, pendingCount } from "./requests.js";
import { startLive, onLive, liveBadgeHtml } from "./live.js";
import { OverviewView } from "./overview.js";
import { HelpView } from "./help.js";
import { initScrollButtons } from "./scrollButtons.js";
import { initShortcuts } from "./shortcuts.js";

const $ = (id) => document.getElementById(id);
const TAB_KEY = "cq_dash_tab";

// ------------------------------------------------------------------- auth UI

function showView(name) {
  ["loginView", "deniedView", "setupView", "appView"].forEach((id) => { $(id).hidden = id !== name; });
  $("authLoading").hidden = true;
}

const DENIED = {
  "not-authorized": ["Access denied", `<p>This account is not a staff account of this school.</p>
    <p class="small muted">Teachers get their username and password from the Admin. If you are the Admin and see this, check the setup steps in the README. Your account ID:</p>`],
  disabled: ["Account deactivated", "<p>Your account has been deactivated by the Admin. Please contact the Admin if you think this is a mistake.</p>"],
  legacy: ["Account not set up", `<p>The school already has an Admin, and this older account has no role yet.</p>
    <p class="small muted">Ask the Admin to create a teacher account for you on the <b>Add teacher</b> page.</p>`]
};

let started = false;
watchStaff(
  (profile, user) => {
    if (started && profile.uid !== session.uid) { location.reload(); return; }
    $("userEmail").textContent = profile.name || profile.username || user.email || "";
    const admin = profile.role === "admin";
    $("userRole").innerHTML = `<i class="fa-solid fa-${admin ? "shield-halved" : "chalkboard-user"}" aria-hidden="true"></i><span>${admin ? "Admin" : "Teacher"}</span>`;
    $("userRole").classList.toggle("is-admin", admin);
    $("userRole").title = admin ? "Admin" : (profile.username ? `Teacher · ${profile.username}` : "Teacher");
    $("userInitial").textContent = (profile.name || profile.username || user.email || "?").charAt(0).toUpperCase();
    $("userBox").hidden = false;
    showView("appView");
    if (!started) { started = true; start(); }
  },
  (state, user, err) => {
    if (started) { location.reload(); return; } // signed out, or account changed, in another tab
    $("userBox").hidden = true;
    if (state === "needs-setup") {
      $("setupName").value = "";
      showView("setupView");
      $("setupName").focus();
      return;
    }
    if (DENIED[state]) {
      $("deniedTitle").textContent = DENIED[state][0];
      $("deniedText").innerHTML = DENIED[state][1];
      $("deniedUidRow").hidden = state !== "not-authorized";
      $("deniedUid").textContent = user?.uid || "";
      showView("deniedView");
      return;
    }
    showView("loginView");
    if (state === "error") showNotice($("loginNotice"), `Could not check your account. ${friendlyError(err)}`, "error");
  }
);

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = $("loginEmail").value;
  const password = $("loginPassword").value;
  if (!login.trim() || !password) { showNotice($("loginNotice"), "Please enter your username (or email) and password.", "error"); return; }
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Signing in…";
  hideNotice($("loginNotice"));
  try {
    await teacherSignIn(login, password);
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
  const login = $("loginEmail").value.trim();
  // Teacher accounts have no real mailbox: only the Admin can reset them.
  if (!login.includes("@")) {
    showNotice($("loginNotice"), "Teachers: ask the Admin to reset your password. Admin: type your email above, then press Forgot password.", "info");
    return;
  }
  try {
    await resetPassword(login);
    showNotice($("loginNotice"), "If this email has an account, a password reset link has been sent.", "success");
  } catch (err) {
    showNotice($("loginNotice"), friendlyError(err), "error");
  }
});

$("setupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("setupName").value.trim().replace(/\s+/g, " ");
  if (name.length < 2) { showNotice($("setupNotice"), "Please type your name (at least 2 letters).", "error"); return; }
  $("setupBtn").disabled = true;
  hideNotice($("setupNotice"));
  try {
    await claimAdmin(auth.currentUser, name);
    location.reload();
  } catch (err) {
    console.error(err);
    showNotice($("setupNotice"), err?.code === "permission-denied"
      ? "This account cannot become the Admin (an Admin may already exist). Please reload the page."
      : friendlyError(err), "error");
    $("setupBtn").disabled = false;
  }
});

const signOutNow = async () => {
  started = false;
  await teacherSignOut();
  clearKeyCache();
  location.reload();
};
[$("signOutBtn"), $("deniedSignOut"), $("setupSignOut")].forEach((b) => b.addEventListener("click", signOutNow));

$("changePwBtn").addEventListener("click", async () => {
  $("changePwBtn").closest("details").open = false;
  const values = await formModal({
    title: "Change my password",
    okText: "Change password",
    body: `<div class="field"><label for="cpCurrent">Current password</label><input type="password" id="cpCurrent" autocomplete="current-password"></div>
      <div class="field"><label for="cpNext">New password (at least 8 characters)</label><input type="password" id="cpNext" autocomplete="new-password" maxlength="64"></div>
      <div class="field"><label for="cpAgain">New password again</label><input type="password" id="cpAgain" autocomplete="new-password" maxlength="64"></div>
      <div class="error-text" data-err="pw" hidden></div>`,
    onOpen: (root) => root.querySelector("#cpCurrent").focus(),
    collect: (root) => {
      const current = root.querySelector("#cpCurrent").value;
      const next = root.querySelector("#cpNext").value;
      const again = root.querySelector("#cpAgain").value;
      const problem = !current ? "Type your current password."
        : next.length < 8 ? "The new password needs at least 8 characters."
        : next !== again ? "The two new passwords are different." : "";
      const box = root.querySelector('[data-err="pw"]');
      box.textContent = problem;
      box.hidden = !problem;
      return problem ? null : { current, next };
    }
  });
  if (!values) return;
  try {
    await changeOwnPassword(values.current, values.next);
    logActivity("own_password", "Changed their own password");
    appNotice("Your password has been changed.", "success");
  } catch (err) {
    appNotice(err?.code === "auth/invalid-credential" || err?.code === "auth/wrong-password"
      ? "Your current password is not correct." : `The password was not changed. ${friendlyError(err)}`, "error");
  }
});

// --------------------------------------------------------------------- app

const parts = {};
// Records views load lazily: the first time their tab is opened, and again
// after another tab changed their data (e.g. records were archived).
const stale = { results: true, archive: true };

const PAGES = {
  overview: ["Overview", ""],
  results: ["Results", "Grade, review, print and export submissions."],
  history: ["Student record", "Every student, their details and every quiz they have taken."],
  analysis: ["Analysis", "How grades, sections, quizzes and questions are doing."],
  quizzes: ["Quizzes", "Add quizzes from question banks and manage them."],
  requests: ["Requests", ""],
  teachers: ["Add teacher", "Create teacher accounts and choose the classes each teacher works with."],
  archive: ["Archive & backup", "Archived records, and restoring from a backup file."],
  settings: ["School settings", "Grades, sections, class sizes and the pass mark."],
  help: ["Help", "How to use the dashboard, and keyboard shortcuts."]
};

async function start() {
  const admin = isAdmin();
  document.body.classList.toggle("is-admin", admin);
  if (!admin) {
    // Remove Admin-only parts from the page entirely (not just hidden).
    document.querySelectorAll("[data-admin-only]").forEach((el) => el.remove());
    PAGES.overview[1] = "";
    PAGES.requests[1] = "Ask the Admin for things only the Admin can do, and follow your requests.";
    PAGES.results[1] = "Grade and review submissions from your classes.";
    PAGES.history[1] = "Students of your classes and every quiz they have taken.";
    PAGES.quizzes[1] = "Add quizzes for your classes and manage the quizzes you created.";
  } else {
    PAGES.overview[1] = "";
    PAGES.requests[1] = "Requests from teachers for things only the Admin can do.";
  }

  // Placeholders until quizzes and settings arrive.
  [["tab-overview", "page", 5], ["tab-results", "page", 10], ["tab-history", "table", 8], ["tab-analysis", "page", 5], ["tab-quizzes", "table", 9],
    ["tab-requests", "table", 6], ["tab-teachers", "table", 6], ["archiveRecords", "table", 10], ["tab-settings", "table", 3]]
    .forEach(([id, kind, cols]) => { if ($(id)) $(id).innerHTML = skeleton(kind, { cols, rows: 6 }); });
  try {
    await loadTeacherData();
  } catch (err) {
    console.error(err);
    appNotice(`Could not load quizzes and settings. ${friendlyError(err)} Press Refresh on a tab to try again.`, "error");
  }

  parts.overview = new OverviewView($("tab-overview"), {
    openTab,
    openResults: (scope) => { stale.results = false; openTab("results"); parts.results.openScope(scope); },
    openStudents: (scope) => { openTab("history", { skipShow: true }); parts.history.openScope(scope); }
  });
  parts.results = new RecordsView($("tab-results"), { source: "active" });
  parts.history = new StudentRecordView($("tab-history"));
  parts.analysis = new AnalyticsView($("tab-analysis"));
  parts.quizzes = new QuizAdmin($("tab-quizzes"));
  parts.requests = new RequestsView($("tab-requests"), {
    openStudent: (student) => {
      if (!student) { appNotice("This student is no longer registered.", "info"); return; }
      openTab("history", { skipShow: true });
      parts.history.openStudent(student);
    }
  });
  parts.help = new HelpView($("tab-help"));

  if (admin) {
    // Admin-only modules are loaded only for the Admin.
    const [{ SettingsAdmin }, { BackupImport }, { TeachersAdmin }] = await Promise.all([
      import("./settingsAdmin.js"), import("./backupImport.js"), import("./teachersAdmin.js")
    ]);
    parts.archive = new RecordsView($("archiveRecords"), { source: "archive" });
    parts.settings = new SettingsAdmin($("tab-settings"));
    parts.teachers = new TeachersAdmin($("tab-teachers"));
    parts.backup = new BackupImport($("backupImportCard"), {
      onImported: (target) => { stale[target === "archive" ? "archive" : "results"] = true; dataChanged(); refreshVisible(); }
    });
    parts.archive.onChanged = (kind) => {
      parts.history.invalidate();
      if (kind === "move") { stale.results = true; parts.analysis.invalidate(); }
    };
  }

  parts.results.onChanged = (kind) => {
    dataChanged();
    if (kind === "move") stale.archive = true;
  };
  parts.history.onChanged = () => { stale.results = true; parts.analysis.invalidate(); };

  // Pending-requests badge for the Admin.
  requestsState.listeners.add(updateBadge);
  watchRequests().catch((err) => console.warn("Requests not loaded", err));

  // Live updates: listeners report changed records; the visible page re-reads only what it shows.
  startLive();
  onLive(onLiveEvent);

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => openTab(tab.dataset.tab)));
  window.addEventListener("hashchange", openFromHash);
  initScrollButtons($("appView"));
  initShortcuts({
    hasTab: (name) => !!document.querySelector(`.tab[data-tab="${name}"]`),
    openTab: (name) => openTab(name),
    openHelp: (section) => { openTab("help"); parts.help.jump(section); }
  });
  if (!openFromHash()) openTab(storage.get(TAB_KEY) || "overview");
}

// ------------------------------------------------------------ live updates

const livePending = new Set();
let liveTimer = null;
function onLiveEvent(e) {
  if (e.type === "status") { paintLiveBadge(); return; }
  if (e.type === "progress") { if (currentTab() === "overview") parts.overview.liveProgress(); return; }
  if (e.type !== "records") return;
  e.ids.forEach((id) => livePending.add(id));
  scheduleLiveFlush(1500);
}

function scheduleLiveFlush(ms) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(flushLive, ms);
}

/** Something is open that a re-render would close (a dialog, a menu, a dropdown). */
function busy() {
  return !!document.querySelector(".modal-backdrop, details.menu[open], .cselect.is-open, .cm");
}

function flushLive() {
  if (!livePending.size) return;
  if (document.hidden) return; // applied when the page is shown again
  if (busy()) { scheduleLiveFlush(3000); return; }
  const ids = new Set(livePending);
  livePending.clear();
  dataChanged();
  const tab = currentTab();
  // Records pages that are not visible re-read when they are opened next.
  if (tab === "results") parts.results.liveUpdate(ids); else if (parts.results.loaded) stale.results = true;
  if (tab === "overview") parts.overview.liveUpdate(ids);
  if (tab === "history") parts.history.liveUpdate(ids);
  if (tab === "analysis") parts.analysis.liveUpdate();
  if (tab === "quizzes") parts.quizzes.liveUpdate?.(ids);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && livePending.size) scheduleLiveFlush(300); });

function paintLiveBadge() {
  const el = $("liveBadge");
  if (el) el.innerHTML = liveBadgeHtml();
}

function updateBadge() {
  const badge = $("requestsBadge");
  if (!badge) return;
  const n = isAdmin() ? pendingCount() : 0;
  badge.textContent = n ? String(n) : "";
  badge.hidden = !n;
  badge.setAttribute("aria-label", `${n} pending`);
}

function dataChanged() {
  parts.analysis.invalidate();
  parts.history.invalidate();
  parts.overview.loadedAt = 0;
}

/** "#student=<id>" or "#history=6|A|12" (links from results, analysis and older links) opens that student's record. */
function openFromHash() {
  const student = parseHistoryHash(location.hash);
  if (!student) return false;
  openTab("history", { skipShow: true });
  parts.history.openStudent(student);
  return true;
}

function currentTab() {
  return document.querySelector(".tab.active")?.dataset.tab || "overview";
}

function refreshVisible() { openTab(currentTab()); }

let currentTabName = null;
function openTab(name, { skipShow = false } = {}) {
  // A tab that is not on the page (e.g. an Admin tab for a teacher) cannot be opened.
  if (!PAGES[name] || !document.querySelector(`.tab[data-tab="${name}"]`)) name = "overview";
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  $("pageTitle").textContent = PAGES[name][0];
  $("pageSub").textContent = PAGES[name][1];
  document.title = `${PAGES[name][0]} · Dashboard`;
  if (currentTabName && name !== currentTabName) window.scrollTo(0, 0);
  if (currentTabName && name !== currentTabName) hideNotice($("appNotice")); // a notice belongs to the tab it came from
  currentTabName = name;
  storage.set(TAB_KEY, name);
  if (name === "overview") parts.overview.show();
  if (name === "results" && stale.results) {
    stale.results = false;
    // After live changes keep the page, filters and selection; otherwise start over.
    if (parts.results.loaded) parts.results.liveUpdate(null); else parts.results.load();
  }
  if (name === "archive" && stale.archive) { stale.archive = false; parts.archive.load(); }
  if (name === "history" && !skipShow) parts.history.show();
  if (name === "analysis") parts.analysis.show();
  if (name === "quizzes") parts.quizzes.show();
  if (name === "requests") parts.requests.show();
  if (name === "teachers") parts.teachers.show();
  if (name === "settings") parts.settings.show();
  if (name === "help") parts.help.show();
}
