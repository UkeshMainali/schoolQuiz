// Shared column sorting for the dashboard tables (Results, Archive, Quizzes,
// Student history). One implementation, so every table sorts the same way:
//
//  - Header cells with data-sort="key" are clickable (and keyboard-operable).
//    Clicking a new column sorts it ascending (or descending for columns where
//    "highest first" is more useful); clicking it again reverses the order.
//  - Rows are sorted as data, before rendering, so the order always applies to
//    the complete filtered list, not just to the rows on screen.
//  - Numbers compare as numbers, dates should be passed as milliseconds, text
//    compares naturally ("Lesson 2" before "Lesson 10", case-insensitive).
//  - Missing values (empty, null, not a number) always go last, whichever
//    direction is chosen.

const isMissing = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

/** Compares two values in ascending order, missing values last. */
export function compareValues(x, y) {
  const xm = isMissing(x), ym = isMissing(y);
  if (xm || ym) return xm && ym ? 0 : xm ? 1 : -1;
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Returns a sorted copy of rows. sort = { key, dir: "asc" | "desc" }.
 * value(row, key) reads the sort value (default: row[key]).
 * tieBreak(a, b) orders rows with equal values (stable, ascending).
 */
export function sortRows(rows, sort, { value = (r, k) => r[k], tieBreak = null } = {}) {
  const d = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: value(row, sort.key) }))
    .sort((a, b) => {
      const am = isMissing(a.v), bm = isMissing(b.v);
      if (am || bm) { if (!(am && bm)) return am ? 1 : -1; }
      else { const c = compareValues(a.v, b.v); if (c) return c * d; }
      return (tieBreak ? tieBreak(a.row, b.row) : 0) || a.i - b.i;
    })
    .map((x) => x.row);
}

/** The sort after clicking column `key`. descFirst lists columns that start "highest first". */
export function nextSort(sort, key, descFirst = []) {
  if (sort.key === key) return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { key, dir: descFirst.includes(key) ? "desc" : "asc" };
}

/** Marks the sorted column (arrow + aria-sort) on every th[data-sort] inside root. */
export function paintSortHeaders(root, sort) {
  root.querySelectorAll("th[data-sort]").forEach((th) => {
    const on = th.dataset.sort === sort.key;
    th.classList.toggle("sorted", on);
    th.dataset.dir = on ? sort.dir : "";
    th.setAttribute("aria-sort", on ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
    th.tabIndex = 0;
    if (!th.title) th.title = "Sort by this column";
  });
}

// Enter or Space on a focused sortable header acts like a click.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target?.matches?.("th[data-sort]")) {
      e.preventDefault();
      e.target.click();
    }
  });
}
