// Import a results backup file (made with Export > Backup on the Results or
// Archive tab). The file is checked, a preview with counts is shown, and
// nothing is written until the teacher confirms. Existing records are never
// overwritten: duplicates are skipped, or added as separate copies if the
// teacher asks for that.

import { parseBackup } from "./backup.js";
import { findExistingIds, importRecords } from "./records.js";
import { appNotice } from "./teacherState.js";
import { escapeHtml, friendlyError, pluralize, formatDateTime, confirmDialog } from "./utilities.js";

export class BackupImport {
  constructor(container, { onImported } = {}) {
    this.el = container;
    this.onImported = onImported;
    this.state = null;
    this.el.innerHTML = `
      <div class="card-head"><div><h2>Restore from a backup</h2><p class="card-sub">Use a backup file from Export. Existing records are not overwritten.</p></div></div>
      <label class="file-drop">
          <input type="file" class="native-hidden" accept=".json,application/json" data-b="file" aria-label="Backup file">
          <span class="file-drop-icon" aria-hidden="true"></span>
          <span class="file-drop-text"><b>Choose a backup file</b> or drop it here</span>
          <span class="file-drop-sub">JSON</span>
        </label>
      <div data-b="preview"></div>`;
    this.$ = (s) => this.el.querySelector(`[data-b="${s}"]`);
    this.$("file").addEventListener("change", (e) => this.read(e.target.files[0]));
    this.$("preview").addEventListener("change", () => this.renderSummary());
    this.$("preview").addEventListener("click", (e) => {
      if (e.target.closest("[data-b-import]")) this.run();
      if (e.target.closest("[data-b-cancel]")) this.reset();
    });
  }

  reset() {
    this.state = null;
    this.$("file").value = "";
    this.$("preview").innerHTML = "";
  }

  async read(file) {
    if (!file) { this.reset(); return; }
    const box = this.$("preview");
    box.innerHTML = '<div class="loading"><span class="spinner"></span> Checking the file…</div>';
    try {
      const parsed = parseBackup(await file.text());
      if (parsed.error) { box.innerHTML = `<div class="notice notice-error">${escapeHtml(parsed.error)}</div>`; return; }
      const existing = await findExistingIds(parsed.records.map((r) => r.id));
      this.state = { ...parsed, existing, fileName: file.name };
      this.render();
    } catch (err) {
      console.error(err);
      box.innerHTML = `<div class="notice notice-error">Could not check the file. ${escapeHtml(friendlyError(err))}</div>`;
    }
  }

  render() {
    const { records, skipped, meta, existing, fileName } = this.state;
    const dupes = records.filter((r) => existing.active.has(r.id) || existing.archive.has(r.id)).length;
    const quizzes = new Set(records.map((r) => r.attempt.quizId)).size;
    const graded = records.filter((r) => r.result).length;
    this.$("preview").innerHTML = `
      <div class="notice notice-info">
        <b>${escapeHtml(fileName)}</b>: ${pluralize(records.length, "valid record")} from ${pluralize(quizzes, "quiz", "quizzes")} (${graded} graded)
        ${meta.exportedAt ? `, exported ${escapeHtml(formatDateTime(new Date(meta.exportedAt)))}` : ""}${meta.source ? ` from the ${meta.source === "archive" ? "archive" : "results"}` : ""}.
      </div>
      ${skipped.length ? `<div class="notice notice-warning"><b>${pluralize(skipped.length, "record")} in the file cannot be imported:</b><ul>${skipped.slice(0, 50).map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>${skipped.length > 50 ? `<p class="small">…and ${skipped.length - 50} more.</p>` : ""}</div>` : ""}
      ${dupes ? `<div class="notice notice-warning">${pluralize(dupes, "record")} already exist${dupes === 1 ? "s" : ""} in your results or archive (same record ID).</div>` : ""}
      ${records.length ? `
      <div class="field">
        <span class="label">Import into</span>
        <label class="check"><input type="radio" name="bTarget" value="archive" ${meta.source === "archive" ? "checked" : ""}> Archive (recommended: check them there, then restore)</label>
        <label class="check"><input type="radio" name="bTarget" value="active" ${meta.source === "archive" ? "" : "checked"}> Results</label>
      </div>
      ${dupes ? `<div class="field">
        <span class="label">Records that already exist</span>
        <label class="check"><input type="radio" name="bDupes" value="skip" checked> Skip them (existing records stay as they are)</label>
        <label class="check"><input type="radio" name="bDupes" value="copy"> Import them as separate copies with new IDs</label>
      </div>` : ""}
      <p data-b="summary"></p>
      <div class="actions-row">
        <button type="button" class="btn btn-primary" data-b-import>Import</button>
        <button type="button" class="btn" data-b-cancel>Cancel</button>
      </div>` : ""}`;
    if (records.length) this.renderSummary();
  }

  choices() {
    const box = this.$("preview");
    return {
      target: box.querySelector('input[name="bTarget"]:checked')?.value || "archive",
      dupes: box.querySelector('input[name="bDupes"]:checked')?.value || "skip"
    };
  }

  /** Records to write, with ids resolved. */
  planned() {
    const { records, existing } = this.state;
    const { dupes } = this.choices();
    const stamp = Date.now().toString(36);
    const out = [];
    let skippedDupes = 0;
    records.forEach((r) => {
      const exists = existing.active.has(r.id) || existing.archive.has(r.id);
      if (!exists) { out.push(r); return; }
      if (dupes === "skip") { skippedDupes++; return; }
      const id = `${r.id}~import-${stamp}`;
      out.push({ id, attempt: { ...r.attempt, originalId: r.id }, result: r.result ? { ...r.result, attemptId: id } : null });
    });
    return { out, skippedDupes };
  }

  renderSummary() {
    const el = this.$("summary");
    if (!el || !this.state) return;
    const { target } = this.choices();
    const { out, skippedDupes } = this.planned();
    el.innerHTML = `<b>${pluralize(out.length, "record")}</b> will be added to the ${target === "archive" ? "Archive" : "Results"}.` +
      (skippedDupes ? ` ${pluralize(skippedDupes, "duplicate")} will be skipped.` : "") +
      (this.state.skipped.length ? ` ${pluralize(this.state.skipped.length, "invalid record")} will be skipped.` : "");
    const btn = this.$("preview").querySelector("[data-b-import]");
    if (btn) btn.disabled = !out.length;
  }

  async run() {
    const { target } = this.choices();
    const { out, skippedDupes } = this.planned();
    if (!out.length) return;
    const ok = await confirmDialog({
      title: `Import ${pluralize(out.length, "record")}?`,
      text: `They will be added to ${target === "archive" ? "Archive" : "Results"}.`,
      okText: "Import"
    });
    if (!ok) return;
    const btn = this.$("preview").querySelector("[data-b-import]");
    btn.disabled = true;
    try {
      // Check again right before writing, in case records were added meanwhile.
      const latest = await findExistingIds(out.map((r) => r.id));
      const clash = out.filter((r) => latest.active.has(r.id) || latest.archive.has(r.id));
      if (clash.length) {
        this.state.existing = await findExistingIds(this.state.records.map((r) => r.id));
        this.render();
        appNotice(`${pluralize(clash.length, "record")} were added by someone else since the file was checked. Review the preview and import again.`, "warning");
        return;
      }
      const n = await importRecords(target, out, (d, t) => appNotice(`Importing ${d} of ${t}…`, "info"));
      const skippedNote = [skippedDupes && `${pluralize(skippedDupes, "duplicate")} skipped`, this.state.skipped.length && `${pluralize(this.state.skipped.length, "invalid record")} skipped`].filter(Boolean).join(", ");
      appNotice(`Imported ${pluralize(n, "record")} into the ${target === "archive" ? "Archive" : "Results"}.${skippedNote ? ` (${skippedNote}.)` : ""}`, "success");
      this.reset();
      this.onImported?.(target);
    } catch (err) {
      console.error(err);
      const partial = err?.completed ? ` ${pluralize(err.completed, "record")} were imported before the error; the rest were not. Choose the file again: imported records will be detected as duplicates.` : " Nothing was imported.";
      appNotice(`Import failed. ${friendlyError(err)}${partial}`, "error");
      btn.disabled = false;
      if (err?.completed) this.onImported?.(target);
    }
  }
}
