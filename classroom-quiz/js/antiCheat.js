// Cheating deterrents for the quiz page.
//
// These only DISCOURAGE casual cheating. Browser JavaScript cannot stop
// screenshots, photos of the screen, a second device, or a student who
// edits the page code. The real protection is that correct answers are never
// sent to the student's browser.

const BLOCKED_COMBOS = new Set(["c", "v", "x", "a", "p", "s", "u"]);

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

export async function requestFullscreen() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
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
export function startAntiCheat({ onLeave, onReturn, onFullscreenExit, onFullscreenEnter, onEvent, isActive }) {
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

  const onKeyDown = (e) => {
    if (!active()) return;
    const key = (e.key || "").toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const devtools = key === "f12" ||
      (mod && e.shiftKey && ["i", "j", "c", "k"].includes(key)) ||
      (e.metaKey && e.altKey && ["i", "j", "c", "u"].includes(key));
    // Allow Ctrl+A / arrows inside the short-answer box, block everything else.
    const combo = mod && BLOCKED_COMBOS.has(key) && !(key === "a" && inEditable(e.target));
    if (devtools || combo) {
      e.preventDefault();
      e.stopPropagation();
      onEvent?.(devtools ? "devtools_shortcut" : `shortcut_${key}`);
    }
    if (key === "printscreen") onEvent?.("printscreen_key");
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
    if (document.visibilityState === "hidden") leave("tab_hidden");
    else back();
  };
  // Window blur catches switching to another app while the tab stays visible.
  // Short delay so focus moving into an iframe/dialog does not count.
  let blurTimer = null;
  const onBlur = () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { if (!document.hasFocus()) leave("window_blur"); }, 300);
  };
  const onFocus = () => { clearTimeout(blurTimer); back(); };

  const onFullscreenChange = () => {
    if (!active()) return;
    if (isFullscreen()) onFullscreenEnter?.();
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
    listeners.forEach(([t, ev, fn, cap]) => t.removeEventListener(ev, fn, !!cap));
  };
}
