// Page navigation shared by the dashboard tables (Results, Archive, Quizzes,
// Student history): "1–50 of 321", First / Previous / page numbers / Next / Last.
//
// pagerHtml({ page, size, total, reachable }) returns the markup. page is 0-based.
// reachable is the last page index that can be opened directly (pages read
// from Firestore one after another can only be opened up to the next one);
// it defaults to the last page. Buttons carry data-page="<index>".

import { escapeHtml } from "./utilities.js";

export const PAGE_SIZE = 50;

export function pageCount(total, size = PAGE_SIZE) {
  return Math.max(1, Math.ceil(total / size));
}

export function pageSlice(rows, page, size = PAGE_SIZE) {
  return rows.slice(page * size, page * size + size);
}

/** Keeps a page index inside 0..pages-1. */
export function clampPage(page, total, size = PAGE_SIZE) {
  return Math.min(Math.max(0, page), pageCount(total, size) - 1);
}

export function pagerHtml({ page, size = PAGE_SIZE, total, reachable = null, label = "records" }) {
  const pages = pageCount(total, size);
  if (total <= size) return "";
  const last = pages - 1;
  const maxOpen = reachable === null ? last : Math.min(reachable, last);
  const from = page * size + 1;
  const to = Math.min(total, from + size - 1);
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
    <span class="pager-info small muted">${from}–${to} of ${total} ${escapeHtml(label)}</span>
    <div class="pager-btns">
      ${btn(0, "«", "First page", " is-icon-only")}
      ${btn(page - 1, "‹ Previous", "Previous page")}
      ${nums.join("")}
      ${btn(page + 1, "Next ›", "Next page")}
      ${reachable === null ? btn(last, "»", "Last page", " is-icon-only") : ""}
    </div>
  </nav>`;
}
