// Help: the built-in guide. The Admin and teachers see different guides, and
// each only describes features that role can use. Topics are expandable
// sections (<details>), grouped into cards, so the page stays short.
// A search box at the top filters the topics as you type, suggests matching
// topics in a list (arrow keys + Enter), and offers ready-made searches.

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
      "<b>Overview</b> shows what needs your attention first (tests to grade, students taking a quiz now), then your key figures and a card for each of your classes.",
      "In <b>My classes</b>, press <b>Grade</b> or <b>Results</b> on a section to open its results, or <b>Students</b> to open its student list.",
      "You only see the grades and sections the Admin assigned to you.",
      "The menu on the left has everything you can use. Pages you cannot use are not shown."
    ])],
    ["Live updates (no refresh needed)", bullets([
      "The dashboard updates by itself when a student starts or submits a quiz, or when someone else (the Admin or another teacher) grades or reviews a test. The <b>Live</b> label at the top right shows it is connected.",
      "Open dialogs and menus are never closed by an update: it waits until you close them.",
      "<i>Reconnecting…</i> means the internet connection dropped. The page catches up by itself when it is back."
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
    ["Set a time limit (test duration)", bullets([
      "When adding a quiz, choose a <b>Test duration</b>: 15, 30, 45 or 60 minutes, any number of minutes, or <b>No time limit</b>. Change or remove it later with <b>Edit</b>.",
      "The timer starts when the student presses <b>Begin</b>, not on the instructions page. Refreshing or reopening the quiz never gives extra time.",
      "When the time is up, the quiz is submitted automatically, also with unanswered questions.",
      "A changed time limit applies to attempts started afterwards. If a student closed the quiz and never came back, open the ⋯ menu of that record and press <b>Submit (time is up)</b>."
    ])],
    ["Live Classroom Mode (projector)", bullets([
      "On <b>Quizzes</b>, press <b>Start Live Classroom</b> and choose a quiz, or press <b>Live</b> on a quiz row.",
      "Choose an answer with the class: it turns <b>green</b> (Correct!) or <b>red</b> (Incorrect!) at once, and the correct answer is shown in green.",
      "<b>Try again</b> clears the answer, <b>Reveal answer</b> / <b>Hide answer</b> shows or hides it, <b>Show explanation</b> appears when the question has one.",
      "Keys: ← → move, 1–4 or A–D choose, R try again, S reveal, E explanation, F fullscreen, Esc exit.",
      "Nothing is saved: no attempt, result or statistic is created or changed, and there is no exam timer (the optional activity timer only counts down)."
    ])],
    ["Allow or stop retakes", bullets([
      "Open a student's result (Results → the student's name) and choose <b>More → Allow retake</b>.",
      "The old attempt is kept as a <i>previous attempt</i> and the student can start again.",
      "If you do nothing, each student can take each quiz once."
    ])]
  ]],
  ["Results and students", [
    ["Grade your students' tests", bullets([
      "You grade the tests of your own classes yourself. No request to the Admin is needed.",
      "<b>Results</b>: choose a grade, section and quiz, then press <b>Grade all eligible</b>, or tick tests and press <b>Grade</b>.",
      "<b>Student record</b>: open a student and press <b>Grade</b>, or use the ⋯ menu of one test (<b>Grade now</b>, <b>Accept</b>, <b>Decline</b>).",
      "Short answers with small spelling mistakes can be marked correct by hand on the full record page."
    ])],
    ["View student results", bullets([
      "Open <b>Results</b>, then choose a grade, a section and a quiz. Press a student's name to open the full record.",
      "You can <b>Accept</b> or <b>Decline</b> submissions, and <b>Allow retake</b> from the full record.",
      "Use the ‹ › buttons above a wide table to see more columns."
    ])],
    ["See a student's answer sheet", bullets([
      "Open <b>Student record</b>, open the student, and press <b>Answer sheet</b> next to any test.",
      "It shows every question, the student's answer, the correct answer and the marks.",
      "Press <b>Open full record</b> for the whole page with quiz activity and hand marking."
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
      "You cannot change student names, delete records, print or export records yourself. Grading and viewing answers need no request.",
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
      "<b>Overview</b> starts with what needs attention (tests to grade, students taking a quiz now, teacher requests), then key figures, a card per grade with each section's students, tests and grading, recent submissions, quizzes and activity.",
      "You see every quiz, result and student, in every grade and section.",
      "Teachers only see their assigned classes and their own quizzes. They grade, review and open answer sheets for their own classes without asking you."
    ])],
    ["Live updates (no refresh needed)", bullets([
      "The dashboard updates by itself when a student starts or submits a quiz, or when someone else (the Admin or another teacher) grades or reviews a test. The <b>Live</b> label at the top right shows it is connected.",
      "Open dialogs and menus are never closed by an update: it waits until you close them.",
      "<i>Reconnecting…</i> means the internet connection dropped. The page catches up by itself when it is back."
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
    ])],
    ["Set a time limit (test duration)", bullets([
      "When adding a quiz, choose a <b>Test duration</b>: 15, 30, 45 or 60 minutes, any number of minutes, or <b>No time limit</b>. Change or remove it later with <b>Edit</b>.",
      "The timer starts when the student presses <b>Begin</b>, not on the instructions page. Refreshing or reopening the quiz never gives extra time.",
      "When the time is up, the quiz is submitted automatically, also with unanswered questions.",
      "A changed time limit applies to attempts started afterwards. If a student closed the quiz and never came back, open the ⋯ menu of that record and press <b>Submit (time is up)</b>."
    ])],
    ["Live Classroom Mode (projector)", bullets([
      "On <b>Quizzes</b>, press <b>Start Live Classroom</b> and choose a quiz, or press <b>Live</b> on a quiz row.",
      "Choose an answer with the class: it turns <b>green</b> (Correct!) or <b>red</b> (Incorrect!) at once, and the correct answer is shown in green.",
      "<b>Try again</b> clears the answer, <b>Reveal answer</b> / <b>Hide answer</b> shows or hides it, <b>Show explanation</b> appears when the question has one.",
      "Keys: ← → move, 1–4 or A–D choose, R try again, S reveal, E explanation, F fullscreen, Esc exit.",
      "Nothing is saved: no attempt, result or statistic is created or changed, and there is no exam timer (the optional activity timer only counts down)."
    ])]
  ]],
  ["Students and records", [
    ["Manage student records", bullets([
      "<b>Student record</b> lists registered students. Search by name or roll number, filter by grade and section.",
      "Students register themselves the first time they use the student page, or press <b>Add student</b>.",
      "Students marked <i>Not registered</i> have results but no record yet: open the ⋯ menu and choose <b>Register this student</b>."
    ])],
    ["Act on many students at once (bulk)", bullets([
      "On <b>Student record</b>, tick the box next to each student, or tick the box in the header to select the whole page. <b>Select all … shown</b> selects every student that matches the filters and search.",
      "The selection stays while you change pages, sorting or search. <b>Clear</b> removes it.",
      "Then use the blue bar: <b>Register</b> (students marked Not registered, with the name and roll number shown), <b>Print</b> records or records with answers, <b>Export</b> the student list, quiz records (CSV) or a backup (JSON), and under <b>More</b>: <b>Archive quiz records</b>, <b>Delete quiz records</b> or <b>Delete students</b>.",
      "Each action asks once for all selected students. Deleting students keeps their quiz records. Editing a name or roll number is done one student at a time, because each roll number must stay unique."
    ])],
    ["See a student's answer sheet", bullets([
      "Open <b>Student record</b>, open the student, and press <b>Answer sheet</b> next to any test. Teachers can do the same for their classes.",
      "To print answer sheets, use <b>Print → Record with answers</b> on the student, or <b>Print → Answer sheets</b> on Results."
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

// Extra words people search with, per topic title (the topic text is searched too).
const KEYWORDS = {
  "How to sign in": "login log in username password account staff",
  "Your dashboard": "overview home start classes sections figures",
  "The Admin dashboard": "overview home start classes sections figures",
  "Live updates (no refresh needed)": "refresh reload automatic auto update real time realtime live",
  "Create and upload quizzes": "add new quiz upload json question bank import lesson",
  "Organise quizzes in tabs": "category categories folder term organize",
  "Open and close quizzes": "start stop publish hide quiz available",
  "Allow or stop retakes": "retake again redo second attempt reattempt",
  "Set a time limit (test duration)": "timer time limit duration minutes countdown timed clock auto submit",
  "Live Classroom Mode (projector)": "live classroom projector present teach whiteboard interactive class show answers fullscreen",
  "Act on many students at once (bulk)": "bulk select multiple many students tick checkbox select all register delete archive export print several",
  "Grade your students' tests": "grade grading mark marks marking score check evaluate result",
  "View student results": "results scores marks accept decline review",
  "See a student's answer sheet": "answer sheet answers responses paper copy questions correct wrong",
  "Analyse performance": "analysis analytics statistics average report chart",
  "View student records": "student record history profile",
  "Ask the Admin for help (requests)": "request admin permission ask print export delete rename",
  "Create teacher accounts": "add teacher new account user staff",
  "Usernames and passwords": "password reset forgot username change login",
  "Grades, sections and permissions": "classes assign access permission deactivate delete teacher",
  "Manage all quizzes": "quizzes edit delete archive owner",
  "Manage student records": "students register add student list",
  "Correct a name or class": "rename name wrong spelling move class section roll number edit",
  "Print, export, archive and delete": "print pdf export csv excel download archive delete backup",
  "Review teacher requests": "requests approve decline permission",
  "School settings": "grades sections class size pass mark settings",
  "Archive and backup": "backup restore import archive json",
  "A teacher forgot their password": "password reset forgot",
  "A student cannot see my quiz": "quiz missing not showing student cannot see",
  "\"You don't have permission\"": "permission denied error not allowed"
};

const SUGGESTIONS = {
  teacher: ["Grade tests", "Answer sheet", "Time limit", "Live Classroom", "Add a quiz", "Retake", "Wrong name", "Shortcuts"],
  admin: ["Add teacher", "Reset password", "Time limit", "Live Classroom", "Answer sheet", "Print or export", "Rename a student", "Backup"]
};

const plain = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
const norm = (t) => String(t).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ");
const STOP = new Set(["a", "an", "the", "to", "of", "how", "do", "i", "my", "can", "is", "for", "in", "on", "and", "or", "what", "where", "be"]);
const words = (t) => norm(t).split(/\s+/).filter((w) => w && !STOP.has(w));

/** Score of one topic for the typed words (0 = no match). Every word must match somewhere. */
function scoreTopic(topic, qWords) {
  let score = 0;
  for (const w of qWords) {
    const stem = w.length > 4 ? w.replace(/(ing|es|s|ed)$/, "") : w;
    const inTitle = topic.titleN.includes(stem), inKeys = topic.keysN.includes(stem), inBody = topic.bodyN.includes(stem);
    if (!inTitle && !inKeys && !inBody) return 0;
    score += (inTitle ? 6 : 0) + (inKeys ? 4 : 0) + (inBody ? 1 : 0);
  }
  return score;
}

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
    const sugg = SUGGESTIONS[isAdmin() ? "admin" : "teacher"];
    this.el.innerHTML = `
      <div class="help-intro card">
        <h2>${isAdmin() ? "Admin guide" : "Teacher guide"}</h2>
        <p class="muted">Short answers to the most common questions. Search, or press a topic to open it.</p>
        <div class="help-search" role="search">
          <label class="sr-only" for="helpSearch">Search help</label>
          <i class="fa-solid fa-magnifying-glass help-search-icon" aria-hidden="true"></i>
          <input type="search" id="helpSearch" placeholder="Search help, e.g. grade, answer sheet, password" autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="false" aria-controls="helpSuggest" aria-autocomplete="list">
          <ul id="helpSuggest" class="help-suggest" role="listbox" hidden></ul>
        </div>
        <div class="help-chips" aria-label="Common searches"><span class="small muted">Try:</span>${sugg.map((t) => `<button type="button" class="help-chip" data-help-try="${escapeHtml(t)}" data-icon="none">${escapeHtml(t)}</button>`).join("")}</div>
        <p class="small muted help-count" data-help-count aria-live="polite" hidden></p>
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
    this.initSearch(guide);
  }

  // -------------------------------------------------------------- search

  initSearch(guide) {
    this.topics = [];
    this.el.querySelectorAll(".help-item").forEach((item, i) => {
      const title = item.querySelector("summary").textContent;
      const card = item.closest(".help-card");
      item.id = item.id || `help-topic-${i}`;
      this.topics.push({
        el: item, card, title, section: card.querySelector("h2").textContent,
        titleN: norm(title), keysN: norm(KEYWORDS[title] || ""), bodyN: norm(plain(item.querySelector(".help-body").innerHTML))
      });
    });
    // The shortcuts table is one more "topic".
    const sc = this.el.querySelector("#help-shortcuts");
    this.topics.push({ el: sc, card: sc, title: "Keyboard shortcuts", section: "Keyboard shortcuts", isCard: true,
      titleN: "keyboard shortcuts", keysN: "keys shortcut hotkey keyboard", bodyN: norm(plain(sc.innerHTML)) });

    const input = this.el.querySelector("#helpSearch");
    const list = this.el.querySelector("#helpSuggest");
    this.active = -1;
    input.addEventListener("input", () => this.search(input.value));
    input.addEventListener("focus", () => { if (input.value.trim()) this.search(input.value); });
    input.addEventListener("keydown", (e) => {
      const items = [...list.querySelectorAll("[role=option]")];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!items.length) return;
        e.preventDefault();
        this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.setAttribute("aria-selected", String(i === this.active)));
        input.setAttribute("aria-activedescendant", items[this.active].id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = items[this.active >= 0 ? this.active : 0];
        if (pick) this.openTopic(Number(pick.dataset.topic));
      } else if (e.key === "Escape") {
        if (!list.hidden) { e.stopPropagation(); this.closeSuggest(); } else if (input.value) { input.value = ""; this.search(""); }
      }
    });
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
    list.addEventListener("click", (e) => {
      const li = e.target.closest("[data-topic]");
      if (li) this.openTopic(Number(li.dataset.topic));
    });
    input.addEventListener("blur", () => setTimeout(() => this.closeSuggest(), 120));
    this.el.querySelectorAll("[data-help-try]").forEach((b) => b.addEventListener("click", () => {
      input.value = b.dataset.helpTry;
      this.search(input.value);
      input.focus();
    }));
  }

  closeSuggest() {
    const list = this.el.querySelector("#helpSuggest");
    const input = this.el.querySelector("#helpSearch");
    if (!list || !input) return;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  /** Filters the topics and fills the suggestion list. */
  search(text) {
    const qWords = words(text);
    const list = this.el.querySelector("#helpSuggest");
    const input = this.el.querySelector("#helpSearch");
    const count = this.el.querySelector("[data-help-count]");
    this.active = -1;
    if (!qWords.length) {
      this.topics.forEach((t) => { t.el.hidden = false; t.card.hidden = false; if (!t.isCard) t.el.open = false; });
      this.el.querySelector(".help-toc").hidden = false;
      count.hidden = true;
      this.closeSuggest();
      return;
    }
    const scored = this.topics.map((t, i) => ({ t, i, score: scoreTopic(t, qWords) }));
    const hits = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    // Show only the matching topics (and their cards).
    const hitSet = new Set(hits.map((x) => x.t));
    this.topics.forEach((t) => { if (!t.isCard) t.el.hidden = !hitSet.has(t); });
    this.el.querySelectorAll(".help-card").forEach((card) => {
      const any = this.topics.some((t) => t.card === card && hitSet.has(t));
      card.hidden = !any;
    });
    this.el.querySelector(".help-toc").hidden = true;
    count.hidden = false;
    count.textContent = hits.length ? `${hits.length} topic${hits.length === 1 ? "" : "s"} found. Press Enter to open the best match.` : "No topic matches. Try another word, or one of the suggestions above.";
    list.innerHTML = hits.slice(0, 6).map((x, n) => `<li role="option" id="help-opt-${n}" data-topic="${x.i}" aria-selected="false">
      <b>${escapeHtml(x.t.title)}</b><span>${escapeHtml(x.t.section)}</span></li>`).join("")
      || '<li class="help-suggest-empty">No matching topic</li>';
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  /** Opens one topic from the search: shows it, expands it and scrolls to it. */
  openTopic(i) {
    const t = this.topics[i];
    if (!t) return;
    this.closeSuggest();
    t.card.hidden = false;
    t.el.hidden = false;
    if (!t.isCard) t.el.open = true;
    t.el.scrollIntoView({ behavior: "smooth", block: "center" });
    t.el.classList.add("help-flash");
    setTimeout(() => t.el.classList.remove("help-flash"), 1600);
  }

  /** Scrolls to a section ("shortcuts" or "help-2") and opens its first topic. */
  jump(id) {
    this.show();
    const box = this.el.querySelector("#helpSearch");
    if (box?.value) { box.value = ""; this.search(""); }
    const target = this.el.querySelector(`#${id.startsWith("help-") ? id : `help-${id}`}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    const first = target.querySelector("details");
    if (first) first.open = true;
    target.querySelector("summary, h2")?.focus?.();
  }
}
