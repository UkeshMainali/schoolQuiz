// Overview: the first page of the dashboard.
//   Admin:   the whole school (teachers, students, quizzes, attempts,
//            grading, requests) plus recent quizzes, submissions and activity.
//   Teacher: the same figures for their own quizzes and classes.
// Counts use Firestore count queries (one read per 1,000 documents counted).

import { db, collection, query, where, getCountFromServer, getDocs, orderBy, limit } from "./firebase.js";
import { countAttempts, splitScope } from "./records.js";
import { session, isAdmin, classesLabel, ownsQuiz } from "./roles.js";
import { teacher, appNotice, onTeacherChange } from "./teacherState.js";
import { requestsState, loadRequests, pendingCount } from "./requests.js";
import { allStudents, nameFor } from "./students.js";
import { ownerLabel } from "./quizAdmin.js";
import { escapeHtml, formatDateTime, friendlyError, toDate, skeleton } from "./utilities.js";

const count = async (q) => (await getCountFromServer(q)).data().count;

export class OverviewView {
  constructor(container, { openTab } = {}) {
    this.el = container;
    this.openTab = openTab;
    this.loadedAt = 0;
    this.el.addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      if (go) this.openTab?.(go.dataset.go);
      if (e.target.closest("[data-ov=refresh]")) this.load();
    });
    onTeacherChange((what) => { if (what === "quizzes" && this.shown) this.renderQuizzes(); });
  }

  show() {
    this.shown = true;
    // Figures are re-read at most once a minute when the tab is opened.
    if (Date.now() - this.loadedAt > 60000) this.load();
  }

  async load() {
    this.loadedAt = Date.now();
    this.el.innerHTML = skeleton("page", { cols: 5, rows: 5 });
    try {
      const stats = isAdmin() ? await this.adminStats() : await this.teacherStats();
      const recent = await this.recentAttempts().catch((err) => { console.warn(err); return []; });
      const activity = isAdmin() ? await this.recentActivity().catch((err) => { console.warn(err); return []; }) : [];
      this.render(stats, recent, activity);
    } catch (err) {
      console.error(err);
      this.el.innerHTML = "";
      appNotice(`Could not load the overview. ${friendlyError(err)}`, "error");
    }
  }

  async adminStats() {
    const attempts = collection(db, "attempts");
    const [teachers, students, total, submitted, results] = await Promise.all([
      count(query(collection(db, "teachers"), where("role", "==", "teacher"))),
      count(collection(db, "students")),
      count(attempts),
      count(query(attempts, where("status", "==", "submitted"))),
      count(collection(db, "results"))
    ]);
    if (!requestsState.loaded) await loadRequests().catch(() => {});
    const quizzes = [...teacher.quizzes.values()].filter((q) => !q.archived);
    const classes = teacher.settings.grades.reduce((n, g) => n + (teacher.settings.sectionsByGrade[g] || []).length, 0);
    return [
      { label: "Teachers", value: teachers, go: "teachers" },
      { label: "Students", value: students, go: "history" },
      { label: "Quizzes", value: quizzes.length, sub: `${quizzes.filter((q) => q.active).length} open`, go: "quizzes" },
      { label: "Quiz attempts", value: total, sub: `${total - submitted} in progress`, go: "results" },
      { label: "Completed tests", value: submitted, go: "results" },
      { label: "Waiting for grading", value: Math.max(0, submitted - results), warn: submitted - results > 0, go: "results" },
      { label: "Grades and sections", value: `${teacher.settings.grades.length} / ${classes}`, sub: "grades / sections", go: "settings" },
      { label: "Pending requests", value: pendingCount(), warn: pendingCount() > 0, go: "requests" }
    ];
  }

  async teacherStats() {
    const scopes = splitScope({});
    const [total, submitted, graded] = await Promise.all([
      countAttempts("active", {}),
      Promise.all(scopes.map((sc) => count(query(collection(db, "attempts"), where("grade", "==", sc.grade), where("section", "==", sc.section), where("status", "==", "submitted"))))).then((a) => a.reduce((x, y) => x + y, 0)),
      Promise.all(scopes.map((sc) => count(query(collection(db, "results"), where("grade", "==", sc.grade), where("section", "==", sc.section))))).then((a) => a.reduce((x, y) => x + y, 0))
    ]);
    if (!requestsState.loaded) await loadRequests().catch(() => {});
    const mine = [...teacher.quizzes.values()].filter((q) => ownsQuiz(q) && !q.archived);
    return [
      { label: "My quizzes", value: mine.length, sub: `${mine.filter((q) => q.active).length} open`, go: "quizzes" },
      { label: "My classes", value: scopes.length, sub: classesLabel(session.classes), go: "history" },
      { label: "Students", value: allStudents().length, sub: "registered in my classes", go: "history" },
      { label: "Quiz attempts", value: total, sub: `${total - submitted} in progress`, go: "results" },
      { label: "Waiting for grading", value: Math.max(0, submitted - graded), warn: submitted - graded > 0, go: "results" },
      { label: "My requests", value: requestsState.list.length, sub: `${pendingCount()} pending`, go: "requests" }
    ];
  }

  /** Latest submissions (Admin: all; teacher: their classes). */
  async recentAttempts() {
    const byTime = (a, b) => (toDate(b.submittedAt)?.getTime() || 0) - (toDate(a.submittedAt)?.getTime() || 0);
    if (isAdmin()) {
      // Newest first using the automatic single-field index (no composite index needed).
      const snap = await getDocs(query(collection(db, "attempts"), orderBy("submittedAt", "desc"), limit(8)));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.submittedAt).sort(byTime);
    }
    // Teachers: their classes' submissions, sorted here.
    const lists = await Promise.all(splitScope({}).map((sc) => getDocs(query(collection(db, "attempts"),
      where("grade", "==", sc.grade), where("section", "==", sc.section), where("status", "==", "submitted")))
      .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })))));
    return lists.flat().sort(byTime).slice(0, 8);
  }

  async recentActivity() {
    const snap = await getDocs(query(collection(db, "activity"), orderBy("at", "desc"), limit(10)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  render(stats, recent, activity) {
    const card = (s) => `<button type="button" class="summary-card stat-link ${s.warn ? "warn" : ""}" data-go="${s.go}">
      <div class="summary-label">${escapeHtml(s.label)}</div><div class="summary-value">${escapeHtml(s.value)}</div>${s.sub ? `<div class="summary-sub">${escapeHtml(s.sub)}</div>` : ""}</button>`;
    this.el.innerHTML = `
      <div class="overview-head">
        <p class="muted">Signed in as <b>${escapeHtml(session.name || session.username || "Admin")}</b> · ${isAdmin() ? "Admin" : escapeHtml(classesLabel(session.classes))}</p>
        <button type="button" class="btn btn-small" data-ov="refresh">Refresh</button>
      </div>
      <div class="summary-grid overview-grid">${stats.map(card).join("")}</div>
      <div class="overview-cols">
        <section class="card table-card">
          <div class="card-head"><h2>Recently created quizzes</h2><button type="button" class="btn btn-small btn-ghost" data-go="quizzes">All quizzes</button></div>
          <div data-ov="quizzes"></div>
        </section>
        <section class="card table-card">
          <div class="card-head"><h2>Recently submitted</h2><button type="button" class="btn btn-small btn-ghost" data-go="results">All results</button></div>
          ${recent.length ? `<div class="table-wrap"><table class="data-table compact"><thead><tr><th>Student</th><th>Class</th><th>Quiz</th><th>Submitted</th></tr></thead><tbody>
            ${recent.map((a) => `<tr><td><a href="result.html?id=${encodeURIComponent(a.id)}">${escapeHtml(nameFor(a))}</a></td><td class="nowrap small">${escapeHtml(a.grade)} ${escapeHtml(a.section)} · ${escapeHtml(a.rollNo)}</td><td class="small">${escapeHtml(a.quizTitle)}</td><td class="small nowrap">${escapeHtml(formatDateTime(a.submittedAt))}</td></tr>`).join("")}
          </tbody></table></div>` : '<p class="empty">No submissions yet.</p>'}
        </section>
      </div>
      ${isAdmin() ? `<section class="card table-card">
        <div class="card-head"><h2>Recent activity</h2></div>
        ${activity.length ? `<ul class="activity-list">${activity.map((x) => `<li><span class="small muted nowrap">${escapeHtml(formatDateTime(x.at))}</span><span><b>${escapeHtml(x.actorName || "Someone")}</b>${x.role === "teacher" ? ' <span class="badge badge-muted">Teacher</span>' : ""} ${escapeHtml(x.text)}</span></li>`).join("")}</ul>` : '<p class="empty">No activity recorded yet.</p>'}
      </section>` : ""}`;
    this.renderQuizzes();
  }

  renderQuizzes() {
    const box = this.el.querySelector('[data-ov="quizzes"]');
    if (!box) return;
    const when = (q) => toDate(q.createdAt || q.importedAt)?.getTime() || 0;
    const list = [...teacher.quizzes.values()].filter((q) => ownsQuiz(q)).sort((a, b) => when(b) - when(a)).slice(0, 6);
    box.innerHTML = list.length ? `<div class="table-wrap"><table class="data-table compact"><thead><tr><th>Quiz</th><th>Grade</th>${isAdmin() ? "<th>Created by</th>" : ""}<th>Status</th></tr></thead><tbody>
      ${list.map((q) => `<tr><td>${escapeHtml(q.title)}<div class="small muted">${escapeHtml(formatDateTime(q.createdAt || q.importedAt))}</div></td><td class="nowrap small">${q.grade ? `Grade ${escapeHtml(q.grade)}` : "Any"}${q.sections?.length ? ` · ${q.sections.map(escapeHtml).join(", ")}` : ""}</td>${isAdmin() ? `<td class="small">${escapeHtml(ownerLabel(q))}</td>` : ""}<td>${q.archived ? '<span class="badge badge-muted">Archived</span>' : q.active ? '<span class="badge badge-success">Open</span>' : '<span class="badge">Closed</span>'}</td></tr>`).join("")}
    </tbody></table></div>` : '<p class="empty">No quizzes yet.</p>';
  }
}
