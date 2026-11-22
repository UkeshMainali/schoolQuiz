// Teacher dashboard (dashboard.html).
// Every Firestore read here is allowed only for an authorised teacher by
// firestore.rules; the sign-in check below only decides what to display.

import {
  db, doc, getDocs, setDoc, updateDoc, collection, query, where, orderBy, limit,
  startAfter, writeBatch, serverTimestamp, Timestamp
} from "./firebase.js";
import { watchTeacher, teacherSignIn, teacherSignOut, resetPassword } from "./auth.js";
import { gradeAttempts, needsGrading, loadAnswerKey, clearKeyCache } from "./grading.js";
import { parseQuestionBank, toPublicQuiz, toAnswerKey } from "./questionBank.js";
import { overview, groupBy, scoreBands, questionStats } from "./analytics.js";
import {
  loadSettings, escapeHtml, formatDateTime, toDate, friendlyError, showNotice, hideNotice,
  toCsv, downloadFile, confirmDialog, storage
} from "./utilities.js";

const PAGE_SIZE = 500;
const FLAG_THRESHOLD = 3;

const $ = (id) => document.getElementById(id);

const data = {
  settings: null,
  quizzes: new Map(),       // quizId -> quiz doc
  attempts: [],             // loaded attempts
  results: new Map(),       // attemptId -> result doc
  lastAttemptDoc: null,
  hasMore: false,
  rows: []
};
const view = {
  quizId: storage.get("cq_dash_quiz") || "",
  sortKey: "submittedMs",
  sortDir: "desc",
  importParsed: null
};

// ------------------------------------------------------------------- auth UI

function showView(name) {
  ["loginView", "deniedView", "appView"].forEach((id) => { $(id).hidden = id !== name; });
  $("authLoading").hidden = true;
}

let started = false;
watchTeacher(
  (user) => {
    $("userEmail").textContent = user.email || "";
    $("userBox").hidden = false;
    showView("appView");
    if (!started) { started = true; loadAll(); }
  },
  (reason, user, err) => {
    started = false;
    $("userBox").hidden = !user;
    $("userEmail").textContent = user?.email || "";
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
  await teacherSignOut();
  clearKeyCache();
  location.reload();
}));

// --------------------------------------------------------------------- tabs

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
  const showToolbar = ["results", "analysis"].includes(tab.dataset.tab);
  document.querySelector(".toolbar").hidden = !showToolbar;
  if (tab.dataset.tab === "analysis") renderAnalysis();
}));

// -------------------------------------------------------------------- loading

function appNotice(text, type = "info") { showNotice($("appNotice"), text, type); }

async function loadQuizzes() {
  const snap = await getDocs(collection(db, "quizzes"));
  data.quizzes = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
}

async function loadAll() {
  hideNotice($("appNotice"));
  $("dataInfo").textContent = "Loading…";
  try {
    data.settings = await loadSettings();
    await loadQuizzes();
    renderQuizFilter();
    renderFilterOptions();
    renderQuizzesTable();
    renderSettingsForm();
    await loadResultsData();
  } catch (err) {
    console.error(err);
    appNotice(`Could not load data. ${friendlyError(err)}`, "error");
    $("dataInfo").textContent = "";
  }
}

async function loadResultsData({ more = false } = {}) {
  const attemptsCol = collection(db, "attempts");
  const parts = [];
  if (view.quizId) parts.push(where("quizId", "==", view.quizId));
  parts.push(orderBy("startedAt", "desc"));
  if (more && data.lastAttemptDoc) parts.push(startAfter(data.lastAttemptDoc));
  parts.push(limit(PAGE_SIZE));

  $("dataInfo").textContent = "Loading…";
  const attemptSnap = await getDocs(query(attemptsCol, ...parts));
  const newAttempts = attemptSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  data.attempts = more ? [...data.attempts, ...newAttempts] : newAttempts;
  data.lastAttemptDoc = attemptSnap.docs[attemptSnap.docs.length - 1] || data.lastAttemptDoc;
  data.hasMore = attemptSnap.docs.length === PAGE_SIZE;

  if (!more) {
    const resultsQuery = view.quizId
      ? query(collection(db, "results"), where("quizId", "==", view.quizId))
      : query(collection(db, "results"), limit(PAGE_SIZE * 4));
    const resultSnap = await getDocs(resultsQuery);
    data.results = new Map(resultSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  }
  buildRows();
  $("dataInfo").textContent = `Loaded ${data.attempts.length} attempt${data.attempts.length === 1 ? "" : "s"} at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  renderResults();
  if (!$("tab-analysis").hidden) renderAnalysis();
}

const STATUS_ORDER = { in_progress: 0, ungraded: 1, graded: 2 };

function buildRows() {
  data.rows = data.attempts.map((a) => {
    const quiz = data.quizzes.get(a.quizId);
    const result = data.results.get(a.id);
    let status = "in_progress";
    if (a.status === "submitted") status = needsGrading(a, result, quiz) ? "ungraded" : "graded";
    const graded = status === "graded";
    // A stale result (old answer key) still shows its old marks until regraded.
    const shownResult = a.status === "submitted" ? result : null;
    return {
      id: a.id,
      attempt: a,
      quizId: a.quizId,
      quizTitle: a.quizTitle || quiz?.title || a.quizId,
      studentName: a.studentName,
      nameLower: a.nameLower || String(a.studentName || "").toLowerCase(),
      rollNo: a.rollNo,
      rollNum: Number(a.rollNo),
      grade: a.grade,
      section: a.section,
      status,
      statusOrder: STATUS_ORDER[status],
      obtained: shownResult ? shownResult.obtainedMarks : null,
      total: shownResult ? shownResult.totalMarks : (quiz?.totalMarks ?? null),
      percentage: shownResult ? shownResult.percentage : null,
      passed: graded ? !!result.passed : null,
      details: graded ? result.details : null,
      stale: a.status === "submitted" && !!result && !graded,
      focusLossCount: a.focusLossCount || 0,
      fullscreenExitCount: a.fullscreenExitCount || 0,
      answeredCount: a.answeredCount || 0,
      questionCount: a.questionCount || 0,
      submittedAt: a.submittedAt,
      submittedMs: toDate(a.submittedAt)?.getTime() || 0
    };
  });
}

$("refreshBtn").addEventListener("click", async () => {
  try { await loadQuizzes(); await loadResultsData(); }
  catch (err) { appNotice(`Could not refresh. ${friendlyError(err)}`, "error"); }
});
$("loadMoreBtn").addEventListener("click", () => loadResultsData({ more: true }).catch((err) => appNotice(friendlyError(err), "error")));
$("quizFilter").addEventListener("change", async () => {
  view.quizId = $("quizFilter").value;
  storage.set("cq_dash_quiz", view.quizId);
  data.lastAttemptDoc = null;
  try { await loadResultsData(); }
  catch (err) {
    console.error(err);
    const indexMsg = String(err?.message || "").includes("index") ? " A Firestore index is still being built or is missing (see README)." : "";
    appNotice(`Could not load results. ${friendlyError(err)}${indexMsg}`, "error");
  }
});

// ------------------------------------------------------------ results table

function renderQuizFilter() {
  const sorted = [...data.quizzes.values()].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
  $("quizFilter").innerHTML = `<option value="">All quizzes</option>` +
    sorted.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.title)}</option>`).join("");
  if (view.quizId && !data.quizzes.has(view.quizId)) view.quizId = "";
  $("quizFilter").value = view.quizId;
}

function renderFilterOptions() {
  const s = data.settings;
  $("gradeFilter").innerHTML = `<option value="">All grades</option>` + s.grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("");
  $("sectionFilter").innerHTML = `<option value="">All sections</option>` + s.sections.map((x) => `<option value="${escapeHtml(x)}">Section ${escapeHtml(x)}</option>`).join("");
}

function filteredRows() {
  const term = $("searchInput").value.trim().toLowerCase();
  const grade = $("gradeFilter").value;
  const section = $("sectionFilter").value;
  const status = $("statusFilter").value;
  return data.rows.filter((r) => {
    if (term && !(r.nameLower.includes(term) || String(r.rollNo) === term.replace(/^0+(?=\d)/, ""))) return false;
    if (grade && r.grade !== grade) return false;
    if (section && r.section !== section) return false;
    if (status === "passed" && r.passed !== true) return false;
    if (status === "failed" && r.passed !== false) return false;
    if (status === "flagged" && r.focusLossCount < FLAG_THRESHOLD) return false;
    if (["graded", "ungraded", "in_progress"].includes(status) && r.status !== status) return false;
    return true;
  });
}

function sortRows(rows) {
  const { sortKey, sortDir } = view;
  const dir = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    const xNull = x === null || x === undefined || Number.isNaN(x);
    const yNull = y === null || y === undefined || Number.isNaN(y);
    if (xNull && yNull) return 0;
    if (xNull) return 1;   // empty values always last
    if (yNull) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * dir;
  });
}

function statusBadge(r) {
  if (r.status === "in_progress") return `<span class="badge">In progress (${r.answeredCount}/${r.questionCount})</span>`;
  if (r.status === "ungraded") return `<span class="badge badge-warning">${r.stale ? "Needs regrading" : "Needs grading"}</span>`;
  return r.passed ? `<span class="badge badge-success">Pass</span>` : `<span class="badge badge-danger">Fail</span>`;
}

function fmt(n) { return n === null || n === undefined ? "—" : String(n); }

function renderSummary(rows) {
  const o = overview(rows);
  const unit = o.unit === "marks" ? (o.totalMarks ? ` / ${o.totalMarks}` : "") : "%";
  const cards = [
    ["Total students", o.totalStudents],
    ["Total submissions", o.totalSubmissions, o.inProgress ? `${o.inProgress} still in progress` : ""],
    [o.unit === "marks" ? "Average marks" : "Average score", o.average === null ? "—" : `${o.average}${unit}`],
    [o.unit === "marks" ? "Highest marks" : "Highest score", o.highest === null ? "—" : `${o.highest}${unit}`],
    [o.unit === "marks" ? "Lowest marks" : "Lowest score", o.lowest === null ? "—" : `${o.lowest}${unit}`],
    ["Ungraded submissions", o.ungraded, o.ungraded ? "Press Grade now" : "", o.ungraded ? "warn" : ""]
  ];
  $("summaryCards").innerHTML = cards.map(([label, value, sub, kind]) => `
    <div class="summary-card ${kind || ""}">
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="summary-sub">${escapeHtml(sub)}</div>` : ""}
    </div>`).join("");

  const pending = data.rows.filter((r) => r.status === "ungraded").length;
  $("gradeBanner").hidden = pending === 0;
  $("gradeBannerText").textContent = `${pending} submitted quiz${pending === 1 ? " needs" : "zes need"} grading.`;
}

function renderResults() {
  const all = data.rows;
  const rows = sortRows(filteredRows());
  renderSummary(all);
  document.querySelector(".col-quiz").hidden = !!view.quizId;

  document.querySelectorAll("#resultsTable th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === view.sortKey);
    th.dataset.dir = th.dataset.sort === view.sortKey ? view.sortDir : "";
    th.setAttribute("aria-sort", th.dataset.sort === view.sortKey ? (view.sortDir === "asc" ? "ascending" : "descending") : "none");
  });

  $("resultsBody").innerHTML = rows.map((r) => `
    <tr data-id="${escapeHtml(r.id)}" tabindex="0">
      <td class="name-cell">${escapeHtml(r.studentName)}</td>
      <td>${escapeHtml(r.rollNo)}</td>
      <td>${escapeHtml(r.grade)}</td>
      <td>${escapeHtml(r.section)}</td>
      <td class="col-quiz"${view.quizId ? " hidden" : ""}>${escapeHtml(r.quizTitle)}</td>
      <td class="num">${fmt(r.obtained)}</td>
      <td class="num">${fmt(r.total)}</td>
      <td class="num">${r.percentage === null ? "—" : `${r.percentage}%`}</td>
      <td>${statusBadge(r)}</td>
      <td class="num">${r.focusLossCount >= FLAG_THRESHOLD ? `<span class="badge badge-warning">${r.focusLossCount}</span>` : r.focusLossCount}</td>
      <td class="small">${r.submittedMs ? escapeHtml(formatDateTime(r.submittedAt)) : "—"}</td>
    </tr>`).join("");

  const filtersOn = $("searchInput").value || $("gradeFilter").value || $("sectionFilter").value || $("statusFilter").value;
  $("matchCount").textContent = filtersOn
    ? `Showing ${rows.length} of ${all.length} attempt${all.length === 1 ? "" : "s"}`
    : `${all.length} attempt${all.length === 1 ? "" : "s"}`;
  const empty = $("emptyState");
  if (!all.length) {
    empty.textContent = data.quizzes.size ? "No student has started this quiz yet." : "No quizzes yet. Import a question bank on the Quizzes tab.";
    empty.hidden = false;
  } else if (!rows.length) {
    empty.textContent = "No students match these filters.";
    empty.hidden = false;
  } else empty.hidden = true;
  $("resultsTable").hidden = !rows.length;
  $("loadMoreBtn").hidden = !data.hasMore;
}

document.querySelectorAll("#resultsTable th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  const key = th.dataset.sort;
  if (view.sortKey === key) view.sortDir = view.sortDir === "asc" ? "desc" : "asc";
  else { view.sortKey = key; view.sortDir = ["obtained", "percentage", "submittedMs", "focusLossCount"].includes(key) ? "desc" : "asc"; }
  renderResults();
}));

["searchInput", "gradeFilter", "sectionFilter", "statusFilter"].forEach((id) =>
  $(id).addEventListener("input", renderResults));
$("clearFilters").addEventListener("click", () => {
  ["searchInput", "gradeFilter", "sectionFilter", "statusFilter"].forEach((id) => { $(id).value = ""; });
  renderResults();
});

function openRow(e) {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  if (e.type === "keydown" && e.key !== "Enter") return;
  location.href = `result.html?id=${encodeURIComponent(tr.dataset.id)}`;
}
$("resultsBody").addEventListener("click", openRow);
$("resultsBody").addEventListener("keydown", openRow);

$("exportBtn").addEventListener("click", () => {
  const rows = sortRows(filteredRows());
  if (!rows.length) { appNotice("There are no results to export.", "info"); return; }
  const csv = toCsv([
    ["Student name", "Roll no.", "Grade", "Section", "Quiz", "Obtained marks", "Total marks", "Percentage", "Result", "Status", "Correct", "Incorrect", "Unanswered", "Times left page", "Fullscreen exits", "Submitted at"],
    ...rows.map((r) => {
      const res = data.results.get(r.id);
      return [r.studentName, r.rollNo, r.grade, r.section, r.quizTitle, fmt(r.obtained), fmt(r.total),
        r.percentage === null ? "" : r.percentage, r.passed === null ? "" : r.passed ? "Pass" : "Fail",
        r.status === "graded" ? "Graded" : r.status === "ungraded" ? "Needs grading" : "In progress",
        res?.correctCount ?? "", res?.incorrectCount ?? "", res?.unansweredCount ?? "",
        r.focusLossCount, r.fullscreenExitCount, r.submittedMs ? formatDateTime(r.submittedAt) : ""];
    })
  ]);
  const quizPart = view.quizId || "all-quizzes";
  downloadFile(`results-${quizPart}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
});

// ------------------------------------------------------------------ grading

async function runGrading(attempts, label) {
  if (!attempts.length) { appNotice("Nothing to grade.", "info"); return; }
  $("gradeBtn").disabled = true;
  $("regradeBtn").disabled = true;
  appNotice(`${label} ${attempts.length} submission${attempts.length === 1 ? "" : "s"}…`, "info");
  try {
    clearKeyCache(); // always use the latest answer key
    const { graded, skipped, results } = await gradeAttempts(
      attempts, data.results, data.settings.passPercent,
      (done, total) => appNotice(`${label} ${done} of ${total}…`, "info")
    );
    results.forEach((r, id) => data.results.set(id, r));
    buildRows();
    renderResults();
    if (skipped.length) {
      const titles = [...new Set(skipped.map((s) => s.attempt.quizTitle))].join(", ");
      appNotice(`Graded ${graded}. ${skipped.length} could not be graded because there is no answer key for: ${titles}. Import that question bank again.`, "warning");
    } else {
      appNotice(`Graded ${graded} submission${graded === 1 ? "" : "s"}. Results are saved.`, "success");
    }
  } catch (err) {
    console.error(err);
    appNotice(`Grading stopped. ${friendlyError(err)} Already graded submissions are saved; press Grade now to continue.`, "error");
  } finally {
    $("gradeBtn").disabled = false;
    $("regradeBtn").disabled = false;
  }
}

$("gradeBtn").addEventListener("click", () =>
  runGrading(data.rows.filter((r) => r.status === "ungraded").map((r) => r.attempt), "Grading"));

$("regradeBtn").addEventListener("click", async () => {
  const submitted = data.rows.filter((r) => r.status !== "in_progress").map((r) => r.attempt);
  if (!submitted.length) { appNotice("There are no submitted quizzes to grade.", "info"); return; }
  const ok = await confirmDialog({
    title: "Regrade all submissions?",
    text: `All ${submitted.length} loaded submission${submitted.length === 1 ? "" : "s"} will be graded again with the current answer key. Manual corrections you made are kept.`,
    okText: "Regrade"
  });
  if (ok) runGrading(submitted, "Regrading");
});

// ------------------------------------------------------------------ analysis

function statTable(title, groups, firstCol, { expected } = {}) {
  if (!groups.length) return "";
  const showExpected = expected && groups.some((g) => expected(g.key));
  return `
    <div class="card">
      <h2>${escapeHtml(title)}</h2>
      <div class="table-wrap">
      <table class="data-table compact">
        <thead><tr>
          <th>${escapeHtml(firstCol)}</th><th class="num">Students</th>
          ${showExpected ? '<th class="num">Not submitted</th>' : ""}
          <th class="num">Graded</th><th class="num">Average marks</th><th class="num">Average %</th>
          <th class="num">Highest</th><th class="num">Lowest</th><th class="num">Pass</th><th class="num">Fail</th>
        </tr></thead>
        <tbody>${groups.map((g) => {
          const exp = showExpected ? expected(g.key) : null;
          return `<tr>
            <td>${escapeHtml(g.label)}</td><td class="num">${g.students}</td>
            ${showExpected ? `<td class="num">${exp ? Math.max(0, exp - g.submitted) : "—"}</td>` : ""}
            <td class="num">${g.graded}</td><td class="num">${fmt(g.avg)}</td>
            <td class="num">${g.avgPercent === null ? "—" : `${g.avgPercent}%`}</td>
            <td class="num">${fmt(g.max)}</td><td class="num">${fmt(g.min)}</td>
            <td class="num">${g.passed}</td><td class="num">${g.failed}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      </div>
    </div>`;
}

function bars(title, items, total, note = "") {
  return `
    <div class="card">
      <h2>${escapeHtml(title)}</h2>
      ${note ? `<p class="small muted">${escapeHtml(note)}</p>` : ""}
      <div class="bars">${items.map((it) => `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(it.label)}</span>
          <span class="bar-track"><span class="bar-fill ${it.kind || ""}" style="width:${total ? (it.count / total) * 100 : 0}%"></span></span>
          <span class="bar-value">${it.count}</span>
        </div>`).join("")}
      </div>
    </div>`;
}

async function renderAnalysis() {
  const box = $("analysisContent");
  const rows = data.rows;
  if (!rows.some((r) => r.status === "graded")) {
    box.innerHTML = `<div class="card empty">No graded results yet for this selection.</div>`;
    return;
  }
  const o = overview(rows);
  const singleQuiz = !!view.quizId;
  let html = "";
  if (!singleQuiz) html += `<div class="notice notice-info">Several quizzes are included, so compare the <b>Average %</b> column. Choose one quiz above to compare marks.</div>`;

  html += bars("Pass / fail", [
    { label: "Passed", count: o.passed, kind: "ok" },
    { label: "Failed", count: o.failed, kind: "bad" }
  ], o.graded, `Pass mark: ${singleQuiz && data.results.size ? ([...data.results.values()][0].passPercent ?? data.settings.passPercent) : data.settings.passPercent}%`);

  html += statTable("Grade-wise performance", groupBy(rows, (r) => r.grade, (k) => `Grade ${k}`), "Grade");

  const sizes = data.settings.classSizes || {};
  html += statTable("Section-wise performance", groupBy(rows, (r) => `${r.grade}-${r.section}`, (k) => {
    const [g, s] = k.split("-");
    return `Grade ${g} – Section ${s}`;
  }), "Section", { expected: singleQuiz ? (k) => Number(sizes[k]) || 0 : null });

  html += bars("Score distribution", scoreBands(rows), o.graded);

  if (singleQuiz) {
    try {
      const key = await loadAnswerKey(view.quizId);
      const qs = questionStats(rows, key);
      if (qs.length) {
        html += `
          <div class="card">
            <h2>Questions (hardest first)</h2>
            <div class="table-wrap">
            <table class="data-table compact">
              <thead><tr><th>Question</th><th class="num">Correct</th><th class="num">Incorrect</th><th class="num">Unanswered</th><th class="num">% correct</th></tr></thead>
              <tbody>${qs.map((q) => `<tr><td>${escapeHtml(q.text)}</td><td class="num">${q.correct}</td><td class="num">${q.incorrect}</td><td class="num">${q.unanswered}</td><td class="num">${q.percentCorrect}%</td></tr>`).join("")}</tbody>
            </table>
            </div>
          </div>`;
      }
    } catch (err) { console.warn(err); }
  }
  box.innerHTML = html;
}

// ------------------------------------------------------------------ quizzes

function renderQuizzesTable() {
  const list = [...data.quizzes.values()].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
  $("quizzesBody").innerHTML = list.length ? list.map((q) => `
    <tr>
      <td>${escapeHtml(q.title)}</td>
      <td class="small"><code>${escapeHtml(q.id)}</code></td>
      <td>${escapeHtml(q.grade || "Any")}</td>
      <td class="num">${q.questionCount ?? "—"}</td>
      <td class="num">${q.totalMarks ?? "—"}</td>
      <td>${escapeHtml(q.version || "1")}</td>
      <td>${q.active ? '<span class="badge badge-success">Open</span>' : '<span class="badge">Closed</span>'}</td>
      <td class="actions-cell">
        <button type="button" class="btn btn-small" data-action="toggle" data-id="${escapeHtml(q.id)}">${q.active ? "Close" : "Open"}</button>
        <button type="button" class="btn btn-small" data-action="key" data-id="${escapeHtml(q.id)}">Answer key</button>
        <button type="button" class="btn btn-small btn-danger" data-action="delete" data-id="${escapeHtml(q.id)}">Delete</button>
      </td>
    </tr>`).join("") : `<tr><td colspan="8" class="empty">No quizzes yet. Import a question bank above.</td></tr>`;
}

$("quizzesBody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const quiz = data.quizzes.get(btn.dataset.id);
  if (!quiz) return;
  if (btn.dataset.action === "toggle") {
    btn.disabled = true;
    try {
      await updateDoc(doc(db, "quizzes", quiz.id), { active: !quiz.active, updatedAt: serverTimestamp() });
      quiz.active = !quiz.active;
      renderQuizzesTable();
      appNotice(`"${quiz.title}" is now ${quiz.active ? "open for students" : "closed"}.`, "success");
    } catch (err) { appNotice(friendlyError(err), "error"); btn.disabled = false; }
  } else if (btn.dataset.action === "key") {
    showAnswerKey(quiz);
  } else if (btn.dataset.action === "delete") {
    const ok = await confirmDialog({
      title: `Delete "${quiz.title}"?`,
      text: "The quiz and its answer key will be deleted. Student attempts and results are kept, but they cannot be regraded unless you import this question bank again.",
      okText: "Delete quiz", danger: true
    });
    if (!ok) return;
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "quizzes", quiz.id));
      batch.delete(doc(db, "answerKeys", quiz.id));
      await batch.commit();
      data.quizzes.delete(quiz.id);
      renderQuizzesTable();
      renderQuizFilter();
      $("answerKeyView").innerHTML = "";
      appNotice(`"${quiz.title}" was deleted.`, "success");
    } catch (err) { appNotice(friendlyError(err), "error"); }
  }
});

async function showAnswerKey(quiz) {
  const box = $("answerKeyView");
  box.innerHTML = `<div class="loading"><span class="spinner"></span> Loading answer key…</div>`;
  try {
    const key = await loadAnswerKey(quiz.id, { refresh: true });
    if (!key) { box.innerHTML = `<div class="notice notice-warning">No answer key found for this quiz. Import the question bank again.</div>`; return; }
    box.innerHTML = `
      <h3 style="margin-top:24px">Answer key: ${escapeHtml(quiz.title)}</h3>
      <div class="table-wrap">
      <table class="data-table compact">
        <thead><tr><th>#</th><th>ID</th><th>Question</th><th>Type</th><th>Correct answer</th><th class="num">Marks</th><th>Explanation</th></tr></thead>
        <tbody>${key.questions.map((q, i) => {
          const answer = q.type === "short_answer"
            ? `${(q.acceptedAnswers || []).map(escapeHtml).join(" / ")}<div class="small muted">${q.caseSensitive ? "Case sensitive" : "Not case sensitive"}</div>`
            : `${escapeHtml(q.correctOptionId)}. ${escapeHtml((q.options || []).find((o) => o.id === q.correctOptionId)?.text || "")}`;
          return `<tr><td>${i + 1}</td><td class="small"><code>${escapeHtml(q.id)}</code></td><td>${escapeHtml(q.text)}</td><td class="small">${escapeHtml(q.type)}</td><td>${answer}</td><td class="num">${q.marks}</td><td class="small">${escapeHtml(q.explanation || "")}</td></tr>`;
        }).join("")}</tbody>
      </table>
      </div>
      <button type="button" class="btn btn-small" id="hideKeyBtn" style="margin-top:12px">Hide answer key</button>`;
    $("hideKeyBtn").addEventListener("click", () => { box.innerHTML = ""; });
  } catch (err) {
    box.innerHTML = `<div class="notice notice-error">${escapeHtml(friendlyError(err))}</div>`;
  }
}

// ------------------------------------------------------------------- import

$("importFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  const box = $("importPreview");
  if (!files.length) { box.innerHTML = ""; return; }
  const all = { quizzes: [], errors: [], warnings: [] };
  for (const file of files) {
    let text;
    try { text = await file.text(); }
    catch { all.errors.push(`${file.name}: could not be read.`); continue; }
    const parsed = parseQuestionBank(text, file.name);
    all.quizzes.push(...parsed.quizzes);
    all.errors.push(...parsed.errors.map((m) => `${file.name}: ${m}`));
    all.warnings.push(...parsed.warnings.map((m) => `${file.name}: ${m}`));
  }
  const ids = new Set();
  all.quizzes = all.quizzes.filter((q) => {
    if (ids.has(q.quizId)) { all.errors.push(`Quiz id "${q.quizId}" appears in more than one file; only the first is used.`); return false; }
    ids.add(q.quizId); return true;
  });
  view.importParsed = all;
  renderImportPreview();
});

function renderImportPreview() {
  const { quizzes, errors, warnings } = view.importParsed;
  const box = $("importPreview");
  let html = "";
  if (errors.length) html += `<div class="notice notice-error"><b>Problems found:</b><ul>${errors.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
  if (warnings.length) html += `<div class="notice notice-warning"><ul>${warnings.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
  if (quizzes.length) {
    html += `
      <div class="table-wrap">
      <table class="data-table compact">
        <thead><tr><th>Quiz</th><th>ID</th><th>Grade</th><th class="num">Questions</th><th>Types</th><th class="num">Marks</th><th>Version</th><th>Action</th></tr></thead>
        <tbody>${quizzes.map((q) => {
          const existing = data.quizzes.get(q.quizId);
          const types = Object.entries(q.questions.reduce((m, x) => ({ ...m, [x.type]: (m[x.type] || 0) + 1 }), {})).map(([t, n]) => `${n} ${t}`).join(", ");
          let action = '<span class="badge badge-info">New</span>';
          if (existing) {
            const newIds = new Set(q.questions.map((x) => x.id));
            const removed = (existing.questions || []).filter((x) => !newIds.has(x.id)).length;
            action = `<span class="badge badge-warning">Replaces existing (v${escapeHtml(existing.version || "1")})</span>` +
              (removed ? `<div class="small" style="color:var(--danger)">${removed} question${removed === 1 ? "" : "s"} removed: students in the middle of this quiz will be affected.</div>` : "");
          }
          return `<tr><td>${escapeHtml(q.title)}</td><td class="small"><code>${escapeHtml(q.quizId)}</code></td><td>${escapeHtml(q.grade || "Any")}</td><td class="num">${q.questions.length}</td><td class="small">${escapeHtml(types)}</td><td class="num">${q.questions.reduce((s, x) => s + x.marks, 0)}</td><td>${escapeHtml(q.version)}</td><td>${action}</td></tr>`;
        }).join("")}</tbody>
      </table>
      </div>
      <label class="check"><input type="checkbox" id="importOpen"> Open ${quizzes.length === 1 ? "this quiz" : "these quizzes"} for students now</label>
      <p class="small muted">Existing submissions for a replaced quiz will show <b>Needs regrading</b> so you can grade them with the new answer key.</p>
      <button type="button" id="importBtn" class="btn btn-primary">Import ${quizzes.length} quiz${quizzes.length === 1 ? "" : "zes"}</button>`;
  } else if (!errors.length) {
    html += `<div class="notice notice-error">No quizzes found in the selected file.</div>`;
  }
  box.innerHTML = html;
  $("importBtn")?.addEventListener("click", doImport);
}

async function doImport() {
  const { quizzes } = view.importParsed;
  const open = $("importOpen").checked;
  const btn = $("importBtn");
  btn.disabled = true;
  btn.textContent = "Importing…";
  try {
    // One timestamp shared by both documents identifies this answer-key version.
    const importedAt = Timestamp.now();
    for (let i = 0; i < quizzes.length; i += 200) {
      const batch = writeBatch(db);
      quizzes.slice(i, i + 200).forEach((q) => {
        const existing = data.quizzes.get(q.quizId);
        batch.set(doc(db, "quizzes", q.quizId), {
          ...toPublicQuiz(q),
          active: open ? true : !!existing?.active,
          importedAt,
          createdAt: existing?.createdAt || importedAt,
          updatedAt: serverTimestamp()
        });
        batch.set(doc(db, "answerKeys", q.quizId), { ...toAnswerKey(q), importedAt, source: q.source || "" });
      });
      await batch.commit();
    }
    clearKeyCache();
    await loadQuizzes();
    renderQuizzesTable();
    renderQuizFilter();
    buildRows();
    renderResults();
    $("importPreview").innerHTML = `<div class="notice notice-success">Imported ${quizzes.length} quiz${quizzes.length === 1 ? "" : "zes"} successfully.</div>`;
    $("importFile").value = "";
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Try again";
    appNotice(`Import failed. ${friendlyError(err)}`, "error");
  }
}

// ------------------------------------------------------------------ settings

function parseList(value) {
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

function renderClassSizeFields(grades, sections) {
  const sizes = data.settings.classSizes || {};
  $("classSizeFields").innerHTML = grades.flatMap((g) => sections.map((s) => {
    const k = `${g}-${s}`;
    return `<label class="class-size"><span>Grade ${escapeHtml(g)} – ${escapeHtml(s)}</span><input type="number" min="0" max="500" data-class="${escapeHtml(k)}" value="${sizes[k] ?? ""}"></label>`;
  })).join("");
}

function renderSettingsForm() {
  const s = data.settings;
  $("setGrades").value = s.grades.join(", ");
  $("setSections").value = s.sections.join(", ");
  $("setPass").value = s.passPercent;
  renderClassSizeFields(s.grades, s.sections);
}

["setGrades", "setSections"].forEach((id) => $(id).addEventListener("change", () =>
  renderClassSizeFields(parseList($("setGrades").value), parseList($("setSections").value))));

$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const grades = parseList($("setGrades").value);
  const sections = parseList($("setSections").value).map((s) => s.toUpperCase());
  const pass = Number($("setPass").value);
  const bad = [...grades, ...sections].find((v) => !/^[A-Za-z0-9]{1,10}$/.test(v));
  if (!grades.length || !sections.length) { appNotice("Enter at least one grade and one section.", "error"); return; }
  if (bad) { appNotice(`"${bad}" is not valid. Use only letters and numbers (no spaces).`, "error"); return; }
  if (!(pass >= 1 && pass <= 100)) { appNotice("Pass mark must be between 1 and 100.", "error"); return; }
  const classSizes = {};
  document.querySelectorAll("[data-class]").forEach((input) => {
    const n = parseInt(input.value, 10);
    if (n > 0) classSizes[input.dataset.class] = n;
  });
  $("saveSettingsBtn").disabled = true;
  try {
    await setDoc(doc(db, "settings", "school"), { grades, sections, passPercent: pass, classSizes, updatedAt: serverTimestamp() });
    data.settings = { ...data.settings, grades, sections, passPercent: pass, classSizes };
    renderFilterOptions();
    renderSettingsForm();
    appNotice("Settings saved. Students will see the new choices next time they open the quiz page.", "success");
  } catch (err) {
    appNotice(`Could not save settings. ${friendlyError(err)}`, "error");
  } finally {
    $("saveSettingsBtn").disabled = false;
  }
});
