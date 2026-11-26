// Left / right buttons for wide tables, for people using a mouse without a
// side-scrolling wheel. They sit above each scrollable table and only show
// when the table is wider than its box. The normal scrollbar, touchpad and
// vertical page scrolling are unchanged.

const STEP = 0.7; // part of the visible width scrolled per click

function enhance(wrap) {
  if (wrap.dataset.hscroll) return;
  wrap.dataset.hscroll = "1";
  const bar = document.createElement("div");
  bar.className = "hscroll-bar";
  bar.hidden = true;
  bar.innerHTML = `
    <span class="hscroll-hint small muted">More columns</span>
    <button type="button" class="btn btn-small btn-icon hscroll-btn" data-dir="-1" data-icon="none" aria-label="Scroll table left" title="Scroll left"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
    <button type="button" class="btn btn-small btn-icon hscroll-btn" data-dir="1" data-icon="none" aria-label="Scroll table right" title="Scroll right"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`;
  wrap.parentNode.insertBefore(bar, wrap);
  const [left, right] = bar.querySelectorAll("button");
  const update = () => {
    const max = wrap.scrollWidth - wrap.clientWidth;
    const overflow = max > 4 && wrap.offsetParent !== null;
    bar.hidden = !overflow;
    left.disabled = wrap.scrollLeft <= 2;
    right.disabled = wrap.scrollLeft >= max - 2;
  };
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dir]");
    if (!b || b.disabled) return;
    wrap.scrollBy({ left: Number(b.dataset.dir) * Math.max(160, wrap.clientWidth * STEP), behavior: "smooth" });
  });
  wrap.addEventListener("scroll", update, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    const table = wrap.querySelector("table");
    if (table) ro.observe(table);
  }
  // Rows are re-rendered inside the same box: check again after changes.
  new MutationObserver(() => requestAnimationFrame(update)).observe(wrap, { childList: true, subtree: true });
  update();
}

/** Adds the buttons to every .table-wrap inside root, now and when new ones appear. */
export function initScrollButtons(root = document.body) {
  const scan = () => root.querySelectorAll(".table-wrap").forEach((w) => { if (w.parentNode) enhance(w); });
  scan();
  new MutationObserver(() => scan()).observe(root, { childList: true, subtree: true });
  // A hidden tab has no width; check again when it becomes visible.
  window.addEventListener("resize", () => root.querySelectorAll(".table-wrap").forEach((w) => w.dispatchEvent(new Event("scroll"))));
  document.addEventListener("click", () => requestAnimationFrame(() => root.querySelectorAll(".table-wrap").forEach((w) => w.dispatchEvent(new Event("scroll")))), true);
}
