// Analysis tab: overview, grade / section / quiz / student / question views.
// Filters: grade, section, quiz (Firestore query) and dates (in the browser).

import { queryAttempts, fetchResults } from "./records.js";
import { toRow } from "./recordsView.js";
import { teacher, sortedQuizzes, quizTitle, appNotice, onTeacherChange } from "./teacherState.js";
import { overview, groupBy, scoreBands, studentStats, questionStats, lessonStats, countable } from "./analytics.js";
import { escapeHtml, friendlyError, sectionsFor, pluralize, historyLink } from "./utilities.js";

const MAX_RECORDS = 3000;

export class AnalyticsView {
  constructor(container) {
    this.el = container;
    this.cache = new Map(); // scope key -> rows (avoids re-reading when only dates change)
    this.el.innerHTML = `
      <div class="card filters-card">
        <div class="filters analytics-filters">
          <label class="stack-field"><span>Grade</span><select data-f="grade"></select></label>
          <label class="stack-field"><span>Section</span><select data-f="section"></select></label>
          <label class="stack-field"><span>Quiz</span><select data-f="quiz"></select></label>
          <label class="stack-field date-field"><span>Submitted from</span><input type="date" data-f="from"></label>
          <label class="stack-field date-field"><span>To</span><input type="date" data-f="to"></label>
          <button type="button" class="btn" data-act="reload"><span class="i-refresh" aria-hidden="true"></span>Refresh</button>
        </div>
        <p class="small muted" data-info></p>
      </div>
      <div data-out></div>`;
    this.$ = (s) => this.el.querySelector(s);
    this.el.addEventListener("change", (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      if (f === "grade") { this.fillSections(); this.fillQuizzes(); }
      if (f === "from" || f === "to") this.render(); else this.load();
    });
    this.el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sub]");
      if (!b) return;
      this.sub = b.dataset.sub;
      this.el.querySelectorAll("[data-sub]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      this.el.querySelectorAll("[data-view]").forEach((v) => { v.hidden = v.dataset.view !== this.sub; });
    });
    this.$('[data-act="reload"]').addEventListener("click", () => { this.cache.clear(); this.load(); });
    onTeacherChange(() => { if (this.initialised) { this.fillFilters(); if (this.rows) this.render(); } });
  }

  fillFilters() {
    const g = this.$('[data-f="grade"]');
    const cur = g.value;
    g.innerHTML = '<option value="">All grades</option>' + teacher.settings.grades.map((x) => `<option value="${escapeHtml(x)}">Grade ${escapeHtml(x)}</option>`).join("");
    g.value = teacher.settings.grades.includes(cur) ? cur : "";
    this.fillSections();
    this.fillQuizzes();
  }

  fillSections() {
    const grade = this.$('[data-f="grade"]').value;
    const s = this.$('[data-f="section"]');
    s.innerHTML = '<option value="">All sections</option>' + (grade ? sectionsFor(teacher.settings, grade) : []).map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
    s.disabled = !grade;
  }

  fillQuizzes() {
    const grade = this.$('[data-f="grade"]').value;
    const q = this.$('[data-f="quiz"]');
    const cur = q.value;
    const list = sortedQuizzes({ grade, includeArchived: true });
    q.innerHTML = '<option value="">All quizzes</option>' + list.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.title)}${x.grade && !grade ? ` (Grade ${escapeHtml(x.grade)})` : ""}</option>`).join("");
    q.value = list.some((x) => x.id === cur) ? cur : "";
  }

  scope() {
    return { grade: this.$('[data-f="grade"]').value, section: this.$('[data-f="section"]').value, quizId: this.$('[data-f="quiz"]').value };
  }

  async show() {
    if (!this.initialised) { this.fillFilters(); this.initialised = true; }
    await this.load();
  }

  async load() {
    const scope = this.scope();
    const key = JSON.stringify(scope);
    if (this.cache.has(key)) { this.rows = this.cache.get(key); this.render(); return; }
    this.$("[data-out]").innerHTML = '<div class="loading"><span class="spinner"></span> Loading records…</div>';
    try {
      let items = [];
      let cursor = null;
      let more = true;
      while (more && items.length < MAX_RECORDS) {
        const page = await queryAttempts("active", scope, { pageSize: 500, cursor });
        items = items.concat(page.items);
        cursor = page.cursor;
        more = page.hasMore;
      }
      this.capped = more;
      const results = await fetchResults("active", items.map((a) => a.id));
      this.rows = items.map((a) => toRow(a, results.get(a.id) || null));
      this.cache.set(key, this.rows);
      this.render();
    } catch (err) {
      console.error(err);
      this.$("[data-out]").innerHTML = "";
      appNotice(`Could not load analysis data. ${friendlyError(err)}`, "error");
    }
  }

  /** Called after grading, archiving etc. so the next view re-reads data. */
  invalidate() { this.cache.clear(); }

  filteredRows() {
    const from = this.$('[data-f="from"]').value, to = this.$('[data-f="to"]').value;
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    if (!fromMs && !toMs) return this.rows;
    return this.rows.filter((r) => r.submittedMs && (!fromMs || r.submittedMs >= fromMs) && (!toMs || r.submittedMs <= toMs));
  }

  render() {
    const rows = this.filteredRows();
    const scope = this.scope();
    const graded = countable(rows);
    this.$("[data-info]").textContent = `${pluralize(rows.length, "record")} in this selection, ${graded.length} graded and counted.` +
      (this.capped ? ` Only the first ${MAX_RECORDS} records were loaded; narrow the filters for exact figures.` : "") +
      " Declined submissions and quizzes still in progress are not counted in averages.";
    if (!rows.length) { this.$("[data-out]").innerHTML = '<div class="card empty">No records for this selection.</div>'; return; }

    const o = overview(rows);
    const single = !!scope.quizId;
    const cards = [
      ["Students", o.totalStudents],
      ["Submissions", o.totalSubmissions, o.inProgress ? `${o.inProgress} still in progress` : ""],
      ["Graded (counted)", o.graded, o.ungraded ? `${o.ungraded} not graded yet` : ""],
      ["Average %", o.avgPercent === null ? "—" : `${o.avgPercent}%`],
      single ? ["Average marks", o.average === null ? "—" : `${o.average} / ${o.totalMarks}`] : ["Quizzes", new Set(rows.map((r) => r.quizId)).size],
      ["Highest %", o.highestPercent === null ? "—" : `${o.highestPercent}%`],
      ["Lowest %", o.lowestPercent === null ? "—" : `${o.lowestPercent}%`],
      ["Pass / fail", `${o.passed} / ${o.failed}`]
    ];
    let overviewHtml = `<div class="summary-grid compact">${cards.map(([l, v, sub]) => `<div class="summary-card"><div class="summary-label">${l}</div><div class="summary-value">${escapeHtml(v)}</div>${sub ? `<div class="summary-sub">${escapeHtml(sub)}</div>` : ""}</div>`).join("")}</div>`;
    if (!single) overviewHtml += '<p class="section-note">Several quizzes are included, so averages are in percent. Choose one quiz to see marks.</p>';
    if (!scope.grade) overviewHtml += this.groupTable("Grade comparison", groupBy(rows, (r) => r.grade, (k) => `Grade ${k}`), "Grade", single);
    overviewHtml += this.bars("Score distribution", scoreBands(rows), graded.length);

    const sections = groupBy(rows, (r) => `${r.grade}|${r.section}`, (k) => { const [g, s] = k.split("|"); return `Grade ${g} – ${s}`; });
    // Grouped into views so one screen never shows everything at once.
    const views = [
      ["overview", "Overview", overviewHtml],
      ["sections", "Sections", this.groupTable("Sections", sections, "Section", single, { highlight: true, expected: single ? (k) => Number(teacher.settings.classSizes?.[k.replace("|", "-")]) || 0 : null })],
      ["quizzes", "Quizzes", single ? "" : this.groupTable("Quizzes", groupBy(rows, (r) => r.quizId, (k, list) => list[0]?.quizTitle || quizTitle(k)), "Quiz", false, { marksPerGroup: true })],
      ["students", "Students", this.studentsTable(studentStats(rows), single)],
      ["questions", "Questions & lessons", this.questionsSection(rows)]
    ].filter(([, , h]) => h);
    if (!views.some(([k]) => k === this.sub)) this.sub = "overview";
    this.$("[data-out]").innerHTML = `
      <div class="segmented" role="tablist" aria-label="Analysis views">
        ${views.map(([k, label]) => `<button type="button" role="tab" data-sub="${k}" aria-selected="${k === this.sub}">${label}</button>`).join("")}
      </div>
      ${views.map(([k, , h]) => `<div class="sub-view" data-view="${k}"${k === this.sub ? "" : " hidden"}>${h}</div>`).join("")}`;
  }

  groupTable(title, groups, firstCol, single, { highlight = false, expected = null, marksPerGroup = false } = {}) {
    if (!groups.length) return "";
    const withAvg = groups.filter((g) => g.avgPercent !== null);
    const best = highlight && withAvg.length > 1 ? Math.max(...withAvg.map((g) => g.avgPercent)) : null;
    const worst = highlight && withAvg.length > 1 ? Math.min(...withAvg.map((g) => g.avgPercent)) : null;
    const showExpected = expected && groups.some((g) => expected(g.key));
    const showMarks = single || marksPerGroup;
    return `
      <div class="card"><h2>${escapeHtml(title)}</h2>
        <div class="table-wrap"><table class="data-table compact">
          <thead><tr><th>${escapeHtml(firstCol)}</th><th class="num">Students</th>${showExpected ? '<th class="num">Not submitted</th>' : ""}
            <th class="num">Submitted</th><th class="num">Graded</th>${showMarks ? '<th class="num">Avg marks</th>' : ""}<th class="num">Avg %</th>
            <th class="num">Highest %</th><th class="num">Lowest %</th><th class="num">Pass</th><th class="num">Fail</th></tr></thead>
          <tbody>${groups.map((g) => {
            const exp = showExpected ? expected(g.key) : 0;
            const tag = g.avgPercent !== null && g.avgPercent === best ? ' <span class="badge badge-success">highest</span>'
              : g.avgPercent !== null && g.avgPercent === worst ? ' <span class="badge badge-warning">lowest</span>' : "";
            return `<tr><td>${escapeHtml(g.label)}${tag}</td><td class="num">${g.students}</td>
              ${showExpected ? `<td class="num">${exp ? Math.max(0, exp - g.students) : "—"}</td>` : ""}
              <td class="num">${g.submitted}</td><td class="num">${g.graded}</td>
              ${showMarks ? `<td class="num">${g.avgMarks === null ? "—" : `${g.avgMarks} / ${g.totalMarks}`}</td>` : ""}
              <td class="num">${g.avgPercent === null ? "—" : `${g.avgPercent}%`}</td>
              <td class="num">${g.max === null ? "—" : `${g.max}%`}</td><td class="num">${g.min === null ? "—" : `${g.min}%`}</td>
              <td class="num">${g.passed}</td><td class="num">${g.failed}</td></tr>`;
          }).join("")}</tbody>
        </table></div>
        ${showExpected ? '<p class="small muted">"Not submitted" uses the class sizes from School settings.</p>' : ""}
      </div>`;
  }

  bars(title, items, total) {
    return `<div class="card"><h2>${escapeHtml(title)}</h2><div class="bars">${items.map((it) => `
      <div class="bar-row"><span class="bar-label">${escapeHtml(it.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${total ? (it.count / total) * 100 : 0}%"></span></span>
        <span class="bar-value">${it.count}</span></div>`).join("")}</div></div>`;
  }

  studentsTable(students, single) {
    if (!students.length) return "";
    return `<div class="card"><h2>Students</h2>
      <div class="table-wrap"><table class="data-table compact">
        <thead><tr><th>Student</th><th class="num">Roll</th><th>Grade</th><th>Section</th>${single ? "" : '<th class="num">Quizzes attempted</th><th class="num">Completed</th>'}
          <th class="num">Graded</th><th class="num">Avg %</th><th class="num">Best %</th><th class="num">Lowest %</th><th></th></tr></thead>
        <tbody>${students.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td class="num">${escapeHtml(s.rollNo)}</td><td>${escapeHtml(s.grade)}</td><td>${escapeHtml(s.section)}</td>
          ${single ? "" : `<td class="num">${s.attempted}</td><td class="num">${s.completed}</td>`}
          <td class="num">${s.graded}</td><td class="num">${s.avgPercent === null ? "—" : `${s.avgPercent}%`}</td>
          <td class="num">${s.best === null ? "—" : `${s.best}%`}</td><td class="num">${s.worst === null ? "—" : `${s.worst}%`}</td>
          <td><a class="small" href="${escapeHtml(historyLink(s.grade, s.section, s.rollNo))}">History</a></td></tr>`).join("")}</tbody>
      </table></div></div>`;
  }

  questionsSection(rows) {
    const qs = questionStats(rows).filter((q) => q.responses > 0);
    if (!qs.length) return "";
    const multiQuiz = new Set(qs.map((q) => q.quizId)).size > 1;
    const table = (title, list, note) => `
      <div class="card"><h2>${escapeHtml(title)}</h2>${note ? `<p class="small muted">${escapeHtml(note)}</p>` : ""}
        <div class="table-wrap"><table class="data-table compact">
          <thead><tr><th>Question</th>${multiQuiz ? "<th>Quiz</th>" : ""}<th>Lesson</th><th class="num">Responses</th><th class="num">Correct</th><th class="num">Incorrect</th><th class="num">Unanswered</th><th class="num">% correct</th></tr></thead>
          <tbody>${list.map((q) => `<tr><td>${escapeHtml(q.text)}</td>${multiQuiz ? `<td class="small">${escapeHtml(q.quizTitle)}</td>` : ""}<td class="small">${escapeHtml(q.lesson || "—")}</td>
            <td class="num">${q.responses}</td><td class="num">${q.correct}</td><td class="num">${q.incorrect}</td><td class="num">${q.unanswered}</td><td class="num">${q.percentCorrect}%</td></tr>`).join("")}</tbody>
        </table></div></div>`;
    const hardest = [...qs].sort((a, b) => a.percentCorrect - b.percentCorrect || b.responses - a.responses).slice(0, 10);
    const easiest = [...qs].sort((a, b) => b.percentCorrect - a.percentCorrect || b.responses - a.responses).slice(0, 10);
    const lessons = lessonStats(rows);
    let html = table("Most often answered wrongly", hardest, "The 10 questions with the lowest share of correct answers.");
    html += table("Most often answered correctly", easiest, "");
    if (lessons.length) {
      html += `<div class="card"><h2>Performance by lesson</h2><p class="small muted">Share of marks earned per lesson, lowest first.</p>
        <div class="table-wrap"><table class="data-table compact"><thead><tr><th>Lesson</th><th class="num">Questions</th><th class="num">Students</th><th class="num">Marks earned</th></tr></thead>
        <tbody>${lessons.map((l) => `<tr><td>${escapeHtml(l.lesson)}</td><td class="num">${l.questions}</td><td class="num">${l.students}</td><td class="num">${l.percent}%</td></tr>`).join("")}</tbody></table></div></div>`;
    }
    return html;
  }
}
