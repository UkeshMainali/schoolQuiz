// Quizzes tab: add quizzes from question-bank files (each lesson separately
// or several lessons merged), and manage existing quizzes (open/close, edit
// details, archive, answer key, delete).
//
// Every quiz gets its own document id. Adding a quiz never replaces an
// existing one unless the teacher explicitly chooses "Replace".
//
// Storage per quiz (all written together in one batch):
//   quizzes/{id}      list document: title, grade, counts, status (students can read open quizzes)
//   quizContent/{id}  questions and options, no answers (students can read while the quiz is open)
//   answerKeys/{id}   correct answers (teacher only)

import { db, doc, writeBatch, serverTimestamp, Timestamp } from "./firebase.js";
import { parseQuestionBank, buildQuiz, toQuizMeta, toQuizContent, toAnswerKey } from "./questionBank.js";
import { loadAnswerKey, clearKeyCache } from "./grading.js";
import { teacher, reloadQuizzes, reloadCategories, setCategories, appNotice, onTeacherChange } from "./teacherState.js";
import { pagerHtml, pageSlice, clampPage } from "./pager.js";
import { escapeHtml, friendlyError, confirmDialog, inputDialog, pluralize, formatDateTime, formatDate, toDate, storage, skeleton } from "./utilities.js";
import { sortRows, nextSort, paintSortHeaders } from "./tableSort.js";
import { session, isAdmin, ownsQuiz, myGrades, mySections } from "./roles.js";
import { countAttempts, attemptIdParts } from "./records.js";
import { logActivity } from "./auth.js";
import {
  ALL, UNCATEGORIZED, addCategory, renameCategory, deleteCategory, moveQuizzes,
  nameProblem, categoryOf, categoryName
} from "./quizCategories.js";

const QUIZZES_PER_BATCH = 100; // 3 writes each, below Firestore's 500 limit
const TAB_KEY = "cq_quiz_tab";

// Sort values for the quiz table columns.
const STATUS_ORDER = (q) => (q.archived ? 2 : q.active ? 0 : 1);
const QUIZ_VALUE = {
  title: (q) => q.title,
  grade: (q) => q.grade,
  category: (q) => { const c = categoryOf(q, teacher.categories); return c ? categoryName(c, teacher.categories) : null; }, // no tab = empty, sorts last
  questions: (q) => (typeof q.questionCount === "number" ? q.questionCount : null),
  marks: (q) => (typeof q.totalMarks === "number" ? q.totalMarks : null),
  status: STATUS_ORDER,
  created: (q) => toDate(q.createdAt || q.importedAt)?.getTime() ?? null,
  owner: (q) => ownerLabel(q),
  attempts: (q) => null // filled in by the view (counts load lazily)
};

const gradeLabel = (g) => (g ? `Grade ${escapeHtml(g)}` : "Any grade");
/** "Sections A, B" or "All sections". */
const sectionsLabel = (q) => (Array.isArray(q.sections) && q.sections.length ? `Section ${q.sections.map(escapeHtml).join(", ")}` : "All sections");
/** Who owns a quiz: a teacher's name, or "Admin" (also for quizzes made before roles existed). */
export function ownerLabel(q) {
  if (q.ownerRole === "teacher") return q.ownerName || "Teacher";
  return q.ownerId ? (q.ownerName || "Admin") : "Admin (older quiz)";
}
const typeSummary = (questions) => Object.entries(questions.reduce((m, q) => ({ ...m, [q.type]: (m[q.type] || 0) + 1 }), {}))
  .map(([t, n]) => `${n} ${t.replace("_", " ")}`).join(", ");

export class QuizAdmin {
  constructor(container) {
    this.el = container;
    this.imp = null;
    this.filters = { search: "", grade: "", status: "", owner: "" };
    this.attemptCounts = new Map(); // quizId -> number (loaded for the quizzes on screen)
    this.sort = { key: "grade", dir: "asc" }; // then title
    this.tab = storage.get(TAB_KEY) ?? ALL;
    this.selected = new Set();
    this.qpage = 0;
    this.el.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h2>Add quizzes</h2><p class="card-sub">Upload a question bank file.</p></div></div>
        <label class="file-drop">
          <input type="file" class="native-hidden" accept=".json,application/json" multiple data-q="file" aria-label="Question bank files">
          <span class="file-drop-icon" aria-hidden="true"></span>
          <span class="file-drop-text"><b>Choose question bank files</b> or drop them here</span>
          <span class="file-drop-sub">JSON · nothing is saved until you press Add</span>
        </label>
        <div data-q="preview"></div>
      </div>

      <div class="card table-card quiz-table-card">
        <div class="qtabs-bar">
          <div class="qtabs" role="tablist" aria-label="Quiz tabs" data-q="tabs"></div>
          <button type="button" class="btn btn-small btn-ghost qtabs-add" data-q="new-tab" data-icon="plus" aria-label="New tab"><span class="btn-text">New tab</span></button>
        </div>
        <div class="card-head qtab-head">
          <div class="qtab-title"><h2 data-q="tab-title">All quizzes</h2><span class="muted small" data-q="count"></span></div>
          <div class="qtab-actions" data-q="tab-actions"></div>
        </div>
        <div class="filters">
          <label class="stack-field grow"><span>Search</span><input type="search" data-q="search" placeholder="Quiz title or ID"></label>
          <label class="stack-field"><span>Grade</span><select data-q="grade"></select></label>
          ${isAdmin() ? '<label class="stack-field"><span>Created by</span><select data-q="owner"></select></label>' : ""}
          <label class="stack-field"><span>Status</span><select data-q="status">
            <option value="">Open and closed</option><option value="open">Open</option><option value="closed">Closed</option><option value="archived">Archived</option><option value="all">All, including archived</option>
          </select></label>
          <button type="button" class="btn" data-q="refresh">Refresh</button>
        </div>
        <div class="selection-bar" data-q="selection" hidden>
          <b data-q="sel-count"></b>
          <button type="button" class="btn btn-small" data-q="move-selected" data-icon="folder-open">Move to tab…</button>
          <button type="button" class="btn-link small" data-q="clear-selection">Clear selection</button>
        </div>
        <div class="table-wrap">
          <table class="data-table quiz-table">
            <thead><tr>
              <th class="col-check"><input type="checkbox" data-q="select-all" aria-label="Select all quizzes shown"></th>
              <th data-sort="title">Quiz</th>
              <th data-sort="grade">Grade</th>
              <th data-sort="category">Tab</th>
              ${isAdmin() ? '<th data-sort="owner">Created by</th>' : ""}
              <th data-sort="questions" class="num">Questions</th>
              <th data-sort="marks" class="num">Marks</th>
              <th data-sort="attempts" class="num" title="Student attempts${isAdmin() ? "" : " in your classes"}">Attempts</th>
              <th data-sort="status">Status</th>
              <th data-sort="created">Created</th>
              <th class="actions-col">Actions</th>
            </tr></thead>
            <tbody data-q="list"></tbody>
          </table>
        </div>
        <div data-q="pager"></div>
      </div>
      <div data-q="key"></div>`;
    this.$ = (s) => this.el.querySelector(`[data-q="${s}"]`);
    this.bind();
    onTeacherChange((what) => {
      if (what === "students" || !this.shown) return;
      this.fillGradeFilter();
      this.renderList();
      // Keep an import the user is working on as it is; only settings change its choices.
      if (this.imp && what === "settings") this.renderImport();
    });
  }

  show() {
    this.shown = true;
    this.fillGradeFilter();
    this.renderList();
  }

  bind() {
    this.$("file").addEventListener("change", (e) => this.readFiles([...e.target.files]));
    this.$("search").addEventListener("input", (e) => { this.filters.search = e.target.value; this.qpage = 0; this.renderList(); });
    this.$("grade").addEventListener("change", (e) => { this.filters.grade = e.target.value; this.qpage = 0; this.renderList(); });
    this.$("status").addEventListener("change", (e) => { this.filters.status = e.target.value; this.qpage = 0; this.renderList(); });
    this.$("owner")?.addEventListener("change", (e) => { this.filters.owner = e.target.value; this.qpage = 0; this.renderList(); });
    this.$("refresh").addEventListener("click", async () => {
      this.attemptCounts.clear();
      try { await Promise.all([reloadQuizzes(), reloadCategories()]); appNotice("Quiz list refreshed.", "success"); } catch (err) { appNotice(friendlyError(err), "error"); }
    });
    this.$("list").addEventListener("click", (e) => this.onListClick(e));
    this.$("list").addEventListener("change", (e) => {
      const box = e.target.closest("[data-select]");
      if (!box) return;
      if (box.checked) this.selected.add(box.dataset.select); else this.selected.delete(box.dataset.select);
      box.closest("tr").classList.toggle("selected", box.checked);
      this.renderSelection();
    });
    this.$("select-all").addEventListener("change", (e) => {
      this.visibleQuizzes().forEach((q) => { if (e.target.checked) this.selected.add(q.id); else this.selected.delete(q.id); });
      this.renderList();
    });
    this.$("clear-selection").addEventListener("click", () => { this.selected.clear(); this.renderList(); });
    this.$("move-selected").addEventListener("click", () => this.run(() => this.moveDialog([...this.selected])));
    // 50 quizzes per page; sorting and filtering always use the whole list.
    this.$("pager").addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (!b || b.disabled) return;
      this.qpage = Number(b.dataset.page);
      this.renderList();
      this.el.querySelector(".quiz-table").scrollIntoView({ block: "start", behavior: "smooth" });
    });
    this.el.querySelector(".quiz-table thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      this.sort = nextSort(this.sort, th.dataset.sort, ["questions", "marks", "created", "attempts"]);
      this.qpage = 0;
      this.renderList();
    });
    this.$("tabs").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab-id]");
      if (!t) return;
      this.setTab(t.dataset.tabId);
    });
    this.$("tabs").addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const tabs = [...this.$("tabs").querySelectorAll("[data-tab-id]")];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const j = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      this.setTab(tabs[j].dataset.tabId);
      this.$("tabs").querySelector(`[data-tab-id="${CSS.escape(tabs[j].dataset.tabId)}"]`)?.focus();
    });
    this.$("new-tab").addEventListener("click", () => this.run(() => this.newTab()));
    this.$("tabs").addEventListener("scroll", () => this.updateTabFades(), { passive: true });
    // The tab row only scrolls sideways: a mouse wheel scrolls it left/right.
    this.$("tabs").addEventListener("wheel", (e) => {
      const strip = this.$("tabs");
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }, { passive: false });
    window.addEventListener("resize", () => { if (this.shown) this.updateTabFades(); });
    this.$("tab-actions").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab-act]");
      if (!b) return;
      b.closest("details")?.removeAttribute("open");
      this.run(() => (b.dataset.tabAct === "rename" ? this.renameTab() : this.deleteTab()));
    });
    const preview = this.$("preview");
    preview.addEventListener("change", (e) => this.onImportChange(e));
    preview.addEventListener("input", (e) => {
      if (e.target.dataset.imp === "title") { this.imp.mergeTitle = e.target.value; this.renderPlan(); }
    });
    preview.addEventListener("click", (e) => {
      if (e.target.closest('[data-imp="add"]')) this.doImport();
      if (e.target.closest('[data-imp="cancel"]')) this.resetImport();
    });
    document.addEventListener("click", (e) => {
      this.el.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
  }

  // ------------------------------------------------------------ quiz tabs

  /** Runs a teacher action and shows any error. */
  async run(fn) {
    try { await fn(); } catch (err) { console.error(err); appNotice(friendlyError(err), "error"); }
  }

  tabExists(id) { return id === ALL || teacher.categories.some((c) => c.id === id); }

  /** The quizzes this page manages: all for the Admin, a teacher's own for a teacher. */
  myQuizzes() { return [...teacher.quizzes.values()].filter((q) => ownsQuiz(q)); }

  setTab(id) {
    this.tab = this.tabExists(id) ? id : ALL;
    storage.set(TAB_KEY, this.tab);
    this.qpage = 0;
    this.renderList();
    if (this.imp) this.renderImport();
  }

  /** Quizzes counted on each tab, with the current status filter. */
  tabCounts() {
    const counts = new Map([[ALL, 0]]);
    teacher.categories.forEach((c) => counts.set(c.id, 0));
    this.myQuizzes().filter((q) => this.statusMatches(q)).forEach((q) => {
      const c = categoryOf(q, teacher.categories);
      counts.set(ALL, counts.get(ALL) + 1);
      counts.set(c, (counts.get(c) || 0) + 1);
    });
    return counts;
  }

  renderTabs() {
    if (!this.tabExists(this.tab)) this.tab = ALL;
    const counts = this.tabCounts();
    const tabs = [[ALL, "All quizzes"], ...teacher.categories.map((c) => [c.id, c.name])];
    this.$("tabs").innerHTML = tabs.map(([id, name]) => {
      const on = id === this.tab;
      return `<button type="button" role="tab" class="qtab${on ? " active" : ""}" data-tab-id="${escapeHtml(id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">
        <span class="qtab-name">${escapeHtml(name)}</span><span class="chip-count">${counts.get(id) || 0}</span></button>`;
    }).join("");
    // Keep the active tab in view by scrolling the tab row only (never the page).
    const strip = this.$("tabs");
    const active = strip.querySelector(".qtab.active");
    if (active) {
      if (active.offsetLeft < strip.scrollLeft) strip.scrollLeft = active.offsetLeft - 12;
      else if (active.offsetLeft + active.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = active.offsetLeft + active.offsetWidth - strip.clientWidth + 12;
    }
    this.updateTabFades();
    const custom = teacher.categories.find((c) => c.id === this.tab);
    this.$("tab-title").textContent = custom ? custom.name : "All quizzes";
    // Rename and Delete sit in plain sight next to the tab's name.
    this.$("tab-actions").innerHTML = custom ? `
      <button type="button" class="btn btn-small" data-tab-act="rename">Rename tab</button>
      <button type="button" class="btn btn-small btn-danger" data-tab-act="delete">Delete tab</button>` : "";
  }

  /** Fades the edge of the tab row where more tabs are hidden. */
  updateTabFades() {
    const strip = this.$("tabs");
    const bar = strip.parentElement;
    bar.classList.toggle("fade-left", strip.scrollLeft > 2);
    bar.classList.toggle("fade-right", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  }

  async newTab() {
    const name = await inputDialog({
      title: "New tab",
      field: { type: "text", label: "Tab name", maxLength: 40, value: "" },
      okText: "Create tab",
      validate: (v) => nameProblem(v, teacher.categories)
    });
    if (name === null) return;
    const { list, id } = await addCategory(name);
    setCategories(list);
    this.setTab(id);
    appNotice(`Tab "${name}" created.`, "success");
  }

  async renameTab() {
    const cat = teacher.categories.find((c) => c.id === this.tab);
    if (!cat) return;
    const name = await inputDialog({
      title: "Rename tab",
      field: { type: "text", label: "Tab name", maxLength: 40, value: cat.name },
      okText: "Rename",
      validate: (v) => nameProblem(v, teacher.categories, cat.id)
    });
    if (name === null || name === cat.name) return;
    setCategories(await renameCategory(cat.id, name));
    appNotice(`Tab renamed to "${name}". Its quizzes did not change.`, "success");
  }

  async deleteTab() {
    const cat = teacher.categories.find((c) => c.id === this.tab);
    if (!cat) return;
    // Every quiz on this tab, archived ones included.
    const ids = this.myQuizzes().filter((q) => categoryOf(q, teacher.categories) === cat.id).map((q) => q.id);
    let moveTo = UNCATEGORIZED;
    if (ids.length) {
      const others = [...teacher.categories.filter((c) => c.id !== cat.id).map((c) => ({ value: c.id, label: c.name })), { value: UNCATEGORIZED, label: "No tab (they stay under All quizzes)" }];
      const chosen = await inputDialog({
        title: `Delete the "${cat.name}" tab?`,
        text: `Its ${pluralize(ids.length, "quiz", "quizzes")} will be moved, not deleted.`,
        field: { type: "select", label: `Move the ${pluralize(ids.length, "quiz", "quizzes")} to`, options: others, value: others[0].value },
        okText: "Move quizzes and delete tab",
        danger: true,
        check: `Yes, delete the "${cat.name}" tab`
      });
      if (chosen === null) return;
      moveTo = chosen;
    } else {
      const ok = await confirmDialog({ title: `Delete the "${cat.name}" tab?`, text: "The tab is empty.", okText: "Delete tab", danger: true });
      if (!ok) return;
    }
    const list = await deleteCategory(cat.id, ids, moveTo);
    ids.forEach((id) => { const q = teacher.quizzes.get(id); if (q) q.categoryId = moveTo; });
    setCategories(list);
    this.setTab(ids.length && moveTo ? moveTo : ALL);
    appNotice(`Tab "${cat.name}" deleted.${ids.length ? ` ${pluralize(ids.length, "quiz was", "quizzes were")} ${moveTo ? `moved to ${categoryName(moveTo, list)}` : "kept with no tab (see All quizzes)"}.` : ""}`, "success");
  }

  /** Asks for a tab and moves the quizzes there (only categoryId changes). */
  async moveDialog(ids) {
    ids = ids.filter((id) => teacher.quizzes.has(id));
    if (!ids.length) return;
    const first = teacher.quizzes.get(ids[0]);
    const current = ids.length === 1 ? categoryOf(first, teacher.categories) : null;
    const options = [...teacher.categories.map((c) => ({ value: c.id, label: c.name })), { value: UNCATEGORIZED, label: "No tab (only under All quizzes)" }];
    const fallback = this.tab !== ALL && this.tab !== current ? this.tab : options.find((o) => o.value !== current)?.value ?? UNCATEGORIZED;
    const to = await inputDialog({
      title: ids.length === 1 ? `Move "${first.title}"` : `Move ${ids.length} quizzes`,
      text: teacher.categories.length ? "" : "No tabs yet. Create one with New tab first.",
      field: { type: "select", label: "Move to tab", options, value: fallback },
      okText: "Move"
    });
    if (to === null) return;
    const moving = ids.filter((id) => categoryOf(teacher.quizzes.get(id), teacher.categories) !== to);
    if (!moving.length) { appNotice(to ? `Already in ${categoryName(to, teacher.categories)}.` : "These quizzes already have no tab.", "info"); return; }
    await moveQuizzes(moving, to);
    moving.forEach((id) => Object.assign(teacher.quizzes.get(id), { categoryId: to, updatedAt: new Date() }));
    this.selected.clear();
    this.renderList();
    appNotice(to ? `Moved ${pluralize(moving.length, "quiz", "quizzes")} to ${categoryName(to, teacher.categories)}.` : `Removed ${pluralize(moving.length, "quiz", "quizzes")} from their tab. They are under All quizzes.`, "success");
  }

  // ------------------------------------------------------------ quiz list

  fillGradeFilter() {
    const sel = this.$("grade");
    const grades = [...new Set([...myGrades(teacher.settings), ...this.myQuizzes().map((q) => q.grade).filter(Boolean)])];
    sel.innerHTML = '<option value="">All grades</option>' + grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("");
    sel.value = grades.includes(this.filters.grade) ? this.filters.grade : "";
    this.filters.grade = sel.value;
    const own = this.$("owner");
    if (own) {
      const owners = [...new Map(this.myQuizzes().map((q) => [q.ownerRole === "teacher" ? q.ownerId : "__admin", ownerLabel(q).replace(" (older quiz)", "")])).entries()]
        .sort((a, b) => (a[0] === "__admin" ? -1 : b[0] === "__admin" ? 1 : a[1].localeCompare(b[1])));
      own.innerHTML = '<option value="">Everyone</option>' + owners.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
      own.value = owners.some(([id]) => id === this.filters.owner) ? this.filters.owner : "";
      this.filters.owner = own.value;
    }
  }

  statusMatches(q) {
    switch (this.filters.status) {
      case "open": return !q.archived && !!q.active;
      case "closed": return !q.archived && !q.active;
      case "archived": return !!q.archived;
      case "all": return true;
      default: return !q.archived;
    }
  }

  /** Tab + filters + search, then sorted: the complete list the table shows. */
  visibleQuizzes() {
    const term = this.filters.search.trim().toLowerCase();
    const list = this.myQuizzes()
      .filter((q) => this.tab === ALL || categoryOf(q, teacher.categories) === this.tab)
      .filter((q) => this.statusMatches(q))
      .filter((q) => !this.filters.grade || String(q.grade) === this.filters.grade)
      .filter((q) => !this.filters.owner || (this.filters.owner === "__admin" ? q.ownerRole !== "teacher" : q.ownerId === this.filters.owner))
      .filter((q) => !term || String(q.title).toLowerCase().includes(term) || q.id.toLowerCase().includes(term));
    return sortRows(list, this.sort, {
      value: (q, k) => (k === "attempts" ? (this.attemptCounts.has(q.id) ? this.attemptCounts.get(q.id) : null) : QUIZ_VALUE[k](q)),
      tieBreak: (a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true })
    });
  }

  renderList() {
    this.renderTabs();
    // Forget selections that no longer exist.
    [...this.selected].forEach((id) => { if (!teacher.quizzes.has(id)) this.selected.delete(id); });
    const list = this.visibleQuizzes();
    this.qpage = clampPage(this.qpage, list.length);
    const shown = pageSlice(list, this.qpage);
    const archivedCount = this.myQuizzes().filter((q) => q.archived && (this.tab === ALL || categoryOf(q, teacher.categories) === this.tab)).length;
    const hiddenArchived = archivedCount && !["archived", "all"].includes(this.filters.status);
    this.$("count").textContent = `${pluralize(list.length, "quiz", "quizzes")}${hiddenArchived ? ` · ${archivedCount} archived hidden` : ""}`;
    paintSortHeaders(this.el.querySelector(".quiz-table"), this.sort);
    let empty = "";
    if (!list.length) {
      const anyHere = this.myQuizzes().some((q) => this.tab === ALL || categoryOf(q, teacher.categories) === this.tab);
      empty = !this.myQuizzes().length ? "No quizzes yet. Add a question bank file above."
        : !anyHere ? (this.tab === ALL ? "No quizzes yet." : "No quizzes in this tab yet.")
          : "No quizzes match these filters.";
    }
    this.$("list").innerHTML = shown.length ? shown.map((q) => this.quizRow(q)).join("") : `<tr><td colspan="${isAdmin() ? 11 : 10}" class="empty">${escapeHtml(empty)}</td></tr>`;
    this.loadAttemptCounts(shown);
    this.$("pager").innerHTML = pagerHtml({ page: this.qpage, total: list.length, label: "quizzes" });
    const all = this.$("select-all");
    const selShown = list.filter((q) => this.selected.has(q.id)).length;
    all.checked = !!list.length && selShown === list.length;
    all.indeterminate = selShown > 0 && selShown < list.length;
    this.renderSelection();
  }

  /** Live update: students started or submitted; recount those quizzes' attempts. */
  liveUpdate(ids) {
    let changed = false;
    ids.forEach((id) => { const p = attemptIdParts(id); if (p && this.attemptCounts.delete(p.quizId)) changed = true; });
    if (changed && this.shown) this.renderList();
  }

  /** Counts attempts for the quizzes on screen (1 small count query each; cached). */
  async loadAttemptCounts(quizzes) {
    const todo = quizzes.filter((q) => !this.attemptCounts.has(q.id) && !this.counting?.has(q.id));
    if (!todo.length) return;
    this.counting = this.counting || new Set();
    todo.forEach((q) => this.counting.add(q.id));
    await Promise.all(todo.map(async (q) => {
      try {
        const n = await countAttempts("active", { quizId: q.id });
        this.attemptCounts.set(q.id, n);
        const cell = this.$("list").querySelector(`[data-attempts="${CSS.escape(q.id)}"]`);
        if (cell) cell.textContent = String(n);
      } catch (err) {
        console.warn("Attempt count unavailable", q.id, err);
      } finally {
        this.counting.delete(q.id);
      }
    }));
  }

  renderSelection() {
    const n = this.selected.size;
    this.$("selection").hidden = !n;
    this.$("sel-count").textContent = `${pluralize(n, "quiz", "quizzes")} selected`;
  }

  quizRow(q) {
    const id = escapeHtml(q.id);
    const lessons = Array.isArray(q.lessons) ? q.lessons : [];
    const kind = q.merged
      ? `<span class="badge badge-info" title="${escapeHtml(lessons.map((l) => l.title).join(", "))}">Merged · ${lessons.length} lessons</span>`
      : '<span class="badge badge-muted">Individual</span>';
    const status = q.archived ? '<span class="badge badge-muted">Archived</span>'
      : q.active ? '<span class="badge badge-success">Open</span>' : '<span class="badge">Closed</span>';
    const cat = categoryOf(q, teacher.categories);
    const created = q.createdAt || q.importedAt;
    const sel = this.selected.has(q.id);
    return `
      <tr class="${sel ? "selected" : ""}">
        <td class="col-check"><input type="checkbox" data-select="${id}"${sel ? " checked" : ""} aria-label="Select ${escapeHtml(q.title)}"></td>
        <td>
          <div class="quiz-title">${escapeHtml(q.title)}${q.merged ? ` ${kind}` : ""}</div>
          <div class="small muted quiz-sub"><code>${id}</code>${q.merged ? ` · ${lessons.map((l) => escapeHtml(l.title)).join(" · ")}` : ""}</div>
        </td>
        <td class="nowrap">${gradeLabel(q.grade)}<div class="small muted">${sectionsLabel(q)}</div></td>
        <td class="nowrap">${cat ? escapeHtml(categoryName(cat, teacher.categories)) : '<span class="muted">—</span>'}</td>
        ${isAdmin() ? `<td class="nowrap small">${escapeHtml(ownerLabel(q))}</td>` : ""}
        <td class="num">${q.questionCount ?? "—"}</td>
        <td class="num">${q.totalMarks ?? "—"}</td>
        <td class="num" data-attempts="${id}">${this.attemptCounts.has(q.id) ? this.attemptCounts.get(q.id) : '<span class="muted">…</span>'}</td>
        <td>${status}</td>
        <td class="small nowrap" title="${created ? escapeHtml(formatDateTime(created)) : ""}">${created ? escapeHtml(formatDate(created)) : "—"}</td>
        <td class="actions-cell">
          ${q.archived ? "" : `<button type="button" class="btn btn-small" data-act="toggle" data-id="${id}">${q.active ? "Close" : "Open"}</button>`}
          <button type="button" class="btn btn-small" data-act="edit" data-id="${id}">Edit</button>
          <details class="menu menu-right">
            <summary class="btn btn-small" aria-label="More actions">⋯</summary>
            <div class="menu-list">
              <button type="button" data-act="move" data-id="${id}" data-icon="folder-open">Move to tab…</button>
              <button type="button" data-act="key" data-id="${id}">View answer key</button>
              <button type="button" data-act="${q.archived ? "unarchive" : "archive"}" data-id="${id}">${q.archived ? "Unarchive" : "Archive"}</button>
              <button type="button" data-act="delete" data-id="${id}" class="danger">Delete…</button>
            </div>
          </details>
        </td>
      </tr>`;
  }

  async onListClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    btn.closest("details")?.removeAttribute("open");
    const quiz = teacher.quizzes.get(btn.dataset.id);
    if (!quiz) return;
    const act = btn.dataset.act;
    try {
      if (!ownsQuiz(quiz)) { appNotice("You can only change your own quizzes.", "error"); return; }
      if (act === "toggle") {
        if (!quiz.active && !classesOk(quiz)) { appNotice("This quiz is for a grade or section you are not assigned to, so it cannot be opened. Edit its grade and sections first, or contact the Admin.", "error"); return; }
        await this.setStatus(quiz, { active: !quiz.active }, `"${quiz.title}" is now ${quiz.active ? "closed" : "open for students"}.`);
        logActivity(quiz.active ? "quiz_opened" : "quiz_closed", `${quiz.active ? "Opened" : "Closed"} quiz "${quiz.title}"`, quiz.id);
      }
      else if (act === "archive") {
        const ok = await confirmDialog({
          title: `Archive "${quiz.title}"?`,
          text: "It is hidden from students. You can unarchive it later.",
          okText: "Archive quiz"
        });
        if (ok) { await this.setStatus(quiz, { archived: true, active: false }, `"${quiz.title}" was archived. Choose Status: Archived to see it.`); logActivity("quiz_archived", `Archived quiz "${quiz.title}"`, quiz.id); }
      } else if (act === "unarchive") await this.setStatus(quiz, { archived: false }, `"${quiz.title}" was unarchived. It is closed; press Open when students should see it.`);
      else if (act === "edit") await this.editQuiz(quiz);
      else if (act === "move") await this.moveDialog([quiz.id]);
      else if (act === "key") await this.showAnswerKey(quiz);
      else if (act === "delete") await this.deleteQuiz(quiz);
    } catch (err) {
      console.error(err);
      appNotice(friendlyError(err), "error");
    }
  }

  async setStatus(quiz, changes, message) {
    const batch = writeBatch(db);
    batch.update(doc(db, "quizzes", quiz.id), { ...changes, updatedAt: serverTimestamp() });
    await batch.commit();
    Object.assign(quiz, changes, { updatedAt: new Date() });
    this.renderList();
    appNotice(message, "success");
  }

  async editQuiz(quiz) {
    const grades = [...new Set([...myGrades(teacher.settings), ...(quiz.grade ? [quiz.grade] : [])])];
    const values = await editDialog(quiz, grades, teacher.settings.passPercent);
    if (!values) return;
    const passChanged = (values.passPercent ?? null) !== (quiz.passPercent ?? null);
    const gradeChanged = values.grade !== (quiz.grade || "") || values.sections.join() !== (quiz.sections || []).join();
    const meta = { title: values.title, grade: values.grade, sections: values.sections, description: values.description, passPercent: values.passPercent, updatedAt: serverTimestamp() };
    const keyChanges = { title: values.title, passPercent: values.passPercent };
    // A new pass mark changes results, so give the answer key a new version
    // stamp: existing results then show "Needs regrading".
    if (passChanged) {
      const importedAt = Timestamp.now();
      meta.importedAt = importedAt;
      keyChanges.importedAt = importedAt;
      if (!quiz.importedAt) keyChanges.version = quiz.version || "1";
    }
    const batch = writeBatch(db);
    batch.update(doc(db, "quizzes", quiz.id), meta);
    batch.set(doc(db, "answerKeys", quiz.id), keyChanges, { merge: true });
    await batch.commit();
    clearKeyCache();
    Object.assign(quiz, meta, { updatedAt: new Date() });
    this.renderList();
    const notes = [];
    if (gradeChanged) notes.push("Only students of the chosen grade and sections see it.");
    if (passChanged) notes.push("Existing results now show Needs regrading so the new pass mark can be applied.");
    appNotice(`Saved "${values.title}". ${notes.join(" ")}`.trim(), "success");
    await reloadQuizzes();
  }

  async deleteQuiz(quiz) {
    const res = await confirmDialog({
      title: `Delete "${quiz.title}"?`,
      text: "This cannot be undone. Student records are kept.",
      okText: "Delete quiz",
      danger: true,
      check: "Yes, permanently delete this quiz"
    });
    if (!res) return;
    const batch = writeBatch(db);
    ["quizzes", "quizContent", "answerKeys"].forEach((c) => batch.delete(doc(db, c, quiz.id)));
    await batch.commit();
    logActivity("quiz_deleted", `Deleted quiz "${quiz.title}"`, quiz.id);
    clearKeyCache();
    this.$("key").innerHTML = "";
    await reloadQuizzes();
    appNotice(`"${quiz.title}" was deleted.`, "success");
  }

  async showAnswerKey(quiz) {
    const box = this.$("key");
    box.innerHTML = skeleton("table", { cols: 4, rows: 5 });
    box.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const key = await loadAnswerKey(quiz.id, { refresh: true });
      if (!key) { box.innerHTML = '<div class="notice notice-warning">No answer key was found for this quiz. Add the question bank again and choose Replace.</div>'; return; }
      const showLesson = key.questions.some((q) => q.lessonTitle) && quiz.merged;
      box.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Answer key: ${escapeHtml(quiz.title)}</h3><button type="button" class="btn btn-small" data-hide>Hide answer key</button></div>
          <p class="small muted">Pass mark: ${escapeHtml(key.passPercent ?? teacher.settings.passPercent)}%${key.passPercent ? "" : " (school default)"} · Version ${escapeHtml(key.version || "1")}</p>
          <div class="table-wrap">
          <table class="data-table compact">
            <thead><tr><th>#</th>${showLesson ? "<th>Lesson</th>" : ""}<th>Question</th><th>Type</th><th>Correct answer</th><th class="num">Marks</th><th>Explanation</th></tr></thead>
            <tbody>${key.questions.map((q, i) => {
              const answer = q.type === "short_answer"
                ? `${(q.acceptedAnswers || []).map(escapeHtml).join(" / ")}<div class="small muted">${q.caseSensitive ? "Case sensitive" : "Not case sensitive"}</div>`
                : `${escapeHtml(q.correctOptionId)}. ${escapeHtml((q.options || []).find((o) => o.id === q.correctOptionId)?.text || "")}`;
              return `<tr><td>${i + 1}</td>${showLesson ? `<td class="small">${escapeHtml(q.lessonTitle || "")}</td>` : ""}<td>${escapeHtml(q.text)}</td><td class="small">${escapeHtml(q.type.replace("_", " "))}</td><td>${answer}</td><td class="num">${q.marks}</td><td class="small">${escapeHtml(q.explanation || "")}</td></tr>`;
            }).join("")}</tbody>
          </table>
          </div>
        </div>`;
      box.querySelector("[data-hide]").addEventListener("click", () => { box.innerHTML = ""; });
    } catch (err) {
      box.innerHTML = `<div class="notice notice-error">${escapeHtml(friendlyError(err))}</div>`;
    }
  }

  // --------------------------------------------------------------- import

  resetImport() {
    this.imp = null;
    this.$("file").value = "";
    this.$("preview").innerHTML = "";
  }

  async readFiles(files) {
    if (!files.length) { this.resetImport(); return; }
    const imp = { lessons: [], errors: [], warnings: [], mode: "separate", mergeTitle: "", onCollision: "keep", open: false, categoryId: null, sections: {} };
    for (const file of files) {
      let text;
      try { text = await file.text(); } catch { imp.errors.push(`${file.name} could not be read.`); continue; }
      const parsed = parseQuestionBank(text, file.name);
      imp.errors.push(...parsed.errors);
      imp.warnings.push(...parsed.warnings);
      const grades = myGrades(teacher.settings);
      parsed.lessons.forEach((l) => {
        const gradeOk = grades.includes(l.grade);
        imp.lessons.push({ ...l, include: true, chosenGrade: gradeOk ? l.grade : (grades.length === 1 ? grades[0] : "") });
      });
    }
    this.imp = imp;
    this.renderImport();
  }

  renderImport() {
    const imp = this.imp;
    const grades = myGrades(teacher.settings);
    // New quizzes go to the selected tab unless the teacher picks another one here.
    if (!imp.tabTouched || (imp.categoryId && !this.tabExists(imp.categoryId))) imp.categoryId = this.tab === ALL ? UNCATEGORIZED : this.tab;
    let html = "";
    if (imp.errors.length) html += `<div class="notice notice-error"><b>Some lessons could not be read:</b><ul>${imp.errors.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
    if (imp.warnings.length) html += `<div class="notice notice-warning"><ul>${imp.warnings.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
    if (!imp.lessons.length) {
      this.$("preview").innerHTML = html + (imp.errors.length ? "" : '<div class="notice notice-error">No lessons with questions were found in the selected files.</div>');
      return;
    }
    html += `
      <h4>1. Choose lessons and their grade</h4>
      <div class="table-wrap">
      <table class="data-table compact import-table">
        <thead><tr><th><input type="checkbox" data-imp="all" aria-label="Select all lessons" ${imp.lessons.every((l) => l.include) ? "checked" : ""}></th><th>Lesson</th><th>File</th><th class="num">Questions</th><th>Types</th><th class="num">Marks</th><th>Grade</th></tr></thead>
        <tbody>${imp.lessons.map((l, i) => {
          const badGrade = l.grade && !grades.includes(l.grade);
          return `<tr>
            <td><input type="checkbox" data-imp="inc" data-i="${i}" ${l.include ? "checked" : ""} aria-label="Include ${escapeHtml(l.title)}"></td>
            <td>${escapeHtml(l.title)}<div class="small muted"><code>${escapeHtml(l.lessonId)}</code></div></td>
            <td class="small">${escapeHtml(l.source)}</td>
            <td class="num">${l.questions.length}</td>
            <td class="small">${escapeHtml(typeSummary(l.questions))}</td>
            <td class="num">${l.questions.reduce((s, q) => s + q.marks, 0)}</td>
            <td>
              <select data-imp="grade" data-i="${i}" aria-label="Grade for ${escapeHtml(l.title)}">
                <option value="">Choose…</option>
                ${grades.map((g) => `<option value="${escapeHtml(g)}" ${g === l.chosenGrade ? "selected" : ""}>Grade ${escapeHtml(g)}</option>`).join("")}
              </select>
              ${badGrade ? `<div class="small error-text">The file says grade "${escapeHtml(l.grade)}", which is ${isAdmin() ? "not in School settings" : "not one of your grades"}.</div>` : ""}
              ${!l.grade ? '<div class="small muted">No grade in the file.</div>' : ""}
            </td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      </div>

      <h4>2. Separate quizzes or one merged quiz?</h4>
      <div class="radio-cards">
        <label class="radio-card"><input type="radio" name="impMode" data-imp="mode" value="separate" ${imp.mode === "separate" ? "checked" : ""}>
          <span><b>Separate quizzes</b><br><span class="small muted">Each ticked lesson becomes its own quiz.</span></span></label>
        <label class="radio-card"><input type="radio" name="impMode" data-imp="mode" value="merge" ${imp.mode === "merge" ? "checked" : ""}>
          <span><b>Merge into one quiz</b><br><span class="small muted">Ticked lessons become one quiz.</span></span></label>
      </div>
      <div class="field merge-title" ${imp.mode === "merge" ? "" : "hidden"}>
        <label for="impTitle">Title of the merged quiz</label>
        <input type="text" id="impTitle" data-imp="title" maxlength="120" value="${escapeHtml(imp.mergeTitle)}" placeholder="e.g. Science revision: lessons 1 to 3">
      </div>

      <h4>3. Who takes the quiz</h4>
      <div data-imp="sections"></div>

      <h4>4. Options</h4>
      <div class="field">
        <label for="impTab">Add the new quizzes to this tab</label>
        <select id="impTab" data-imp="tab">
          ${[...teacher.categories.map((c) => [c.id, c.name]), [UNCATEGORIZED, "No tab (only under All quizzes)"]].map(([id, name]) => `<option value="${escapeHtml(id)}" ${id === imp.categoryId ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
        </select>
        
      </div>
      <div class="field">
        <label for="impCollision">If a quiz with the same ID already exists</label>
        <select id="impCollision" data-imp="collision">
          <option value="keep" ${imp.onCollision === "keep" ? "selected" : ""}>Keep both: save the new one under a new ID (recommended)</option>
          <option value="replace" ${imp.onCollision === "replace" ? "selected" : ""}>Replace the existing quiz (same ID, new questions)</option>
        </select>
      </div>
      <label class="check"><input type="checkbox" data-imp="open" ${imp.open ? "checked" : ""}> Open the new quizzes for students now</label>

      <h4>5. Check and add</h4>
      <div data-imp="plan"></div>`;
    this.$("preview").innerHTML = html;
    this.renderSections();
    this.renderPlan();
  }

  /** Section choice for each grade used by the ticked lessons. */
  renderSections() {
    const box = this.$("preview").querySelector('[data-imp="sections"]');
    if (!box) return;
    const imp = this.imp;
    const used = [...new Set(imp.lessons.filter((l) => l.include && l.chosenGrade).map((l) => l.chosenGrade))];
    if (!used.length) { box.innerHTML = '<p class="small muted">Choose a grade for the lessons first.</p>'; return; }
    box.innerHTML = used.map((g) => {
      const secs = mySections(teacher.settings, g);
      if (!(g in imp.sections)) imp.sections[g] = isAdmin() ? [] : secs.slice();
      const chosen = imp.sections[g];
      const all = isAdmin() && !chosen.length;
      return `<div class="class-row">
        <span class="class-grade">Grade ${escapeHtml(g)}</span>
        <div class="class-secs">
          ${isAdmin() ? `<label class="chip-check"><input type="checkbox" data-imp="sec-all" data-g="${escapeHtml(g)}"${all ? " checked" : ""}><span>All sections</span></label>` : ""}
          ${secs.map((x) => `<label class="chip-check"><input type="checkbox" data-imp="sec" data-g="${escapeHtml(g)}" value="${escapeHtml(x)}"${chosen.includes(x) ? " checked" : ""}><span>${escapeHtml(x)}</span></label>`).join("")}
        </div></div>`;
    }).join("") + `<p class="small muted">${isAdmin() ? "Only students of the ticked sections see the quiz. All sections: every section of the grade." : "You can choose only the sections assigned to you."}</p>`;
  }

  onImportChange(e) {
    const t = e.target;
    const imp = this.imp;
    if (!imp || !t.dataset.imp) return;
    const i = Number(t.dataset.i);
    switch (t.dataset.imp) {
      case "all": imp.lessons.forEach((l) => { l.include = t.checked; }); this.renderImport(); return;
      case "inc": imp.lessons[i].include = t.checked; this.renderSections(); break;
      case "grade": imp.lessons[i].chosenGrade = t.value; this.renderSections(); break;
      case "sec": {
        const g = t.dataset.g;
        const set = new Set(imp.sections[g] || []);
        if (t.checked) set.add(t.value); else set.delete(t.value);
        imp.sections[g] = mySections(teacher.settings, g).filter((x) => set.has(x));
        this.renderSections();
        break;
      }
      case "sec-all": imp.sections[t.dataset.g] = []; this.renderSections(); break;
      case "mode":
        imp.mode = t.value;
        this.$("preview").querySelector(".merge-title").hidden = imp.mode !== "merge";
        break;
      case "collision": imp.onCollision = t.value; break;
      case "open": imp.open = t.checked; break;
      case "tab": imp.categoryId = t.value; imp.tabTouched = true; break;
      default: return;
    }
    this.renderPlan();
  }

  /** Works out which quizzes would be created, under which ids. */
  plan() {
    const imp = this.imp;
    const problems = [];
    const warnings = [];
    const included = imp.lessons.filter((l) => l.include);
    if (!included.length) problems.push("Tick at least one lesson.");
    included.filter((l) => !l.chosenGrade).forEach((l) => problems.push(`Choose a grade for "${l.title}".`));
    if (!isAdmin()) {
      [...new Set(included.map((l) => l.chosenGrade).filter(Boolean))]
        .filter((g) => !(imp.sections[g] || []).length).forEach((g) => problems.push(`Tick at least one section of Grade ${g}.`));
    }
    let built = [];
    if (!problems.length) {
      if (imp.mode === "merge") {
        const gradesUsed = [...new Set(included.map((l) => l.chosenGrade))];
        if (included.length < 2) problems.push("Tick at least two lessons to merge.");
        else if (gradesUsed.length > 1) problems.push(`Lessons from different grades (${gradesUsed.join(", ")}) cannot be merged into one quiz.`);
        else {
          const r = buildQuiz(included, { title: imp.mergeTitle, grade: gradesUsed[0], merge: true });
          built = [r.quiz];
          warnings.push(...r.warnings);
          if (!r.quiz.questions.length) problems.push("The merged quiz has no questions.");
        }
      } else {
        built = included.map((l) => {
          const r = buildQuiz([l], { grade: l.chosenGrade });
          warnings.push(...r.warnings);
          return r.quiz;
        });
      }
    }
    const used = new Set();
    const quizzes = built.map((quiz) => {
      const base = quiz.quizId;
      const existing = teacher.quizzes.get(base);
      let id = base;
      let action = "new";
      if (existing && imp.onCollision === "replace" && !used.has(base) && ownsQuiz(existing)) {
        action = "replace";
      } else if (existing || used.has(base)) {
        let n = 2;
        while (teacher.quizzes.has(`${base}-${n}`) || used.has(`${base}-${n}`)) n++;
        id = `${base}-${n}`;
        action = "copy";
      }
      used.add(id);
      return { quiz: { ...quiz, quizId: id, sections: (imp.sections[quiz.grade] || []).slice() }, id, base, existing, action };
    });
    return { quizzes, problems, warnings };
  }

  renderPlan() {
    const box = this.$("preview").querySelector('[data-imp="plan"]');
    if (!box) return;
    const { quizzes, problems, warnings } = this.plan();
    const actionText = (p) => ({
      new: '<span class="badge badge-info">New quiz</span>',
      copy: `<span class="badge badge-info">New quiz</span><div class="small muted">Gets a new ID (<code>${escapeHtml(p.base)}</code> is taken).</div>`,
      replace: `<span class="badge badge-warning">Replaces "${escapeHtml(p.existing?.title || p.base)}"</span><div class="small error-text">Submitted work will need regrading.</div>`
    })[p.action];
    let html = "";
    if (warnings.length) html += `<div class="notice notice-warning"><ul>${warnings.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
    if (problems.length) html += `<div class="notice notice-error"><ul>${problems.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
    if (quizzes.length) {
      html += `
        <div class="table-wrap">
        <table class="data-table compact">
          <thead><tr><th>Quiz</th><th>ID</th><th>Grade and sections</th><th class="num">Questions</th><th class="num">Marks</th><th>What happens</th></tr></thead>
          <tbody>${quizzes.map((p) => `<tr>
            <td>${escapeHtml(p.quiz.title)}${p.quiz.merged ? `<div class="small muted">Merged: ${p.quiz.lessons.map((l) => escapeHtml(l.title)).join(" + ")}</div>` : ""}</td>
            <td class="small"><code>${escapeHtml(p.id)}</code></td>
            <td class="nowrap">${gradeLabel(p.quiz.grade)}<div class="small muted">${sectionsLabel(p.quiz)}</div></td>
            <td class="num">${p.quiz.questions.length}</td>
            <td class="num">${p.quiz.questions.reduce((s, q) => s + q.marks, 0)}</td>
            <td>${actionText(p)}</td></tr>`).join("")}</tbody>
        </table>
        </div>`;
    }
    const n = quizzes.length;
    const newCount = quizzes.filter((p) => p.action !== "replace").length;
    if (newCount) html += `<p class="small muted">${newCount === n ? (this.imp.categoryId ? "These quizzes go" : "These quizzes are added") : `The ${pluralize(newCount, "new quiz", "new quizzes")} ${this.imp.categoryId ? (newCount === 1 ? "goes" : "go") : (newCount === 1 ? "is added" : "are added")}`} ${this.imp.categoryId ? ` to the <b>${escapeHtml(categoryName(this.imp.categoryId, teacher.categories))}</b> tab` : " in no tab (they show under All quizzes)"}.</p>`;
    html += `<div class="actions-row">
      <button type="button" class="btn btn-primary" data-imp="add" ${problems.length || !n ? "disabled" : ""}>Add ${pluralize(n, "quiz", "quizzes")}</button>
      <button type="button" class="btn" data-imp="cancel">Cancel</button></div>`;
    box.innerHTML = html;
  }

  async doImport() {
    const btn = this.$("preview").querySelector('[data-imp="add"]');
    btn.disabled = true;
    btn.textContent = "Checking…";
    let saved = 0;
    try {
      // Re-read the quiz list so ids are checked against the latest data.
      const before = this.plan().quizzes.map((p) => `${p.id}:${p.action}`).join();
      await reloadQuizzes();
      const { quizzes, problems } = this.plan();
      if (problems.length) { this.renderPlan(); return; }
      if (quizzes.map((p) => `${p.id}:${p.action}`).join() !== before) {
        this.renderPlan();
        appNotice("The quiz list changed since you chose the files (perhaps in another tab). Check the list below and press Add again.", "warning");
        return;
      }
      if (quizzes.some((p) => p.action === "replace")) {
        const names = quizzes.filter((p) => p.action === "replace").map((p) => `"${p.existing.title}"`).join(", ");
        const ok = await confirmDialog({ title: "Replace existing quizzes?", text: `${names} will get new questions. Student records are kept.`, okText: "Replace", danger: true });
        if (!ok) { this.renderPlan(); return; }
      }
      btn.textContent = "Saving…";
      const importedAt = Timestamp.now(); // shared by the list doc and the answer key: identifies this key version
      for (let i = 0; i < quizzes.length; i += QUIZZES_PER_BATCH) {
        const chunk = quizzes.slice(i, i + QUIZZES_PER_BATCH);
        const batch = writeBatch(db);
        chunk.forEach(({ quiz, id, existing, action }) => {
          const replacing = action === "replace";
          // Ownership: new quizzes belong to whoever adds them; a replaced quiz keeps its owner.
          const owner = replacing && existing.ownerId
            ? { ownerId: existing.ownerId, ownerRole: existing.ownerRole || "admin", ownerName: existing.ownerName || "" }
            : { ownerId: session.teacherId, ownerRole: isAdmin() ? "admin" : "teacher", ownerName: session.name || (isAdmin() ? "Admin" : session.username) };
          batch.set(doc(db, "quizzes", id), {
            ...toQuizMeta(quiz),
            ...owner,
            sections: quiz.sections || [],
            createdBy: replacing ? (existing.createdBy || owner.ownerName) : owner.ownerName,
            passPercent: quiz.passPercent ?? null,
            active: this.imp.open || (replacing && !!existing.active),
            archived: false,
            // replaced quizzes keep their tab; new ones go to the chosen tab
            categoryId: replacing ? (existing.categoryId || UNCATEGORIZED) : (this.imp.categoryId || UNCATEGORIZED),
            source: quiz.source || "",
            importedAt,
            createdAt: (replacing && existing.createdAt) || importedAt,
            updatedAt: serverTimestamp()
          });
          batch.set(doc(db, "quizContent", id), toQuizContent(quiz));
          batch.set(doc(db, "answerKeys", id), { ...toAnswerKey(quiz), importedAt, source: quiz.source || "" });
        });
        await batch.commit();
        saved += chunk.length;
      }
      clearKeyCache();
      const names = quizzes.map((p) => p.quiz.title);
      logActivity("quiz_created", `Added ${pluralize(saved, "quiz", "quizzes")}: ${names.join(", ")}`.slice(0, 300), quizzes.map((p) => p.id).join(",").slice(0, 200));
      const opened = this.imp.open;
      const tabName = this.imp.categoryId ? categoryName(this.imp.categoryId, teacher.categories) : "none (under All quizzes)";
      this.resetImport();
      await reloadQuizzes();
      appNotice(`Added ${pluralize(saved, "quiz", "quizzes")}: ${names.join(", ")}. Tab: ${tabName}.${opened ? "" : " Press Open to show it to students."}`, "success");
    } catch (err) {
      console.error(err);
      const partial = saved ? ` ${pluralize(saved, "quiz was", "quizzes were")} saved before the error; the rest were not.` : " Nothing was saved.";
      appNotice(`Adding quizzes failed. ${friendlyError(err)}${partial}`, "error");
      if (saved) await reloadQuizzes().catch(() => {});
      if (this.imp) this.renderPlan();
    }
  }
}

/** Modal form for a quiz's details. Resolves with the new values or null. */
/** The quiz's grade and sections are allowed for the user (teachers: their classes). */
function classesOk(q) {
  if (isAdmin()) return true;
  const mine = session.classes[String(q.grade || "")] || [];
  const secs = Array.isArray(q.sections) ? q.sections : [];
  return !!mine.length && !!secs.length && secs.every((s) => mine.includes(s));
}

function editDialog(quiz, grades, defaultPass) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="eqTitle" novalidate>
      <h2 id="eqTitle">Edit quiz details</h2>
      <div class="field"><label for="eqName">Title</label><input type="text" id="eqName" maxlength="120" required></div>
      <div class="field"><label for="eqGrade">Grade</label>
        <select id="eqGrade">${grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("")}${quiz.grade ? "" : '<option value="">Any grade (older quiz)</option>'}</select>
        <p class="small muted">Only students of this grade see the quiz.</p></div>
      <div class="field"><span class="label">Sections</span><div class="class-secs" id="eqSecs"></div></div>
      <div class="field"><label for="eqDesc">Information for students (optional)</label><textarea id="eqDesc" rows="3" maxlength="500"></textarea></div>
      <div class="field"><label for="eqPass">Pass mark % (leave empty for the school default, ${escapeHtml(defaultPass)}%)</label><input type="number" id="eqPass" min="1" max="100"></div>
      <p class="small muted">To change questions, upload the file again and choose Replace.</p>
      <p class="small error-text" data-err></p>
      <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
    </form>`;
  const f = backdrop.querySelector("form");
  const q = (s) => backdrop.querySelector(s);
  q("#eqName").value = quiz.title || "";
  q("#eqGrade").value = quiz.grade || "";
  let chosenSecs = Array.isArray(quiz.sections) ? quiz.sections.slice() : [];
  const renderSecs = () => {
    const g = q("#eqGrade").value;
    const secs = g ? mySections(teacher.settings, g) : [];
    const all = isAdmin() && !chosenSecs.length;
    q("#eqSecs").innerHTML = !g ? '<span class="small muted">Every grade and section (older quiz).</span>'
      : (isAdmin() ? `<label class="chip-check"><input type="checkbox" data-all${all ? " checked" : ""}><span>All sections</span></label>` : "")
        + secs.map((x) => `<label class="chip-check"><input type="checkbox" value="${escapeHtml(x)}"${chosenSecs.includes(x) ? " checked" : ""}><span>${escapeHtml(x)}</span></label>`).join("");
  };
  renderSecs();
  q("#eqGrade").addEventListener("change", () => { chosenSecs = isAdmin() ? [] : mySections(teacher.settings, q("#eqGrade").value).slice(); renderSecs(); });
  q("#eqSecs").addEventListener("change", (e) => {
    if (e.target.matches("[data-all]")) chosenSecs = [];
    else chosenSecs = [...q("#eqSecs").querySelectorAll("input[value]:checked")].map((b) => b.value);
    renderSecs();
  });
  q("#eqDesc").value = quiz.description || "";
  q("#eqPass").value = quiz.passPercent ?? "";
  document.body.appendChild(backdrop);
  q("#eqName").focus();
  return new Promise((resolve) => {
    const done = (v) => { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(null); };
    document.addEventListener("keydown", onKey);
    q("[data-cancel]").addEventListener("click", () => done(null));
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = q("#eqName").value.trim();
      const passRaw = q("#eqPass").value.trim();
      const pass = passRaw === "" ? null : Number(passRaw);
      if (!title) { q("[data-err]").textContent = "Enter a title."; return; }
      if (pass !== null && !(pass >= 1 && pass <= 100)) { q("[data-err]").textContent = "The pass mark must be between 1 and 100."; return; }
      const grade = q("#eqGrade").value;
      const sections = grade ? chosenSecs.filter((x) => mySections(teacher.settings, grade).includes(x)) : [];
      if (!isAdmin() && (!grade || !sections.length)) { q("[data-err]").textContent = "Choose a grade and at least one of your sections."; return; }
      done({ title, grade, sections, description: q("#eqDesc").value.trim(), passPercent: pass });
    });
  });
}
