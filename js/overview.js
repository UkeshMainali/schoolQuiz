// Overview: the first page of the dashboard.
//
//   1. Greeting, with quick links.
//   2. "Needs your attention": only what is waiting (grading, requests,
//      students taking a quiz right now). "All caught up" otherwise.
//   3. Four key figures.
//   4. Classes: one card per grade, one row per section with its students,
//      completed tests, tests to grade and students taking a quiz now. Each
//      row opens that section's results or students.
//   5. Recently submitted, recently created quizzes and (Admin) activity.
//
// Admin: the whole school. Teacher: their own classes and quizzes.
// Counts use Firestore count queries (1 read per 1,000 documents counted).
// The page updates by itself (see live.js): new submissions refresh the
// figures at most every 20 seconds; "taking a quiz now" costs no reads.

import { db, collection, query, where, getCountFromServer, getDocs, orderBy, limit } from "./firebase.js";
import { splitScope } from "./records.js";
import { session, isAdmin, classesLabel, ownsQuiz, myGrades, mySections, sectionsText } from "./roles.js";
import { teacher, appNotice, onTeacherChange } from "./teacherState.js";
import { requestsState, pendingCount } from "./requests.js";
import { allStudents, nameFor } from "./students.js";
import { ownerLabel } from "./quizAdmin.js";
import { live } from "./live.js";
import { escapeHtml, formatDateTime, friendlyError, toDate, skeleton, pluralize } from "./utilities.js";

const count = async (q) => (await getCountFromServer(q)).data().count;
const LIVE_MIN_GAP = 20000;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export class OverviewView {
  constructor(container, { openTab, openResults, openStudents } = {}) {
    this.el = container;
    this.openTab = openTab;
    this.openResults = openResults || (() => openTab?.("results"));
    this.openStudents = openStudents || (() => openTab?.("history"));
    this.loadedAt = 0;
    this.data = null;
    this.el.addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      if (go) { this.openTab?.(go.dataset.go); return; }
      const res = e.target.closest("[data-results]");
      if (res) { this.openResults(this.scopeOf(res, "results")); return; }
      const stu = e.target.closest("[data-students]");
      if (stu) { this.openStudents(this.scopeOf(stu, "students")); return; }
      if (e.target.closest("[data-ov=refresh]")) this.load();
    });
    onTeacherChange((what) => {
      if (!this.shown || !this.data) return;
      if (what === "quizzes") { this.renderQuizzes(); this.renderKpis(); }
      if (what === "students") { this.renderKpis(); this.renderClasses(); }
    });
    requestsState.listeners.add(() => { if (this.shown && this.data) this.renderAttention(); });
  }

  scopeOf(btn, attr) {
    const [grade = "", section = "", status = ""] = String(btn.dataset[attr] || "").split("|");
    return { grade, section, status };
  }

  show() {
    this.shown = true;
    // Figures are re-read at most once a minute when the tab is opened.
    if (Date.now() - this.loadedAt > 60000) this.load({ quiet: !!this.data });
  }

  // ------------------------------------------------------------- loading

  async load({ quiet = false } = {}) {
    this.loadedAt = Date.now();
    if (!quiet || !this.data) this.el.innerHTML = skeleton("page", { cols: 5, rows: 5 });
    try {
      const [stats, classes, recent, activity] = await Promise.all([
        isAdmin() ? this.adminStats() : Promise.resolve({}),
        this.classStats(),
        this.recentAttempts().catch((err) => { console.warn(err); return []; }),
        isAdmin() ? this.recentActivity().catch((err) => { console.warn(err); return []; }) : Promise.resolve([])
      ]);
      const sum = (k) => classes.reduce((n, c) => n + c[k], 0);
      if (!isAdmin()) Object.assign(stats, { completed: sum("submitted"), graded: sum("graded") });
      this.data = { stats, classes, recent, activity };
      this.render();
    } catch (err) {
      console.error(err);
      if (!quiet) this.el.innerHTML = "";
      appNotice(`Could not load the overview. ${friendlyError(err)}`, "error");
    }
  }

  /** Records changed (a student submitted, someone graded): refresh quietly, at most every 20 s. */
  liveUpdate() {
    this.loadedAt = 0;
    if (!this.shown || !this.data) return;
    const wait = LIVE_MIN_GAP - (Date.now() - (this.liveAt || 0));
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      if (this.el.hidden) return;
      this.liveAt = Date.now();
      this.load({ quiet: true });
    }, Math.max(0, wait));
  }

  /** Students started or saved an answer: update "taking a quiz now" (no reads). */
  liveProgress() {
    if (!this.data) return;
    this.renderAttention();
    this.renderClasses();
  }

  async adminStats() {
    const attempts = collection(db, "attempts");
    const [teachers, students, completed, graded] = await Promise.all([
      count(query(collection(db, "teachers"), where("role", "==", "teacher"))),
      count(collection(db, "students")),
      count(query(attempts, where("status", "==", "submitted"))),
      count(collection(db, "results"))
    ]);
    return { teachers, students, completed, graded };
  }

  /** Every class (grade + section) the user works with, with its figures (2 count queries each). */
  async classStats() {
    const s = teacher.settings;
    const pairs = [];
    myGrades(s).forEach((g) => mySections(s, g).forEach((sec) => pairs.push({ grade: String(g), section: String(sec) })));
    return Promise.all(pairs.map(async (p) => {
      const inClass = [where("grade", "==", p.grade), where("section", "==", p.section)];
      const [submitted, graded] = await Promise.all([
        count(query(collection(db, "attempts"), ...inClass, where("status", "==", "submitted"))),
        count(query(collection(db, "results"), ...inClass))
      ]);
      return { ...p, submitted, graded };
    }));
  }

  /** Latest submissions (Admin: all; teacher: their classes). */
  async recentAttempts() {
    const byTime = (a, b) => (toDate(b.submittedAt)?.getTime() || 0) - (toDate(a.submittedAt)?.getTime() || 0);
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.submittedAt);
    if (isAdmin()) {
      // Newest first using the automatic single-field index (no composite index needed).
      return rows(await getDocs(query(collection(db, "attempts"), orderBy("submittedAt", "desc"), limit(8)))).sort(byTime);
    }
    const scopes = splitScope({});
    if (!this.noRecentIndex) {
      try {
        // With the optional index (firestore.indexes.json) this reads only 8 per class.
        const lists = await Promise.all(scopes.map((sc) => getDocs(query(collection(db, "attempts"),
          where("grade", "==", sc.grade), where("section", "==", sc.section), orderBy("submittedAt", "desc"), limit(8))).then(rows)));
        return lists.flat().sort(byTime).slice(0, 8);
      } catch (err) {
        if (err?.code !== "failed-precondition") throw err;
        this.noRecentIndex = true;
      }
    }
    // Without it: the class's submissions, sorted here.
    const lists = await Promise.all(scopes.map((sc) => getDocs(query(collection(db, "attempts"),
      where("grade", "==", sc.grade), where("section", "==", sc.section), where("status", "==", "submitted"))).then(rows)));
    return lists.flat().sort(byTime).slice(0, 8);
  }

  async recentActivity() {
    const snap = await getDocs(query(collection(db, "activity"), orderBy("at", "desc"), limit(8)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // ------------------------------------------------------------ figures

  myQuizzes() {
    return [...teacher.quizzes.values()].filter((q) => !q.archived && (isAdmin() || ownsQuiz(q)));
  }

  takingNow(grade, section) {
    let n = 0;
    live.inProgress.forEach((a) => { if ((!grade || String(a.grade) === grade) && (!section || String(a.section) === section)) n++; });
    return n;
  }

  toGrade() {
    const { stats, classes } = this.data;
    if (isAdmin()) return Math.max(0, stats.completed - stats.graded);
    return classes.reduce((n, c) => n + Math.max(0, c.submitted - c.graded), 0);
  }

  studentsIn(grade, section) {
    return allStudents().filter((s) => String(s.grade) === grade && (!section || String(s.section) === section)).length;
  }

  // ------------------------------------------------------------ rendering

  render() {
    const admin = isAdmin();
    const name = session.name || session.username || "Admin";
    const today = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    const quick = admin
      ? [["results", "Results", "table-list"], ["history", "Student record", "id-card"], ["quizzes", "Quizzes", "file-circle-plus"], ["teachers", "Add teacher", "user-plus"]]
      : [["results", "Results", "table-list"], ["history", "Student record", "id-card"], ["quizzes", "My quizzes", "file-circle-plus"], ["requests", "Requests", "inbox"]];
    this.el.innerHTML = `
      <section class="ov-hero">
        <div class="ov-hero-text">
          <h2>${escapeHtml(greeting())}, ${escapeHtml(name.split(" ")[0])}</h2>
          <p>${admin ? "Admin · whole school" : `Teacher · ${escapeHtml(pluralize(splitScope({}).length, "class", "classes"))}`} · ${escapeHtml(today)}</p>
        </div>
        <div class="ov-quick">${quick.map(([tab, label, icon]) => `<button type="button" class="btn btn-small" data-go="${tab}" data-icon="${icon}">${label}</button>`).join("")}</div>
      </section>
      <section class="ov-attention" data-ov="attention" aria-live="polite"></section>
      <section class="ov-kpis" data-ov="kpis" aria-label="Key figures"></section>
      <section class="card ov-classes">
        <div class="card-head ov-section-head">
          <div><h2>${admin ? "Classes" : "My classes"}</h2><p class="small muted">Students, completed tests and grading for each section.</p></div>
        </div>
        <div data-ov="classes"></div>
      </section>
      <div class="ov-cols">
        <section class="card table-card">
          <div class="card-head ov-section-head"><h2>Recently submitted</h2><button type="button" class="btn btn-small btn-ghost" data-go="results">All results</button></div>
          <div data-ov="recent"></div>
        </section>
        <section class="card table-card">
          <div class="card-head ov-section-head"><h2>${admin ? "Recently created quizzes" : "My recent quizzes"}</h2><button type="button" class="btn btn-small btn-ghost" data-go="quizzes">All quizzes</button></div>
          <div data-ov="quizzes"></div>
        </section>
      </div>
      ${admin ? `<section class="card table-card">
        <div class="card-head ov-section-head"><h2>Recent activity</h2></div>
        <div data-ov="activity"></div>
      </section>` : ""}
      <p class="small muted ov-updated">Updated ${escapeHtml(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}. This page updates by itself. <button type="button" class="btn-link small" data-ov="refresh">Refresh now</button></p>`;
    this.renderAttention();
    this.renderKpis();
    this.renderClasses();
    this.renderRecent();
    this.renderQuizzes();
    this.renderActivity();
  }

  renderAttention() {
    const box = this.el.querySelector('[data-ov="attention"]');
    if (!box || !this.data) return;
    const items = [];
    const grade = this.toGrade();
    if (grade) items.push({ tone: "warn", icon: "clipboard-check", title: `${pluralize(grade, "test")} waiting for grading`, text: "Grade them so they count in marks and analysis.", btn: "Grade now", attr: 'data-results="||ungraded"' });
    const now = this.takingNow();
    if (now) items.push({ tone: "live", icon: "pen-to-square", title: `${pluralize(now, "student")} taking a quiz now`, text: "Their tests show up here as soon as they submit.", btn: "Watch", attr: 'data-results="||in_progress"' });
    const pend = pendingCount();
    if (isAdmin() && pend) items.push({ tone: "info", icon: "inbox", title: `${pluralize(pend, "teacher request")} waiting`, text: "Approve, decline or do them now.", btn: "Review", attr: 'data-go="requests"' });
    if (!isAdmin() && pend) items.push({ tone: "info", icon: "inbox", title: `${pluralize(pend, "request")} sent to the Admin`, text: "The answer shows on the Requests page.", btn: "Open", attr: 'data-go="requests"' });
    box.innerHTML = items.length
      ? `<h2 class="sr-only">Needs your attention</h2><div class="ov-todo">${items.map((x) => `
          <div class="ov-todo-item tone-${x.tone}">
            <span class="ov-todo-icon"><i class="fa-solid fa-${x.icon}" aria-hidden="true"></i></span>
            <div class="ov-todo-text"><b>${escapeHtml(x.title)}</b><span>${escapeHtml(x.text)}</span></div>
            <button type="button" class="btn btn-small ${x.tone === "warn" ? "btn-primary" : ""}" ${x.attr} data-icon="none">${escapeHtml(x.btn)}</button>
          </div>`).join("")}</div>`
      : '<div class="ov-allclear"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span><b>All caught up.</b> Nothing is waiting for you.</span></div>';
  }

  renderKpis() {
    const box = this.el.querySelector('[data-ov="kpis"]');
    if (!box || !this.data) return;
    const { stats, classes } = this.data;
    const quizzes = this.myQuizzes();
    const open = quizzes.filter((q) => q.active).length;
    const k = isAdmin()
      ? [
        { label: "Students", value: stats.students, sub: "registered", go: "history", icon: "user-graduate" },
        { label: "Teachers", value: stats.teachers, sub: "accounts", go: "teachers", icon: "chalkboard-user" },
        { label: "Quizzes", value: quizzes.length, sub: `${open} open now`, go: "quizzes", icon: "file-lines" },
        { label: "Completed tests", value: stats.completed, sub: `${stats.graded} graded`, go: "results", icon: "square-check" }
      ]
      : [
        { label: "Students", value: allStudents().length, sub: "in my classes", go: "history", icon: "user-graduate" },
        { label: "Classes", value: classes.length, sub: classesLabel(session.classes, teacher.settings), go: "history", icon: "people-group" },
        { label: "My quizzes", value: quizzes.length, sub: `${open} open now`, go: "quizzes", icon: "file-lines" },
        { label: "Completed tests", value: stats.completed, sub: `${stats.graded} graded`, go: "results", icon: "square-check" }
      ];
    box.innerHTML = k.map((c) => `<button type="button" class="ov-kpi" data-go="${c.go}" data-icon="none">
      <span class="ov-kpi-icon"><i class="fa-solid fa-${c.icon}" aria-hidden="true"></i></span>
      <span class="ov-kpi-body"><span class="ov-kpi-label">${escapeHtml(c.label)}</span><span class="ov-kpi-value">${escapeHtml(c.value)}</span><span class="ov-kpi-sub">${escapeHtml(c.sub)}</span></span>
    </button>`).join("");
  }

  renderClasses() {
    const box = this.el.querySelector('[data-ov="classes"]');
    if (!box || !this.data) return;
    const { classes } = this.data;
    if (!classes.length) {
      box.innerHTML = `<p class="empty">${isAdmin() ? "No grades and sections yet. Add them in School settings." : "No classes are assigned to you yet. Ask the Admin to add your grades and sections."}</p>`;
      return;
    }
    const byGrade = new Map();
    classes.forEach((c) => { if (!byGrade.has(c.grade)) byGrade.set(c.grade, []); byGrade.get(c.grade).push(c); });
    box.innerHTML = `<div class="ov-grade-grid">${[...byGrade.entries()].map(([g, list]) => {
      const students = this.studentsIn(g);
      const todo = list.reduce((n, c) => n + Math.max(0, c.submitted - c.graded), 0);
      const done = list.reduce((n, c) => n + c.submitted, 0);
      return `<article class="ov-grade">
        <header class="ov-grade-head">
          <div><h3>Grade ${escapeHtml(g)}</h3>
            <p>${pluralize(list.length, "section")} · ${pluralize(students, "student")} · ${pluralize(done, "test")}</p></div>
          ${todo ? `<span class="badge badge-warning">${todo} to grade</span>` : done ? '<span class="badge badge-success">All graded</span>' : ""}
        </header>
        <div class="ov-sec-head" aria-hidden="true"><span>Section</span><span>Students</span><span>Tests</span><span>To grade</span><span></span></div>
        <ul class="ov-sections">${list.map((c) => {
          const left = Math.max(0, c.submitted - c.graded);
          const now = this.takingNow(c.grade, c.section);
          const scope = `${escapeHtml(c.grade)}|${escapeHtml(c.section)}`;
          return `<li class="ov-section">
            <span class="ov-section-name"><span class="ov-sec-chip" aria-label="Section">${escapeHtml(c.section)}</span>${now ? `<span class="ov-now" title="Taking a quiz now"><span class="live-dot on" aria-hidden="true"></span>${now} now</span>` : ""}</span>
            <span class="ov-num" data-label="Students">${this.studentsIn(c.grade, c.section)}</span>
            <span class="ov-num" data-label="Tests">${c.submitted}</span>
            <span class="ov-num ${left ? "ov-warn" : ""}" data-label="To grade">${left}</span>
            <span class="ov-section-actions">
              <button type="button" class="btn btn-small ${left ? "btn-primary" : ""}" data-results="${scope}${left ? "|ungraded" : ""}" data-icon="none" aria-label="${left ? "Grade" : "Results of"} Grade ${escapeHtml(c.grade)} ${escapeHtml(c.section)}">${left ? "Grade" : "Results"}</button>
              <button type="button" class="btn btn-small btn-ghost" data-students="${scope}" data-icon="none" aria-label="Students of Grade ${escapeHtml(c.grade)} ${escapeHtml(c.section)}">Students</button>
            </span>
          </li>`;
        }).join("")}</ul>
      </article>`;
    }).join("")}</div>`;
  }

  renderRecent() {
    const box = this.el.querySelector('[data-ov="recent"]');
    if (!box || !this.data) return;
    const recent = this.data.recent;
    box.innerHTML = recent.length ? `<ul class="ov-list">${recent.map((a) => `<li>
        <a class="ov-list-main" href="result.html?id=${encodeURIComponent(a.id)}"><b>${escapeHtml(nameFor(a))}</b><span>${escapeHtml(a.quizTitle)}</span></a>
        <span class="ov-list-meta"><span class="badge badge-muted">${escapeHtml(a.grade)}${escapeHtml(a.section)} · Roll ${escapeHtml(a.rollNo)}</span><span class="small muted">${escapeHtml(formatDateTime(a.submittedAt))}</span></span>
      </li>`).join("")}</ul>` : '<p class="empty">No submissions yet.</p>';
  }

  renderQuizzes() {
    const box = this.el.querySelector('[data-ov="quizzes"]');
    if (!box) return;
    const when = (q) => toDate(q.createdAt || q.importedAt)?.getTime() || 0;
    const list = [...teacher.quizzes.values()].filter((q) => ownsQuiz(q)).sort((a, b) => when(b) - when(a)).slice(0, 6);
    box.innerHTML = list.length ? `<ul class="ov-list">${list.map((q) => `<li>
        <span class="ov-list-main"><b>${escapeHtml(q.title)}</b><span>${q.grade ? `Grade ${escapeHtml(q.grade)}` : "Any grade"}${q.sections?.length ? ` · ${escapeHtml(sectionsText(teacher.settings, q.grade, q.sections))}` : ""}${isAdmin() ? ` · ${escapeHtml(ownerLabel(q))}` : ""}</span></span>
        <span class="ov-list-meta">${q.archived ? '<span class="badge badge-muted">Archived</span>' : q.active ? '<span class="badge badge-success">Open</span>' : '<span class="badge">Closed</span>'}<span class="small muted">${escapeHtml(formatDateTime(q.createdAt || q.importedAt))}</span></span>
      </li>`).join("")}</ul>` : '<p class="empty">No quizzes yet.</p>';
  }

  renderActivity() {
    const box = this.el.querySelector('[data-ov="activity"]');
    if (!box || !this.data) return;
    const activity = this.data.activity;
    box.innerHTML = activity.length ? `<ul class="activity-list">${activity.map((x) => `<li><span class="small muted nowrap">${escapeHtml(formatDateTime(x.at))}</span><span><b>${escapeHtml(x.actorName || "Someone")}</b>${x.role === "teacher" ? ' <span class="badge badge-muted">Teacher</span>' : ""} ${escapeHtml(x.text)}</span></li>`).join("")}</ul>` : '<p class="empty">No activity recorded yet.</p>';
  }
}
