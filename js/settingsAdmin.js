// School settings tab: grades, the sections of each grade, the number of
// students per section (the highest roll number allowed) and
// the default pass mark (settings/school).
//
// Student records store the grade and section names as text, so renaming
// or removing a section here never changes or deletes existing records:
// they keep the name they were submitted with.

import { db, doc, setDoc, serverTimestamp } from "./firebase.js";
import { teacher, setSettings, appNotice } from "./teacherState.js";
import { escapeHtml, friendlyError, NAME_PATTERN, confirmDialog, normalizeSettings, allSections } from "./utilities.js";

let uid = 0;
const nextId = () => `s${++uid}`;

export class SettingsAdmin {
  constructor(container) {
    this.el = container;
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("input", (e) => this.onInput(e));
    this.el.addEventListener("submit", (e) => { e.preventDefault(); this.save(); });
  }

  show() {
    if (this.dirty) return; // keep unsaved edits when switching tabs
    this.load();
    this.render();
  }

  /** Working copy: [{ grade, isNew, sections: [{ key, name, original, size }] }] */
  load() {
    const s = teacher.settings;
    this.pass = s.passPercent;
    this.grades = s.grades.map((g) => ({
      key: nextId(),
      grade: g,
      isNew: false,
      sections: (s.sectionsByGrade[g] || []).map((name) => ({ key: nextId(), name, original: name, size: s.classSizes[`${g}-${name}`] ?? "" }))
    }));
    this.dirty = false;
  }

  render() {
    this.el.innerHTML = `
      <form class="settings-form" novalidate>
        <div class="settings-layout">
          <div class="settings-main">
            <div class="section-title"><h2>Grades and sections</h2><span>Renaming or removing a section never changes existing results.</span></div>
            <p class="small muted settings-note">Students: the highest roll number allowed in the section (e.g. 40 allows 1 to 40). Leave it empty for no limit. Lowering it never changes existing records; a student above the new limit cannot start or submit a quiz until it is corrected.</p>
            <div class="grade-editors">
              ${this.grades.map((g) => this.gradeCard(g)).join("")}
            </div>
          </div>
          <aside class="settings-side">
            <div class="card add-grade">
              <label for="newGrade" class="label">Add a grade</label>
              <div class="inline-form">
                <input type="text" id="newGrade" maxlength="30" placeholder="e.g. 7">
                <button type="button" class="btn" data-act="add-grade">Add</button>
              </div>
            </div>
            <div class="card">
              <div class="field">
                <label for="setPass">Default pass mark (%)</label>
                <input type="number" id="setPass" min="1" max="100" required value="${escapeHtml(this.pass)}">
                <p class="hint">For quizzes without their own pass mark. Applies the next time results are graded.</p>
              </div>
            </div>
            <div class="card save-card">
              <p class="small error-text" data-err></p>
              <div class="save-row">
                <button type="submit" class="btn btn-primary" data-save>Save settings</button>
                <button type="button" class="btn btn-ghost" data-act="discard">Discard</button>
              </div>
              <span class="small muted" data-dirty>${this.dirty ? "Unsaved changes" : ""}</span>
            </div>
          </aside>
        </div>
      </form>`;
  }

  gradeCard(g) {
    return `
      <div class="card grade-editor" data-grade="${g.key}">
        <div class="card-head">
          <h3>Grade ${escapeHtml(g.grade)}${g.isNew ? ' <span class="badge badge-info">New</span>' : ""}</h3>
          <button type="button" class="btn btn-small btn-danger" data-act="remove-grade" data-g="${g.key}">Remove grade</button>
        </div>
        <table class="data-table compact section-table">
          <thead><tr><th>Section name</th><th class="num" title="Highest roll number students of this section may enter. Leave empty for no limit.">Students (max roll no.)</th><th></th></tr></thead>
          <tbody>
            ${g.sections.map((s) => `
              <tr data-s="${s.key}">
                <td><input type="text" maxlength="30" value="${escapeHtml(s.name)}" data-field="name" data-g="${g.key}" data-s="${s.key}" aria-label="Section name">
                  ${s.original && s.original !== s.name ? `<div class="small muted">Renamed from "${escapeHtml(s.original)}". Old results keep "${escapeHtml(s.original)}".</div>` : ""}</td>
                <td class="num"><input type="text" maxlength="6" inputmode="numeric" placeholder="No limit" value="${escapeHtml(s.size)}" data-field="size" data-g="${g.key}" data-s="${s.key}" aria-label="Students in section (highest roll number)" class="num-input"></td>
                <td><button type="button" class="btn btn-small" data-act="remove-section" data-g="${g.key}" data-s="${s.key}" aria-label="Remove section">Remove</button></td>
              </tr>`).join("")}
            ${g.sections.length ? "" : '<tr><td colspan="3" class="empty">No sections yet.</td></tr>'}
          </tbody>
        </table>
        <button type="button" class="btn btn-small" data-act="add-section" data-g="${g.key}">+ Add section</button>
      </div>`;
  }

  findGrade(key) { return this.grades.find((g) => g.key === key); }

  markDirty() {
    this.dirty = true;
    const d = this.el.querySelector("[data-dirty]");
    if (d) d.textContent = "Unsaved changes";
  }

  onInput(e) {
    const t = e.target;
    if (t.id === "setPass") { this.pass = t.value; this.markDirty(); return; }
    const g = this.findGrade(t.dataset.g);
    const s = g?.sections.find((x) => x.key === t.dataset.s);
    if (!s) return;
    if (t.dataset.field === "name") s.name = t.value;
    if (t.dataset.field === "size") s.size = t.value;
    this.markDirty();
  }

  async onClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const g = this.findGrade(btn.dataset.g);
    switch (btn.dataset.act) {
      case "add-section":
        g.sections.push({ key: nextId(), name: "", original: "", size: "" });
        this.markDirty();
        this.render();
        this.el.querySelector(`[data-grade="${g.key}"] tbody tr:last-child input`)?.focus();
        break;
      case "remove-section": {
        const s = g.sections.find((x) => x.key === btn.dataset.s);
        if (s.original) {
          const ok = await confirmDialog({
            title: `Remove section "${s.original}" from Grade ${g.grade}?`,
            text: "Students will no longer be able to choose it. Existing results for this section are kept and stay visible on the Results tab.",
            okText: "Remove section"
          });
          if (!ok) return;
        }
        g.sections = g.sections.filter((x) => x !== s);
        this.markDirty();
        this.render();
        break;
      }
      case "remove-grade": {
        const ok = await confirmDialog({
          title: `Remove Grade ${g.grade}?`,
          text: "Students will no longer be able to choose this grade. Quizzes, results and archived records for it are kept.",
          okText: "Remove grade"
        });
        if (!ok) return;
        this.grades = this.grades.filter((x) => x !== g);
        this.markDirty();
        this.render();
        break;
      }
      case "add-grade": {
        const input = this.el.querySelector("#newGrade");
        const name = input.value.trim();
        const err = this.el.querySelector("[data-err]");
        if (!NAME_PATTERN.test(name)) { err.textContent = `"${name}" is not a valid grade. Use letters, numbers, spaces or dashes (up to 30).`; return; }
        if (this.grades.some((x) => x.grade.toLowerCase() === name.toLowerCase())) { err.textContent = `Grade ${name} already exists.`; return; }
        this.grades.push({ key: nextId(), grade: name, isNew: true, sections: [{ key: nextId(), name: "A", original: "", size: "" }] });
        this.markDirty();
        this.render();
        break;
      }
      case "discard":
        this.load();
        this.render();
        break;
      default:
    }
  }

  async save() {
    const err = this.el.querySelector("[data-err]");
    err.textContent = "";
    const pass = Number(this.pass);
    const problems = [];
    if (!this.grades.length) problems.push("Keep at least one grade.");
    if (!(pass >= 1 && pass <= 100)) problems.push("The pass mark must be between 1 and 100.");
    const sectionsByGrade = {};
    const classSizes = {};
    this.grades.forEach((g) => {
      const names = g.sections.map((s) => s.name.trim());
      if (!names.length) problems.push(`Grade ${g.grade} needs at least one section.`);
      names.forEach((n) => { if (!NAME_PATTERN.test(n)) problems.push(`Grade ${g.grade}: "${n}" is not a valid section name. Use letters, numbers, spaces or dashes (up to 30).`); });
      const lower = names.map((n) => n.toLowerCase());
      if (new Set(lower).size !== lower.length) problems.push(`Grade ${g.grade} has the same section name twice.`);
      sectionsByGrade[g.grade] = names;
      g.sections.forEach((s) => {
        const raw = String(s.size ?? "").trim();
        if (!raw) return; // no limit
        if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) {
          problems.push(`Grade ${g.grade}, Section ${s.name.trim() || "(no name)"}: the number of students must be a whole number from 1, or empty for no limit.`);
          return;
        }
        classSizes[`${g.grade}-${s.name.trim()}`] = Number(raw);
      });
    });
    if (problems.length) { err.innerHTML = problems.map(escapeHtml).join("<br>"); return; }

    const grades = this.grades.map((g) => g.grade);
    const data = normalizeSettings({ grades, sectionsByGrade, passPercent: pass, classSizes });
    const btn = this.el.querySelector("[data-save]");
    btn.disabled = true;
    try {
      // "sections" (all names) is kept for pages cached from the older version.
      await setDoc(doc(db, "settings", "school"), { ...data, sections: allSections(data), updatedAt: serverTimestamp() });
      setSettings(data);
      this.load();
      this.render();
      appNotice("Settings saved. Students get the new grades, sections and roll number limits the next time they save their details or start a quiz.", "success");
    } catch (e) {
      appNotice(`Could not save settings. ${friendlyError(e)}`, "error");
      btn.disabled = false;
    }
  }
}
