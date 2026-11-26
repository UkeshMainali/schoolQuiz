// Help: the built-in guide. The Admin and teachers see different guides, and
// each only describes features that role can use. Topics are expandable
// sections (<details>), grouped into cards, so the page stays short.

import { isAdmin } from "./roles.js";
import { GO_KEYS, OTHER_KEYS } from "./shortcuts.js";
import { escapeHtml } from "./utilities.js";

const kbd = (k) => `<kbd>${escapeHtml(k)}</kbd>`;
const steps = (list) => `<ol>${list.map((s) => `<li>${s}</li>`).join("")}</ol>`;
const bullets = (list) => `<ul>${list.map((s) => `<li>${s}</li>`).join("")}</ul>`;

const TEACHER = [
  ["Getting started", [
    ["How to sign in", steps([
      "Open the website and press <b>Staff login</b> at the top right.",
      "Type the <b>username</b> and <b>password</b> the Admin gave you, then press <b>Sign in</b>.",
      "Forgot your password? Ask the Admin to reset it. Your quizzes and records are kept.",
      "To change your password yourself, press your name at the bottom of the menu, then <b>Change password</b>."
    ])],
    ["Your dashboard", bullets([
      "<b>Overview</b> shows your quizzes, your classes, attempts and what still needs grading.",
      "You only see the grades and sections the Admin assigned to you. They are listed at the top of the Overview.",
      "The menu on the left has everything you can use. Pages you cannot use are not shown."
    ])]
  ]],
  ["Quizzes", [
    ["Create and upload quizzes", steps([
      "Open <b>Quizzes</b> and press <b>Choose question bank files</b> (JSON).",
      "Tick the lessons you want and choose the grade for each.",
      "Under <b>Who takes the quiz</b>, tick the sections. Only your own sections can be chosen.",
      "Choose separate quizzes or one merged quiz, then press <b>Add</b>."
    ])],
    ["Organise quizzes in tabs", bullets([
      "Press <b>New tab</b> to make a tab, for example \"Term 1\". Your tabs are your own; other teachers do not see them.",
      "Tick quizzes and press <b>Move to tab…</b>, or use the ⋯ menu of one quiz.",
      "Deleting a tab never deletes quizzes: they move to another tab or to All quizzes."
    ])],
    ["Open and close quizzes", bullets([
      "Press <b>Open</b> to let your students start the quiz, and <b>Close</b> to stop new attempts.",
      "Only students of the quiz's grade and ticked sections see it.",
      "Change the title, grade, sections or pass mark with <b>Edit</b>. To change questions, upload the file again and choose Replace."
    ])],
    ["Allow or stop retakes", bullets([
      "Open a student's result (Results → the student's name) and choose <b>More → Allow retake</b>.",
      "The old attempt is kept as a <i>previous attempt</i> and the student can start again.",
      "If you do nothing, each student can take each quiz once."
    ])]
  ]],
  ["Results and students", [
    ["View student results", bullets([
      "Open <b>Results</b>, then choose a grade, a section and a quiz.",
      "Press <b>Grade all eligible</b> to calculate marks. You can <b>Accept</b> or <b>Decline</b> submissions.",
      "Short answers with small spelling mistakes can be marked correct by hand on the result page.",
      "Use the ‹ › buttons above a wide table to see more columns."
    ])],
    ["Analyse performance", bullets([
      "<b>Analysis</b> compares sections, quizzes, questions and lessons for your classes.",
      "Only graded, not declined submissions count. The latest attempt of each quiz counts."
    ])],
    ["View student records", bullets([
      "<b>Student record</b> lists the registered students of your classes with their overall results.",
      "Open a student to see every quiz they took, even under a different name.",
      "Names come from the student records, so a name corrected by the Admin shows everywhere."
    ])],
    ["Ask the Admin for help (requests)", bullets([
      "You cannot change student names, delete records, print or export records yourself.",
      "Use <b>Request a change</b> on a student, <b>Ask the Admin…</b> on results, or <b>Requests → New request</b>.",
      "Explain what you need and why. Follow the status on the <b>Requests</b> page: Pending, Approved, Declined or Completed.",
      "If the Admin gives a one-time permission to print or export, a <b>Print now</b> or <b>Download CSV</b> button appears on your request."
    ])]
  ]],
  ["Common problems", [
    ["A student cannot see my quiz", bullets([
      "Check that the quiz is <b>Open</b> and that its grade and sections match the student's.",
      "Ask the student to press <b>Change details</b> on the student page and check their grade and section."
    ])],
    ["A student's name is wrong", bullets(["Open the student in <b>Student record</b> and press <b>Request a change</b>. The Admin corrects it everywhere."])],
    ["\"You don't have permission\"", bullets(["The action is only for the Admin, or the record is outside your classes. Send a request instead."])],
    ["I cannot open my quiz", bullets(["The quiz is for a section that is no longer assigned to you. Edit its sections, or ask the Admin."])]
  ]]
];

const ADMIN = [
  ["Getting started", [
    ["The Admin dashboard", bullets([
      "<b>Overview</b> shows the whole school: teachers, students, quizzes, attempts, grading still to do, pending requests and recent activity. Press a figure to open its page.",
      "You see every quiz, result and student, in every grade and section.",
      "Teachers only see their assigned classes and their own quizzes."
    ])],
    ["First steps after the upgrade", steps([
      "Open <b>Student record</b> and press <b>Link existing results</b> once. It creates student records from your existing results.",
      "Add your teachers on <b>Add teacher</b>.",
      "Check <b>School settings</b>: grades, sections and class sizes."
    ])]
  ]],
  ["Teachers", [
    ["Create teacher accounts", steps([
      "Open <b>Add teacher</b>.",
      "Type the teacher's name, a username (small letters, numbers, dot, dash) and an initial password (8 characters or more).",
      "Tick the sections they teach in each grade. A teacher can have one section, several sections, or several grades.",
      "Press <b>Create teacher</b> and give the username and password to the teacher privately."
    ])],
    ["Usernames and passwords", bullets([
      "<b>Change username</b> (⋯ menu): the password stays the same.",
      "<b>Reset password</b>: the old password stops working at once. The teacher keeps all quizzes and records.",
      "Passwords are never stored in the database and cannot be shown later."
    ])],
    ["Grades, sections and permissions", bullets([
      "Press <b>Edit</b> on a teacher to change their name or classes.",
      "A teacher sees results and students only of their ticked sections, and can open quizzes only for them.",
      "<b>Deactivate</b> blocks the account without deleting anything. <b>Delete</b> removes the login only: quizzes, results and records stay, and you can take over their quizzes."
    ])]
  ]],
  ["Quizzes", [
    ["Manage all quizzes", bullets([
      "<b>Quizzes</b> lists every teacher's quizzes. Filter with <b>Created by</b>.",
      "You can open, close, edit, archive or delete any quiz. Quizzes made before the upgrade are marked <i>Admin (older quiz)</i>.",
      "When you add a quiz you may leave <b>All sections</b> ticked, or choose sections.",
      "The Attempts column counts student attempts per quiz."
    ])]
  ]],
  ["Students and records", [
    ["Manage student records", bullets([
      "<b>Student record</b> lists registered students. Search by name or roll number, filter by grade and section.",
      "Students register themselves the first time they use the student page, or press <b>Add student</b>.",
      "Students marked <i>Not registered</i> have results but no record yet: open the ⋯ menu and choose <b>Register this student</b>."
    ])],
    ["Correct a name or class", bullets([
      "Open a student and press <b>Edit details</b>. Change the name, grade, section or roll number.",
      "The student keeps the same record, so all past results stay linked. The new name shows in results, reports, exports and analysis. Earlier names are remembered.",
      "Two students cannot share the same grade, section and roll number."
    ])],
    ["Print, export, archive and delete", bullets([
      "On <b>Results</b>: tick records or use the table menus to print, export (CSV or backup file), archive or delete.",
      "On <b>Student record</b>: print or export one student, or all students shown.",
      "Deleting asks for confirmation and offers a backup file first. Archived records can be restored."
    ])]
  ]],
  ["Requests and activity", [
    ["Review teacher requests", bullets([
      "<b>Requests</b> shows what teachers asked for. New ones are <b>Pending</b>.",
      "<b>Approve</b> does not give the teacher new access: do the change yourself (for example <b>Open student record</b> or <b>Do it now</b> in the ⋯ menu), then <b>Mark completed</b>.",
      "For printing or exporting you can choose <b>Approve with one-time permission</b>: the teacher can print or export those records once, within 7 days.",
      "Every decision is written to the activity log on the Overview."
    ])]
  ]],
  ["School and data", [
    ["School settings", bullets([
      "Grades, sections per grade, the number of students per section (the highest roll number) and the pass mark.",
      "If you rename or remove a section, update the teachers who had it on <b>Add teacher</b>."
    ])],
    ["Archive and backup", bullets([
      "Archived records are kept out of Results and analysis but can be restored.",
      "Download a backup file from any Results or Archive list (Export → Backup file), and restore it here with <b>Import</b>."
    ])],
    ["Global management", bullets([
      "Overview: watch grading, requests and activity across the school.",
      "Results, Analysis and Student record: choose All grades to see everything."
    ])]
  ]],
  ["Common problems", [
    ["A teacher forgot their password", bullets(["Add teacher → ⋯ → <b>Reset password</b>, then give them the new password."])],
    ["A teacher sees no results", bullets(["Check their grades and sections with <b>Edit</b>. Results only show for ticked sections."])],
    ["A student sees someone else's name", bullets(["They typed the wrong roll number, grade or section. If the record itself is wrong, fix it with <b>Edit details</b> on Student record."])],
    ["Two records for one student", bullets(["Open the wrong one and <b>Delete student</b> (their results are kept), then correct the remaining record."])]
  ]]
];

export class HelpView {
  constructor(container) {
    this.el = container;
  }

  show() {
    if (!this.rendered) this.render();
  }

  render() {
    this.rendered = true;
    const guide = isAdmin() ? ADMIN : TEACHER;
    const go = GO_KEYS.filter((g) => isAdmin() || !g.admin);
    this.el.innerHTML = `
      <div class="help-intro card">
        <h2>${isAdmin() ? "Admin guide" : "Teacher guide"}</h2>
        <p class="muted">Short answers to the most common questions. Press a topic to open it.</p>
        <nav class="help-toc" aria-label="Help topics">${guide.map(([title], i) => `<a href="#help-${i}" data-help-jump="help-${i}">${escapeHtml(title)}</a>`).join("")}<a href="#help-shortcuts" data-help-jump="help-shortcuts">Keyboard shortcuts</a></nav>
      </div>
      ${guide.map(([title, topics], i) => `
        <section class="card help-card" id="help-${i}">
          <h2>${escapeHtml(title)}</h2>
          ${topics.map(([q, a]) => `<details class="help-item"><summary>${escapeHtml(q)}</summary><div class="help-body">${a}</div></details>`).join("")}
        </section>`).join("")}
      <section class="card help-card" id="help-shortcuts">
        <h2>Keyboard shortcuts</h2>
        <p class="small muted">They work on the dashboard pages. They do not work while you type in a box, when a dialog is open, or on the student quiz pages.</p>
        <div class="table-wrap"><table class="data-table compact shortcut-table">
          <thead><tr><th>Shortcut</th><th>What it does</th></tr></thead>
          <tbody>
            ${go.map((g) => `<tr><td class="nowrap">${kbd("G")} then ${kbd(g.key.toUpperCase())}</td><td>Open ${escapeHtml(g.label)}</td></tr>`).join("")}
            ${OTHER_KEYS.map((k) => `<tr><td class="nowrap">${k.keys.map(kbd).join(" ")}</td><td>${escapeHtml(k.label)}</td></tr>`).join("")}
            <tr><td class="nowrap">${kbd("Tab")} / ${kbd("Shift")} + ${kbd("Tab")}</td><td>Move between buttons and fields; ${kbd("Enter")} or ${kbd("Space")} presses a button or opens a topic</td></tr>
          </tbody>
        </table></div>
        <p class="small muted">Press G, let go, then press the letter within about a second. Browser shortcuts such as Ctrl + F (find) keep working.</p>
      </section>`;
    this.el.querySelectorAll("[data-help-jump]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      this.jump(a.dataset.helpJump);
    }));
  }

  /** Scrolls to a section ("shortcuts" or "help-2") and opens its first topic. */
  jump(id) {
    this.show();
    const target = this.el.querySelector(`#${id.startsWith("help-") ? id : `help-${id}`}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    const first = target.querySelector("details");
    if (first) first.open = true;
    target.querySelector("summary, h2")?.focus?.();
  }
}
