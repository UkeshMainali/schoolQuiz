// Requests: teachers ask the Admin for operations they cannot do themselves
// (correct a name, delete a record, print or export records, ...).
//
//   requests/{id}  teacherId, teacherName, type, studentId/studentName, grade,
//                  section, rollNo, recordIds, details, reason, status, createdAt
//                  + adminNote, decidedAt/By, grant, completedAt/By
//
// Status: pending -> approved | declined -> completed.
// Approving does NOT give the teacher the feature. The Admin either does the
// operation (Do it now / Open student record, then Mark completed) or grants
// a one-time permission for printing or exporting exactly those records,
// which the teacher uses once from this page. Every decision is logged.

import {
  db, doc, getDocs, collection, query, where, writeBatch, serverTimestamp, addDoc, Timestamp, onSnapshot
} from "./firebase.js";
import { logActivity } from "./auth.js";
import { session, isAdmin } from "./roles.js";
import { fetchRecordsByIds, fetchStudentRecords, archiveRecords, deleteRecords } from "./records.js";
import { toRow } from "./recordsView.js";
import { summaryCsv, buildBackup } from "./backup.js";
import { buildReport, printHtml } from "./print.js";
import { directory } from "./students.js";
import { teacher, appNotice } from "./teacherState.js";
import { escapeHtml, friendlyError, formatDateTime, confirmDialog, downloadFile, pluralize, skeletonRows, formModal } from "./utilities.js";
import { sortRows, nextSort, paintSortHeaders } from "./tableSort.js";

export const TYPES = {
  rename_student: "Correct a student's name",
  edit_student: "Change a student's grade, section or roll number",
  delete_student: "Delete a student record",
  print_records: "Print records",
  export_records: "Export records",
  archive_records: "Archive records",
  delete_records: "Delete records",
  other: "Something else"
};
const GRANTABLE = ["print_records", "export_records"];
const STATUS = {
  pending: '<span class="badge badge-warning">Pending</span>',
  approved: '<span class="badge badge-info">Approved</span>',
  declined: '<span class="badge badge-danger-outline">Declined</span>',
  completed: '<span class="badge badge-success">Completed</span>'
};
const GRANT_DAYS = 7;

export const requestsState = { list: [], loaded: false, listeners: new Set() };
const notify = () => requestsState.listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });

/** Teacher: their own requests. Admin: every request. */
export async function loadRequests() {
  const q = isAdmin() ? collection(db, "requests") : query(collection(db, "requests"), where("teacherId", "==", session.teacherId));
  const snap = await getDocs(q);
  requestsState.list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  requestsState.loaded = true;
  notify();
  return requestsState.list;
}

/** Same as loadRequests, but keeps the list up to date (new requests and decisions show at once). */
let requestsUnsub = null;
export function watchRequests() {
  if (requestsUnsub) return Promise.resolve(requestsState.list);
  const q = isAdmin() ? collection(db, "requests") : query(collection(db, "requests"), where("teacherId", "==", session.teacherId));
  return new Promise((resolve, reject) => {
    let first = true;
    requestsUnsub = onSnapshot(q, (snap) => {
      requestsState.list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      requestsState.loaded = true;
      notify();
      if (first) { first = false; resolve(requestsState.list); }
    }, (err) => {
      requestsUnsub = null;
      if (first) { first = false; reject(err); } else console.warn("Live requests stopped", err);
    });
  });
}

export const pendingCount = () => requestsState.list.filter((r) => r.status === "pending").length;

/**
 * Opens the "Request from the Admin" form.
 *   types:   allowed request types (first is selected)
 *   student: { id, name, grade, section, rollNo } (optional)
 *   records: [{ id, studentName, quizTitle }] (optional)
 */
export async function openRequestDialog({ types = Object.keys(TYPES), student = null, records = [], intro = "" } = {}) {
  const about = student
    ? `${student.name} · Roll ${student.rollNo} · Grade ${student.grade} · Section ${student.section}`
    : records.length ? `${pluralize(records.length, "record")}: ${records.slice(0, 3).map((r) => `${r.studentName} (${r.quizTitle})`).join(", ")}${records.length > 3 ? "…" : ""}` : "";
  const values = await formModal({
    title: "Request from the Admin",
    okText: "Send request",
    body: `
      <p class="small muted">${escapeHtml(intro || "You don't have permission to do this yourself. The Admin will review your request.")}</p>
      ${about ? `<p class="request-about"><b>${escapeHtml(about)}</b></p>` : ""}
      <div class="field"><label for="rqType">What do you need?</label>
        <select id="rqType">${types.map((t) => `<option value="${t}">${escapeHtml(TYPES[t])}</option>`).join("")}</select></div>
      <div class="field"><label for="rqDetails">Details <span class="muted">(e.g. the correct name)</span></label><input type="text" id="rqDetails" maxlength="300" autocomplete="off"></div>
      <div class="field"><label for="rqReason">Reason</label><textarea id="rqReason" rows="3" maxlength="500"></textarea><div class="error-text" data-err="reason" hidden></div></div>`,
    onOpen: (root) => root.querySelector("#rqDetails").focus(),
    collect: (root) => {
      const reason = root.querySelector("#rqReason").value.trim();
      const box = root.querySelector('[data-err="reason"]');
      const err = reason.length < 3 ? "Please give a short reason." : "";
      box.textContent = err; box.hidden = !err;
      return err ? null : { type: root.querySelector("#rqType").value, details: root.querySelector("#rqDetails").value.trim(), reason };
    }
  });
  if (!values) return null;
  try {
    const data = {
      teacherId: session.teacherId, teacherUid: session.uid, teacherName: session.name,
      type: values.type, details: values.details, reason: values.reason,
      studentId: student?.id || "", studentName: student?.name || (records[0]?.studentName ?? ""),
      grade: student?.grade || (records[0]?.grade ?? ""), section: student?.section || (records[0]?.section ?? ""),
      rollNo: student?.rollNo || (records.length === 1 ? records[0].rollNo : ""),
      recordIds: records.map((r) => r.id).slice(0, 200),
      status: "pending", createdAt: serverTimestamp()
    };
    const ref = await addDoc(collection(db, "requests"), data);
    requestsState.list.unshift({ id: ref.id, ...data, createdAt: new Date() });
    notify();
    appNotice("Your request was sent to the Admin. You can follow it on the Requests page.", "success");
    return ref.id;
  } catch (err) {
    console.error(err);
    appNotice(`The request was not sent. ${friendlyError(err)}`, "error");
    return null;
  }
}

async function updateRequest(req, changes) {
  const batch = writeBatch(db);
  batch.update(doc(db, "requests", req.id), changes);
  await batch.commit();
  Object.assign(req, changes, Object.fromEntries(Object.keys(changes).filter((k) => k.endsWith("At")).map((k) => [k, new Date()])));
  notify();
}

/** The records a request is about, as dashboard rows. */
async function requestRows(req) {
  let recs;
  if (req.recordIds?.length) recs = await fetchRecordsByIds(req.recordIds);
  else if (req.studentId || req.rollNo) {
    const student = directory.byId.get(req.studentId) || { id: req.studentId, grade: req.grade, section: req.section, rollNo: req.rollNo };
    recs = (await fetchStudentRecords(student)).filter((r) => r.source === "active");
  } else recs = [];
  return recs.map((r) => toRow(r.attempt, r.result, false));
}

async function printRows(rows, title) {
  if (!rows.length) { appNotice("There are no records to print.", "info"); return false; }
  appNotice("Preparing the report…", "info");
  const html = await buildReport(rows.map((r) => ({ id: r.id, attempt: r.attempt, result: r.result })), {
    title, quizzes: teacher.quizzes, passPercent: teacher.settings.passPercent, includeAnswers: rows.length === 1
  });
  printHtml(html);
  appNotice('Report ready. Choose "Save as PDF" in the print dialog for one combined PDF.', "success");
  return true;
}

function exportRows(rows, stem) {
  if (!rows.length) { appNotice("There are no records to export.", "info"); return false; }
  downloadFile(`${stem}_${new Date().toISOString().slice(0, 10)}.csv`.replace(/[^A-Za-z0-9_.-]+/g, "-"), summaryCsv(rows));
  appNotice(`Exported ${pluralize(rows.length, "record")}.`, "success");
  return true;
}

const grantActive = (r) => r.status === "approved" && r.grant && (!r.grant.expiresAt?.toMillis || r.grant.expiresAt.toMillis() > Date.now());

export class RequestsView {
  constructor(container, { openStudent } = {}) {
    this.el = container;
    this.openStudent = openStudent;
    this.filter = isAdmin() ? "pending" : "";
    this.sort = { key: "created", dir: "desc" };
    this.el.innerHTML = `
      ${isAdmin() ? "" : `<div class="card"><div class="card-head"><div><h2>Ask the Admin</h2><p class="card-sub">For things only the Admin can do, such as correcting a student's name or printing records.</p></div>
        <button type="button" class="btn btn-primary" data-r="new" data-icon="paper-plane">New request</button></div></div>`}
      <div class="card table-card">
        <div class="card-head">
          <div><h2>${isAdmin() ? "Teacher requests" : "My requests"}</h2><span class="muted small" data-r="count"></span></div>
          <div class="filters inline-filters">
            <select data-r="filter" aria-label="Status">
              <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="declined">Declined</option><option value="completed">Completed</option>
            </select>
            <button type="button" class="btn btn-small" data-r="refresh">Refresh</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data-table requests-table">
            <thead><tr>
              <th data-sort="created">Submitted</th>${isAdmin() ? '<th data-sort="teacher">Teacher</th>' : ""}<th data-sort="type">Request</th>
              <th data-sort="student">Student / records</th><th>Reason</th><th data-sort="status">Status</th><th class="actions-col">Actions</th>
            </tr></thead>
            <tbody data-r="body"></tbody>
          </table>
        </div>
      </div>`;
    this.$ = (k) => this.el.querySelector(`[data-r="${k}"]`);
    this.$("filter").value = this.filter;
    this.$("filter").addEventListener("change", (e) => { this.filter = e.target.value; this.render(); });
    this.$("refresh").addEventListener("click", () => this.load());
    this.$("new")?.addEventListener("click", () => openRequestDialog());
    this.el.querySelector(".requests-table thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      this.sort = nextSort(this.sort, th.dataset.sort, ["created"]);
      this.render();
    });
    this.$("body").addEventListener("click", (e) => this.onClick(e));
    document.addEventListener("click", (e) => {
      this.el.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
    });
    requestsState.listeners.add(() => { if (this.shown) this.render(); });
  }

  show() {
    this.shown = true;
    if (!requestsState.loaded) this.load(); else this.render();
  }

  async load() {
    this.$("body").innerHTML = skeletonRows(isAdmin() ? 7 : 6, 4);
    try { await loadRequests(); } catch (err) { console.error(err); this.$("body").innerHTML = ""; appNotice(`Could not load requests. ${friendlyError(err)}`, "error"); }
  }

  render() {
    const list = requestsState.list.filter((r) => !this.filter || r.status === this.filter);
    const value = {
      created: (r) => r.createdAt?.toMillis?.() ?? (r.createdAt instanceof Date ? r.createdAt.getTime() : 0),
      teacher: (r) => r.teacherName, type: (r) => TYPES[r.type] || r.type, student: (r) => r.studentName,
      status: (r) => ["pending", "approved", "declined", "completed"].indexOf(r.status)
    };
    const rows = sortRows(list, this.sort, { value: (r, k) => value[k](r) });
    const pend = pendingCount();
    this.$("count").textContent = `${pluralize(requestsState.list.length, "request")}${pend ? ` · ${pend} pending` : ""}`;
    paintSortHeaders(this.el.querySelector(".requests-table"), this.sort);
    const cols = isAdmin() ? 7 : 6;
    this.$("body").innerHTML = rows.map((r) => {
      const id = escapeHtml(r.id);
      const who = r.studentName ? `${escapeHtml(r.studentName)}${r.rollNo ? `<div class="small muted">Roll ${escapeHtml(r.rollNo)} · Grade ${escapeHtml(r.grade)} · ${escapeHtml(r.section)}</div>` : ""}` : "";
      const recs = r.recordIds?.length ? `<div class="small muted">${pluralize(r.recordIds.length, "record")}</div>` : "";
      const decided = r.decidedAt ? `<div class="small muted">${escapeHtml(formatDateTime(r.decidedAt))}</div>` : "";
      const note = r.adminNote ? `<div class="small">Admin: ${escapeHtml(r.adminNote)}</div>` : "";
      const grant = r.grant ? `<div class="small muted">${grantActive(r) ? `One-time permission until ${escapeHtml(formatDateTime(r.grant.expiresAt))}` : r.status === "approved" ? "Permission expired" : "Permission used"}</div>` : "";
      return `<tr>
        <td class="small nowrap">${escapeHtml(formatDateTime(r.createdAt))}</td>
        ${isAdmin() ? `<td>${escapeHtml(r.teacherName)}</td>` : ""}
        <td><b>${escapeHtml(TYPES[r.type] || r.type)}</b>${r.details ? `<div class="small">${escapeHtml(r.details)}</div>` : ""}</td>
        <td>${who}${recs}</td>
        <td class="small">${escapeHtml(r.reason)}</td>
        <td>${STATUS[r.status] || escapeHtml(r.status)}${decided}${note}${grant}</td>
        <td class="actions-cell">${this.actions(r, id)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="${cols}" class="empty">${requestsState.list.length ? "No requests with this status." : isAdmin() ? "No requests from teachers yet." : "You have not sent any requests."}</td></tr>`;
  }

  actions(r, id) {
    const b = (act, label, cls = "") => `<button type="button" class="btn btn-small ${cls}" data-act="${act}" data-id="${id}">${label}</button>`;
    const m = (act, label, cls = "") => `<button type="button" data-act="${act}" data-id="${id}" class="${cls}">${label}</button>`;
    if (!isAdmin()) {
      if (grantActive(r) && r.grant.type === "print_records") return b("use-print", "Print now", "btn-primary");
      if (grantActive(r) && r.grant.type === "export_records") return b("use-export", "Download CSV", "btn-primary");
      return "";
    }
    const more = [];
    if (r.studentId && directory.byId.has(r.studentId)) more.push(m("open-student", "Open student record"));
    if (r.recordIds?.length || r.studentId || r.rollNo) {
      if (r.type === "print_records") more.push(m("do-print", "Print the records now"));
      if (r.type === "export_records") more.push(m("do-export", "Export the records now"));
      if (r.type === "archive_records") more.push(m("do-archive", "Archive the records now"));
      if (r.type === "delete_records") more.push(m("do-delete", "Delete the records now…", "danger"));
    }
    if (r.status === "pending") {
      return `${b("approve", "Approve", "btn-primary")}${b("decline", "Decline")}
        <details class="menu menu-right"><summary class="btn btn-small" aria-label="More actions">⋯</summary><div class="menu-list">
          ${GRANTABLE.includes(r.type) ? m("grant", "Approve with one-time permission") : ""}${more.join("")}</div></details>`;
    }
    if (r.status === "approved") {
      return `${b("complete", "Mark completed")}${more.length ? `<details class="menu menu-right"><summary class="btn btn-small" aria-label="More actions">⋯</summary><div class="menu-list">${more.join("")}</div></details>` : ""}`;
    }
    return more.length ? `<details class="menu menu-right"><summary class="btn btn-small" aria-label="More actions">⋯</summary><div class="menu-list">${more.join("")}</div></details>` : "";
  }

  async onClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    btn.closest("details")?.removeAttribute("open");
    const r = requestsState.list.find((x) => x.id === btn.dataset.id);
    if (!r) return;
    btn.disabled = true;
    try {
      await this.run(btn.dataset.act, r);
    } catch (err) {
      console.error(err);
      appNotice(`The action did not finish. ${friendlyError(err)}`, "error");
    } finally {
      btn.disabled = false;
    }
  }

  async decide(r, status, extra = {}) {
    let note = "";
    if (status === "declined" || status === "approved") {
      const v = await formModal({
        title: status === "declined" ? "Decline this request?" : extra.grant ? "Approve with a one-time permission?" : "Approve this request?",
        okText: status === "declined" ? "Decline" : "Approve",
        danger: status === "declined",
        body: `<p class="small muted">${status === "declined" ? "The teacher sees your note." : extra.grant ? `The teacher can ${r.type === "print_records" ? "print" : "export"} these records once, within ${GRANT_DAYS} days. Nothing else changes.` : "Approving does not give the teacher any new access. Do the operation yourself, then mark the request completed."}</p>
          <div class="field"><label for="rqNote">Note for the teacher (optional)</label><input type="text" id="rqNote" maxlength="300"></div>`,
        onOpen: (root) => root.querySelector("#rqNote").focus(),
        collect: (root) => ({ note: root.querySelector("#rqNote").value.trim() })
      });
      if (!v) return;
      note = v.note;
    }
    await updateRequest(r, { status, adminNote: note, decidedAt: serverTimestamp(), decidedBy: session.name || "Admin", ...extra });
    logActivity(`request_${status}`, `${status === "approved" ? "Approved" : "Declined"} request from ${r.teacherName}: ${TYPES[r.type] || r.type}${r.studentName ? ` (${r.studentName})` : ""}${extra.grant ? " with a one-time permission" : ""}`, r.id);
    appNotice(`Request ${status}.`, "success");
  }

  async complete(r, text) {
    await updateRequest(r, { status: "completed", completedAt: serverTimestamp(), completedBy: session.name || "Admin" });
    logActivity("request_completed", text || `Completed request from ${r.teacherName}: ${TYPES[r.type] || r.type}${r.studentName ? ` (${r.studentName})` : ""}`, r.id);
  }

  async run(act, r) {
    switch (act) {
      case "approve": return this.decide(r, "approved");
      case "decline": return this.decide(r, "declined");
      case "grant": return this.decide(r, "approved", {
        grant: { type: r.type, studentId: r.studentId || "", recordIds: r.recordIds || [], expiresAt: Timestamp.fromMillis(Date.now() + GRANT_DAYS * 86400000) }
      });
      case "complete": await this.complete(r); appNotice("Marked as completed.", "success"); return undefined;
      case "open-student": return this.openStudent?.(directory.byId.get(r.studentId));
      case "do-print": {
        if (await printRows(await requestRows(r), "Student records")) await this.complete(r, `Printed records for ${r.teacherName}'s request${r.studentName ? ` (${r.studentName})` : ""}`);
        return undefined;
      }
      case "do-export": {
        if (exportRows(await requestRows(r), `records_${r.studentName || "request"}`)) await this.complete(r, `Exported records for ${r.teacherName}'s request${r.studentName ? ` (${r.studentName})` : ""}`);
        return undefined;
      }
      case "do-archive": {
        const rows = await requestRows(r);
        if (!rows.length) { appNotice("These records are no longer in Results.", "info"); return undefined; }
        const ok = await confirmDialog({ title: `Archive ${pluralize(rows.length, "record")}?`, text: "They move to the Archive. You can restore them later.", okText: "Archive" });
        if (!ok) return undefined;
        await archiveRecords(rows.map((x) => ({ id: x.id, attempt: x.attempt, result: x.result })));
        await this.complete(r, `Archived ${pluralize(rows.length, "record")} for ${r.teacherName}'s request`);
        appNotice(`Archived ${pluralize(rows.length, "record")} and marked the request completed.`, "success");
        return undefined;
      }
      case "do-delete": {
        const rows = await requestRows(r);
        if (!rows.length) { appNotice("These records are no longer in Results.", "info"); return undefined; }
        const res = await confirmDialog({
          title: `Delete ${pluralize(rows.length, "record")}?`, text: "This permanently deletes them. It cannot be undone.",
          okText: "Delete", danger: true, option: { label: "Download a backup file first (recommended)", checked: true }, check: `Yes, delete ${pluralize(rows.length, "record")}`
        });
        if (!res) return undefined;
        if (res.option) downloadFile(`request_${r.id}_backup.json`, buildBackup(rows.map((x) => ({ id: x.id, attempt: x.attempt, result: x.result })), "active"), "application/json");
        await deleteRecords("active", rows);
        await this.complete(r, `Deleted ${pluralize(rows.length, "record")} for ${r.teacherName}'s request`);
        appNotice(`Deleted ${pluralize(rows.length, "record")} and marked the request completed.`, "success");
        return undefined;
      }
      case "use-print": case "use-export": {
        const rows = await requestRows({ ...r, recordIds: r.grant.recordIds, studentId: r.grant.studentId || r.studentId });
        const done = act === "use-print" ? await printRows(rows, "Student records") : exportRows(rows, `records_${r.studentName || "request"}`);
        if (done) await updateRequest(r, { status: "completed", completedAt: serverTimestamp(), completedBy: session.name });
        return undefined;
      }
      default: return undefined;
    }
  }
}
