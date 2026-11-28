// Page navigation shared by the dashboard tables (Results, Archive, Quizzes,
// Student record): "1–30 of 321", a records-per-page box, and
// First / Previous / page numbers / Next / Last.
//
// pagerHtml({ page, size, total, reachable, sizeKey }) returns the markup.
// page is 0-based. reachable is the last page index that can be opened
// directly (pages read from Firestore one after another can only be opened
// up to the next one); it defaults to the last page. Buttons carry
// data-page="<index>"; the per-page box is a <select data-page-size>.
//
// The chosen page size is remembered per table on this device (sizeKey).

import { escapeHtml, storage } from "./utilities.js";

export const PAGE_SIZES = [30, 40, 50, 100, 150];
export const DEFAULT_PAGE_SIZE = 30;
/** Kept for older imports: the default number of rows per page. */
export const PAGE_SIZE = DEFAULT_PAGE_SIZE;

const sizeStoreKey = (key) => `ees_page_size_${key}`;

/** The page size chosen for one table (30 by default). */
export function getPageSize(key) {
  const n = Number(storage.get(sizeStoreKey(key)));
  return PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
}

export function setPageSize(key, n) {
  n = Number(n);
  if (PAGE_SIZES.includes(n)) storage.set(sizeStoreKey(key), n);
  return getPageSize(key);
}

/**
 * The page that keeps the first row of the current page in view after the
 * page size changes (so the reader does not lose their place).
 */
export function pageAfterResize(page, oldSize, newSize, total) {
  const first = page * oldSize;
  return clampPage(Math.floor(first / newSize), total, newSize);
}

export function pageCount(total, size = DEFAULT_PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / size));
}

export function pageSlice(rows, page, size = DEFAULT_PAGE_SIZE) {
  return rows.slice(page * size, page * size + size);
}

/** Keeps a page index inside 0..pages-1. */
export function clampPage(page, total, size = DEFAULT_PAGE_SIZE) {
  return Math.min(Math.max(0, page), pageCount(total, size) - 1);
}

function sizeSelect(size, label) {
  return `<label class="pager-size small muted"><span>Show</span>
    <select data-page-size aria-label="${escapeHtml(label)} per page">${PAGE_SIZES.map((n) => `<option value="${n}"${n === size ? " selected" : ""}>${n} ${escapeHtml(label)}</option>`).join("")}</select></label>`;
}

export function pagerHtml({ page, size = DEFAULT_PAGE_SIZE, total, reachable = null, label = "records", sizeKey = "" }) {
  // Nothing to page and nothing to choose: no bar at all.
  if (total <= (sizeKey ? PAGE_SIZES[0] : size)) return "";
  const pages = pageCount(total, size);
  const last = pages - 1;
  const maxOpen = reachable === null ? last : Math.min(reachable, last);
  const from = page * size + 1;
  const to = Math.min(total, from + size - 1);
  const info = `<span class="pager-info small muted">${from}–${to} of ${total} ${escapeHtml(label)}</span>`;
  const sizeBox = sizeKey ? sizeSelect(size, label) : "";
  if (total <= size) {
    return `<nav class="pager" aria-label="Pages"><div class="pager-left">${info}${sizeBox}</div></nav>`;
  }
  const btn = (target, text, aria, extra = "") =>
    `<button type="button" class="btn btn-small pager-btn${extra}" data-page="${target}" aria-label="${escapeHtml(aria)}"${target < 0 || target > maxOpen || target === page ? " disabled" : ""}>${text}</button>`;
  // Up to 5 numbered pages around the current one.
  let start = Math.max(0, Math.min(page - 2, last - 4));
  const end = Math.min(last, start + 4);
  start = Math.max(0, end - 4);
  const nums = [];
  for (let i = start; i <= end; i++) {
    nums.push(i === page
      ? `<span class="pager-num current" aria-current="page">${i + 1}</span>`
      : btn(i, String(i + 1), `Page ${i + 1}`, " pager-num"));
  }
  return `<nav class="pager" aria-label="Pages">
    <div class="pager-left">${info}${sizeBox}</div>
    <div class="pager-btns">
      ${btn(0, "«", "First page", " is-icon-only")}
      ${btn(page - 1, "‹ Previous", "Previous page")}
      ${nums.join("")}
      ${btn(page + 1, "Next ›", "Next page")}
      ${reachable === null ? btn(last, "»", "Last page", " is-icon-only") : ""}
    </div>
  </nav>`;
}
