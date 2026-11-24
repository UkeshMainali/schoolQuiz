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
import { teacher, reloadQuizzes, sortedQuizzes, appNotice, onTeacherChange } from "./teacherState.js";
import { escapeHtml, friendlyError, confirmDialog, pluralize, formatDateTime } from "./utilities.js";

const QUIZZES_PER_BATCH = 100; // 3 writes each, below Firestore's 500 limit

const gradeLabel = (g) => (g ? `Grade ${escapeHtml(g)}` : "Any grade");
const typeSummary = (questions) => Object.entries(questions.reduce((m, q) => ({ ...m, [q.type]: (m[q.type] || 0) + 1 }), {}))
  .map(([t, n]) => `${n} ${t.replace("_", " ")}`).join(", ");

export class QuizAdmin {
  constructor(container) {
    this.el = container;
    this.imp = null;
    this.filters = { search: "", grade: "", archived: false };
    this.el.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h2>Add quizzes</h2><p class="card-sub">Each lesson becomes a quiz, or merge lessons into one. A new quiz never replaces an earlier one unless you choose Replace.</p></div></div>
        <label class="file-drop">
          <input type="file" class="native-hidden" accept=".json,application/json" multiple data-q="file" aria-label="Question bank files">
          <span class="file-drop-icon" aria-hidden="true"></span>
          <span class="file-drop-text"><b>Choose question bank files</b> or drop them here</span>
          <span class="file-drop-sub">JSON · nothing is saved until you press Add</span>
        </label>
        <div data-q="preview"></div>
      </div>

      <div class="card table-card">
        <div class="card-head"><h2>All quizzes</h2><span class="muted small" data-q="count"></span></div>
        <div class="filters">
          <label class="stack-field grow"><span>Search</span><input type="search" data-q="search" placeholder="Quiz title"></label>
          <label class="stack-field"><span>Grade</span><select data-q="grade"></select></label>
          <label class="check inline"><input type="checkbox" data-q="archived"> Show archived</label>
          <button type="button" class="btn" data-q="refresh"><span class="i-refresh" aria-hidden="true"></span>Refresh</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Quiz</th><th>Grade</th><th class="num">Questions</th><th class="num">Marks</th><th>Status</th><th>Updated</th><th class="actions-col">Actions</th></tr></thead>
            <tbody data-q="list"></tbody>
          </table>
        </div>
      </div>
      <div data-q="key"></div>`;
    this.$ = (s) => this.el.querySelector(`[data-q="${s}"]`);
    this.bind();
    onTeacherChange(() => { if (this.shown) { this.fillGradeFilter(); this.renderList(); if (this.imp) this.renderImport(); } });
  }

  show() {
    this.shown = true;
    this.fillGradeFilter();
    this.renderList();
  }

  bind() {
    this.$("file").addEventListener("change", (e) => this.readFiles([...e.target.files]));
    this.$("search").addEventListener("input", (e) => { this.filters.search = e.target.value; this.renderList(); });
    this.$("grade").addEventListener("change", (e) => { this.filters.grade = e.target.value; this.renderList(); });
    this.$("archived").addEventListener("change", (e) => { this.filters.archived = e.target.checked; this.renderList(); });
    this.$("refresh").addEventListener("click", async () => {
      try { await reloadQuizzes(); appNotice("Quiz list refreshed.", "success"); } catch (err) { appNotice(friendlyError(err), "error"); }
    });
    this.$("list").addEventListener("click", (e) => this.onListClick(e));
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

  fillGradeFilter() {
    const sel = this.$("grade");
    const grades = [...new Set([...teacher.settings.grades, ...[...teacher.quizzes.values()].map((q) => q.grade).filter(Boolean)])];
    sel.innerHTML = '<option value="">All grades</option>' + grades.map((g) => `<option value="${escapeHtml(g)}">Grade ${escapeHtml(g)}</option>`).join("");
    sel.value = grades.includes(this.filters.grade) ? this.filters.grade : "";
    this.filters.grade = sel.value;
  }

  // ------------------------------------------------------------ quiz list

  visibleQuizzes() {
    const term = this.filters.search.trim().toLowerCase();
    return sortedQuizzes({ grade: this.filters.grade, includeArchived: this.filters.archived })
      .filter((q) => !this.filters.grade || String(q.grade) === this.filters.grade)
      .filter((q) => !term || String(q.title).toLowerCase().includes(term) || q.id.toLowerCase().includes(term));
  }

  renderList() {
    const list = this.visibleQuizzes();
    const archivedCount = [...teacher.quizzes.values()].filter((q) => q.archived).length;
    this.$("count").textContent = `${pluralize(list.length, "quiz", "quizzes")} shown${archivedCount && !this.filters.archived ? ` (${archivedCount} archived hidden)` : ""}`;
    this.$("list").innerHTML = list.length ? list.map((q) => this.quizRow(q)).join("") :
      `<tr><td colspan="7" class="empty">${teacher.quizzes.size ? "No quizzes match these filters." : "No quizzes yet. Add a question bank file above."}</td></tr>`;
  }

  quizRow(q) {
    const id = escapeHtml(q.id);
    const lessons = Array.isArray(q.lessons) ? q.lessons : [];
    const kind = q.merged
      ? `<span class="badge badge-info" title="${escapeHtml(lessons.map((l) => l.title).join(", "))}">Merged · ${lessons.length} lessons</span>`
      : '<span class="badge badge-muted">Individual</span>';
    const status = q.archived ? '<span class="badge badge-muted">Archived</span>'
      : q.active ? '<span class="badge badge-success">Open</span>' : '<span class="badge">Closed</span>';
    return `
      <tr>
        <td>
          <div class="quiz-title">${escapeHtml(q.title)}</div>
          <div class="small muted">${kind} <code>${id}</code></div>
          ${q.merged ? `<div class="small muted">${lessons.map((l) => escapeHtml(l.title)).join(" · ")}</div>` : ""}
        </td>
        <td class="nowrap">${gradeLabel(q.grade)}</td>
        <td class="num">${q.questionCount ?? "—"}</td>
        <td class="num">${q.totalMarks ?? "—"}</td>
        <td>${status}</td>
        <td class="small nowrap">${escapeHtml(formatDateTime(q.updatedAt || q.importedAt))}</td>
        <td class="actions-cell">
          ${q.archived ? "" : `<button type="button" class="btn btn-small" data-act="toggle" data-id="${id}">${q.active ? "Close" : "Open"}</button>`}
          <button type="button" class="btn btn-small" data-act="edit" data-id="${id}">Edit</button>
          <details class="menu">
            <summary class="btn btn-small" aria-label="More actions">⋯</summary>
            <div class="menu-list">
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
      if (act === "toggle") await this.setStatus(quiz, { active: !quiz.active }, `"${quiz.title}" is now ${quiz.active ? "closed" : "open for students"}.`);
      else if (act === "archive") {
        const ok = await confirmDialog({
          title: `Archive "${quiz.title}"?`,
          text: "The quiz is closed and hidden from the list and from students. Its questions, answer key and student records are kept. You can unarchive it at any time.",
          okText: "Archive quiz"
        });
        if (ok) await this.setStatus(quiz, { archived: true, active: false }, `"${quiz.title}" was archived. Tick "Show archived" to see it.`);
      } else if (act === "unarchive") await this.setStatus(quiz, { archived: false }, `"${quiz.title}" was unarchived. It is closed; press Open when students should see it.`);
      else if (act === "edit") await this.editQuiz(quiz);
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
    const grades = [...new Set([...teacher.settings.grades, ...(quiz.grade ? [quiz.grade] : [])])];
    const values = await editDialog(quiz, grades, teacher.settings.passPercent);
    if (!values) return;
    const passChanged = (values.passPercent ?? null) !== (quiz.passPercent ?? null);
    const gradeChanged = values.grade !== (quiz.grade || "");
    const meta = { title: values.title, grade: values.grade, description: values.description, passPercent: values.passPercent, updatedAt: serverTimestamp() };
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
    if (gradeChanged) notes.push("Students of other grades will no longer see it.");
    if (passChanged) notes.push("Existing results now show Needs regrading so the new pass mark can be applied.");
    appNotice(`Saved "${values.title}". ${notes.join(" ")}`.trim(), "success");
    await reloadQuizzes();
  }

  async deleteQuiz(quiz) {
    const res = await confirmDialog({
      title: `Delete "${quiz.title}"?`,
      text: "The quiz, its questions and its answer key are permanently deleted. Student records for this quiz are kept, but they cannot be graded again unless you add the same question bank again with the same quiz ID. Archive the quiz instead if you may need it later.",
      okText: "Delete quiz",
      danger: true,
      check: "Yes, permanently delete this quiz"
    });
    if (!res) return;
    const batch = writeBatch(db);
    ["quizzes", "quizContent", "answerKeys"].forEach((c) => batch.delete(doc(db, c, quiz.id)));
    await batch.commit();
    clearKeyCache();
    this.$("key").innerHTML = "";
    await reloadQuizzes();
    appNotice(`"${quiz.title}" was deleted.`, "success");
  }

  async showAnswerKey(quiz) {
    const box = this.$("key");
    box.innerHTML = '<div class="card"><div class="loading"><span class="spinner"></span> Loading answer key…</div></div>';
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
    const imp = { lessons: [], errors: [], warnings: [], mode: "separate", mergeTitle: "", onCollision: "keep", open: false };
    for (const file of files) {
      let text;
      try { text = await file.text(); } catch { imp.errors.push(`${file.name} could not be read.`); continue; }
      const parsed = parseQuestionBank(text, file.name);
      imp.errors.push(...parsed.errors);
      imp.warnings.push(...parsed.warnings);
      parsed.lessons.forEach((l) => {
        const gradeOk = teacher.settings.grades.includes(l.grade);
        imp.lessons.push({ ...l, include: true, chosenGrade: gradeOk ? l.grade : (teacher.settings.grades.length === 1 && !l.grade ? teacher.settings.grades[0] : "") });
      });
    }
    this.imp = imp;
    this.renderImport();
  }

  renderImport() {
    const imp = this.imp;
    const grades = teacher.settings.grades;
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
              ${badGrade ? `<div class="small error-text">The file says grade "${escapeHtml(l.grade)}", which is not in School settings.</div>` : ""}
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
          <span><b>Merge into one quiz</b><br><span class="small muted">All ticked lessons (same grade) become one quiz. Each question remembers its lesson.</span></span></label>
      </div>
      <div class="field merge-title" ${imp.mode === "merge" ? "" : "hidden"}>
        <label for="impTitle">Title of the merged quiz</label>
        <input type="text" id="impTitle" data-imp="title" maxlength="120" value="${escapeHtml(imp.mergeTitle)}" placeholder="e.g. Science revision: lessons 1 to 3">
      </div>

      <h4>3. Options</h4>
      <div class="field">
        <label for="impCollision">If a quiz with the same ID already exists</label>
        <select id="impCollision" data-imp="collision">
          <option value="keep" ${imp.onCollision === "keep" ? "selected" : ""}>Keep both: save the new one under a new ID (recommended)</option>
          <option value="replace" ${imp.onCollision === "replace" ? "selected" : ""}>Replace the existing quiz (same ID, new questions)</option>
        </select>
      </div>
      <label class="check"><input type="checkbox" data-imp="open" ${imp.open ? "checked" : ""}> Open the new quizzes for students now</label>

      <h4>4. Check and add</h4>
      <div data-imp="plan"></div>`;
    this.$("preview").innerHTML = html;
    this.renderPlan();
  }

  onImportChange(e) {
    const t = e.target;
    const imp = this.imp;
    if (!imp || !t.dataset.imp) return;
    const i = Number(t.dataset.i);
    switch (t.dataset.imp) {
      case "all": imp.lessons.forEach((l) => { l.include = t.checked; }); this.renderImport(); return;
      case "inc": imp.lessons[i].include = t.checked; break;
      case "grade": imp.lessons[i].chosenGrade = t.value; break;
      case "mode":
        imp.mode = t.value;
        this.$("preview").querySelector(".merge-title").hidden = imp.mode !== "merge";
        break;
      case "collision": imp.onCollision = t.value; break;
      case "open": imp.open = t.checked; break;
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
      if (existing && imp.onCollision === "replace" && !used.has(base)) {
        action = "replace";
      } else if (existing || used.has(base)) {
        let n = 2;
        while (teacher.quizzes.has(`${base}-${n}`) || used.has(`${base}-${n}`)) n++;
        id = `${base}-${n}`;
        action = "copy";
      }
      used.add(id);
      return { quiz: { ...quiz, quizId: id }, id, base, existing, action };
    });
    return { quizzes, problems, warnings };
  }

  renderPlan() {
    const box = this.$("preview").querySelector('[data-imp="plan"]');
    if (!box) return;
    const { quizzes, problems, warnings } = this.plan();
    const actionText = (p) => ({
      new: '<span class="badge badge-info">New quiz</span>',
      copy: `<span class="badge badge-info">New quiz</span><div class="small muted">ID <code>${escapeHtml(p.base)}</code> is already used${p.existing ? ` by "${escapeHtml(p.existing.title)}"` : " in this list"}, so this one gets its own ID.</div>`,
      replace: `<span class="badge badge-warning">Replaces "${escapeHtml(p.existing?.title || p.base)}"</span><div class="small error-text">Students who are in the middle of this quiz will get the new questions. Submitted work will show Needs regrading.</div>`
    })[p.action];
    let html = "";
    if (warnings.length) html += `<div class="notice notice-warning"><ul>${warnings.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
    if (problems.length) html += `<div class="notice notice-error"><ul>${problems.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
    if (quizzes.length) {
      html += `
        <div class="table-wrap">
        <table class="data-table compact">
          <thead><tr><th>Quiz</th><th>ID</th><th>Grade</th><th class="num">Questions</th><th class="num">Marks</th><th>What happens</th></tr></thead>
          <tbody>${quizzes.map((p) => `<tr>
            <td>${escapeHtml(p.quiz.title)}${p.quiz.merged ? `<div class="small muted">Merged: ${p.quiz.lessons.map((l) => escapeHtml(l.title)).join(" + ")}</div>` : ""}</td>
            <td class="small"><code>${escapeHtml(p.id)}</code></td>
            <td class="nowrap">${gradeLabel(p.quiz.grade)}</td>
            <td class="num">${p.quiz.questions.length}</td>
            <td class="num">${p.quiz.questions.reduce((s, q) => s + q.marks, 0)}</td>
            <td>${actionText(p)}</td></tr>`).join("")}</tbody>
        </table>
        </div>`;
    }
    const n = quizzes.length;
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
        const ok = await confirmDialog({ title: "Replace existing quizzes?", text: `${names} will get new questions and a new answer key. Student records are kept.`, okText: "Replace", danger: true });
        if (!ok) { this.renderPlan(); return; }
      }
      btn.textContent = "Saving…";
      const importedAt = Timestamp.now(); // shared by the list doc and the answer key: identifies this key version
      for (let i = 0; i < quizzes.length; i += QUIZZES_PER_BATCH) {
        const chunk = quizzes.slice(i, i + QUIZZES_PER_BATCH);
        const batch = writeBatch(db);
        chunk.forEach(({ quiz, id, existing, action }) => {
          const replacing = action === "replace";
          batch.set(doc(db, "quizzes", id), {
            ...toQuizMeta(quiz),
            passPercent: quiz.passPercent ?? null,
            active: this.imp.open || (replacing && !!existing.active),
            archived: false,
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
      const opened = this.imp.open;
      this.resetImport();
      await reloadQuizzes();
      appNotice(`Added ${pluralize(saved, "quiz", "quizzes")}: ${names.join(", ")}.${opened ? "" : " Press Open next to a quiz when students should see it."}`, "success");
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
      <div class="field"><label for="eqDesc">Information for students (optional)</label><textarea id="eqDesc" rows="3" maxlength="500"></textarea></div>
      <div class="field"><label for="eqPass">Pass mark % (leave empty for the school default, ${escapeHtml(defaultPass)}%)</label><input type="number" id="eqPass" min="1" max="100"></div>
      <p class="small muted">To change the questions, add the question bank file again on this tab and choose "Replace the existing quiz".</p>
      <p class="small error-text" data-err></p>
      <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
    </form>`;
  const f = backdrop.querySelector("form");
  const q = (s) => backdrop.querySelector(s);
  q("#eqName").value = quiz.title || "";
  q("#eqGrade").value = quiz.grade || "";
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
      done({ title, grade: q("#eqGrade").value, description: q("#eqDesc").value.trim(), passPercent: pass });
    });
  });
}
