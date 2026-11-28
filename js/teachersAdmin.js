// Add Teacher (Admin only): create teacher accounts and manage them.
//
// Accounts are real Firebase Authentication accounts, so passwords are never
// stored in Firestore. Each teacher signs in with a username; behind it is a
// made-up email (never used for mail), kept in usernames/{username}.
//
// Without Cloud Functions a browser cannot change the password of another
// account. "Reset password" therefore gives the teacher a NEW login with the
// new password and moves their profile (same teacherId, so every quiz and
// record stays theirs) to it; the old login stops working at once because
// the rules only accept accounts that have a teachers/{uid} document.

import {
  db, doc, getDoc, getDocs, collection, writeBatch, serverTimestamp, query, where,
  createAuthAccount, STAFF_EMAIL_DOMAIN
} from "./firebase.js";
import { USERNAME_PATTERN, logActivity } from "./auth.js";
import { session, cleanClasses, classesLabel, sectionsText } from "./roles.js";
import { teacher, appNotice, onTeacherChange, reloadQuizzes } from "./teacherState.js";
import { sortRows, nextSort, paintSortHeaders } from "./tableSort.js";
import { escapeHtml, friendlyError, confirmDialog, formatDate, formatDateTime, normalizeName, pluralize, skeletonRows, sectionsFor, formModal } from "./utilities.js";

export { formModal };

const MIN_PASSWORD = 8;
const VALUE = {
  name: (t) => t.name,
  username: (t) => t.username,
  classes: (t) => classesLabel(t.classes, teacher.settings),
  status: (t) => (t.status === "disabled" ? 1 : 0),
  created: (t) => t.createdAt?.toMillis?.() ?? null
};

const randomEmail = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@${STAFF_EMAIL_DOMAIN}`;

export function passwordProblem(pw) {
  if (!pw) return "Enter a password.";
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 64) return "Use at most 64 characters.";
  return "";
}

export function usernameProblem(name) {
  if (!name) return "Enter a username.";
  if (!USERNAME_PATTERN.test(name)) return "3 to 30 characters: small letters, numbers, dot, dash or underscore. Start with a letter or number.";
  return "";
}

/** Checkbox grid of every grade and its sections. classes: { "6": ["A"] } */
export function classPickerHtml(settings, classes = {}, prefix = "cp") {
  if (!settings.grades.length) return '<p class="small muted">Add grades in School settings first.</p>';
  return `<div class="class-picker">${settings.grades.map((g) => {
    const secs = sectionsFor(settings, g);
    const chosen = classes[g] || [];
    return `<div class="class-row">
      <span class="class-grade">Grade ${escapeHtml(g)}</span>
      <div class="class-secs">${secs.map((s) => `<label class="chip-check"><input type="checkbox" data-${prefix}-grade="${escapeHtml(g)}" value="${escapeHtml(s)}"${chosen.includes(s) ? " checked" : ""}><span>${escapeHtml(s)}</span></label>`).join("") || '<span class="small muted">No sections</span>'}</div>
    </div>`;
  }).join("")}</div>`;
}

export function readClassPicker(root, prefix = "cp") {
  const out = {};
  root.querySelectorAll(`input[data-${prefix}-grade]:checked`).forEach((box) => {
    const g = box.getAttribute(`data-${prefix}-grade`);
    (out[g] = out[g] || []).push(box.value);
  });
  return out;
}

export class TeachersAdmin {
  constructor(container) {
    this.el = container;
    this.list = [];
    this.sort = { key: "name", dir: "asc" };
    this.loaded = false;
    this.el.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h2>Add a teacher</h2><p class="card-sub">The teacher signs in with this username and password.</p></div></div>
        <form data-t="form" novalidate>
          <div class="form-grid">
            <div class="field"><label for="tName">Teacher's name</label><input type="text" id="tName" maxlength="80" autocomplete="off" placeholder="e.g. Sita Karki"><div class="error-text" data-err="name" hidden></div></div>
            <div class="field"><label for="tUser">Username</label><input type="text" id="tUser" maxlength="30" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. sita.karki"><div class="error-text" data-err="username" hidden></div></div>
            <div class="field"><label for="tPass">Initial password</label>
              <div class="input-affix"><input type="password" id="tPass" maxlength="64" autocomplete="new-password"><button type="button" class="affix-btn" data-t="show" aria-label="Show password" aria-pressed="false">Show</button></div>
              <div class="hint">At least ${MIN_PASSWORD} characters. Give it to the teacher privately.</div>
              <div class="error-text" data-err="password" hidden></div></div>
          </div>
          <div class="field"><span class="label">Grades and sections</span><div data-t="picker"></div><div class="error-text" data-err="classes" hidden></div></div>
          <div class="actions-row"><button type="submit" class="btn btn-primary" data-t="create" data-icon="user-plus">Create teacher</button></div>
        </form>
      </div>

      <div class="card table-card">
        <div class="card-head">
          <div><h2>Teachers</h2><span class="muted small" data-t="count"></span></div>
          <div class="filters inline-filters">
            <input type="search" data-t="search" placeholder="Search name or username" aria-label="Search teachers">
            <button type="button" class="btn btn-small" data-t="refresh">Refresh</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table teacher-table">
            <thead><tr>
              <th data-sort="name">Teacher</th><th data-sort="username">Username</th><th data-sort="classes">Grades and sections</th>
              <th data-sort="status">Status</th><th data-sort="created">Created</th><th class="actions-col">Actions</th>
            </tr></thead>
            <tbody data-t="body"></tbody>
          </table>
        </div>
      </div>`;
    this.$ = (k) => this.el.querySelector(`[data-t="${k}"]`);
    this.$("form").addEventListener("submit", (e) => { e.preventDefault(); this.create(); });
    this.$("show").addEventListener("click", (e) => {
      const input = this.el.querySelector("#tPass");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      e.target.textContent = show ? "Hide" : "Show";
      e.target.setAttribute("aria-pressed", String(show));
    });
    this.el.querySelector("#tUser").addEventListener("input", (e) => { e.target.value = e.target.value.toLowerCase().replace(/\s+/g, ""); });
    this.$("search").addEventListener("input", () => this.render());
    this.$("refresh").addEventListener("click", () => this.load());
    this.el.querySelector(".teacher-table thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      this.sort = nextSort(this.sort, th.dataset.sort, ["created"]);
      this.render();
    });
    this.$("body").addEventListener("click", (e) => this.onRowClick(e));
    document.addEventListener("click", (e) => {
      this.el.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
    onTeacherChange((what) => { if (what === "settings" && this.shown) this.renderPicker(); });
  }

  show() {
    this.shown = true;
    this.renderPicker();
    if (!this.loaded) this.load();
  }

  renderPicker() {
    const keep = this.$("picker").innerHTML ? readClassPicker(this.$("picker")) : {};
    this.$("picker").innerHTML = classPickerHtml(teacher.settings, keep);
  }

  async load() {
    this.$("body").innerHTML = skeletonRows(6, 4);
    try {
      const snap = await getDocs(query(collection(db, "teachers"), where("role", "==", "teacher")));
      this.list = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      this.loaded = true;
      this.render();
    } catch (err) {
      console.error(err);
      this.$("body").innerHTML = "";
      appNotice(`Could not load teachers. ${friendlyError(err)}`, "error");
    }
  }

  render() {
    const term = this.$("search").value.trim().toLowerCase();
    const rows = sortRows(this.list.filter((t) => !term || String(t.name).toLowerCase().includes(term) || String(t.username).includes(term)), this.sort, { value: (t, k) => VALUE[k](t) });
    this.$("count").textContent = pluralize(this.list.length, "teacher");
    paintSortHeaders(this.el.querySelector(".teacher-table"), this.sort);
    this.$("body").innerHTML = rows.map((t) => {
      const uid = escapeHtml(t.uid);
      const disabled = t.status === "disabled";
      const classes = Object.entries(cleanClasses(t.classes)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
      return `<tr class="${disabled ? "row-muted" : ""}">
        <td class="name-cell"><b>${escapeHtml(t.name)}</b></td>
        <td><code>${escapeHtml(t.username)}</code></td>
        <td>${classes.length ? classes.map(([g, secs]) => `<div class="small"><b>Grade ${escapeHtml(g)}:</b> ${escapeHtml(sectionsText(teacher.settings, g, secs))}</div>`).join("") : '<span class="small muted">None</span>'}</td>
        <td>${disabled ? '<span class="badge">Deactivated</span>' : '<span class="badge badge-success">Active</span>'}</td>
        <td class="small nowrap" title="${escapeHtml(formatDateTime(t.createdAt))}">${escapeHtml(formatDate(t.createdAt))}</td>
        <td class="actions-cell">
          <button type="button" class="btn btn-small" data-row="edit" data-uid="${uid}">Edit</button>
          <details class="menu menu-right">
            <summary class="btn btn-small" aria-label="More actions for ${escapeHtml(t.name)}">⋯</summary>
            <div class="menu-list">
              <button type="button" data-row="username" data-uid="${uid}" data-icon="at">Change username</button>
              <button type="button" data-row="password" data-uid="${uid}" data-icon="key">Reset password</button>
              <button type="button" data-row="status" data-uid="${uid}" data-icon="${disabled ? "user-check" : "user-slash"}">${disabled ? "Activate account" : "Deactivate account"}</button>
              <button type="button" data-row="delete" data-uid="${uid}" class="danger">Delete teacher…</button>
            </div>
          </details>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">${this.list.length ? "No teacher matches this search." : "No teachers yet. Add one above."}</td></tr>`;
  }

  setError(key, msg, root = this.el) {
    const box = root.querySelector(`[data-err="${key}"]`);
    if (box) { box.textContent = msg || ""; box.hidden = !msg; }
  }

  async create() {
    const name = normalizeName(this.el.querySelector("#tName").value);
    const username = this.el.querySelector("#tUser").value.trim().toLowerCase();
    const password = this.el.querySelector("#tPass").value;
    const classes = readClassPicker(this.$("picker"));
    const errs = {
      name: name.length < 2 ? "Enter the teacher's full name." : "",
      username: usernameProblem(username),
      password: passwordProblem(password),
      classes: Object.keys(classes).length ? "" : "Tick at least one section."
    };
    Object.entries(errs).forEach(([k, v]) => this.setError(k, v));
    if (Object.values(errs).some(Boolean)) return;
    const btn = this.$("create");
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      if ((await getDoc(doc(db, "usernames", username))).exists()) { this.setError("username", "This username is already taken."); return; }
      const email = randomEmail();
      const uid = await createAuthAccount(email, password);
      const batch = writeBatch(db);
      batch.set(doc(db, "teachers", uid), {
        role: "teacher", teacherId: uid, name, username, email, classes, status: "active",
        createdAt: serverTimestamp(), createdBy: session.teacherId, updatedAt: serverTimestamp()
      });
      batch.set(doc(db, "usernames", username), { email, teacherId: uid, uid });
      await batch.commit();
      logActivity("teacher_created", `Created teacher ${name} (${username}): ${classesLabel(classes)}`, uid);
      this.el.querySelector("#tName").value = "";
      this.el.querySelector("#tUser").value = "";
      this.el.querySelector("#tPass").value = "";
      this.renderPicker();
      this.$("picker").querySelectorAll("input").forEach((b) => { b.checked = false; });
      appNotice(`Teacher ${name} was created. They sign in with the username "${username}" and the password you set.`, "success");
      await this.load();
    } catch (err) {
      console.error(err);
      const msg = err?.code === "auth/weak-password" ? "Firebase rejected this password as too weak. Choose a longer one."
        : err?.code === "auth/operation-not-allowed" ? "Email/Password sign-in is not enabled in Firebase. See the README."
          : friendlyError(err);
      appNotice(`The teacher was not created. ${msg}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Create teacher";
    }
  }

  async onRowClick(e) {
    const btn = e.target.closest("button[data-row]");
    if (!btn) return;
    btn.closest("details")?.removeAttribute("open");
    const t = this.list.find((x) => x.uid === btn.dataset.uid);
    if (!t) return;
    try {
      switch (btn.dataset.row) {
        case "edit": await this.edit(t); break;
        case "username": await this.changeUsername(t); break;
        case "password": await this.resetPassword(t); break;
        case "status": await this.toggleStatus(t); break;
        case "delete": await this.remove(t); break;
        default:
      }
    } catch (err) {
      console.error(err);
      appNotice(`The change was not saved. ${friendlyError(err)}`, "error");
    }
  }

  async edit(t) {
    const values = await formModal({
      title: `Edit ${t.name}`,
      okText: "Save",
      body: `
        <div class="field"><label for="etName">Name</label><input type="text" id="etName" maxlength="80"><div class="error-text" data-err="name" hidden></div></div>
        <div class="field"><span class="label">Grades and sections</span>${classPickerHtml(teacher.settings, cleanClasses(t.classes), "ep")}<div class="error-text" data-err="classes" hidden></div>
        <p class="small muted">Sections that are no longer in School settings are dropped when you save.</p></div>`,
      onOpen: (root) => { root.querySelector("#etName").value = t.name || ""; root.querySelector("#etName").focus(); },
      collect: (root) => {
        const name = normalizeName(root.querySelector("#etName").value);
        const classes = readClassPicker(root, "ep");
        const errs = { name: name.length < 2 ? "Enter the teacher's full name." : "", classes: Object.keys(classes).length ? "" : "Tick at least one section." };
        Object.entries(errs).forEach(([k, v]) => this.setError(k, v, root));
        return Object.values(errs).some(Boolean) ? null : { name, classes };
      }
    });
    if (!values) return;
    const batch = writeBatch(db);
    batch.update(doc(db, "teachers", t.uid), { name: values.name, classes: values.classes, updatedAt: serverTimestamp() });
    await batch.commit();
    logActivity("teacher_updated", `Updated ${values.name}: ${classesLabel(values.classes)}`, t.teacherId);
    appNotice(`Saved ${values.name}.`, "success");
    await this.load();
  }

  async changeUsername(t) {
    const values = await formModal({
      title: `Change username of ${t.name}`,
      okText: "Change username",
      body: `<div class="field"><label for="euName">New username</label><input type="text" id="euName" maxlength="30" autocapitalize="none" spellcheck="false"><div class="error-text" data-err="username" hidden></div></div>
        <p class="small muted">The password stays the same. Tell the teacher their new username.</p>`,
      onOpen: (root) => { const i = root.querySelector("#euName"); i.value = t.username; i.select(); i.addEventListener("input", () => { i.value = i.value.toLowerCase().replace(/\s+/g, ""); }); },
      collect: (root) => {
        const username = root.querySelector("#euName").value.trim().toLowerCase();
        const err = usernameProblem(username) || (username === t.username ? "This is the current username." : "");
        this.setError("username", err, root);
        return err ? null : { username };
      }
    });
    if (!values) return;
    if ((await getDoc(doc(db, "usernames", values.username))).exists()) { appNotice(`The username "${values.username}" is already taken.`, "error"); return; }
    const batch = writeBatch(db);
    batch.set(doc(db, "usernames", values.username), { email: t.email, teacherId: t.teacherId, uid: t.uid });
    batch.delete(doc(db, "usernames", t.username));
    batch.update(doc(db, "teachers", t.uid), { username: values.username, updatedAt: serverTimestamp() });
    await batch.commit();
    logActivity("teacher_username", `Changed username of ${t.name}: ${t.username} → ${values.username}`, t.teacherId);
    appNotice(`${t.name} now signs in as "${values.username}".`, "success");
    await this.load();
  }

  async resetPassword(t) {
    const values = await formModal({
      title: `Reset password of ${t.name}`,
      okText: "Set new password",
      body: `<div class="field"><label for="epPass">New password</label><input type="text" id="epPass" maxlength="64" autocomplete="new-password"><div class="error-text" data-err="password" hidden></div></div>
        <p class="small muted">The old password stops working right away. Their quizzes and records are kept.</p>`,
      onOpen: (root) => root.querySelector("#epPass").focus(),
      collect: (root) => {
        const password = root.querySelector("#epPass").value;
        const err = passwordProblem(password);
        this.setError("password", err, root);
        return err ? null : { password };
      }
    });
    if (!values) return;
    appNotice("Setting the new password…", "info");
    const email = randomEmail();
    const newUid = await createAuthAccount(email, values.password);
    const { uid: _old, ...profile } = t; // eslint-disable-line no-unused-vars
    const batch = writeBatch(db);
    batch.set(doc(db, "teachers", newUid), { ...profile, email, updatedAt: serverTimestamp(), passwordResetAt: serverTimestamp() });
    batch.set(doc(db, "usernames", t.username), { email, teacherId: t.teacherId, uid: newUid });
    batch.delete(doc(db, "teachers", t.uid));
    await batch.commit();
    logActivity("teacher_password", `Reset the password of ${t.name}`, t.teacherId);
    appNotice(`New password set for ${t.name}. They sign in with "${t.username}" and the new password.`, "success");
    await this.load();
  }

  async toggleStatus(t) {
    const disabling = t.status !== "disabled";
    const ok = await confirmDialog({
      title: disabling ? `Deactivate ${t.name}?` : `Activate ${t.name}?`,
      text: disabling ? "They can no longer sign in or see any records. Their quizzes and records are kept. You can activate the account again later." : "They can sign in again with their current username and password.",
      okText: disabling ? "Deactivate" : "Activate",
      danger: disabling
    });
    if (!ok) return;
    const batch = writeBatch(db);
    batch.update(doc(db, "teachers", t.uid), { status: disabling ? "disabled" : "active", updatedAt: serverTimestamp() });
    await batch.commit();
    logActivity(disabling ? "teacher_deactivated" : "teacher_activated", `${disabling ? "Deactivated" : "Activated"} ${t.name}`, t.teacherId);
    appNotice(`${t.name} was ${disabling ? "deactivated" : "activated"}.`, "success");
    await this.load();
  }

  async remove(t) {
    const owned = [...teacher.quizzes.values()].filter((q) => q.ownerId === t.teacherId);
    const res = await confirmDialog({
      title: `Delete ${t.name}?`,
      text: `Their login stops working. Quizzes, results and student records are NOT deleted.${owned.length ? ` They own ${pluralize(owned.length, "quiz", "quizzes")}.` : ""}`,
      okText: "Delete teacher",
      danger: true,
      option: owned.length ? { label: "Make the Admin the owner of their quizzes", checked: true } : null,
      check: `Yes, delete ${t.name}`
    });
    if (!res) return;
    const batch = writeBatch(db);
    batch.delete(doc(db, "teachers", t.uid));
    batch.delete(doc(db, "usernames", t.username));
    if (res.option) owned.forEach((q) => batch.update(doc(db, "quizzes", q.id), {
      ownerId: session.teacherId, ownerRole: "admin", ownerName: session.name || "Admin", previousOwner: t.name, updatedAt: serverTimestamp()
    }));
    await batch.commit();
    logActivity("teacher_deleted", `Deleted teacher ${t.name} (${t.username})${res.option && owned.length ? `; ${owned.length} quizzes moved to the Admin` : ""}`, t.teacherId);
    appNotice(`${t.name} was deleted. Their quizzes and records are kept.`, "success");
    if (res.option && owned.length) await reloadQuizzes().catch(() => {});
    await this.load();
  }
}
