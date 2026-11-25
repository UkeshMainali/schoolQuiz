// Student history: find students and show every attempt of one student
// (grade + section + roll number) across all quizzes, from the results and,
// optionally, the archive. Used by the dashboard's "Student history" tab
// (student.html only forwards old links there).

import { queryAttempts, fetchResults } from "./records.js";
import { toRow } from "./recordsView.js";
import { groupByStudent, performance, studentKey } from "./analytics.js";
import { teacher, appNotice, onTeacherChange } from "./teacherState.js";
import { sortRows, nextSort, paintSortHeaders } from "./tableSort.js";
import { buildReport, printHtml } from "./print.js";
import { escapeHtml, formatDateTime, friendlyError, sectionsFor, normalizeRoll, pluralize, storage, skeleton } from "./utilities.js";

const MAX_RECORDS = 3000;
const fmt = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);

// Sort values of the student list (one row per student).
const GROUP_VALUE = {
  name: (g) => g.names.join(" / "),
  rollNum: (g) => Number(g.rollNo),
  grade: (g) => g.grade,
  section: (g) => g.section,
  attempted: (g) => g.perf.attempted,
  counted: (g) => g.perf.counted,
  overall: (g) => g.perf.overallPercent,
  average: (g) => g.perf.averagePercent,
  latestMs: (g) => g.latestMs
};
const GROUP_DESC_FIRST = ["attempted", "counted", "overall", "average", "latestMs"];
const DETAIL_DESC_FIRST = ["submittedMs", "obtained", "percentage", "focusLossCount"];


export class HistoryView {
  constructor(container) {
    this.el = container;
    this.cache = new Map();
    this.rows = [];
    this.groups = [];
    this.sort = { key: "section", dir: "asc" }; // then roll number (same order as before)
    this.detailSort = { key: "quizTitle", dir: "asc" };
    const saved = storage.get("cq_history_scope") || {};
    this.scope = { grade: saved.grade || "", section: saved.section || "", archive: saved.archive !== false };
    this.el.innerHTML = `
      <div class="card filters-card">
        <div class="filters">
          <label class="stack-field"><span>Grade</span><select data-h="grade"></select></label>
          <label class="stack-field"><span>Section</span><select data-h="section"></select></label>
          <label class="stack-field grow"><span>Search</span><input type="search" data-h="search" placeholder="Name or roll no."></label>
          <label class="check inline"><input type="checkbox" data-h="archive"> Include archived</label>
          <button type="button" class="btn" data-h="refresh">Refresh</button>
        </div>
      </div>
      <div data-h="list"></div>
      <div data-h="detail" hidden></div>`;
    this.$ = (k) => this.el.querySelector(`[data-h="${k}"]`);
    this.$("grade").addEventListener("change", () => { this.scope.grade = this.$("grade").value; this.scope.section = ""; this.fillSections(); this.load(); });
    this.$("section").addEventListener("change", () => { this.scope.section = this.$("section").value; this.load(); });
    this.$("archive").addEventListener("change", () => { this.scope.archive = this.$("archive").checked; this.load(); });
    this.$("search").addEventListener("input", () => this.renderList());
    this.$("refresh").addEventListener("click", () => { this.cache.clear(); if (this.current) this.openStudent(this.current); else this.load(); });
    this.el.addEventListener("click", (e) => this.onClick(e));
    document.addEventListener("click", (e) => {
      this.el.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
    onTeacherChange(() => { if (this.initialised) this.fillFilters(); });
  }

  fillFilters() {
    const grades = teacher.settings.grades;
    if (!grades.includes(this.scope.grade)) this.scope.grade = grades[0] || "";
    this.$("grade").innerHTML = grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("");
    this.$("grade").value = this.scope.grade;
    this.$("archive").checked = this.scope.archive;
    this.fillSections();
  }

  fillSections() {
    const list = sectionsFor(teacher.settings, this.scope.grade);
    this.$("section").innerHTML = '<option value="">All sections</option>' + list.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    this.$("section").value = list.includes(this.scope.section) ? this.scope.section : "";
    this.scope.section = this.$("section").value;
  }

  /** First display of the tab. */
  async show() {
    if (!this.initialised) { this.fillFilters(); this.initialised = true; }
    if (!this.current && !this.loadedKey) await this.load();
  }

  invalidate() { this.cache.clear(); this.loadedKey = null; }

  async fetch(scope, archive) {
    const key = JSON.stringify({ ...scope, archive });
    if (this.cache.has(key)) return this.cache.get(key);
    const sources = archive ? ["active", "archive"] : ["active"];
    let rows = [];
    let capped = false;
    for (const source of sources) {
      let cursor = null, more = true, items = [];
      while (more && items.length < MAX_RECORDS) {
        const page = await queryAttempts(source, scope, { pageSize: 500, cursor });
        items = items.concat(page.items);
        cursor = page.cursor;
        more = page.hasMore;
      }
      capped = capped || more;
      const results = await fetchResults(source, items.map((a) => a.id));
      rows = rows.concat(items.map((a) => ({ ...toRow(a, results.get(a.id) || null, source === "archive"), archived: source === "archive" })));
    }
    const out = { rows, capped };
    this.cache.set(key, out);
    return out;
  }

  // ------------------------------------------------------------ student list

  async load() {
    storage.set("cq_history_scope", this.scope);
    this.current = null;
    this.$("detail").hidden = true;
    this.$("list").hidden = false;
    const scope = { grade: this.scope.grade, section: this.scope.section };
    this.loadedKey = JSON.stringify(this.scope);
    this.$("list").innerHTML = skeleton("table", { cols: 8, rows: 8 });
    try {
      const { rows, capped } = await this.fetch(scope, this.scope.archive);
      this.rows = rows;
      this.capped = capped;
      this.groups = groupByStudent(rows).map((g) => ({
        ...g,
        perf: performance(g.rows),
        latestMs: Math.max(0, ...g.rows.map((r) => r.submittedMs || 0)) || null
      }));
      this.renderList();
    } catch (err) {
      console.error(err);
      this.$("list").innerHTML = "";
      appNotice(`Could not load students. ${friendlyError(err)}`, "error");
    }
  }

  /** Students matching the search, sorted by the chosen column (the whole filtered list, not just what is on screen). */
  visibleGroups() {
    const term = this.$("search").value.trim().toLowerCase();
    const roll = term ? normalizeRoll(term) : null;
    const list = term ? this.groups.filter((g) => (roll && g.rollNo === roll) || g.names.some((n) => n.toLowerCase().includes(term))) : this.groups;
    return sortRows(list, this.sort, {
      value: (g, k) => GROUP_VALUE[k](g),
      tieBreak: (a, b) => Number(a.rollNo) - Number(b.rollNo)
    });
  }

  renderList() {
    if (this.current) return;
    const list = this.visibleGroups();
    const box = this.$("list");
    if (!this.groups.length) {
      box.innerHTML = `<div class="card empty">No student records for Grade ${escapeHtml(this.scope.grade)}${this.scope.section ? `, Section ${escapeHtml(this.scope.section)}` : ""}.</div>`;
      return;
    }
    box.innerHTML = `
      <div class="card table-card">
        <div class="table-head">
          <span class="small muted">${pluralize(list.length, "student")}${list.length !== this.groups.length ? ` of ${this.groups.length}` : ""}${this.capped ? " (first 3,000 records only: choose a section)" : ""}</span>
          <div class="table-actions">
            <details class="menu">
              <summary class="btn btn-small">Print</summary>
              <div class="menu-list">
                <button type="button" data-act="print-list">Histories of the students shown</button>
                <button type="button" data-act="print-list-answers">Histories with answers</button>
              </div>
            </details>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th data-sort="name">Student</th><th data-sort="rollNum" class="num">Roll</th><th data-sort="grade">Grade</th><th data-sort="section">Section</th><th data-sort="attempted" class="num" title="Quizzes attempted">Quizzes</th><th data-sort="counted" class="num" title="Graded, not declined, latest attempt per quiz">Counted</th><th data-sort="overall" class="num" title="Total marks ÷ total possible">Overall</th><th data-sort="average" class="num" title="Mean of quiz percentages">Average</th><th data-sort="latestMs">Last submitted</th><th class="actions-col"></th></tr></thead>
            <tbody>${list.map((g) => `
              <tr>
                <td class="name-cell"><button type="button" class="link-btn" data-open="${escapeHtml(g.key)}">${escapeHtml(g.names.join(" / "))}</button></td>
                <td class="num">${escapeHtml(g.rollNo)}</td>
                <td>${escapeHtml(g.grade)}</td>
                <td>${escapeHtml(g.section)}</td>
                <td class="num">${g.perf.attempted}</td>
                <td class="num">${g.perf.counted}</td>
                <td class="num">${fmt(g.perf.overallPercent, "%")}</td>
                <td class="num">${fmt(g.perf.averagePercent, "%")}</td>
                <td class="small nowrap">${g.latestMs ? escapeHtml(formatDateTime(new Date(g.latestMs))) : "—"}</td>
                <td class="col-actions"><button type="button" class="btn btn-small" data-open="${escapeHtml(g.key)}">Open</button></td>
              </tr>`).join("") || '<tr><td colspan="10" class="empty">No student matches this search.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
    paintSortHeaders(box.querySelector("table"), this.sort);
  }

  // ---------------------------------------------------------- one student

  /** student: { grade, section, rollNo } */
  async openStudent(student) {
    if (!this.initialised) { this.initialised = true; this.scope.grade = student.grade; this.fillFilters(); }
    this.current = student;
    this.$("list").hidden = true;
    const box = this.$("detail");
    box.hidden = false;
    box.innerHTML = skeleton("page", { cols: 7, rows: 5 });
    try {
      const { rows } = await this.fetch({ grade: student.grade, section: student.section, rollNo: student.rollNo }, this.scope.archive);
      this.renderDetail(student, rows);
    } catch (err) {
      console.error(err);
      box.innerHTML = "";
      appNotice(`Could not load the history. ${friendlyError(err)}`, "error");
    }
  }

  renderDetail(student, rows) {
    const box = this.$("detail");
    this.detailStudent = student;
    this.detailAll = rows;
    this.detailRows = sortRows(rows, this.detailSort, {
      tieBreak: (a, b) => String(a.quizTitle).localeCompare(String(b.quizTitle), undefined, { numeric: true }) || ((a.submittedMs || Infinity) - (b.submittedMs || Infinity))
    });
    const back = '<button type="button" class="btn btn-small btn-back" data-act="back">← All students</button>';
    if (!rows.length) {
      box.innerHTML = `<div class="card">${back}<p class="empty">No records for roll ${escapeHtml(student.rollNo)}, Grade ${escapeHtml(student.grade)}, Section ${escapeHtml(student.section)}.</p></div>`;
      return;
    }
    const names = [...new Set(rows.map((r) => r.studentName))];
    const perf = performance(rows);
    const status = (r) => {
      const parts = [];
      if (r.archived) parts.push('<span class="badge badge-muted">Archived</span>');
      if (r.previous) parts.push('<span class="badge badge-muted">Previous attempt</span>');
      if (r.grading === "in_progress") parts.push('<span class="badge badge-muted">In progress</span>');
      else if (r.grading === "graded") parts.push(r.passed ? '<span class="badge badge-success">Pass</span>' : '<span class="badge badge-danger">Fail</span>');
      else if (r.review === "declined") parts.push('<span class="badge badge-muted">Not graded</span>');
      else parts.push(`<span class="badge badge-warning">${escapeHtml(r.gradingLabel)}</span>`);
      if (r.review === "accepted") parts.push('<span class="badge badge-info">Accepted</span>');
      else if (r.review === "declined") parts.push('<span class="badge badge-danger-outline">Declined</span>');
      else if (r.review === "pending") parts.push('<span class="badge badge-muted">Pending review</span>');
      return `<div class="status-stack">${parts.join("")}</div>`;
    };
    box.innerHTML = `
      <section class="card">
        <div class="card-head">
          <div>
            ${back}
            <h2 class="student-title">${escapeHtml(names.join(" / "))}</h2>
            <p class="muted">Roll ${escapeHtml(student.rollNo)} · Grade ${escapeHtml(student.grade)} · Section ${escapeHtml(student.section)}${names.length > 1 ? " · more than one name spelling used" : ""}</p>
          </div>
          <details class="menu">
            <summary class="btn btn-small">Print</summary>
            <div class="menu-list">
              <button type="button" data-act="print-one">History</button>
              <button type="button" data-act="print-one-answers">History with answers</button>
            </div>
          </details>
        </div>
        <div class="summary-grid compact">
          <div class="summary-card"><div class="summary-label">Quizzes attempted</div><div class="summary-value">${perf.attempted}</div></div>
          <div class="summary-card"><div class="summary-label">Counted</div><div class="summary-value">${perf.counted}</div><div class="summary-sub">${perf.finalized} accepted, ${perf.pending} pending</div></div>
          <div class="summary-card"><div class="summary-label">Marks</div><div class="summary-value">${perf.counted ? `${perf.obtained} / ${perf.possible}` : "—"}</div></div>
          <div class="summary-card"><div class="summary-label">Overall</div><div class="summary-value">${fmt(perf.overallPercent, "%")}</div><div class="summary-sub">total marks ÷ possible</div></div>
          <div class="summary-card"><div class="summary-label">Average</div><div class="summary-value">${fmt(perf.averagePercent, "%")}</div><div class="summary-sub">mean of quiz %</div></div>
        </div>
        <p class="small muted">Only the latest graded attempt of each quiz counts.</p>
      </section>
      <section class="card table-card">
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th data-sort="quizTitle">Quiz</th><th data-sort="studentName">Name used</th><th data-sort="submittedMs">Submitted</th><th data-sort="statusOrder">Status</th><th data-sort="obtained" class="num">Marks</th><th data-sort="percentage" class="num">%</th><th data-sort="focusLossCount" class="num" title="Times the student left the quiz page">Left</th><th class="actions-col"></th></tr></thead>
            <tbody>${this.detailRows.map((r) => `<tr class="${perf.countedIds.has(r.id) ? "" : "row-muted"}">
              <td>${escapeHtml(r.quizTitle)}${!perf.countedIds.has(r.id) ? `<div class="small muted">Not counted: ${escapeHtml(perf.notCounted(r).toLowerCase())}</div>` : ""}</td>
              <td>${escapeHtml(r.studentName)}</td>
              <td class="small nowrap">${r.submittedMs ? escapeHtml(formatDateTime(r.attempt.submittedAt)) : "—"}</td>
              <td>${status(r)}</td>
              <td class="num">${r.obtained === null ? "—" : `${r.obtained} / ${r.total}`}</td>
              <td class="num">${fmt(r.percentage, "%")}</td>
              <td class="num">${r.focusLossCount}</td>
              <td class="col-actions"><a class="btn btn-small" href="result.html?id=${encodeURIComponent(r.id)}${r.archived ? "&source=archive" : ""}">View</a></td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
      </section>`;
    paintSortHeaders(box, this.detailSort);
  }

  async onClick(e) {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      if (this.current) {
        this.detailSort = nextSort(this.detailSort, th.dataset.sort, DETAIL_DESC_FIRST);
        this.renderDetail(this.detailStudent, this.detailAll);
      } else {
        this.sort = nextSort(this.sort, th.dataset.sort, GROUP_DESC_FIRST);
        this.renderList();
      }
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      const g = this.groups.find((x) => x.key === open.dataset.open);
      if (g) this.openStudent({ grade: g.grade, section: g.section, rollNo: g.rollNo });
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    act.closest("details")?.removeAttribute("open");
    switch (act.dataset.act) {
      case "back": this.current = null; this.$("detail").hidden = true; this.$("list").hidden = false; this.renderList(); if (location.hash.startsWith("#history")) history.replaceState(null, "", location.pathname + location.search); break;
      case "print-one": await this.print(this.detailRows, false, "Student history"); break;
      case "print-one-answers": await this.print(this.detailRows, true, "Student history with answers"); break;
      case "print-list": await this.print(this.listRows(), false, "Student histories"); break;
      case "print-list-answers": await this.print(this.listRows(), true, "Student histories with answers"); break;
      default:
    }
  }

  listRows() {
    const keys = new Set(this.visibleGroups().map((g) => g.key));
    return this.rows.filter((r) => keys.has(studentKey(r)));
  }

  async print(rows, includeAnswers, title) {
    if (!rows?.length) { appNotice("There is nothing to print.", "info"); return; }
    appNotice("Preparing the report…", "info");
    const s = this.current || this.scope;
    const html = await buildReport(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result, archived: r.archived })), {
      title,
      subtitle: [`Grade ${s.grade}`, s.section && `Section ${s.section}`, this.scope.archive ? "including archived" : ""].filter(Boolean).join(" · "),
      quizzes: teacher.quizzes,
      passPercent: teacher.settings.passPercent,
      includeAnswers
    });
    appNotice('Report ready. Choose "Save as PDF" in the print dialog for one combined PDF.', "success");
    printHtml(html);
  }
}

/** Parses "#history=6|A|12" into { grade, section, rollNo } or null. */
export function parseHistoryHash(hash) {
  const m = /^#history=(.+)$/.exec(hash || "");
  if (!m) return null;
  const [grade, section, roll] = m[1].split("|").map(decodeURIComponent);
  const rollNo = normalizeRoll(roll);
  return grade && section && rollNo ? { grade, section, rollNo } : null;
}
