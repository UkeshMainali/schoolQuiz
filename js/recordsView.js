// Results table used twice on the dashboard: active results and the archive.
// One class, configured by `source`, so both views behave the same way.
//
// Browse:   Grade -> Section -> Quiz (each choice narrows the Firestore query)
// Filter:   search, status, submission dates (applied to the loaded records)
// Actions:  per record, on selected records, or on all records shown.

import {
  queryAttempts, fetchResults, countAttempts, setReviewStatus, deleteRecords,
  archiveRecords, restoreRecords
} from "./records.js";
import { gradeAttempts, needsGrading, clearKeyCache } from "./grading.js";
import { buildBackup, summaryCsv, detailedCsv } from "./backup.js";
import { buildReport, printHtml } from "./print.js";
import { sortRows, nextSort, paintSortHeaders } from "./tableSort.js";
import { teacher, sortedQuizzes, quizTitle, appNotice, onTeacherChange } from "./teacherState.js";
import { overview } from "./analytics.js";
import {
  escapeHtml, formatDateTime, toDate, friendlyError, downloadFile, confirmDialog, pluralize,
  sectionsFor, storage, historyLink, skeletonRows
} from "./utilities.js";

const FLAG_THRESHOLD = 3;
const PAGE_SIZE = 300;
const REVIEW_LABELS = { pending: "Pending review", accepted: "Accepted", declined: "Declined" };

const STATUS_FILTERS = [
  ["", "All statuses"],
  ["in_progress", "In progress"],
  ["ungraded", "Submitted, needs grading"],
  ["graded", "Graded"],
  ["pending", "Pending review"],
  ["accepted", "Accepted"],
  ["declined", "Declined"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["flagged", `Left the quiz ${FLAG_THRESHOLD}+ times`],
  ["previous", "Previous attempts (retakes)"]
];

/**
 * Turns an attempt + result into the row used by tables, analysis and exports.
 * grading: in_progress | ungraded | stale (answer key changed) | graded
 * review:  pending | accepted | declined (submitted attempts only)
 */
export function toRow(a, result, isArchive = false) {
  const quiz = teacher.quizzes.get(a.quizId);
  const submitted = a.status === "submitted";
  let grading = "in_progress";
  if (submitted) {
    if (isArchive) grading = result ? "graded" : "ungraded";
    else grading = !result ? "ungraded" : needsGrading(a, result, quiz) ? "stale" : "graded";
  }
  const review = submitted ? (a.reviewStatus || "pending") : null;
  const showMarks = submitted && result;
  return {
    id: a.id,
    attempt: a,
    result,
    quizId: a.quizId,
    quizTitle: a.quizTitle || quizTitle(a.quizId),
    studentName: a.studentName,
    nameLower: a.nameLower || String(a.studentName || "").toLowerCase(),
    rollNo: a.rollNo,
    rollNum: Number(a.rollNo),
    grade: a.grade,
    section: a.section,
    submitted,
    grading,
    gradingLabel: { in_progress: "In progress", ungraded: "Needs grading", stale: "Needs regrading", graded: "Graded" }[grading],
    review,
    reviewLabel: review ? REVIEW_LABELS[review] : "",
    statusOrder: { in_progress: 0, ungraded: 1, stale: 1, graded: 2 }[grading] * 10 + ({ pending: 0, accepted: 1, declined: 2 }[review] ?? 0),
    obtained: showMarks ? result.obtainedMarks : null,
    total: showMarks ? result.totalMarks : (quiz?.totalMarks ?? null),
    percentage: showMarks ? result.percentage : null,
    passed: grading === "graded" && result ? !!result.passed : null,
    details: grading === "graded" && result ? result.details : null,
    previous: !!a.previousAttempt,
    focusLossCount: a.focusLossCount || 0,
    fullscreenExitCount: a.fullscreenExitCount || 0,
    answeredCount: a.answeredCount || 0,
    questionCount: a.questionCount || 0,
    submittedMs: toDate(a.submittedAt)?.getTime() || 0
  };
}

export class RecordsView {
  constructor(container, { source }) {
    this.el = container;
    this.source = source;
    this.isArchive = source === "archive";
    const saved = storage.get(`cq_scope_${source}`) || {};
    this.scope = { grade: saved.grade || "", section: saved.section || "", quizId: saved.quizId || "" };
    this.items = [];
    this.results = new Map();
    this.cursor = null;
    this.hasMore = false;
    this.rows = [];
    this.selected = new Set();
    this.sort = { key: "studentName", dir: "asc" };
    this.counts = { grades: new Map(), sections: new Map() };
    this.loaded = false;
    this.busy = false;
    this.renderSkeleton();
    this.bind();
    onTeacherChange(() => { if (this.loaded) { this.buildRows(); this.renderBrowse(); this.render(); } });
  }

  // ---------------------------------------------------------------- markup

  renderSkeleton() {
    const a = this.isArchive;
    const menu = (label, which, items) => `
      <details class="menu">
        <summary class="btn btn-small">${label}</summary>
        <div class="menu-list">${items.map(([verb, text]) => `<button type="button" data-act="${verb}-${which}">${escapeHtml(text)}</button>`).join("")}</div>
      </details>`;
    this.el.innerHTML = `
      ${a ? '<div class="section-title"><h2>Archived records</h2></div>' : ""}
      <div class="browse card">
        <div class="browse-row"><span class="browse-label">Grade</span><div class="chips" data-level="grade"></div></div>
        <div class="browse-row" data-row="section"><span class="browse-label">Section</span><div class="chips" data-level="section"></div></div>
        <div class="browse-row"><label class="browse-label" for="${this.source}-quiz">Quiz</label>
          <select id="${this.source}-quiz" class="scope-quiz"></select>
          <button type="button" class="btn btn-small" data-act="refresh">Refresh</button>
          <span class="small muted data-info"></span>
        </div>
      </div>

      ${a ? "" : '<div class="summary-grid compact" data-summary></div>'}
      ${a ? "" : `<div class="notice notice-warning grade-banner" data-grade-banner hidden>
        <span data-grade-text></span>
        <button type="button" class="btn btn-primary btn-small" data-act="grade-eligible">Grade all eligible</button>
      </div>`}

      <div class="card table-card">
        <div class="filters">
          <label class="stack-field grow"><span>Search</span><input type="search" data-filter="search" placeholder="Name or roll no." aria-label="Search by name or roll number"></label>
          <label class="stack-field"><span>Status</span><select data-filter="status" aria-label="Status">${STATUS_FILTERS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join("")}</select></label>
          <label class="stack-field date-field"><span>Submitted from</span><input type="date" data-filter="from" aria-label="Submitted from"></label>
          <label class="stack-field date-field"><span>To</span><input type="date" data-filter="to" aria-label="Submitted to"></label>
          <button type="button" class="btn btn-ghost" data-act="clear-filters">Clear</button>
        </div>

        <div class="table-head">
          <span class="small muted" data-count></span>
          <div class="table-actions">
            ${menu("Print", "filtered", [["print", "Results by student (shown)"], ["sheets", "Answer sheets by student (shown)"]])}
            ${menu("Export", "filtered", [["csv", "Summary CSV (shown)"], ["detailcsv", "Detailed CSV with answers (shown)"], ["backup", "Backup file, JSON (shown)"]])}
            <details class="menu">
              <summary class="btn btn-small">More</summary>
              <div class="menu-list">
                ${a ? `
                <button type="button" data-act="restore-filtered">Restore all shown</button>
                <button type="button" data-act="delete-filtered" class="danger">Permanently delete all shown…</button>` : `
                <button type="button" data-act="regrade-filtered">Regrade all shown</button>
                <button type="button" data-act="archive-filtered">Archive all shown</button>
                <button type="button" data-act="delete-filtered" class="danger">Delete all shown…</button>`}
              </div>
            </details>
          </div>
        </div>

        <div class="selection-bar" data-selection hidden>
          <b data-sel-count></b>
          ${a ? `
          <button type="button" class="btn btn-small" data-act="restore-selected">Restore</button>` : `
          <button type="button" class="btn btn-small" data-act="grade-selected">Grade</button>
          <button type="button" class="btn btn-small" data-act="accept-selected">Accept</button>
          <button type="button" class="btn btn-small" data-act="decline-selected">Decline</button>`}
          ${menu("Print", "selected", [["print", "Results by student"], ["sheets", "Answer sheets by student"]])}
          ${menu("Export", "selected", [["csv", "Summary CSV"], ["detailcsv", "Detailed CSV with answers"], ["backup", "Backup file (JSON)"]])}
          ${a ? "" : '<button type="button" class="btn btn-small" data-act="archive-selected">Archive</button>'}
          <button type="button" class="btn btn-small btn-danger" data-act="delete-selected">Delete</button>
          <button type="button" class="btn-link small" data-act="clear-selection">Clear selection</button>
        </div>

        <div class="table-wrap">
          <table class="data-table records-table">
            <thead>
              <tr>
                <th class="col-check"><input type="checkbox" data-act="select-all" aria-label="Select all shown records"></th>
                <th data-sort="studentName">Student</th>
                <th data-sort="rollNum" class="num">Roll</th>
                <th data-sort="grade">Grade</th>
                <th data-sort="section">Section</th>
                <th data-sort="quizTitle">Quiz</th>
                <th data-sort="obtained" class="num">Marks</th>
                <th data-sort="percentage" class="num">%</th>
                <th data-sort="statusOrder">Status</th>
                <th data-sort="focusLossCount" class="num" title="Times the student left the quiz page">Left</th>
                <th data-sort="submittedMs">Submitted</th>
                <th class="col-actions"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody data-body></tbody>
          </table>
        </div>
        <div class="empty" data-empty hidden></div>
        <div class="center load-more"><button type="button" class="btn btn-small" data-act="load-more" hidden>Load more</button></div>
      </div>`;
    this.$ = (sel) => this.el.querySelector(sel);
  }

  bind() {
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("change", (e) => this.onChange(e));
    this.$('[data-filter="search"]').addEventListener("input", () => this.render());
    document.addEventListener("click", (e) => {
      this.el.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
  }

  // ---------------------------------------------------------------- loading

  saveScope() { storage.set(`cq_scope_${this.source}`, this.scope); }

  async load({ more = false } = {}) {
    // A scope change while loading: load again once the current load ends.
    if (this.busy) { if (!more) this.reloadAfter = true; return; }
    this.busy = true;
    this.reloadAfter = false;
    const info = this.$(".data-info");
    info.textContent = "Loading…";
    if (!more) { this.$("[data-body]").innerHTML = skeletonRows(12, 8); this.$("[data-empty]").hidden = true; }
    try {
      if (!more) { this.items = []; this.results = new Map(); this.cursor = null; this.selected.clear(); }
      const page = await queryAttempts(this.source, this.scope, { pageSize: PAGE_SIZE, cursor: more ? this.cursor : null });
      this.items = more ? [...this.items, ...page.items] : page.items;
      this.cursor = page.cursor;
      this.hasMore = page.hasMore;
      const res = await fetchResults(this.source, page.items.map((a) => a.id));
      res.forEach((v, k) => this.results.set(k, v));
      this.loaded = true;
      this.buildRows();
      info.textContent = `${pluralize(this.items.length, "record")} loaded at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      if (!more) this.loadCounts();
      this.renderBrowse();
      this.render();
    } catch (err) {
      console.error(err);
      info.textContent = "";
      appNotice(`Could not load records. ${friendlyError(err)}`, "error");
    } finally {
      this.busy = false;
      if (this.reloadAfter) this.load();
    }
  }

  /** Small count queries for the Grade / Section chips. */
  async loadCounts() {
    try {
      const grades = teacher.settings.grades;
      const gCounts = await Promise.all(grades.map((g) => countAttempts(this.source, { grade: g, quizId: this.scope.quizId })));
      this.counts.grades = new Map(grades.map((g, i) => [g, gCounts[i]]));
      this.counts.sections = new Map();
      if (this.scope.grade) {
        const secs = this.sectionChoices();
        const sCounts = await Promise.all(secs.map((s) => countAttempts(this.source, { grade: this.scope.grade, section: s, quizId: this.scope.quizId })));
        this.counts.sections = new Map(secs.map((s, i) => [s, sCounts[i]]));
      }
      this.renderBrowse();
    } catch (err) {
      console.warn("Counts unavailable", err);
    }
  }

  sectionChoices() {
    const g = this.scope.grade;
    const fromSettings = sectionsFor(teacher.settings, g);
    const seen = this.items.filter((a) => a.grade === g).map((a) => a.section);
    return [...new Set([...fromSettings, ...seen, ...(this.scope.section ? [this.scope.section] : [])])];
  }

  // ------------------------------------------------------------- row model

  buildRows() {
    this.rows = this.items.map((a) => toRow(a, this.results.get(a.id) || null, this.isArchive));
  }

  filteredRows() {
    const term = this.$('[data-filter="search"]').value.trim().toLowerCase();
    const status = this.$('[data-filter="status"]').value;
    const from = this.$('[data-filter="from"]').value;
    const to = this.$('[data-filter="to"]').value;
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    const rollTerm = term.replace(/^0+(?=\d)/, "");
    return this.rows.filter((r) => {
      if (term && !(r.nameLower.includes(term) || String(r.rollNo) === rollTerm)) return false;
      if ((fromMs || toMs) && !r.submittedMs) return false;
      if (fromMs && r.submittedMs < fromMs) return false;
      if (toMs && r.submittedMs > toMs) return false;
      switch (status) {
        case "in_progress": return r.grading === "in_progress";
        case "ungraded": return r.grading === "ungraded" || r.grading === "stale";
        case "graded": return r.grading === "graded";
        case "pending": case "accepted": case "declined": return r.review === status;
        case "passed": return r.passed === true;
        case "failed": return r.passed === false;
        case "flagged": return r.focusLossCount >= FLAG_THRESHOLD;
        case "previous": return r.previous;
        default: return true;
      }
    });
  }

  sortedRows(rows) {
    return sortRows(rows, this.sort);
  }

  // -------------------------------------------------------------- rendering

  renderBrowse() {
    const s = this.scope;
    const chip = (level, value, label, count) =>
      `<button type="button" class="chip${(s[level] || "") === value ? " active" : ""}" data-scope-${level}="${escapeHtml(value)}">${escapeHtml(label)}${count !== undefined ? ` <span class="chip-count">${count}</span>` : ""}</button>`;
    this.$('[data-level="grade"]').innerHTML = chip("grade", "", "All grades") +
      teacher.settings.grades.map((g) => chip("grade", g, `Grade ${g}`, this.counts.grades.get(g))).join("");
    const secRow = this.$('[data-row="section"]');
    secRow.hidden = !s.grade;
    if (s.grade) {
      this.$('[data-level="section"]').innerHTML = chip("section", "", "All sections") +
        this.sectionChoices().map((x) => chip("section", x, x, this.counts.sections.get(x))).join("");
    }
    const quizSel = this.$(".scope-quiz");
    const quizzes = sortedQuizzes({ grade: s.grade, includeArchived: true });
    quizSel.innerHTML = `<option value="">All quizzes${s.grade ? ` for Grade ${escapeHtml(s.grade)}` : ""}</option>` +
      quizzes.map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.title)}${q.grade && !s.grade ? ` (Grade ${escapeHtml(q.grade)})` : ""}${q.archived ? " [archived]" : ""}</option>`).join("");
    if (s.quizId && !quizzes.some((q) => q.id === s.quizId)) {
      quizSel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(s.quizId)}">${escapeHtml(quizTitle(s.quizId))}</option>`);
    }
    quizSel.value = s.quizId;
  }

  statusCell(r) {
    if (r.grading === "in_progress") return `<span class="badge">In progress ${r.answeredCount}/${r.questionCount}</span>`;
    const g = r.grading === "graded"
      ? (r.passed ? '<span class="badge badge-success">Pass</span>' : '<span class="badge badge-danger">Fail</span>')
      : `<span class="badge badge-warning">${r.gradingLabel}</span>`;
    const rv = r.review === "accepted" ? '<span class="badge badge-info">Accepted</span>'
      : r.review === "declined" ? '<span class="badge badge-danger-outline">Declined</span>'
        : '<span class="badge badge-muted">Pending review</span>';
    return `<div class="status-stack">${g}${rv}${r.previous ? '<span class="badge">Previous attempt</span>' : ""}</div>`;
  }

  rowActions(r) {
    const history = historyLink(r.grade, r.section, r.rollNo);
    const view = `result.html?id=${encodeURIComponent(r.id)}${this.isArchive ? "&source=archive" : ""}`;
    const items = [
      `<a href="${view}">View details</a>`,
      `<a href="${history}">Student history</a>`
    ];
    if (this.isArchive) {
      items.push(`<button type="button" data-row-act="restore" data-id="${escapeHtml(r.id)}">Restore</button>`);
    } else {
      if (r.submitted) {
        items.push(`<button type="button" data-row-act="grade" data-id="${escapeHtml(r.id)}">${r.grading === "graded" ? "Recalculate" : "Grade"}</button>`);
        if (r.review !== "accepted") items.push(`<button type="button" data-row-act="accept" data-id="${escapeHtml(r.id)}">Accept</button>`);
        if (r.review !== "declined") items.push(`<button type="button" data-row-act="decline" data-id="${escapeHtml(r.id)}">Decline</button>`);
        if (r.review !== "pending") items.push(`<button type="button" data-row-act="pending" data-id="${escapeHtml(r.id)}">Mark pending review</button>`);
      }
      items.push(`<button type="button" data-row-act="print" data-id="${escapeHtml(r.id)}">Print report</button>`);
      items.push(`<button type="button" data-row-act="archive" data-id="${escapeHtml(r.id)}">Archive</button>`);
    }
    items.push(`<button type="button" data-row-act="delete" data-id="${escapeHtml(r.id)}" class="danger">${this.isArchive ? "Delete permanently" : "Delete"}</button>`);
    return `<details class="menu row-menu"><summary class="btn btn-small" aria-label="Actions for ${escapeHtml(r.studentName)}">⋯</summary><div class="menu-list">${items.join("")}</div></details>`;
  }

  render() {
    if (!this.loaded) return;
    const all = this.rows;
    const shown = this.sortedRows(this.filteredRows());
    this.shown = shown;

    if (!this.isArchive) this.renderSummary(all);

    paintSortHeaders(this.el, this.sort);

    this.$("[data-body]").innerHTML = shown.map((r) => `
      <tr data-id="${escapeHtml(r.id)}" class="${this.selected.has(r.id) ? "selected" : ""}">
        <td class="col-check"><input type="checkbox" data-select="${escapeHtml(r.id)}"${this.selected.has(r.id) ? " checked" : ""} aria-label="Select ${escapeHtml(r.studentName)}"></td>
        <td class="name-cell"><a href="result.html?id=${encodeURIComponent(r.id)}${this.isArchive ? "&source=archive" : ""}">${escapeHtml(r.studentName)}</a></td>
        <td class="num">${escapeHtml(r.rollNo)}</td>
        <td>${escapeHtml(r.grade)}</td>
        <td>${escapeHtml(r.section)}</td>
        <td class="quiz-cell">${escapeHtml(r.quizTitle)}</td>
        <td class="num">${r.obtained === null ? "—" : `${r.obtained}/${r.total}`}</td>
        <td class="num">${r.percentage === null ? "—" : `${r.percentage}%`}</td>
        <td>${this.statusCell(r)}</td>
        <td class="num">${r.focusLossCount >= FLAG_THRESHOLD ? `<span class="badge badge-warning">${r.focusLossCount}</span>` : r.focusLossCount}</td>
        <td class="small nowrap">${r.submittedMs ? escapeHtml(formatDateTime(r.attempt.submittedAt)) : "—"}</td>
        <td class="col-actions">${this.rowActions(r)}</td>
      </tr>`).join("");

    const filtersOn = ["search", "status", "from", "to"].some((f) => this.$(`[data-filter="${f}"]`).value);
    this.$("[data-count]").textContent = filtersOn
      ? `Showing ${shown.length} of ${pluralize(all.length, "record")}${this.hasMore ? " loaded" : ""}`
      : `${pluralize(all.length, "record")}${this.hasMore ? " loaded (more available)" : ""}`;
    const empty = this.$("[data-empty]");
    if (!all.length) {
      empty.textContent = this.isArchive ? "No archived records here." : "No student records here yet.";
      empty.hidden = false;
    } else if (!shown.length) {
      empty.textContent = "No records match these filters.";
      empty.hidden = false;
    } else empty.hidden = true;
    this.$(".records-table").hidden = !shown.length;
    this.$('[data-act="load-more"]').hidden = !this.hasMore;
    this.renderSelection();
  }

  renderSummary(rows) {
    const o = overview(rows);
    const unit = o.unit === "marks" ? (o.totalMarks ? ` / ${o.totalMarks}` : "") : "%";
    const cards = [
      ["Students", o.totalStudents],
      ["Submissions", o.totalSubmissions, o.inProgress ? `${o.inProgress} in progress` : ""],
      ["Graded", o.graded, o.declined ? `${o.declined} declined (not counted)` : ""],
      [o.unit === "marks" ? "Average marks" : "Average score", o.average === null ? "—" : `${o.average}${unit}`],
      [o.unit === "marks" ? "Highest" : "Highest score", o.highest === null ? "—" : `${o.highest}${unit}`],
      [o.unit === "marks" ? "Lowest" : "Lowest score", o.lowest === null ? "—" : `${o.lowest}${unit}`],
      ["Needs grading", o.ungraded, "", o.ungraded ? "warn" : ""]
    ];
    this.$("[data-summary]").innerHTML = cards.map(([label, value, sub, kind]) => `
      <div class="summary-card ${kind || ""}">
        <div class="summary-label">${escapeHtml(label)}</div>
        <div class="summary-value">${escapeHtml(value)}</div>
        ${sub ? `<div class="summary-sub">${escapeHtml(sub)}</div>` : ""}
      </div>`).join("");
    const eligible = this.eligibleForGrading(rows).length;
    this.$("[data-grade-banner]").hidden = eligible === 0;
    this.$("[data-grade-text]").textContent = `${pluralize(eligible, "submission")} ${eligible === 1 ? "needs" : "need"} grading.`;
  }

  renderSelection() {
    const n = [...this.selected].filter((id) => this.rows.some((r) => r.id === id)).length;
    this.$("[data-selection]").hidden = n === 0;
    this.$("[data-sel-count]").textContent = `${n} selected`;
    const all = this.$('[data-act="select-all"]');
    const shownIds = (this.shown || []).map((r) => r.id);
    const selShown = shownIds.filter((id) => this.selected.has(id)).length;
    all.checked = shownIds.length > 0 && selShown === shownIds.length;
    all.indeterminate = selShown > 0 && selShown < shownIds.length;
  }

  // ----------------------------------------------------------------- events

  onChange(e) {
    const t = e.target;
    if (t.matches("[data-select]")) {
      if (t.checked) this.selected.add(t.dataset.select); else this.selected.delete(t.dataset.select);
      t.closest("tr").classList.toggle("selected", t.checked);
      this.renderSelection();
    } else if (t.matches('[data-act="select-all"]')) {
      (this.shown || []).forEach((r) => { if (t.checked) this.selected.add(r.id); else this.selected.delete(r.id); });
      this.render();
    } else if (t.matches("[data-filter]")) {
      this.render();
    } else if (t.matches(".scope-quiz")) {
      this.scope.quizId = t.value;
      this.saveScope();
      this.load();
    }
  }

  onClick(e) {
    const scopeBtn = e.target.closest("[data-scope-grade],[data-scope-section]");
    if (scopeBtn) {
      if (scopeBtn.hasAttribute("data-scope-grade")) {
        this.scope.grade = scopeBtn.dataset.scopeGrade;
        this.scope.section = "";
        const q = teacher.quizzes.get(this.scope.quizId);
        if (q && q.grade && this.scope.grade && q.grade !== this.scope.grade) this.scope.quizId = "";
      } else {
        this.scope.section = scopeBtn.dataset.scopeSection;
      }
      this.saveScope();
      this.load();
      return;
    }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      this.sort = nextSort(this.sort, th.dataset.sort, ["obtained", "percentage", "submittedMs", "focusLossCount"]);
      this.render();
      return;
    }
    const rowBtn = e.target.closest("[data-row-act]");
    if (rowBtn) {
      rowBtn.closest("details")?.removeAttribute("open");
      const row = this.rows.find((r) => r.id === rowBtn.dataset.id);
      if (row) this.runAction(rowBtn.dataset.rowAct, [row], "this record");
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act || act.matches('input[type="checkbox"]')) return;
    act.closest("details")?.removeAttribute("open");
    const name = act.dataset.act;
    if (name === "refresh") { this.load(); return; }
    if (name === "load-more") { this.load({ more: true }); return; }
    if (name === "clear-filters") {
      ["search", "status", "from", "to"].forEach((f) => { this.$(`[data-filter="${f}"]`).value = ""; });
      this.render();
      return;
    }
    if (name === "clear-selection") { this.selected.clear(); this.render(); return; }
    if (name === "grade-eligible") { this.runAction("grade", this.eligibleForGrading(this.rows), "eligible records"); return; }
    const [verb, which] = name.split("-");
    const targets = which === "selected"
      ? this.rows.filter((r) => this.selected.has(r.id))
      : (this.shown || []);
    this.runAction(verb === "regrade" ? "regrade" : verb, targets, which === "selected" ? "selected records" : "records shown");
  }

  eligibleForGrading(rows) {
    return rows.filter((r) => r.submitted && r.review !== "declined" && (r.grading === "ungraded" || r.grading === "stale"));
  }

  // ---------------------------------------------------------------- actions

  scopeDescription() {
    const parts = [];
    if (this.scope.grade) parts.push(`Grade ${this.scope.grade}`);
    if (this.scope.section) parts.push(`Section ${this.scope.section}`);
    if (this.scope.quizId) parts.push(quizTitle(this.scope.quizId));
    const status = this.$('[data-filter="status"]');
    if (status.value) parts.push(status.options[status.selectedIndex].text);
    const term = this.$('[data-filter="search"]').value.trim();
    if (term) parts.push(`Search "${term}"`);
    const from = this.$('[data-filter="from"]').value, to = this.$('[data-filter="to"]').value;
    if (from || to) parts.push(`Submitted ${from || "…"} to ${to || "…"}`);
    return parts.join(" · ") || "All records";
  }

  async runAction(verb, rows, label) {
    if (!rows.length) { appNotice("There are no records for this action.", "info"); return; }
    try {
      switch (verb) {
        case "grade": return await this.grade(rows.filter((r) => r.submitted && r.review !== "declined"), rows);
        case "regrade": {
          const ok = await confirmDialog({ title: `Regrade ${pluralize(rows.length, "record")}?`, text: "Uses the current answer keys. Manual corrections are kept.", okText: "Regrade" });
          if (ok) await this.grade(rows.filter((r) => r.submitted && r.review !== "declined"), rows);
          return;
        }
        case "accept": case "decline": case "pending": return await this.review(verb, rows);
        case "print": return await this.print(rows, false);
        case "sheets": return await this.print(rows, true);
        case "csv": return this.exportCsv(rows);
        case "detailcsv": return await this.exportDetailedCsv(rows);
        case "backup": return this.exportBackup(rows);
        case "archive": return await this.archive(rows, label);
        case "restore": return await this.restore(rows);
        case "delete": return await this.delete(rows, label);
        default: return undefined;
      }
    } catch (err) {
      console.error(err);
      const partial = err?.completed ? ` ${err.completed} record(s) were completed before the error; the rest were not changed.` : "";
      appNotice(`The action did not finish. ${friendlyError(err)}${partial}`, "error");
      if (err?.completed) this.load();
    }
  }

  async grade(rows, original) {
    const skippedDeclined = original.filter((r) => r.review === "declined").length;
    const skippedOpen = original.filter((r) => !r.submitted).length;
    if (!rows.length) {
      appNotice(`Nothing to grade.${skippedDeclined ? " Declined submissions are not graded." : ""}${skippedOpen ? " Quizzes still in progress cannot be graded." : ""}`, "info");
      return;
    }
    appNotice(`Grading ${pluralize(rows.length, "submission")}…`, "info");
    clearKeyCache();
    const { graded, skipped, results } = await gradeAttempts(rows.map((r) => r.attempt), this.results, teacher.settings.passPercent,
      (done, total) => appNotice(`Grading ${done} of ${total}…`, "info"));
    results.forEach((r, id) => this.results.set(id, r));
    this.buildRows();
    this.render();
    const notes = [];
    if (skipped.length) notes.push(`${skipped.length} could not be graded because their quiz has no answer key (import the question bank again).`);
    if (skippedDeclined) notes.push(`${skippedDeclined} declined skipped.`);
    if (skippedOpen) notes.push(`${skippedOpen} still in progress skipped.`);
    appNotice(`Graded ${pluralize(graded, "submission")}. ${notes.join(" ")}`.trim(), skipped.length ? "warning" : "success");
    this.onChanged?.("grade");
  }

  async review(status, rows) {
    const eligible = rows.filter((r) => r.submitted);
    if (!eligible.length) { appNotice("Only submitted quizzes can be accepted or declined.", "info"); return; }
    let note = "";
    if (status === "decline") {
      const ok = await confirmDialog({
        title: `Decline ${pluralize(eligible.length, "submission")}?`,
        text: "They are left out of grades and averages. You can accept them later.",
        okText: "Decline"
      });
      if (!ok) return;
      note = "Declined by teacher";
    }
    const value = status === "accept" ? "accepted" : status === "decline" ? "declined" : "pending";
    await setReviewStatus(eligible, value, note);
    const now = new Date();
    eligible.forEach((r) => Object.assign(r.attempt, { reviewStatus: value, reviewedAt: now }));
    this.buildRows();
    this.render();
    appNotice(`${pluralize(eligible.length, "submission")} marked as ${REVIEW_LABELS[value].toLowerCase()}.`, "success");
    this.onChanged?.("review");
  }

  async print(rows, includeAnswers) {
    appNotice(`Preparing the report…`, "info");
    const single = rows.length === 1;
    const html = await buildReport(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })), {
      title: single ? "Quiz report" : includeAnswers ? "Answer sheets" : (this.isArchive ? "Archived results by student" : "Results by student"),
      subtitle: this.scopeDescription(),
      quizzes: teacher.quizzes,
      passPercent: teacher.settings.passPercent,
      includeAnswers: single || includeAnswers
    });
    appNotice(`Report ready. Choose "Save as PDF" in the print dialog for one combined PDF.`, "success");
    printHtml(html);
  }

  fileStem() {
    const s = this.scope;
    return [this.isArchive ? "archive" : "results", s.grade && `grade-${s.grade}`, s.section && `section-${s.section}`, s.quizId, new Date().toISOString().slice(0, 10)]
      .filter(Boolean).join("_").replace(/[^A-Za-z0-9_.-]+/g, "-");
  }

  exportCsv(rows) {
    downloadFile(`${this.fileStem()}_summary.csv`, summaryCsv(rows));
    appNotice(`Exported ${pluralize(rows.length, "record")} to a summary CSV.`, "success");
  }

  async exportDetailedCsv(rows) {
    appNotice("Preparing the detailed CSV…", "info");
    const csv = await detailedCsv(rows, { quizzes: teacher.quizzes, passPercent: teacher.settings.passPercent });
    downloadFile(`${this.fileStem()}_detailed.csv`, csv);
    appNotice(`Exported ${pluralize(rows.length, "record")} to a detailed CSV (one row per question).`, "success");
  }

  exportBackup(rows) {
    downloadFile(`${this.fileStem()}_backup.json`, buildBackup(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })), this.source), "application/json");
    appNotice(`Downloaded a backup of ${pluralize(rows.length, "record")}.`, "success");
  }

  async archive(rows, label) {
    const ok = await confirmDialog({
      title: `Archive ${pluralize(rows.length, "record")}?`,
      text: `The ${label} move to the Archive. You can restore them later.`,
      okText: "Archive"
    });
    if (!ok) return;
    const n = await archiveRecords(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })),
      (d, t) => appNotice(`Archiving ${d} of ${t}…`, "info"));
    this.removeRows(rows);
    appNotice(`Archived ${pluralize(n, "record")}. Find them on the Archive & backup tab.`, "success");
    this.onChanged?.("move");
  }

  async restore(rows) {
    const ok = await confirmDialog({ title: `Restore ${pluralize(rows.length, "record")}?`, text: "They move back to the Results tab.", okText: "Restore" });
    if (!ok) return;
    const { restored, renamed } = await restoreRecords(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })),
      (d, t) => appNotice(`Restoring ${d} of ${t}…`, "info"));
    this.removeRows(rows);
    appNotice(`Restored ${pluralize(restored, "record")} to Results.${renamed ? ` ${renamed} got a new ID because the student already has a newer attempt for that quiz.` : ""}`, "success");
    this.onChanged?.("move");
  }

  async delete(rows, label) {
    const n = rows.length;
    const filtered = label === "records shown";
    const res = await confirmDialog({
      title: `${this.isArchive ? "Permanently delete" : "Delete"} ${pluralize(n, "record")}?`,
      text: `This permanently deletes the ${label}. It cannot be undone.`,
      okText: `Delete ${pluralize(n, "record")}`,
      danger: true,
      option: { label: "Download a backup file of these records first (recommended)", checked: true },
      check: filtered || n > 1 ? `Yes, delete these ${pluralize(n, "record")}` : ""
    });
    if (!res) return;
    if (res.option) this.exportBackup(rows);
    const done = await deleteRecords(this.source, rows, (d, t) => appNotice(`Deleting ${d} of ${t}…`, "info"));
    this.removeRows(rows);
    appNotice(`Deleted ${pluralize(done, "record")}.`, "success");
    this.onChanged?.("delete");
  }

  removeRows(rows) {
    const ids = new Set(rows.map((r) => r.id));
    this.items = this.items.filter((a) => !ids.has(a.id));
    ids.forEach((id) => { this.results.delete(id); this.selected.delete(id); });
    this.buildRows();
    this.render();
    this.loadCounts();
  }
}
