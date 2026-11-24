// Font Awesome icons for every button, link-button and menu item.
//
// Buttons are created in many places (pages and JavaScript views), so instead
// of hard-coding an <i> in each template, this module gives every button the
// icon that matches what it does, from its action name or its label. It also
// runs for buttons added later and when a label changes (e.g. "Sign in" ->
// "Signing in…"). A button that already has an icon (.fa-*) is left alone,
// and data-icon="none" turns the icon off for one button.

// [pattern on the label (lower case, trimmed), icon name]. First match wins.
const BY_LABEL = [
  [/^signing in|^sign in$|^log ?in/, "right-to-bracket"],
  [/teacher login/, "chalkboard-user"],
  [/^sign out/, "right-from-bracket"],
  [/forgot password/, "key"],
  [/^show$/, "eye"],
  [/^hide$/, "eye-slash"],
  [/refresh|reload/, "rotate"],
  [/load more/, "angles-down"],
  [/clear selection/, "xmark"],
  [/^clear( filters)?$/, "filter-circle-xmark"],
  [/answer sheets|with answers/, "file-lines"],
  [/^print|results by student|histories of the students|^history$/, "print"],
  [/csv/, "file-csv"],
  [/backup file|json/, "database"],
  [/^export/, "file-export"],
  [/^import/, "file-import"],
  [/^more$/, "ellipsis"],
  [/^⋯$|^…$/, "ellipsis"],
  [/grade all|^grade now|^grade$/, "clipboard-check"],
  [/regrade|recalculate/, "arrows-rotate"],
  [/^accept/, "circle-check"],
  [/^decline/, "circle-xmark"],
  [/pending review/, "hourglass-half"],
  [/^unarchive|^restore/, "box-open"],
  [/archive/, "box-archive"],
  [/delete|^remove/, "trash-can"],
  [/^add|^\+ ?add/, "plus"],
  [/^edit/, "pen-to-square"],
  [/answer key/, "key"],
  [/view details|^view$/, "eye"],
  [/student history/, "clock-rotate-left"],
  [/all students|^go back|^back/, "arrow-left"],
  [/allow retake/, "rotate-left"],
  [/^cancel/, "xmark"],
  [/^discard/, "rotate-left"],
  [/^save/, "floppy-disk"],
  [/change details/, "user-pen"],
  [/switch student|not you/, "users"],
  [/^start|^begin|^continue|^resume/, "play"],
  [/^next|^finish/, "arrow-right"],
  [/^previous/, "arrow-left"],
  [/review answers|^review/, "list-check"],
  [/back to (the )?quiz/, "arrow-left"],
  [/^submit/, "paper-plane"],
  [/fullscreen/, "expand"],
  [/unanswered/, "circle-question"],
  [/try again|retry/, "rotate-right"],
  [/^close$/, "lock"],
  [/^open$/, "lock-open"],
  [/^ok$|^got it|^yes/, "check"],
  [/^replace/, "right-left"],
  [/^keep both/, "clone"]
];

// Actions whose label alone is ambiguous.
const BY_ACTION = {
  toggle: (label) => (label === "open" ? "lock-open" : "lock"),
  open: () => "chevron-right"
};
const AFTER_TEXT = new Set(["arrow-right", "chevron-right", "angles-down"]);
const SKIP = ".cselect-button, .cdate-button, .cdate-day, .cdate-nav, .cdate-link, .chip, .tab, .nav-num, .option, .link-btn, .affix-btn, [data-icon='none']";
const TARGETS = "button, a.btn, summary.btn, .menu-list > a";

function iconFor(el) {
  if (el.matches(SKIP) || el.closest("#printRoot")) return null;
  if (el.dataset.icon && el.dataset.icon !== "auto") return el.dataset.icon;
  const label = (el.getAttribute("aria-label") && !el.textContent.trim() ? el.getAttribute("aria-label") : el.textContent)
    .replace(/[←→↻+]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (el.dataset.open !== undefined) return BY_ACTION.open();
  if (el.dataset.act === "toggle") return BY_ACTION.toggle(label);
  if (el.matches("summary") && /^⋯|^…/.test(el.textContent.trim())) return "ellipsis";
  for (const [re, icon] of BY_LABEL) if (re.test(label)) return icon;
  return null;
}

function decorate(el) {
  if (!el.isConnected) return;
  const current = el.querySelector(":scope > i.fa-solid[data-auto]");
  const has = el.querySelector(":scope > i[class*='fa-']:not([data-auto])");
  if (has) return;
  const icon = iconFor(el);
  if (current && current.dataset.auto === icon) return;
  if (current) current.remove();
  if (!icon) return;
  // icon-only "⋯" buttons: replace the character with the icon
  if (icon === "ellipsis" && /^[⋯…]$/.test(el.textContent.trim())) {
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", "More actions");
    [...el.childNodes].forEach((n) => { if (n.nodeType === 3) n.textContent = ""; });
    el.classList.add("is-icon-only");
  }
  const i = document.createElement("i");
  i.className = `fa-solid fa-${icon}`;
  i.setAttribute("aria-hidden", "true");
  i.dataset.auto = icon;
  // Text nodes like "← Back" lose their arrow: the icon replaces it.
  [...el.childNodes].forEach((n) => { if (n.nodeType === 3) n.textContent = n.textContent.replace(/^\s*[←+]\s*/, "").replace(/\s*→\s*$/, ""); });
  if (AFTER_TEXT.has(icon)) el.appendChild(i); else el.prepend(i);
}

function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.matches(TARGETS)) decorate(root);
  root.querySelectorAll(TARGETS).forEach(decorate);
}

if (typeof document !== "undefined") {
  let queued = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const items = queued; queued = new Set();
    items.forEach((n) => scan(n));
  };
  const queue = (n) => { if (n) { queued.add(n); if (!scheduled) { scheduled = true; queueMicrotask(flush); } } };
  const start = () => {
    scan(document.body);
    new MutationObserver((records) => {
      records.forEach((r) => {
        if (r.type === "childList") {
          r.addedNodes.forEach((n) => { if (n.nodeType === 1) queue(n); else if (n.parentElement) queue(n.parentElement.closest(TARGETS)); });
          if (r.target.nodeType === 1 && r.target.matches?.(TARGETS)) queue(r.target);
        } else if (r.type === "characterData") {
          queue(r.target.parentElement?.closest(TARGETS));
        }
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
}
