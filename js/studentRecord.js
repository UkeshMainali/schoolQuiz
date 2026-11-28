// Student Record: the central place for student identities and their records.
//
// The list shows every registered student of the chosen grade and section
// (students/{id}) with their performance, plus any older records that are
// not linked to a registered student yet. Opening a student shows every
// quiz they took, under any name they typed and in any class they were in
// (attempts are linked by the permanent studentId).
//
// Admin: add, edit (name, grade, section, roll number), print, export,
//        archive and delete. Teachers: view their classes, open each test's
//        answer sheet, grade and review, and send requests for the rest.
// Both roles can open a test's answer sheet right here and grade it.

import { fetchStudentRecords, queryAllAttempts, archiveRecords, deleteRecords, attemptIdParts, setReviewStatus, submitExpiredAttempts } from "./records.js";
import { gradeAttempts, gradeAttempt, loadAnswerKey, clearKeyCache } from "./grading.js";
import { pagerHtml, pageSlice, clampPage, getPageSize, setPageSize, pageAfterResize } from "./pager.js";
import { toRow } from "./recordsView.js";
import { performance, studentKey as rowKey } from "./analytics.js";
import { teacher, appNotice, onTeacherChange } from "./teacherState.js";
import { sortRows, nextSort, paintSortHeaders } from "./tableSort.js";
import { buildReport, printHtml } from "./print.js";
import { summaryCsv, buildBackup } from "./backup.js";
import {
  directory, allStudents, loadStudents, studentKey, createStudent, updateStudent, deleteStudent,
  migrateStudents, studentsMigrated, markStudentsMigrated, linkOldAttempts
} from "./students.js";
import { isAdmin, myGrades, mySections, canSeeClass } from "./roles.js";
import { openRequestDialog } from "./requests.js";
import { logActivity } from "./auth.js";
import {
  escapeHtml, formatDateTime, friendlyError, sectionsFor, normalizeRoll, normalizeName, pluralize, storage, skeleton,
  formModal, confirmDialog, downloadFile, toCsv, validateRoll, NAME_PATTERN
} from "./utilities.js";

const MAX_RECORDS = 3000;
/** A submitted, not declined, not archived test that can be graded. */
const gradable = (r) => r.submitted && !r.archived && r.review !== "declined";
const fmt = (v, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);

const GROUP_VALUE = {
  name: (g) => g.name,
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

export class StudentRecordView {
  constructor(container) {
    this.el = container;
    this.cache = new Map();
    this.rows = [];
    this.groups = [];
    this.sort = { key: "section", dir: "asc" };
    this.detailSort = { key: "quizTitle", dir: "asc" };
    this.listSize = getPageSize("students");
    this.detailSize = getPageSize("student-history");
    this.detailPage = 0;
    this.selected = new Set(); // admin bulk selection (group keys), kept across pages, sort and search
    const saved = storage.get("cq_history_scope") || {};
    this.scope = { grade: saved.grade || "", section: saved.section || "", archive: isAdmin() && saved.archive !== false };
    this.el.innerHTML = `
      <div data-h="setup"></div>
      <div class="card filters-card">
        <div class="filters">
          <label class="stack-field"><span>Grade</span><select data-h="grade"></select></label>
          <label class="stack-field"><span>Section</span><select data-h="section"></select></label>
          <label class="stack-field grow"><span>Search</span><input type="search" data-h="search" placeholder="Name or roll no."></label>
          ${isAdmin() ? '<label class="check inline"><input type="checkbox" data-h="archive"> Include archived</label>' : ""}
          <button type="button" class="btn" data-h="refresh">Refresh</button>
          ${isAdmin() ? '<button type="button" class="btn btn-primary" data-h="add" data-icon="user-plus">Add student</button>' : ""}
        </div>
      </div>
      <div data-h="list"></div>
      <div data-h="detail" hidden></div>`;
    this.$ = (k) => this.el.querySelector(`[data-h="${k}"]`);
    this.$("grade").addEventListener("change", () => { this.scope.grade = this.$("grade").value; this.scope.section = ""; this.fillSections(); this.load(); });
    this.$("section").addEventListener("change", () => { this.scope.section = this.$("section").value; this.load(); });
    this.$("archive")?.addEventListener("change", () => { this.scope.archive = this.$("archive").checked; this.load(); });
    this.$("search").addEventListener("input", () => { this.listPage = 0; this.renderList(); });
    this.$("refresh").addEventListener("click", async () => {
      this.cache.clear();
      try { await loadStudents(); } catch (err) { appNotice(friendlyError(err), "error"); }
      if (this.current) this.openStudent(this.current); else this.load();
    });
    this.$("add")?.addEventListener("click", () => this.run(() => this.addStudent()));
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("change", (e) => {
      if (e.target.matches("[data-sel]")) { this.toggleSelect([e.target.dataset.sel], e.target.checked); return; }
      if (e.target.matches("[data-sel-page]")) {
        this.toggleSelect(pageSlice(this.visibleGroups(), this.listPage || 0, this.listSize).map((g) => g.key), e.target.checked);
        return;
      }
      if (!e.target.matches("[data-page-size]")) return;
      if (this.current) {
        const size = setPageSize("student-history", e.target.value);
        this.detailPage = pageAfterResize(this.detailPage, this.detailSize, size, this.detailAll.length);
        this.detailSize = size;
        this.renderDetail(this.detailStudent, this.detailWho, this.detailAll);
      } else {
        const size = setPageSize("students", e.target.value);
        this.listPage = pageAfterResize(this.listPage || 0, this.listSize, size, this.visibleGroups().length);
        this.listSize = size;
        this.renderList();
      }
    });
    document.addEventListener("click", (e) => {
      this.el.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
    onTeacherChange((what) => {
      if (!this.initialised) return;
      if (what === "settings") this.fillFilters();
      // A student registered or renamed: show it in the list at once.
      if (what === "students" && !this.current && this.loadedKey) { this.buildGroups(); this.renderList(); }
    });
  }

  async run(fn) {
    try { await fn(); } catch (err) {
      console.error(err);
      appNotice(err?.code === "taken" ? "Another student already has this grade, section and roll number." : `The action did not finish. ${friendlyError(err)}`, "error");
    }
  }

  // ------------------------------------------------------------ filters

  grades() { return myGrades(teacher.settings); }

  fillFilters() {
    const grades = this.grades();
    const all = isAdmin() ? '<option value="">All grades</option>' : (grades.length > 1 ? '<option value="">All my grades</option>' : "");
    if (this.scope.grade && !grades.includes(this.scope.grade)) this.scope.grade = "";
    if (!all && !this.scope.grade) this.scope.grade = grades[0] || "";
    this.$("grade").innerHTML = all + grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("");
    this.$("grade").value = this.scope.grade;
    if (this.$("archive")) this.$("archive").checked = this.scope.archive;
    this.fillSections();
  }

  fillSections() {
    const list = this.scope.grade ? mySections(teacher.settings, this.scope.grade) : [];
    this.$("section").innerHTML = '<option value="">All sections</option>' + list.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    this.$("section").value = list.includes(this.scope.section) ? this.scope.section : "";
    this.$("section").disabled = !this.scope.grade;
    this.scope.section = this.$("section").value;
  }

  async show() {
    if (!this.initialised) { this.fillFilters(); this.initialised = true; }
    this.renderSetup();
    if (!this.current && !this.loadedKey) await this.load();
  }

  invalidate() { this.cache.clear(); this.loadedKey = null; }

  /** Opens the student list of one grade / section (from the Overview). */
  openScope({ grade = "", section = "" } = {}) {
    if (!this.initialised) { this.fillFilters(); this.initialised = true; }
    this.renderSetup();
    this.scope.grade = grade;
    this.fillFilters();
    this.scope.section = section;
    this.fillSections();
    this.$("search").value = "";
    this.load();
  }

  // ------------------------------------------------- one-time setup banner

  async renderSetup() {
    const box = this.$("setup");
    if (!isAdmin()) { box.innerHTML = ""; return; }
    try {
      if (await studentsMigrated()) { box.innerHTML = ""; return; }
    } catch { /* show the banner */ }
    box.innerHTML = `<div class="notice notice-warning setup-banner">
      <div><b>One-time setup: link existing results to student records.</b>
      <div class="small">Creates a permanent record for every student found in your results and archive, using their latest name, and links their quizzes to it. Nothing is deleted. You can run it again safely.</div></div>
      <button type="button" class="btn btn-primary btn-small" data-act="migrate">Link existing results</button></div>`;
  }

  async migrate() {
    const ok = await confirmDialog({
      title: "Link existing results to student records?",
      text: "This reads all results once, creates missing student records and links each quiz attempt to its student. It may take a minute for many records. Nothing is deleted.",
      okText: "Start"
    });
    if (!ok) return;
    const res = await migrateStudents((msg) => appNotice(msg, "info"));
    await markStudentsMigrated(res);
    logActivity("students_migrated", `Linked results to student records: ${res.created} students created, ${res.linked} attempts linked`);
    appNotice(`Done. ${pluralize(res.created, "student record")} created and ${pluralize(res.linked, "attempt")} linked.${res.skipped ? ` ${res.skipped} could not be linked (unusual roll number or name).` : ""}`, "success");
    this.cache.clear();
    this.renderSetup();
    this.load();
  }

  // ----------------------------------------------------------- loading

  async fetch(scope, archive) {
    const key = JSON.stringify({ ...scope, archive });
    if (this.cache.has(key)) return this.cache.get(key);
    const sources = archive ? ["active", "archive"] : ["active"];
    let rows = [];
    let capped = false;
    const loaded = await Promise.all(sources.map((source) => queryAllAttempts(source, scope, { max: MAX_RECORDS })));
    for (const [i, source] of sources.entries()) {
      const { items, results, capped: more } = loaded[i];
      capped = capped || more;
      rows = rows.concat(items.map((a) => ({ ...toRow(a, results.get(a.id) || null, source === "archive"), archived: source === "archive" })));
    }
    const out = { rows, capped };
    this.cache.set(key, out);
    return out;
  }

  inScope(s) {
    return canSeeClass(s.grade, s.section)
      && (!this.scope.grade || String(s.grade) === this.scope.grade)
      && (!this.scope.section || String(s.section) === this.scope.section);
  }

  async load({ quiet = false } = {}) {
    storage.set("cq_history_scope", this.scope);
    this.current = null;
    this.$("detail").hidden = true;
    this.$("list").hidden = false;
    const scope = { grade: this.scope.grade, section: this.scope.section };
    this.loadedKey = JSON.stringify(this.scope);
    if (!quiet) {
      this.listPage = 0;
      this.selected.clear();
      this.$("list").innerHTML = skeleton("table", { cols: 8, rows: 8 });
    }
    try {
      const { rows, capped } = await this.fetch(scope, this.scope.archive);
      this.rows = rows;
      this.capped = capped;
      this.buildGroups();
      this.renderList();
    } catch (err) {
      console.error(err);
      this.$("list").innerHTML = "";
      appNotice(`Could not load students. ${friendlyError(err)}`, "error");
    }
  }

  /** One group per registered student in scope, plus records not linked to anyone. */
  buildGroups() {
    const byKey = new Map();
    allStudents().filter((s) => this.inScope(s)).forEach((s) => {
      byKey.set(`id:${s.id}`, { key: `id:${s.id}`, student: s, name: s.name, grade: s.grade, section: s.section, rollNo: s.rollNo, names: [s.name], rows: [] });
    });
    this.rows.forEach((r) => {
      const k = rowKey(r);
      if (!byKey.has(k)) {
        const st = r.studentId ? directory.byId.get(r.studentId) : null;
        byKey.set(k, { key: k, student: st || null, name: st?.name || r.studentName, grade: st?.grade || r.grade, section: st?.section || r.section, rollNo: st?.rollNo || r.rollNo, names: [], rows: [] });
      }
      const g = byKey.get(k);
      if (r.typedName && !g.names.includes(r.typedName)) g.names.push(r.typedName);
      g.rows.push(r);
    });
    this.groups = [...byKey.values()].map((g) => ({
      ...g,
      perf: performance(g.rows),
      latestMs: Math.max(0, ...g.rows.map((r) => r.submittedMs || 0)) || null
    }));
    const keys = new Set(this.groups.map((g) => g.key));
    [...this.selected].forEach((k) => { if (!keys.has(k)) this.selected.delete(k); });
  }

  visibleGroups() {
    const term = this.$("search").value.trim().toLowerCase();
    const roll = term ? normalizeRoll(term) : null;
    const list = term ? this.groups.filter((g) => (roll && g.rollNo === roll) || [g.name, ...g.names].some((n) => String(n).toLowerCase().includes(term))) : this.groups;
    return sortRows(list, this.sort, {
      value: (g, k) => GROUP_VALUE[k](g),
      tieBreak: (a, b) => String(a.grade).localeCompare(String(b.grade), undefined, { numeric: true }) || Number(a.rollNo) - Number(b.rollNo)
    });
  }

  scopeText() {
    return [this.scope.grade ? `Grade ${this.scope.grade}` : (isAdmin() ? "All grades" : "My classes"), this.scope.section && `Section ${this.scope.section}`].filter(Boolean).join(", ");
  }

  renderList() {
    if (this.current) return;
    const list = this.visibleGroups();
    this.listPage = clampPage(this.listPage || 0, list.length, this.listSize);
    const pageList = pageSlice(list, this.listPage, this.listSize);
    const bulk = isAdmin();
    const pageAll = pageList.length > 0 && pageList.every((g) => this.selected.has(g.key));
    const box = this.$("list");
    if (!this.groups.length) {
      box.innerHTML = `<div class="card empty">No students in ${escapeHtml(this.scopeText())} yet.${isAdmin() ? " Students are added when they register on the student page, or press Add student." : ""}</div>`;
      return;
    }
    const adminTools = isAdmin() ? `
      <details class="menu">
        <summary class="btn btn-small">Print</summary>
        <div class="menu-list">
          <button type="button" data-act="print-list">Records of the students shown</button>
          <button type="button" data-act="print-list-answers">Records with answers</button>
        </div>
      </details>
      <details class="menu">
        <summary class="btn btn-small">Export</summary>
        <div class="menu-list">
          <button type="button" data-act="export-students">Student list (CSV)</button>
          <button type="button" data-act="export-list">Quiz records of the students shown (CSV)</button>
        </div>
      </details>` : "";
    box.innerHTML = `
      <div class="card table-card">
        <div class="table-head">
          <span class="small muted">${pluralize(list.length, "student")}${list.length !== this.groups.length ? ` of ${this.groups.length}` : ""}${this.capped ? " (first 3,000 records only: choose a section)" : ""}</span>
          <div class="table-actions">${adminTools}</div>
        </div>
        ${bulk ? this.bulkBarHtml(list) : ""}
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>${bulk ? `<th class="sel-col"><input type="checkbox" data-sel-page aria-label="Select all students on this page"${pageAll ? " checked" : ""}></th>` : ""}<th data-sort="name">Student</th><th data-sort="rollNum" class="num">Roll</th><th data-sort="grade">Grade</th><th data-sort="section">Section</th><th data-sort="attempted" class="num" title="Quizzes attempted">Quizzes</th><th data-sort="counted" class="num" title="Graded, not declined, latest attempt per quiz">Counted</th><th data-sort="overall" class="num" title="Total marks ÷ total possible">Overall</th><th data-sort="average" class="num" title="Mean of quiz percentages">Average</th><th data-sort="latestMs">Last submitted</th><th class="actions-col"></th></tr></thead>
            <tbody>${pageList.map((g) => {
              const other = g.names.filter((n) => n !== g.name);
              const on = bulk && this.selected.has(g.key);
              return `<tr${on ? ' class="is-selected"' : ""}>
                ${bulk ? `<td class="sel-col"><input type="checkbox" data-sel="${escapeHtml(g.key)}" aria-label="Select ${escapeHtml(g.name)}"${on ? " checked" : ""}></td>` : ""}
                <td class="name-cell"><button type="button" class="link-btn" data-open="${escapeHtml(g.key)}">${escapeHtml(g.name)}</button>
                  ${g.student ? "" : '<div><span class="badge badge-warning">Not registered</span></div>'}
                  ${other.length ? `<div class="small muted" title="Names typed on quizzes">also: ${escapeHtml(other.join(", "))}</div>` : ""}</td>
                <td class="num">${escapeHtml(g.rollNo)}</td>
                <td>${escapeHtml(g.grade)}</td>
                <td>${escapeHtml(g.section)}</td>
                <td class="num">${g.perf.attempted}</td>
                <td class="num">${g.perf.counted}</td>
                <td class="num">${fmt(g.perf.overallPercent, "%")}</td>
                <td class="num">${fmt(g.perf.averagePercent, "%")}</td>
                <td class="small nowrap">${g.latestMs ? escapeHtml(formatDateTime(new Date(g.latestMs))) : "—"}</td>
                <td class="col-actions">${this.rowMenu(g)}</td>
              </tr>`;
            }).join("") || `<tr><td colspan="${bulk ? 11 : 10}" class="empty">No student matches this search.</td></tr>`}</tbody>
          </table>
        </div>
        ${pagerHtml({ page: this.listPage, size: this.listSize, total: list.length, label: "students", sizeKey: "students" })}
      </div>`;
    paintSortHeaders(box.querySelector("table"), this.sort);
    const pageBox = box.querySelector("[data-sel-page]");
    if (pageBox) pageBox.indeterminate = !pageAll && pageList.some((g) => this.selected.has(g.key));
  }

  // ------------------------------------------------------ bulk actions (admin)

  toggleSelect(keys, on) {
    keys.forEach((k) => (on ? this.selected.add(k) : this.selected.delete(k)));
    this.renderList();
  }

  /** The selected students, in the order shown. */
  selectedGroups() {
    return this.groups.filter((g) => this.selected.has(g.key));
  }

  bulkBarHtml(list) {
    const n = this.selected.size;
    const shownSel = list.filter((g) => this.selected.has(g.key)).length;
    if (!n) {
      return `<div class="bulk-bar is-empty"><span class="small muted"><i class="fa-regular fa-square-check" aria-hidden="true"></i> Tick students to act on several at once.</span>${list.length ? `<button type="button" class="link-btn small" data-bulk="select-all">Select all ${pluralize(list.length, "student")} shown</button>` : ""}</div>`;
    }
    const sel = this.selectedGroups();
    const unreg = sel.filter((g) => !g.student).length;
    const reg = sel.length - unreg;
    const recs = sel.reduce((t, g) => t + g.rows.length, 0);
    const active = sel.reduce((t, g) => t + g.rows.filter((r) => !r.archived).length, 0);
    const b = (act, label, icon, opts = {}) => `<button type="button" data-bulk="${act}" data-icon="none"${opts.disabled ? " disabled" : ""} class="${opts.cls || ""}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${label}</button>`;
    return `
      <div class="bulk-bar" role="region" aria-label="Bulk actions">
        <div class="bulk-count"><strong>${pluralize(n, "student")} selected</strong>${shownSel !== n ? `<span class="small muted"> (${shownSel} shown)</span>` : ""}
          ${shownSel < list.length ? `<button type="button" class="link-btn small" data-bulk="select-all">Select all ${list.length} shown</button>` : ""}
          <button type="button" class="link-btn small" data-bulk="clear">Clear</button></div>
        <div class="bulk-actions">
          ${unreg ? `<button type="button" class="btn btn-small btn-primary" data-bulk="register" data-icon="user-check">Register ${unreg}</button>` : ""}
          <details class="menu">
            <summary class="btn btn-small" data-icon="print">Print</summary>
            <div class="menu-list">
              ${b("print", `Records (${pluralize(recs, "quiz record")})`, "file-lines", { disabled: !recs })}
              ${b("print-answers", "Records with answers", "list-check", { disabled: !recs })}
            </div>
          </details>
          <details class="menu">
            <summary class="btn btn-small" data-icon="file-export">Export</summary>
            <div class="menu-list">
              ${b("export-students", "Student list (CSV)", "users")}
              ${b("export", "Quiz records (CSV)", "file-csv", { disabled: !recs })}
              ${b("backup", "Backup of quiz records (JSON)", "box-archive", { disabled: !active })}
            </div>
          </details>
          <details class="menu">
            <summary class="btn btn-small">More</summary>
            <div class="menu-list">
              ${unreg ? b("register", `Register ${pluralize(unreg, "student")}`, "user-check") : ""}
              ${b("archive", `Archive quiz records (${active})`, "box-archive", { disabled: !active })}
              ${b("delete-records", `Delete quiz records (${recs})…`, "trash-can", { disabled: !recs, cls: "danger" })}
              ${b("delete", `Delete ${pluralize(reg, "student")}…`, "user-xmark", { disabled: !reg, cls: "danger" })}
            </div>
          </details>
        </div>
      </div>`;
  }

  async bulkAction(act) {
    if (act === "select-all") { this.visibleGroups().forEach((g) => this.selected.add(g.key)); this.renderList(); return; }
    if (act === "clear") { this.selected.clear(); this.renderList(); return; }
    const sel = this.selectedGroups();
    if (!sel.length) { appNotice("Select one or more students first.", "info"); return; }
    const who = pluralize(sel.length, "student");
    const allRows = sel.flatMap((g) => g.rows);
    const activeRows = allRows.filter((r) => !r.archived);
    const pick = (rows) => rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result }));
    const stamp = new Date().toISOString().slice(0, 10);
    switch (act) {
      case "print": return this.print(allRows, false, `Student records (${who})`);
      case "print-answers": return this.print(allRows, true, `Student records with answers (${who})`);
      case "export": return this.exportRows(allRows, `selected-student-records`);
      case "export-students": return this.exportStudents(sel, "selected-students");
      case "backup":
        if (!activeRows.length) { appNotice("There are no active quiz records to back up.", "info"); return undefined; }
        downloadFile(`selected-students_backup_${stamp}.json`, buildBackup(pick(activeRows), "active"), "application/json");
        appNotice(`Backup of ${pluralize(activeRows.length, "record")} downloaded.`, "success");
        return undefined;
      case "register": return this.bulkRegister(sel.filter((g) => !g.student));
      case "archive": {
        if (!activeRows.length) { appNotice("There are no active quiz records to archive.", "info"); return undefined; }
        const ok = await confirmDialog({ title: `Archive ${pluralize(activeRows.length, "quiz record")} of ${who}?`, text: "They move to the Archive. You can restore them later. The student records stay.", okText: "Archive" });
        if (!ok) return undefined;
        appNotice(`Archiving ${pluralize(activeRows.length, "record")}…`, "info");
        await archiveRecords(pick(activeRows));
        logActivity("records_archived", `Archived ${activeRows.length} quiz records of ${who} (bulk)`);
        appNotice(`Archived ${pluralize(activeRows.length, "record")} of ${who}.`, "success");
        return this.afterBulk();
      }
      case "delete-records": {
        const archived = allRows.filter((r) => r.archived);
        const res = await confirmDialog({
          title: `Delete ${pluralize(allRows.length, "quiz record")} of ${who}?`, text: "This permanently deletes them. It cannot be undone. The student records stay.",
          okText: "Delete records", danger: true, option: { label: "Download a backup file first (recommended)", checked: true }, check: `Yes, delete ${pluralize(allRows.length, "record")}`
        });
        if (!res) return undefined;
        if (res.option && activeRows.length) downloadFile(`selected-students_backup_${stamp}.json`, buildBackup(pick(activeRows), "active"), "application/json");
        appNotice(`Deleting ${pluralize(allRows.length, "record")}…`, "info");
        if (activeRows.length) await deleteRecords("active", activeRows);
        if (archived.length) await deleteRecords("archive", archived);
        logActivity("records_deleted", `Deleted ${allRows.length} quiz records of ${who} (bulk)`);
        appNotice(`Deleted ${pluralize(allRows.length, "record")} of ${who}.`, "success");
        return this.afterBulk();
      }
      case "delete": {
        const reg = sel.filter((g) => g.student);
        if (!reg.length) { appNotice("None of the selected students is registered.", "info"); return undefined; }
        const skipped = sel.length - reg.length;
        const res = await confirmDialog({
          title: `Delete ${pluralize(reg.length, "student record")}?`,
          text: `Their quiz records are kept and show the name typed on each quiz. Their roll numbers become free for new registrations.${skipped ? ` ${pluralize(skipped, "selected row")} not registered will be skipped.` : ""}`,
          okText: "Delete students", danger: true, check: `Yes, delete ${pluralize(reg.length, "student")}`
        });
        if (!res) return undefined;
        let done = 0; const failed = [];
        for (const g of reg) {
          try { await deleteStudent(g.student); done++; } catch (err) { console.error(err); failed.push(g.name); }
          if (reg.length > 5) appNotice(`Deleting students… ${done + failed.length} of ${reg.length}`, "info");
        }
        if (done) logActivity("student_deleted", `Deleted ${done} student records (bulk): ${reg.filter((g) => !failed.includes(g.name)).map((g) => `${g.name} (${g.grade} ${g.section} roll ${g.rollNo})`).join(", ").slice(0, 900)}`);
        appNotice(failed.length ? `Deleted ${pluralize(done, "student")}. Could not delete: ${failed.join(", ")}.` : `Deleted ${pluralize(done, "student")}. Their quiz records were kept.`, failed.length ? "error" : "success");
        return this.afterBulk();
      }
      default: return undefined;
    }
  }

  /** Registers records that are not linked to a student, using the name, class and roll on them. */
  async bulkRegister(list) {
    if (!list.length) { appNotice("All selected students are already registered.", "info"); return; }
    const ok = await confirmDialog({
      title: `Register ${pluralize(list.length, "student")}?`,
      text: "Each one is registered with the name, grade, section and roll number shown in the list, and their older quiz records are linked. To change a name or roll number first, register that student on their own from the ⋯ menu.",
      okText: `Register ${list.length}`
    });
    if (!ok) return;
    let done = 0; const problems = [];
    for (const g of list) {
      const name = normalizeName(g.name);
      const { roll, error } = validateRoll(g.rollNo, teacher.settings, g.grade, g.section);
      if (name.length < 2 || error) { problems.push(`${g.name || "(no name)"}: ${error || "name too short"}`); continue; }
      try {
        const s = await createStudent({ name, grade: g.grade, section: g.section, rollNo: roll });
        await linkOldAttempts(s);
        done++;
      } catch (err) {
        console.error(err);
        problems.push(`${g.name} (roll ${g.rollNo}): ${err?.code === "taken" ? "roll number already registered" : friendlyError(err)}`);
      }
      if (list.length > 3) appNotice(`Registering… ${done + problems.length} of ${list.length}`, "info");
    }
    if (done) logActivity("student_created", `Registered ${done} students from existing records (bulk)`);
    appNotice(problems.length ? `Registered ${pluralize(done, "student")}. Not registered: ${problems.join("; ")}.` : `Registered ${pluralize(done, "student")}. Their records are linked.`, problems.length ? "error" : "success");
    await this.afterBulk();
  }

  async afterBulk() {
    this.selected.clear();
    this.cache.clear();
    this.onChanged?.();
    await this.load({ quiet: true });
  }

  rowMenu(g) {
    const k = escapeHtml(g.key);
    const item = (act, label, cls = "") => `<button type="button" data-gact="${act}" data-key="${k}" class="${cls}">${label}</button>`;
    const items = [`<button type="button" data-open="${k}">Open record</button>`];
    if (isAdmin()) {
      items.push(g.student ? item("edit", "Edit details…") : item("register", "Register this student"));
      items.push(item("print", "Print record"), item("export", "Export record (CSV)"));
      if (g.rows.some((r) => !r.archived)) items.push(item("archive", "Archive quiz records"));
      if (g.student) items.push(item("delete", "Delete student…", "danger"));
    } else {
      items.push(item("request", "Request a change…"));
    }
    return `<details class="menu row-menu"><summary class="btn btn-small" aria-label="Actions for ${escapeHtml(g.name)}">⋯</summary><div class="menu-list">${items.join("")}</div></details>`;
  }

  // -------------------------------------------------------- live updates

  /** Records changed elsewhere: re-read what is on screen, without a loading screen. */
  async liveUpdate(ids) {
    this.cache.clear();
    if (this.el.closest(".tab-panel")?.hidden) { this.loadedKey = null; return; }
    if (this.current && this.detailWho) {
      const w = this.detailWho;
      const mine = !ids || [...ids].some((id) => {
        const p = attemptIdParts(id);
        return !p || (p.grade === String(w.grade) && p.section === String(w.section) && (p.rollNo === "?" || p.rollNo === String(w.rollNo)))
          || this.detailAll.some((r) => r.id === id);
      });
      if (mine) await this.openStudent(this.detailStudent ? { student: this.detailStudent } : w, { quiet: true });
      return;
    }
    if (this.loadedKey) await this.load({ quiet: true });
  }

  // ---------------------------------------------------------- one student

  /** target: a student, a list group, or { grade, section, rollNo } from a link. */
  async openStudent(target, { quiet = false } = {}) {
    if (!target) return;
    if (!this.initialised) { this.initialised = true; this.scope.grade = target.grade || ""; this.fillFilters(); }
    let student = target.student || (target.id && directory.byId.get(target.id)) || null;
    if (!student && target.rollNo) student = directory.byKey.get(studentKey(target.grade, target.section, target.rollNo)) || null;
    const who = student
      ? { id: student.id, grade: student.grade, section: student.section, rollNo: student.rollNo }
      : { grade: target.grade, section: target.section, rollNo: target.rollNo };
    this.current = student ? { student } : { grade: who.grade, section: who.section, rollNo: who.rollNo };
    if (!quiet) this.detailPage = 0;
    const token = this.current;
    this.$("list").hidden = true;
    const box = this.$("detail");
    box.hidden = false;
    if (!quiet) box.innerHTML = skeleton("page", { cols: 7, rows: 5 });
    try {
      const recs = await fetchStudentRecords(who, { archive: this.scope.archive });
      if (token !== this.current) return; // the user went back or opened someone else meanwhile
      const rows = recs.map((r) => ({ ...toRow(r.attempt, r.result, r.source === "archive"), archived: r.source === "archive" }));
      this.renderDetail(student, who, rows);
    } catch (err) {
      console.error(err);
      box.innerHTML = "";
      appNotice(`Could not load the student record. ${friendlyError(err)}`, "error");
    }
  }

  renderDetail(student, who, rows) {
    const box = this.$("detail");
    this.detailStudent = student;
    this.detailWho = who;
    this.detailAll = rows;
    this.detailRows = sortRows(rows, this.detailSort, {
      tieBreak: (a, b) => String(a.quizTitle).localeCompare(String(b.quizTitle), undefined, { numeric: true }) || ((a.submittedMs || Infinity) - (b.submittedMs || Infinity))
    });
    this.detailPage = clampPage(this.detailPage || 0, this.detailRows.length, this.detailSize);
    const pageRows = pageSlice(this.detailRows, this.detailPage, this.detailSize);
    const name = student?.name || rows[0]?.studentName || "Student";
    const typed = [...new Set(rows.map((r) => r.typedName).filter((n) => n && n !== name))];
    const previous = (student?.previousNames || []).filter((n) => n !== name);
    const perf = performance(rows);
    const pass = Number(teacher.settings.passPercent) || 40;
    const k = escapeHtml(student ? `id:${student.id}` : `${who.grade}|${who.section}|${who.rollNo}`);
    const btn = (act, label, cls = "", icon = "") => `<button type="button" class="btn ${cls}" data-gact="${act}" data-key="${k}"${icon ? ` data-icon="${icon}"` : ""}>${label}</button>`;
    const tools = isAdmin() ? `
        ${student ? btn("edit", "Edit details", "btn-primary", "pen") : btn("register", "Register this student", "btn-primary", "user-plus")}
        <details class="menu"><summary class="btn">Print</summary><div class="menu-list">
          <button type="button" data-act="print-one">Record</button><button type="button" data-act="print-one-answers">Record with answers</button></div></details>
        <details class="menu"><summary class="btn">Export</summary><div class="menu-list">
          <button type="button" data-gact="export" data-key="${k}">Quiz records (CSV)</button><button type="button" data-gact="backup" data-key="${k}">Backup file (JSON)</button></div></details>
        <details class="menu menu-right"><summary class="btn">More</summary><div class="menu-list">
          ${rows.some((r) => !r.archived) ? `<button type="button" data-gact="archive" data-key="${k}">Archive quiz records</button>` : ""}
          ${student ? `<button type="button" data-gact="delete" data-key="${k}" class="danger">Delete student…</button>` : ""}
          ${rows.length ? `<button type="button" data-gact="delete-records" data-key="${k}" class="danger">Delete quiz records…</button>` : ""}</div></details>`
      : btn("request", "Request a change", "", "paper-plane");
    const toGrade = rows.filter((r) => gradable(r) && r.grading !== "graded").length;
    const gradeAll = toGrade ? `<button type="button" class="btn btn-success" data-act="grade-student" data-icon="clipboard-check">Grade ${toGrade === 1 ? "1 test" : `${toGrade} tests`}</button>` : "";
    const counted = rows.filter((r) => perf.countedIds.has(r.id));
    const passedN = counted.filter((r) => r.passed === true).length;
    const failedN = counted.filter((r) => r.passed === false).length;
    const inProgress = rows.filter((r) => r.grading === "in_progress").length;
    const initials = String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
    const tone = (p) => (p === null || p === undefined ? "" : p >= pass ? "is-good" : "is-low");
    const meter = (p) => (p === null || p === undefined ? "" : `<span class="sr-meter ${tone(p)}" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></span>`);
    const kpi = (icon, color, label, value, sub = "", extra = "") => `
        <div class="sr-kpi sr-kpi-${color}">
          <span class="sr-kpi-icon" aria-hidden="true"><i class="fa-solid fa-${icon}"></i></span>
          <div class="sr-kpi-body"><div class="sr-kpi-label">${label}</div><div class="sr-kpi-value">${value}</div>${extra}${sub ? `<div class="sr-kpi-sub">${sub}</div>` : ""}</div>
        </div>`;
    const status = (r) => {
      const parts = [];
      if (r.grading === "in_progress") parts.push(r.timeUp ? '<span class="pill pill-warn"><i class="fa-solid fa-hourglass-end"></i>Time up</span>' : '<span class="pill pill-muted"><i class="fa-solid fa-pen"></i>In progress</span>');
      else if (r.grading === "graded") parts.push(r.passed ? '<span class="pill pill-good"><i class="fa-solid fa-circle-check"></i>Pass</span>' : '<span class="pill pill-bad"><i class="fa-solid fa-circle-xmark"></i>Fail</span>');
      else if (r.review === "declined") parts.push('<span class="pill pill-muted">Not graded</span>');
      else parts.push(`<span class="pill pill-warn"><i class="fa-solid fa-clipboard-list"></i>${escapeHtml(r.gradingLabel)}</span>`);
      if (r.review === "accepted") parts.push('<span class="pill pill-info">Accepted</span>');
      else if (r.review === "declined") parts.push('<span class="pill pill-bad-outline">Declined</span>');
      else if (r.review === "pending") parts.push('<span class="pill pill-plain">Pending review</span>');
      if (r.autoSubmitted) parts.push('<span class="pill pill-plain" title="Submitted automatically when the time ran out"><i class="fa-solid fa-stopwatch"></i>Auto-submitted</span>');
      if (r.archived) parts.push('<span class="pill pill-plain">Archived</span>');
      if (r.previous) parts.push('<span class="pill pill-plain">Previous attempt</span>');
      return `<div class="sr-status">${parts.join("")}</div>`;
    };
    const score = (r) => {
      if (r.obtained === null) return '<span class="muted">—</span>';
      const t = r.passed === true ? "is-good" : r.passed === false ? "is-low" : "";
      return `<div class="sr-score ${t}"><div class="sr-score-top"><b>${fmt(r.percentage, "%")}</b><span>${escapeHtml(r.obtained)} / ${escapeHtml(r.total)}</span></div>${meter(r.percentage).replace(tone(r.percentage), t)}</div>`;
    };
    const chip = (icon, label, value, mono = false) => `<span class="sr-chip"><i class="fa-solid fa-${icon}" aria-hidden="true"></i><span class="sr-chip-label">${label}</span>${mono ? `<code>${value}</code>` : `<b>${value}</b>`}</span>`;
    box.innerHTML = `
      <section class="card sr-profile">
        <div class="sr-top">
          <button type="button" class="btn btn-small btn-back" data-act="back" data-icon="arrow-left">All students</button>
          <div class="sr-actions">${gradeAll}${tools}</div>
        </div>
        <div class="sr-identity">
          <span class="sr-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
          <div class="sr-id-text">
            <h2 class="student-title">${escapeHtml(name)}${student ? "" : ' <span class="badge badge-warning">Not registered</span>'}</h2>
            <div class="sr-chips">
              ${chip("user-graduate", "Roll", escapeHtml(who.rollNo))}
              ${chip("star", "Grade", escapeHtml(who.grade))}
              ${chip("location-dot", "Section", escapeHtml(who.section))}
              ${student ? chip("id-card", "ID", escapeHtml(student.id), true) : ""}
            </div>
            ${previous.length || typed.length ? `<p class="small muted sr-names">Earlier names: ${escapeHtml([...new Set([...previous, ...typed])].join(", "))}</p>` : ""}
          </div>
        </div>
      </section>

      <section class="sr-kpis" aria-label="Performance">
        ${kpi("file-lines", "blue", "Quizzes attempted", perf.attempted, inProgress ? `${inProgress} in progress` : (perf.attempted ? `${perf.counted} counted` : "None yet"))}
        ${kpi("star", "amber", "Marks", perf.counted ? `${perf.obtained}<small> / ${perf.possible}</small>` : "—", perf.counted ? `${perf.finalized} accepted, ${perf.pending} pending review` : "No graded tests yet")}
        ${kpi("bullseye", perf.overallPercent === null ? "slate" : perf.overallPercent >= pass ? "green" : "red", "Overall", fmt(perf.overallPercent, "%"), "Total marks ÷ possible", meter(perf.overallPercent))}
        ${kpi("chart-line", "violet", "Average", fmt(perf.averagePercent, "%"), "Mean of quiz percentages", meter(perf.averagePercent))}
        ${kpi("trophy", "teal", "Passed", perf.counted ? `${passedN}<small> / ${perf.counted}</small>` : "—", perf.counted ? `${failedN} failed · pass mark ${pass}%` : `Pass mark ${pass}%`)}
      </section>

      <section class="card table-card sr-history">
        <div class="sr-history-head">
          <div><h3>Quiz history</h3><p class="small muted">${pluralize(rows.length, "record")} · only the latest graded attempt of each quiz counts</p></div>
          ${toGrade ? `<span class="pill pill-warn"><i class="fa-solid fa-clipboard-list"></i>${pluralize(toGrade, "test")} to grade</span>` : ""}
        </div>
        ${rows.length ? `<div class="table-wrap">
          <table class="data-table sr-table">
            <thead><tr><th data-sort="quizTitle">Quiz</th><th data-sort="submittedMs">Submitted</th><th data-sort="statusOrder">Status</th><th data-sort="percentage" class="sr-score-col">Score</th><th data-sort="grade">Class then</th><th data-sort="focusLossCount" class="num" title="Times the student left the quiz page">Left page</th><th class="actions-col"></th></tr></thead>
            <tbody>${pageRows.map((r) => `<tr class="${perf.countedIds.has(r.id) ? "" : "row-muted"}">
              <td class="sr-quiz-cell"><div class="sr-quiz-title">${escapeHtml(r.quizTitle)}</div>
                ${r.typedName && r.typedName !== name ? `<div class="small muted">Name typed: ${escapeHtml(r.typedName)}</div>` : ""}
                ${!perf.countedIds.has(r.id) ? `<div class="small muted">Not counted: ${escapeHtml(perf.notCounted(r).toLowerCase())}</div>` : ""}</td>
              <td class="small nowrap">${r.submittedMs ? escapeHtml(formatDateTime(r.attempt.submittedAt)) : (r.grading === "in_progress" ? `<span class="muted">${escapeHtml(r.answeredCount)}/${escapeHtml(r.questionCount)} answered</span>` : "—")}</td>
              <td>${status(r)}</td>
              <td class="sr-score-col">${score(r)}</td>
              <td class="small nowrap">Grade ${escapeHtml(r.grade)} · ${escapeHtml(r.section)}</td>
              <td class="num">${r.focusLossCount ? `<span class="pill ${r.focusLossCount >= 3 ? "pill-warn" : "pill-plain"}">${r.focusLossCount}</span>` : '<span class="muted">0</span>'}</td>
              <td class="col-actions"><div class="row-buttons">
                <button type="button" class="btn btn-small" data-sheet="${escapeHtml(r.id)}" data-icon="file-lines" title="Answer sheet">Answers</button>
                ${this.detailMenu(r)}</div></td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
        ${pagerHtml({ page: this.detailPage, size: this.detailSize, total: this.detailRows.length, label: "records", sizeKey: "student-history" })}` : '<div class="sr-empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><p>No quiz records yet.</p></div>'}
      </section>`;
    paintSortHeaders(box, this.detailSort);
  }

  detailMenu(r) {
    const id = escapeHtml(r.id);
    const item = (act, label) => `<button type="button" data-ract="${act}" data-id="${id}">${label}</button>`;
    const items = [`<a href="result.html?id=${encodeURIComponent(r.id)}${r.archived ? "&source=archive" : ""}">Open full record</a>`];
    if (r.timeUp && !r.archived) items.push(item("submit-expired", "Submit (time is up)"));
    if (gradable(r)) items.push(item("grade", r.grading === "graded" ? "Recalculate marks" : "Grade now"));
    if (!r.archived && r.submitted) {
      if (r.review !== "accepted") items.push(item("accept", "Accept"));
      if (r.review !== "declined") items.push(item("decline", "Decline"));
      if (r.review !== "pending") items.push(item("pending", "Mark pending review"));
    }
    return `<details class="menu row-menu menu-right"><summary class="btn btn-small" aria-label="More for ${escapeHtml(r.quizTitle)}">⋯</summary><div class="menu-list">${items.join("")}</div></details>`;
  }

  /** The answer sheet of one test, in a dialog: every question, the student's answer and the correct one. */
  async showSheet(id) {
    const r = this.detailAll.find((x) => x.id === id);
    if (!r) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `<div class="modal modal-sheet" role="dialog" aria-modal="true" aria-labelledby="shTitle">
      <div class="sheet-head"><div><h2 id="shTitle">${escapeHtml(r.quizTitle)}</h2>
        <p class="small muted">${escapeHtml(r.studentName)} · Roll ${escapeHtml(r.rollNo)} · Grade ${escapeHtml(r.grade)} ${escapeHtml(r.section)}${r.submittedMs ? ` · ${escapeHtml(formatDateTime(r.attempt.submittedAt))}` : ""}</p></div>
        <button type="button" class="btn btn-small btn-ghost" data-close aria-label="Close" data-icon="xmark">Close</button></div>
      <div class="sheet-body">${skeleton("table", { cols: 5, rows: 4 })}</div>
      <div class="actions"><a class="btn" href="result.html?id=${encodeURIComponent(r.id)}${r.archived ? "&source=archive" : ""}">Open full record</a><button type="button" class="btn btn-primary" data-close>Done</button></div>
    </div>`;
    document.body.appendChild(backdrop);
    const close = () => { document.removeEventListener("keydown", onKey); backdrop.remove(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop || e.target.closest("[data-close]")) close(); });
    backdrop.querySelector("[data-close]").focus();
    const body = backdrop.querySelector(".sheet-body");
    try {
      body.innerHTML = await this.sheetHtml(r);
    } catch (err) {
      console.error(err);
      body.innerHTML = `<p class="empty">Could not load the answer sheet. ${escapeHtml(friendlyError(err))}</p>`;
    }
  }

  async sheetHtml(r) {
    // A current saved result has every answer; otherwise work it out from the answer key now.
    let g = r.grading === "graded" && r.result?.details?.length ? r.result : null;
    let live = false;
    if (!g) {
      const key = await loadAnswerKey(r.quizId).catch(() => null);
      if (key) { g = gradeAttempt(r.attempt, key, r.result?.overrides || {}, teacher.settings.passPercent); live = true; }
      else if (r.result?.details?.length) g = r.result;
    }
    if (!g) return '<p class="empty">The answer key of this quiz is missing, and the test has not been graded, so the answers cannot be shown.</p>';
    const badge = { correct: '<span class="badge badge-success">Correct</span>', incorrect: '<span class="badge badge-danger">Incorrect</span>', unanswered: '<span class="badge">Unanswered</span>' };
    const note = !r.submitted ? "Not submitted yet: these are the answers saved so far."
      : live ? "Not graded yet: the marks below are worked out now. Press Grade now to save them." : "";
    return `
      <div class="sheet-summary">
        <div><span>Marks</span><b>${escapeHtml(g.obtainedMarks)} / ${escapeHtml(g.totalMarks)}</b></div>
        <div><span>Percentage</span><b>${escapeHtml(g.percentage)}%</b></div>
        <div><span>Correct</span><b>${escapeHtml(g.correctCount)}</b></div>
        <div><span>Incorrect</span><b>${escapeHtml(g.incorrectCount)}</b></div>
        <div><span>Unanswered</span><b>${escapeHtml(g.unansweredCount)}</b></div>
        <div><span>Result</span><b>${g.passed ? '<span class="badge badge-success">Pass</span>' : '<span class="badge badge-danger">Fail</span>'}</b></div>
      </div>
      ${note ? `<p class="notice notice-info small">${escapeHtml(note)}</p>` : ""}
      <div class="table-wrap"><table class="data-table compact sheet-table">
        <thead><tr><th class="num">#</th><th>Question</th><th>Student's answer</th><th>Correct answer</th><th>Result</th><th class="num">Marks</th></tr></thead>
        <tbody>${(g.details || []).map((d) => `<tr class="sheet-${escapeHtml(d.status)}">
          <td class="num">${escapeHtml(d.position)}</td>
          <td>${escapeHtml(d.text || d.questionId)}</td>
          <td>${d.given === null ? '<span class="muted">—</span>' : escapeHtml(d.type === "short_answer" ? d.givenText : `${d.given}. ${d.givenText}`)}</td>
          <td>${escapeHtml(d.correctAnswer)}</td>
          <td>${badge[d.status] || ""}${d.overridden ? ' <span class="small muted">(changed by teacher)</span>' : ""}</td>
          <td class="num">${escapeHtml(d.marksAwarded)} / ${escapeHtml(d.marks)}</td></tr>`).join("")}</tbody>
      </table></div>`;
  }

  /** Grade / accept / decline from the student record (teachers too, for their own classes). */
  async recordAction(act, rows) {
    if (act === "grade") {
      const list = rows.filter(gradable);
      if (!list.length) { appNotice("Nothing to grade here.", "info"); return; }
      appNotice(`Grading ${pluralize(list.length, "test")}…`, "info");
      clearKeyCache();
      const existing = new Map(list.filter((r) => r.result).map((r) => [r.id, r.result]));
      const { graded, skipped } = await gradeAttempts(list.map((r) => r.attempt), existing, teacher.settings.passPercent);
      appNotice(`Graded ${pluralize(graded, "test")}.${skipped.length ? ` ${skipped.length} could not be graded because the quiz has no answer key.` : ""}`, skipped.length ? "warning" : "success");
    } else if (act === "submit-expired") {
      const list = rows.filter((r) => r.timeUp && !r.archived);
      if (!list.length) return;
      const ok = await confirmDialog({ title: "Submit this quiz? The time is up.", text: "The answers saved before the time ran out are submitted as they are.", okText: "Submit" });
      if (!ok) return;
      await submitExpiredAttempts(list);
      logActivity("attempts_time_up", `Submitted ${pluralize(list.length, "timed quiz", "timed quizzes")} after the time ran out`, list.map((r) => r.id).join(",").slice(0, 200));
      appNotice("Submitted. You can grade it now.", "success");
    } else {
      const value = { accept: "accepted", decline: "declined", pending: "pending" }[act];
      const list = rows.filter((r) => r.submitted && !r.archived);
      if (!value || !list.length) return;
      if (act === "decline") {
        const ok = await confirmDialog({ title: "Decline this submission?", text: "It is left out of grades and averages. You can accept it later.", okText: "Decline" });
        if (!ok) return;
      }
      await setReviewStatus(list, value, act === "decline" ? "Declined by teacher" : "");
      appNotice(`Marked as ${{ accepted: "accepted", declined: "declined", pending: "pending review" }[value]}.`, "success");
    }
    this.cache.clear();
    this.onChanged?.();
    await this.openStudent(this.detailStudent ? { student: this.detailStudent } : this.detailWho, { quiet: true });
  }

  // ------------------------------------------------------------- events

  groupFor(key) {
    if (this.current && this.detailWho) {
      const curKey = this.detailStudent ? `id:${this.detailStudent.id}` : `${this.detailWho.grade}|${this.detailWho.section}|${this.detailWho.rollNo}`;
      if (key === curKey) return { key, student: this.detailStudent, name: this.detailStudent?.name || this.detailAll[0]?.studentName, ...this.detailWho, rows: this.detailAll };
    }
    return this.groups.find((g) => g.key === key);
  }

  async onClick(e) {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      if (this.current) {
        this.detailSort = nextSort(this.detailSort, th.dataset.sort, DETAIL_DESC_FIRST);
        this.detailPage = 0;
        this.renderDetail(this.detailStudent, this.detailWho, this.detailAll);
      } else {
        this.sort = nextSort(this.sort, th.dataset.sort, GROUP_DESC_FIRST);
        this.listPage = 0;
        this.renderList();
      }
      return;
    }
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn) {
      if (pageBtn.disabled) return;
      if (this.current) {
        this.detailPage = Number(pageBtn.dataset.page);
        this.renderDetail(this.detailStudent, this.detailWho, this.detailAll);
        this.$("detail").querySelector(".sr-history")?.scrollIntoView({ block: "start", behavior: "smooth" });
      } else {
        this.listPage = Number(pageBtn.dataset.page);
        this.renderList();
        this.$("list").scrollIntoView({ block: "start", behavior: "smooth" });
      }
      return;
    }
    const bulkBtn = e.target.closest("[data-bulk]");
    if (bulkBtn) {
      bulkBtn.closest("details")?.removeAttribute("open");
      if (!bulkBtn.disabled && isAdmin()) this.run(() => this.bulkAction(bulkBtn.dataset.bulk));
      return;
    }
    const sheet = e.target.closest("[data-sheet]");
    if (sheet) { this.run(() => this.showSheet(sheet.dataset.sheet)); return; }
    const ract = e.target.closest("[data-ract]");
    if (ract) {
      ract.closest("details")?.removeAttribute("open");
      const r = this.detailAll.find((x) => x.id === ract.dataset.id);
      if (r) this.run(() => this.recordAction(ract.dataset.ract, [r]));
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      open.closest("details")?.removeAttribute("open");
      const g = this.groups.find((x) => x.key === open.dataset.open);
      if (g) this.openStudent(g);
      return;
    }
    const gact = e.target.closest("[data-gact]");
    if (gact) {
      gact.closest("details")?.removeAttribute("open");
      const g = this.groupFor(gact.dataset.key);
      if (g) this.run(() => this.groupAction(gact.dataset.gact, g));
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    act.closest("details")?.removeAttribute("open");
    switch (act.dataset.act) {
      case "back": this.current = null; this.$("detail").hidden = true; this.$("list").hidden = false; if (this.loadedKey) this.renderList(); else this.load(); /* opened from a link: the list was never loaded */ if (/^#(history|student)/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search); break;
      case "migrate": this.run(() => this.migrate()); break;
      case "grade-student": this.run(() => this.recordAction("grade", this.detailAll.filter((r) => r.grading !== "graded"))); break;
      case "print-one": await this.print(this.detailRows, false, "Student record"); break;
      case "print-one-answers": await this.print(this.detailRows, true, "Student record with answers"); break;
      case "print-list": await this.print(this.listRows(), false, "Student records"); break;
      case "print-list-answers": await this.print(this.listRows(), true, "Student records with answers"); break;
      case "export-list": this.exportRows(this.listRows(), "student-records"); break;
      case "export-students": this.exportStudents(); break;
      default:
    }
  }

  async groupAction(act, g) {
    const label = `${g.name} (roll ${g.rollNo}, Grade ${g.grade} ${g.section})`;
    switch (act) {
      case "edit": return this.editStudent(g.student);
      case "register": return this.registerGroup(g);
      case "print": return this.print(g.rows, false, "Student record");
      case "export": return this.exportRows(g.rows, `student_${g.name}`);
      case "backup":
        downloadFile(`student_${g.name}_backup.json`.replace(/[^A-Za-z0-9_.-]+/g, "-"), buildBackup(g.rows.filter((r) => !r.archived).map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })), "active"), "application/json");
        return undefined;
      case "archive": {
        const active = g.rows.filter((r) => !r.archived);
        if (!active.length) { appNotice("There are no active quiz records to archive.", "info"); return undefined; }
        const ok = await confirmDialog({ title: `Archive ${pluralize(active.length, "quiz record")} of ${g.name}?`, text: "They move to the Archive. You can restore them later. The student record stays.", okText: "Archive" });
        if (!ok) return undefined;
        await archiveRecords(active.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })));
        logActivity("records_archived", `Archived ${active.length} quiz records of ${label}`, g.student?.id || "");
        appNotice(`Archived ${pluralize(active.length, "record")}.`, "success");
        return this.refreshAfterChange(g);
      }
      case "delete-records": {
        const active = g.rows.filter((r) => !r.archived);
        const archived = g.rows.filter((r) => r.archived);
        const res = await confirmDialog({
          title: `Delete ${pluralize(g.rows.length, "quiz record")} of ${g.name}?`, text: "This permanently deletes them. It cannot be undone.",
          okText: "Delete records", danger: true, option: { label: "Download a backup file first (recommended)", checked: true }, check: `Yes, delete ${pluralize(g.rows.length, "record")}`
        });
        if (!res) return undefined;
        if (res.option) downloadFile(`student_${g.name}_backup.json`.replace(/[^A-Za-z0-9_.-]+/g, "-"), buildBackup(active.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })), "active"), "application/json");
        if (active.length) await deleteRecords("active", active);
        if (archived.length) await deleteRecords("archive", archived);
        logActivity("records_deleted", `Deleted ${g.rows.length} quiz records of ${label}`, g.student?.id || "");
        appNotice(`Deleted ${pluralize(g.rows.length, "record")}.`, "success");
        return this.refreshAfterChange(g);
      }
      case "delete": {
        const res = await confirmDialog({
          title: `Delete the student record of ${g.name}?`,
          text: `Their quiz records are kept (${pluralize(g.rows.length, "record")}) and show the name typed on each quiz. The roll number becomes free for a new registration.`,
          okText: "Delete student", danger: true, check: `Yes, delete ${g.name}`
        });
        if (!res) return undefined;
        await deleteStudent(g.student);
        logActivity("student_deleted", `Deleted the student record of ${label}`, g.student.id);
        appNotice(`${g.name} was deleted. Their quiz records were kept.`, "success");
        this.current = null;
        this.cache.clear();
        return this.load();
      }
      case "request": return openRequestDialog({
        types: ["rename_student", "edit_student", "delete_student", "print_records", "export_records", "archive_records", "delete_records", "other"],
        student: { id: g.student?.id || "", name: g.name, grade: g.grade, section: g.section, rollNo: g.rollNo }
      });
      default: return undefined;
    }
  }

  async refreshAfterChange(g) {
    this.cache.clear();
    this.onChanged?.();
    if (this.current) return this.openStudent(g.student ? { student: g.student } : g);
    return this.load();
  }

  studentForm(title, okText, initial = {}) {
    const grades = teacher.settings.grades;
    const sectionOptions = (g) => sectionsFor(teacher.settings, g).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    return formModal({
      title, okText,
      body: `
        <div class="field"><label for="sfName">Full name</label><input type="text" id="sfName" maxlength="80"><div class="error-text" data-err="name" hidden></div></div>
        <div class="row">
          <div class="field"><label for="sfGrade">Grade</label><select id="sfGrade">${grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("")}</select></div>
          <div class="field"><label for="sfSection">Section</label><select id="sfSection"></select></div>
          <div class="field"><label for="sfRoll">Roll number</label><input type="text" id="sfRoll" inputmode="numeric" maxlength="6"><div class="error-text" data-err="roll" hidden></div></div>
        </div>
        <p class="small muted">The student keeps the same record and all their quiz results. The new name is shown everywhere; earlier names are remembered.</p>`,
      onOpen: (root) => {
        const q = (s) => root.querySelector(s);
        q("#sfName").value = initial.name || "";
        q("#sfGrade").value = grades.includes(initial.grade) ? initial.grade : grades[0] || "";
        const fillSec = () => { q("#sfSection").innerHTML = sectionOptions(q("#sfGrade").value); };
        fillSec();
        if (initial.section) q("#sfSection").value = initial.section;
        q("#sfGrade").addEventListener("change", fillSec);
        q("#sfRoll").value = initial.rollNo || "";
        q("#sfName").focus();
      },
      collect: (root) => {
        const q = (s) => root.querySelector(s);
        const name = normalizeName(q("#sfName").value);
        const grade = q("#sfGrade").value, section = q("#sfSection").value;
        const { roll, error } = validateRoll(q("#sfRoll").value, teacher.settings, grade, section);
        const errs = { name: name.length < 2 ? "Enter the student's full name." : "", roll: error || (!grade || !section || !NAME_PATTERN.test(section) ? "Choose a grade and section." : "") };
        Object.entries(errs).forEach(([key, msg]) => { const b = root.querySelector(`[data-err="${key}"]`); b.textContent = msg; b.hidden = !msg; });
        return Object.values(errs).some(Boolean) ? null : { name, grade, section, rollNo: roll };
      }
    });
  }

  async editStudent(student) {
    const v = await this.studentForm(`Edit ${student.name}`, "Save", student);
    if (!v) return;
    if (v.name === student.name && v.grade === student.grade && v.section === student.section && v.rollNo === student.rollNo) return;
    const updated = await updateStudent(student, v);
    const changes = [];
    if (v.name !== student.name) changes.push(`name "${student.name}" → "${v.name}"`);
    if (v.grade !== student.grade || v.section !== student.section || v.rollNo !== student.rollNo) changes.push(`class ${student.grade} ${student.section} roll ${student.rollNo} → ${v.grade} ${v.section} roll ${v.rollNo}`);
    logActivity("student_updated", `Updated student: ${changes.join("; ")}`, student.id);
    appNotice(`Saved. ${updated.name} is shown with the new details everywhere.`, "success");
    this.onChanged?.();
    await this.refreshAfterChange({ student: updated });
  }

  async addStudent() {
    const v = await this.studentForm("Add a student", "Add student", { grade: this.scope.grade, section: this.scope.section });
    if (!v) return;
    const s = await createStudent(v);
    logActivity("student_created", `Added student ${s.name} (roll ${s.rollNo}, Grade ${s.grade} ${s.section})`, s.id);
    appNotice(`${s.name} was added.`, "success");
    this.cache.clear();
    if (!this.current) this.load();
  }

  async registerGroup(g) {
    const v = await this.studentForm(`Register ${g.name}`, "Register", { name: g.name, grade: g.grade, section: g.section, rollNo: g.rollNo });
    if (!v) return;
    const s = await createStudent(v);
    if (v.grade === g.grade && v.section === g.section && v.rollNo === g.rollNo) await linkOldAttempts(s); // links the older records
    logActivity("student_created", `Registered ${s.name} (roll ${s.rollNo}, Grade ${s.grade} ${s.section}) from existing records`, s.id);
    appNotice(`${s.name} is registered. Their records are linked.`, "success");
    await this.refreshAfterChange({ student: s });
  }

  listRows() {
    const keys = new Set(this.visibleGroups().map((g) => g.key));
    return this.rows.filter((r) => keys.has(rowKey(r)));
  }

  exportRows(rows, stem) {
    if (!rows.length) { appNotice("There is nothing to export.", "info"); return; }
    downloadFile(`${stem}_${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^A-Za-z0-9_.-]+/g, "-"), summaryCsv(rows));
    appNotice(`Exported ${pluralize(rows.length, "record")}.`, "success");
  }

  exportStudents(list = this.visibleGroups(), stem = "students") {
    const csv = toCsv([["Student ID", "Name", "Roll no.", "Grade", "Section", "Registered", "Quizzes attempted", "Counted", "Overall %", "Average %", "Earlier names"],
      ...list.map((g) => [g.student?.id || "", g.name, g.rollNo, g.grade, g.section, g.student ? "Yes" : "No", g.perf.attempted, g.perf.counted,
        g.perf.overallPercent ?? "", g.perf.averagePercent ?? "", [...new Set([...(g.student?.previousNames || []), ...g.names])].filter((n) => n !== g.name).join(" / ")])]);
    downloadFile(`${stem}_${new Date().toISOString().slice(0, 10)}.csv`, csv);
    appNotice(`Exported ${pluralize(list.length, "student")}.`, "success");
  }

  async print(rows, includeAnswers, title) {
    if (!rows?.length) { appNotice("There is nothing to print.", "info"); return; }
    appNotice("Preparing the report…", "info");
    const html = await buildReport(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result, archived: r.archived })), {
      title,
      subtitle: [this.current ? "" : this.scopeText(), this.scope.archive ? "including archived" : ""].filter(Boolean).join(" · "),
      quizzes: teacher.quizzes,
      passPercent: teacher.settings.passPercent,
      includeAnswers
    });
    appNotice('Report ready. Choose "Save as PDF" in the print dialog for one combined PDF.', "success");
    printHtml(html);
  }
}

/** "#history=6|A|12" (older links) or "#student=<id>". */
export function parseHistoryHash(hash) {
  const id = /^#student=(.+)$/.exec(hash || "");
  if (id) return { id: decodeURIComponent(id[1]) };
  const m = /^#history=(.+)$/.exec(hash || "");
  if (!m) return null;
  const [grade, section, roll] = m[1].split("|").map(decodeURIComponent);
  const rollNo = normalizeRoll(roll);
  return grade && section && rollNo ? { grade, section, rollNo } : null;
}
