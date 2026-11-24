// Cheating deterrents for the quiz page.
//
// These only DISCOURAGE casual cheating. Browser JavaScript cannot stop
// screenshots, photos of the screen, a second device, or a student who
// edits the page code. The real protection is that correct answers are never
// sent to the student's browser.
//
// Screen-capture measures, and what they really do:
//  - The question is hidden the moment the quiz window loses focus. Tools
//    that take focus first (Windows Snipping Tool / Win+Shift+S, many
//    screen recorders, switching apps) then capture a blank quiz.
//  - Win+Shift / Cmd+Shift key combinations hide the question as soon as the
//    keys go down, before the S/3/4/5 key that takes the screenshot.
//  - Print Screen cannot be blocked: the browser is told only afterwards. We
//    record it and overwrite the clipboard (best effort, Chrome/Edge).
//  - Phones and tablets give web pages no screenshot signal at all.
//
// Key locking:
//  - In fullscreen, Chrome and Edge on a computer let the page "lock" the
//    keyboard (Keyboard Lock API). The Windows key, Alt+Tab and Esc then
//    reach the page instead of the system, so we can block them; Esc has to
//    be held down to leave fullscreen. Other browsers ignore this.
//  - Without that lock, the browser never sees the Windows key, Alt+Tab,
//    Ctrl+Alt+Delete or Fn. The quiz is hidden and the switch is recorded.
//  - Function keys, Tab, Home/End, Alt, Esc and Ctrl shortcuts are blocked
//    during the quiz. Backspace, Delete, Home/End and Ctrl+A/Z/Y keep working
//    inside the short-answer box so students can still type.

const BLOCKED_COMBOS = new Set(["c", "v", "x", "a", "p", "s", "u"]);

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/** Asks Chrome/Edge to send system keys (Windows key, Alt+Tab, Esc) to the page while in fullscreen. */
export function lockKeyboard() {
  try { navigator.keyboard?.lock?.().catch(() => {}); } catch { /* not supported */ }
}

export function unlockKeyboard() {
  try { navigator.keyboard?.unlock?.(); } catch { /* not supported */ }
}

export async function requestFullscreen() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    lockKeyboard();
    return true;
  } catch {
    return false; // not allowed (e.g. iPhone Safari): the quiz still works
  }
}

export function fullscreenSupported() {
  return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
}

/**
 * Starts monitoring. Callbacks:
 *   onLeave(event)          the quiz lost focus (tab switch, minimise, other app)
 *   onReturn()              the student came back
 *   onFullscreenExit()      fullscreen was exited
 *   onFullscreenEnter()
 *   onEvent(type)           any other recorded event (print, blocked shortcut)
 * Returns a stop() function.
 */
export function startAntiCheat({ onLeave, onReturn, onFullscreenExit, onFullscreenEnter, onEvent, onObscure, isActive }) {
  let away = false;
  // A refresh or closing the page fires "hidden" too; do not count that as
  // leaving. If the student cancels the "Leave site?" prompt, reset shortly.
  let unloading = false;
  let unloadTimer = null;
  const markUnloading = () => {
    unloading = true;
    clearTimeout(unloadTimer);
    unloadTimer = setTimeout(() => { unloading = false; }, 1500);
  };
  const active = () => (isActive ? isActive() : true);

  const inEditable = (target) => target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

  const block = (e) => { if (active()) { e.preventDefault(); } };

  const onCopy = (e) => { if (!active()) return; e.preventDefault(); onEvent?.("copy_blocked"); };
  const onPaste = (e) => { if (!active()) return; e.preventDefault(); onEvent?.("paste_blocked"); };
  const onSelectStart = (e) => { if (active() && !inEditable(e.target)) e.preventDefault(); };
  const onDragStart = (e) => block(e);

  let captureTimer = null;
  const hideBriefly = (ms = 2000) => {
    onObscure?.(true);
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => { if (document.hasFocus() && !away) onObscure?.(false); }, ms);
  };

  const onKeyUp = (e) => {
    if (!active()) return;
    if ((e.key || "").toLowerCase() === "printscreen") {
      onEvent?.("printscreen_key");
      hideBriefly();
      // Replace the captured image on the clipboard (works only in some browsers).
      navigator.clipboard?.writeText?.("Screenshots of the quiz are not allowed.").catch(() => {});
    }
  };

  // Record each kind of blocked key at most once every 5 seconds, so holding
  // a key down does not fill the event log.
  const lastLogged = new Map();
  const logKey = (type) => {
    const now = Date.now();
    if (now - (lastLogged.get(type) || 0) < 5000) return;
    lastLogged.set(type, now);
    onEvent?.(type);
  };
  const stopKey = (e, type) => {
    e.preventDefault();
    e.stopPropagation();
    if (type) logKey(type);
  };

  const onKeyDown = (e) => {
    if (!active()) return;
    const key = (e.key || "").toLowerCase();
    const code = e.code || "";
    const mod = e.ctrlKey || e.metaKey;
    const typing = inEditable(e.target);
    // Win+Shift (Snipping Tool) and Cmd+Shift (macOS screenshots): hide first.
    if (e.metaKey && e.shiftKey) {
      hideBriefly(3000);
      if (["s", "3", "4", "5"].includes(key)) onEvent?.("screenshot_shortcut");
    }
    const devtools = key === "f12" ||
      (mod && e.shiftKey && ["i", "j", "c", "k"].includes(key)) ||
      (e.metaKey && e.altKey && ["i", "j", "c", "u"].includes(key));
    // Allow Ctrl+A / arrows inside the short-answer box, block everything else.
    const combo = mod && BLOCKED_COMBOS.has(key) && !(key === "a" && inEditable(e.target));
    if (devtools || combo) {
      stopKey(e, devtools ? "devtools_shortcut" : `shortcut_${key}`);
      return;
    }
    if (key === "printscreen") { hideBriefly(); return; }

    // Windows / Command key (reaches the page only with the keyboard lock).
    if (key === "meta" || key === "os" || code.startsWith("Meta") || code.startsWith("OS")) {
      hideBriefly(3000);
      stopKey(e, "windows_key");
      return;
    }
    // Alt+Tab, Ctrl+Tab and other app/tab switching.
    if (key === "tab" && (e.altKey || mod)) { stopKey(e, "switch_shortcut"); return; }
    // Alt on its own opens the browser menu on Windows; Alt+F4 closes the window.
    if (key === "alt" || key === "altgraph" || e.altKey) { stopKey(e, e.altKey && key !== "alt" ? "alt_shortcut" : null); return; }
    // F1 to F12 (help, refresh, fullscreen, caret browsing, address bar, ...).
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) { stopKey(e, "function_key"); return; }
    // Esc: blocked where the browser allows it (it still leaves fullscreen
    // without the keyboard lock, which is recorded separately).
    if (key === "escape") { stopKey(e); return; }
    if (key === "tab") { stopKey(e, "tab_key"); return; }
    // Editing and navigation keys work while typing an answer, nowhere else.
    if (["backspace", "delete", "home", "end", "pageup", "pagedown", "insert", "contextmenu"].includes(key)) {
      if (!typing) stopKey(e);
      return;
    }
    // Any other Ctrl/Cmd shortcut (find, new tab, history, zoom, ...). While
    // typing, undo/redo, select all and word-wise moves/deletes still work.
    if (mod) {
      const editing = typing && (["a", "z", "y", "backspace", "delete", "arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "shift", "control", "meta"].includes(key));
      if (!editing && key !== "control" && key !== "shift") stopKey(e, "ctrl_shortcut");
    }
  };

  const leave = (reason) => {
    if (!active() || away || unloading) return;
    away = true;
    onLeave?.(reason);
  };
  const back = () => {
    if (!away) return;
    away = false;
    if (active()) onReturn?.();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") { onObscure?.(true); leave("tab_hidden"); }
    else back();
  };
  // Window blur catches switching to another app while the tab stays visible.
  // Short delay so focus moving into an iframe/dialog does not count.
  let blurTimer = null;
  const onBlur = () => {
    if (active()) onObscure?.(true); // hide at once, before any capture tool runs
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { if (!document.hasFocus()) leave("window_blur"); }, 300);
  };
  const onFocus = () => {
    clearTimeout(blurTimer);
    if (active()) onObscure?.(false);
    back();
  };

  const onFullscreenChange = () => {
    if (!active()) return;
    if (isFullscreen()) { lockKeyboard(); onFullscreenEnter?.(); }
    else onFullscreenExit?.();
  };

  const onBeforePrint = () => { if (active()) onEvent?.("print_attempt"); };
  const onBeforeUnload = (e) => {
    markUnloading();
    if (!active()) return;
    e.preventDefault();
    e.returnValue = ""; // browser shows its own "Leave site?" prompt
  };

  const listeners = [
    [document, "contextmenu", block],
    [document, "copy", onCopy],
    [document, "cut", onCopy],
    [document, "paste", onPaste],
    [document, "selectstart", onSelectStart],
    [document, "dragstart", onDragStart],
    [document, "drop", block],
    [document, "keydown", onKeyDown, true],
    [document, "keyup", onKeyUp, true],
    [document, "visibilitychange", onVisibility],
    [window, "blur", onBlur],
    [window, "focus", onFocus],
    [document, "fullscreenchange", onFullscreenChange],
    [document, "webkitfullscreenchange", onFullscreenChange],
    [window, "beforeprint", onBeforePrint],
    [window, "beforeunload", onBeforeUnload],
    [window, "pagehide", markUnloading]
  ];
  listeners.forEach(([t, ev, fn, cap]) => t.addEventListener(ev, fn, !!cap));

  return function stop() {
    clearTimeout(blurTimer);
    clearTimeout(unloadTimer);
    clearTimeout(captureTimer);
    onObscure?.(false);
    unlockKeyboard();
    listeners.forEach(([t, ev, fn, cap]) => t.removeEventListener(ev, fn, !!cap));
  };
}
