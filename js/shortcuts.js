// Keyboard shortcuts for the dashboard.
//
// Two-key "go to" shortcuts (press G, let go, then a letter) are used
// instead of Alt or Ctrl combinations, which browsers and operating systems
// already use (Alt+1 switches tabs on Linux, Alt+H opens Help in Firefox,
// Ctrl+K focuses the address bar in some browsers). Shortcuts never fire
// while typing in a box, while a dialog is open, or with Ctrl/Alt/Cmd held.
// The student quiz pages have no shortcuts (keys are locked during a quiz).

export const GO_KEYS = [
  { key: "o", tab: "overview", label: "Overview" },
  { key: "r", tab: "results", label: "Results" },
  { key: "s", tab: "history", label: "Student record" },
  { key: "a", tab: "analysis", label: "Analysis" },
  { key: "q", tab: "quizzes", label: "Quizzes" },
  { key: "e", tab: "requests", label: "Requests" },
  { key: "t", tab: "teachers", label: "Add teacher", admin: true },
  { key: "b", tab: "archive", label: "Archive and backup", admin: true },
  { key: "c", tab: "settings", label: "School settings", admin: true },
  { key: "h", tab: "help", label: "Help" }
];

export const OTHER_KEYS = [
  { keys: ["/"], label: "Jump to the search box of the page" },
  { keys: ["]"], label: "Next page of the table (when it has pages)" },
  { keys: ["["], label: "Previous page of the table" },
  { keys: ["?"], label: "Show the keyboard shortcuts (Help)" },
  { keys: ["Esc"], label: "Close a dialog or an open menu" }
];

function typing(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["checkbox", "radio", "button", "submit", "reset", "file"].includes(el.type);
  return false;
}

const visible = (el) => el && el.offsetParent !== null;

/**
 * hasTab(name) -> boolean, openTab(name), openHelp(section)
 */
export function initShortcuts({ hasTab, openTab, openHelp }) {
  let goUntil = 0;
  const hint = document.createElement("div");
  hint.className = "shortcut-hint";
  hint.setAttribute("role", "status");
  hint.hidden = true;
  document.body.appendChild(hint);
  const showHint = (text) => { hint.textContent = text; hint.hidden = !text; };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll("details.menu[open]").forEach((d) => d.removeAttribute("open"));
      goUntil = 0; showHint("");
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (typing(e.target) || document.querySelector(".modal-backdrop:not([hidden])")) return;
    if (document.getElementById("appView")?.hidden) return;

    if (goUntil > Date.now()) {
      goUntil = 0;
      showHint("");
      const item = GO_KEYS.find((g) => g.key === e.key.toLowerCase());
      if (item && hasTab(item.tab)) { e.preventDefault(); openTab(item.tab); }
      return;
    }
    if (e.key === "g" || e.key === "G") {
      goUntil = Date.now() + 1500;
      showHint("Go to… (O overview, R results, S student record, Q quizzes, H help)");
      setTimeout(() => { if (goUntil && goUntil <= Date.now()) { goUntil = 0; showHint(""); } }, 1600);
      return;
    }
    if (e.key === "/") {
      const box = [...document.querySelectorAll('.tab-panel:not([hidden]) input[type="search"]')].find(visible);
      if (box) { e.preventDefault(); box.focus(); box.select(); }
      return;
    }
    if (e.key === "]" || e.key === "[") {
      const pager = [...document.querySelectorAll(".tab-panel:not([hidden]) .pager")].find(visible);
      const btn = pager && [...pager.querySelectorAll("[data-page]")].find((b) => (e.key === "]" ? /next/i : /prev/i).test(b.getAttribute("aria-label") || b.textContent));
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key === "?") { e.preventDefault(); openHelp("shortcuts"); }
  });
}
