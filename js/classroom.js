// Live Classroom Mode (teacher dashboard only).
//
// A teacher presents a quiz on a projector: one question at a time, large
// answer cards, and the answer is checked the moment it is chosen (green
// "Correct!" / red "Incorrect!" plus the correct answer in green). The
// teacher can try again, reveal or hide the answer, show the explanation,
// move freely between questions and go fullscreen.
//
// Safety: this mode only READS the quiz (answerKeys/{id} and quizContent/{id},
// which the rules already let this teacher read). It never writes anything:
// no attempt, no submission, no result, no analytics, no grading, no change
// to the quiz. Everything the teacher clicks lives in this page's memory and
// is gone when the mode is closed.
//
// Answers are checked with isCorrectAnswer() from grading.js, the same
// function that grades student attempts, so both always agree.

import { db, doc, getDoc } from "./firebase.js";
import { loadAnswerKey, isCorrectAnswer } from "./grading.js";
import { escapeHtml, friendlyError, formatClock, pluralize } from "./utilities.js";
import { teacher } from "./teacherState.js";
import { sectionsText } from "./roles.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TYPE_LABELS = { mcq: "Multiple choice", true_false: "True or false", short_answer: "Short answer" };
const TIMER_PRESETS = [30, 60, 120, 180, 300]; // seconds

let current = null; // the open session (only one at a time)

/** Opens a quiz picker (every quiz the teacher may present), then the mode. */
export function openClassroomPicker(quizzes) {
  const list = [...quizzes].sort((a, b) => String(a.grade || "").localeCompare(String(b.grade || ""), undefined, { numeric: true })
    || String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal cm-picker" role="dialog" aria-modal="true" aria-labelledby="cmPickTitle">
      <h2 id="cmPickTitle">Start Live Classroom</h2>
      <p class="small muted">Choose a quiz to present. Students' records are not touched.</p>
      <input type="search" class="cm-pick-search" placeholder="Search quizzes" aria-label="Search quizzes">
      <div class="cm-pick-list" role="list"></div>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button></div>
    </div>`;
  const listBox = backdrop.querySelector(".cm-pick-list");
  const search = backdrop.querySelector(".cm-pick-search");
  const paint = () => {
    const term = search.value.trim().toLowerCase();
    const shown = list.filter((q) => !term || String(q.title).toLowerCase().includes(term) || q.id.toLowerCase().includes(term));
    listBox.innerHTML = shown.length ? shown.map((q) => `
      <button type="button" class="cm-pick-item" data-quiz="${escapeHtml(q.id)}" data-icon="none" role="listitem">
        <span class="cm-pick-main"><b>${escapeHtml(q.title)}</b>
          <span class="small muted">${q.grade ? `Grade ${escapeHtml(q.grade)} · ${escapeHtml(sectionsText(teacher.settings, q.grade, q.sections))}` : "Any grade"} · ${pluralize(q.questionCount || 0, "question")}</span></span>
        <i class="fa-solid fa-play" aria-hidden="true"></i>
      </button>`).join("") : `<p class="empty">${list.length ? "No quiz matches this search." : "There are no quizzes to present yet."}</p>`;
  };
  paint();
  document.body.appendChild(backdrop);
  search.focus();
  const close = () => { document.removeEventListener("keydown", onKey); backdrop.remove(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  search.addEventListener("input", paint);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest("[data-close]")) { close(); return; }
    const item = e.target.closest("[data-quiz]");
    if (!item) return;
    const quiz = list.find((q) => q.id === item.dataset.quiz);
    close();
    if (quiz) openClassroom(quiz);
  });
}

/** Loads the quiz questions with their answers (read only). */
async function loadQuestions(quiz) {
  const [key, content] = await Promise.all([
    loadAnswerKey(quiz.id, { refresh: true }),
    getDoc(doc(db, "quizContent", quiz.id)).then((s) => (s.exists() ? s.data() : null)).catch(() => null)
  ]);
  // Older quizzes kept their questions (with answers) in the quiz document itself.
  const source = key?.questions?.length ? key.questions : (Array.isArray(quiz.questions) ? quiz.questions : []);
  const extra = new Map((content?.questions || []).map((q) => [q.id, q]));
  return source
    .filter((q) => q && q.id && q.text && (q.type === "short_answer" ? (q.acceptedAnswers || []).length : (q.options || []).length && q.correctOptionId !== undefined))
    .map((q) => ({ ...q, type: q.type || "mcq", image: q.image || extra.get(q.id)?.image || "" }));
}

/** Opens Live Classroom Mode for one quiz. */
export async function openClassroom(quiz) {
  if (current) current.close();
  const s = {
    quiz,
    questions: [],
    index: 0,
    // per question id: { given, correct, showKey, explain }
    marks: new Map(),
    finished: false,
    timer: null // { end, total, raf }
  };
  const root = document.createElement("div");
  root.className = "cm";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", `Live Classroom Mode: ${quiz.title}`);
  root.innerHTML = `
    <header class="cm-bar">
      <div class="cm-brand">
        <span class="cm-live-dot" aria-hidden="true"></span>
        <div class="cm-brand-text"><div class="cm-title">${escapeHtml(quiz.title)}</div>
          <div class="cm-sub">Live Classroom${quiz.grade ? ` · Grade ${escapeHtml(quiz.grade)}` : ""}</div></div>
      </div>
      <div class="cm-tools">
        <div class="cm-timer-wrap">
          <button type="button" class="cm-tool" data-cm="timer" data-icon="none" aria-haspopup="true" title="Activity timer (T)"><i class="fa-solid fa-stopwatch" aria-hidden="true"></i><span class="cm-timer-text">Timer</span></button>
          <div class="cm-timer-menu" hidden>
            <div class="small muted">Activity timer (does not stop anything)</div>
            <div class="cm-timer-presets">${TIMER_PRESETS.map((sec) => `<button type="button" class="chip-btn" data-cm-timer="${sec}" data-icon="none">${sec < 60 ? `${sec} s` : `${sec / 60} min`}</button>`).join("")}</div>
            <button type="button" class="btn btn-small" data-cm-timer="0" data-icon="xmark">Stop timer</button>
          </div>
        </div>
        <button type="button" class="cm-tool" data-cm="fullscreen" data-icon="none" title="Fullscreen (F)"><i class="fa-solid fa-expand" aria-hidden="true"></i><span>Fullscreen</span></button>
        <button type="button" class="cm-tool cm-exit" data-cm="exit" data-icon="none" title="Exit Live Classroom (Esc)"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Exit</span></button>
      </div>
    </header>
    <div class="cm-progress" aria-hidden="true"><div class="cm-progress-bar"></div></div>
    <main class="cm-stage" tabindex="-1"><div class="cm-loading"><span class="spinner"></span> Loading questions…</div></main>
    <footer class="cm-foot" hidden>
      <button type="button" class="btn btn-lg cm-nav" data-cm="prev" data-icon="none"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>Previous</span></button>
      <div class="cm-mid">
        <button type="button" class="btn cm-act" data-cm="reset" data-icon="none" title="Try again (R)"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i><span>Try again</span></button>
        <button type="button" class="btn cm-act" data-cm="reveal" data-icon="none" title="Reveal or hide the answer (S)"><i class="fa-solid fa-eye" aria-hidden="true"></i><span>Reveal answer</span></button>
        <button type="button" class="btn cm-act" data-cm="explain" data-icon="none" title="Show the explanation (E)"><i class="fa-solid fa-lightbulb" aria-hidden="true"></i><span>Show explanation</span></button>
      </div>
      <button type="button" class="btn btn-lg btn-primary cm-nav" data-cm="next" data-icon="none"><span>Next</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
    </footer>
    <nav class="cm-dots" aria-label="Questions" hidden></nav>`;
  document.body.appendChild(root);
  document.body.classList.add("cm-open");
  const $ = (sel) => root.querySelector(sel);
  const previousFocus = document.activeElement;

  // ------------------------------------------------------------ helpers
  const q = () => s.questions[s.index];
  const mark = (qq = q()) => {
    if (!s.marks.has(qq.id)) s.marks.set(qq.id, { given: null, correct: null, showKey: false, explain: false });
    return s.marks.get(qq.id);
  };
  const done = (qq) => { const m = s.marks.get(qq.id); return !!m && (m.given !== null || m.showKey); };
  const optionText = (qq, id) => (qq.options || []).find((o) => String(o.id) === String(id))?.text ?? "";
  const correctText = (qq) => (qq.type === "short_answer" ? (qq.acceptedAnswers || []).join(" / ") : optionText(qq, qq.correctOptionId));

  // ------------------------------------------------------------ render
  function render() {
    const total = s.questions.length;
    const finishedCount = s.questions.filter(done).length;
    $(".cm-progress-bar").style.width = `${total ? (finishedCount / total) * 100 : 0}%`;
    if (s.finished) { renderSummary(); return; }
    const qq = q();
    const m = mark(qq);
    const answered = m.given !== null;
    const showKey = m.showKey || (answered && m.correct);
    let answerHtml;
    if (qq.type === "short_answer") {
      answerHtml = `<form class="cm-short" data-cm-short>
          <input type="text" class="cm-short-input" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Type the class's answer" aria-label="Answer" value="${escapeHtml(answered ? m.given : "")}"${answered ? " disabled" : ""}>
          <button type="submit" class="btn btn-lg btn-primary" data-icon="none"${answered ? " disabled" : ""}><i class="fa-solid fa-check" aria-hidden="true"></i> Check answer</button>
        </form>
        ${showKey ? `<div class="cm-accepted"><span class="small">Accepted answer${(qq.acceptedAnswers || []).length === 1 ? "" : "s"}</span><b>${escapeHtml(correctText(qq))}</b></div>` : ""}`;
    } else {
      answerHtml = `<div class="cm-options" role="group" aria-label="Answer options">${(qq.options || []).map((o, i) => {
        const isChosen = answered && String(m.given) === String(o.id);
        const isKey = String(o.id) === String(qq.correctOptionId);
        const cls = [isChosen && (m.correct ? "is-correct" : "is-wrong"), !isChosen && showKey && isKey && "is-key", answered && !isChosen && !(showKey && isKey) && "is-dim"].filter(Boolean).join(" ");
        const icon = isChosen ? (m.correct ? "circle-check" : "circle-xmark") : (showKey && isKey ? "circle-check" : "");
        return `<button type="button" class="cm-option ${cls}" data-opt="${escapeHtml(o.id)}" data-icon="none"${answered ? ' aria-disabled="true"' : ""}>
            <span class="cm-letter">${LETTERS[i] || i + 1}</span>
            <span class="cm-option-text">${escapeHtml(o.text)}</span>
            ${icon ? `<i class="fa-solid fa-${icon} cm-option-icon" aria-hidden="true"></i>` : ""}
          </button>`;
      }).join("")}</div>`;
    }
    let feedback = "";
    if (answered && m.correct) {
      feedback = `<div class="cm-feedback is-correct" role="status"><span class="cm-verdict"><i class="fa-solid fa-circle-check" aria-hidden="true"></i>Correct!</span><span>${escapeHtml(qq.type === "short_answer" ? `"${m.given}" is correct.` : `${correctText(qq)} is the correct answer.`)}</span></div>`;
    } else if (answered) {
      feedback = `<div class="cm-feedback is-wrong" role="status"><span class="cm-verdict"><i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>Incorrect!</span><span>${showKey ? `The correct answer is ${escapeHtml(correctText(qq))}.` : "Try again, or reveal the answer."}</span></div>`;
    } else if (showKey) {
      feedback = `<div class="cm-feedback is-key" role="status"><span class="cm-verdict"><i class="fa-solid fa-eye" aria-hidden="true"></i>Answer</span><span>The correct answer is ${escapeHtml(correctText(qq))}.</span></div>`;
    }
    const canExplain = !!qq.explanation && (answered || showKey);
    $(".cm-stage").innerHTML = `
      <div class="cm-card">
        <div class="cm-qhead">
          <span class="cm-counter">Question ${s.index + 1}<span> of ${total}</span></span>
          <span class="cm-badges"><span class="badge badge-info">${escapeHtml(TYPE_LABELS[qq.type] || "Question")}</span><span class="badge">${escapeHtml(pluralize(Number(qq.marks) || 1, "mark"))}</span></span>
          <span class="cm-done small muted">${finishedCount} of ${total} done</span>
        </div>
        ${qq.lessonTitle && s.quiz.merged ? `<div class="small muted cm-lesson">${escapeHtml(qq.lessonTitle)}</div>` : ""}
        <h2 class="cm-question">${escapeHtml(qq.text)}</h2>
        ${qq.image ? `<img class="cm-image" src="${escapeHtml(qq.image)}" alt="">` : ""}
        ${answerHtml}
        <div class="cm-feedback-slot" aria-live="polite">${feedback}</div>
        ${canExplain && m.explain ? `<div class="cm-explain"><b><i class="fa-solid fa-lightbulb" aria-hidden="true"></i> Explanation</b><p>${escapeHtml(qq.explanation)}</p></div>` : ""}
      </div>`;
    // Controls
    $('[data-cm="prev"]').disabled = s.index === 0;
    const last = s.index === total - 1;
    $('[data-cm="next"] span').textContent = last ? "Finish" : "Next";
    $('[data-cm="reset"]').disabled = !answered && !m.showKey;
    const reveal = $('[data-cm="reveal"]');
    reveal.disabled = answered && m.correct;
    reveal.querySelector("span").textContent = showKey && !(answered && m.correct) ? "Hide answer" : "Reveal answer";
    reveal.querySelector("i").className = `fa-solid fa-${showKey && !(answered && m.correct) ? "eye-slash" : "eye"}`;
    const explain = $('[data-cm="explain"]');
    explain.hidden = !qq.explanation;
    explain.disabled = !canExplain;
    explain.querySelector("span").textContent = m.explain && canExplain ? "Hide explanation" : "Show explanation";
    renderDots();
    if (qq.type === "short_answer" && !answered) $(".cm-short-input")?.focus({ preventScroll: true });
  }

  function renderDots() {
    const box = $(".cm-dots");
    box.innerHTML = s.questions.map((qq, i) => {
      const m = s.marks.get(qq.id);
      const st = !m ? "" : m.given !== null ? (m.correct ? "is-correct" : "is-wrong") : m.showKey ? "is-key" : "";
      return `<button type="button" class="cm-dot ${st}${i === s.index && !s.finished ? " is-current" : ""}" data-cm-go="${i}" data-icon="none" aria-label="Question ${i + 1}"${i === s.index ? ' aria-current="step"' : ""}>${i + 1}</button>`;
    }).join("");
  }

  function renderSummary() {
    const total = s.questions.length;
    const vals = s.questions.map((qq) => s.marks.get(qq.id)).filter(Boolean);
    const correct = vals.filter((m) => m.given !== null && m.correct).length;
    const wrong = vals.filter((m) => m.given !== null && !m.correct).length;
    const revealed = vals.filter((m) => m.given === null && m.showKey).length;
    const skipped = total - correct - wrong - revealed;
    $(".cm-stage").innerHTML = `
      <div class="cm-card cm-summary">
        <div class="cm-summary-icon" aria-hidden="true"><i class="fa-solid fa-flag-checkered"></i></div>
        <h2 class="cm-question">End of the quiz</h2>
        <div class="cm-summary-grid">
          <div class="is-correct"><b>${correct}</b><span>Correct</span></div>
          <div class="is-wrong"><b>${wrong}</b><span>Incorrect</span></div>
          <div class="is-key"><b>${revealed}</b><span>Revealed</span></div>
          <div><b>${skipped}</b><span>Not tried</span></div>
        </div>
        <p class="muted">This session is not saved anywhere.</p>
        <div class="cm-summary-actions">
          <button type="button" class="btn btn-lg" data-cm="review" data-icon="none"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back to questions</button>
          <button type="button" class="btn btn-lg" data-cm="restart" data-icon="none"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Start again</button>
          <button type="button" class="btn btn-lg btn-primary" data-cm="exit" data-icon="none"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Exit</button>
        </div>
      </div>`;
    $('[data-cm="prev"]').disabled = false;
    $('[data-cm="next"] span').textContent = "Finish";
    ["reset", "reveal", "explain"].forEach((k) => { $(`[data-cm="${k}"]`).disabled = true; });
    renderDots();
  }

  // ------------------------------------------------------------ actions
  function choose(given) {
    if (s.finished) return;
    const qq = q();
    const m = mark(qq);
    if (m.given !== null) return; // already answered: Try again first
    if (String(given ?? "").trim() === "") return;
    m.given = String(given);
    m.correct = isCorrectAnswer(qq, m.given);
    m.showKey = true; // an incorrect answer shows the correct one in green straight away
    render();
  }
  function go(i) {
    s.finished = false;
    s.index = Math.max(0, Math.min(s.questions.length - 1, i));
    render();
    $(".cm-stage").scrollTo?.({ top: 0 });
  }
  function next() {
    if (s.finished) return;
    if (s.index < s.questions.length - 1) go(s.index + 1);
    else { s.finished = true; render(); }
  }
  function prev() {
    if (s.finished) { s.finished = false; render(); return; }
    if (s.index > 0) go(s.index - 1);
  }
  function reset() {
    if (s.finished) return;
    s.marks.delete(q().id);
    render();
  }
  function toggleReveal() {
    if (s.finished) return;
    const m = mark();
    if (m.given !== null && m.correct) return;
    m.showKey = !m.showKey;
    if (!m.showKey && m.given === null) m.explain = false;
    render();
  }
  function toggleExplain() {
    if (s.finished) return;
    const qq = q();
    const m = mark(qq);
    if (!qq.explanation || (m.given === null && !m.showKey)) return;
    m.explain = !m.explain;
    render();
  }

  // ------------------------------------------------------------ fullscreen
  const fsSupported = () => !!(root.requestFullscreen || root.webkitRequestFullscreen);
  const isFs = () => (document.fullscreenElement || document.webkitFullscreenElement) === root;
  function toggleFullscreen() {
    if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    else if (fsSupported()) (root.requestFullscreen || root.webkitRequestFullscreen).call(root)?.catch?.(() => {});
  }
  function onFsChange() {
    const on = isFs();
    root.classList.toggle("is-fs", on);
    const b = $('[data-cm="fullscreen"]');
    b.querySelector("i").className = `fa-solid fa-${on ? "compress" : "expand"}`;
    b.querySelector("span").textContent = on ? "Exit fullscreen" : "Fullscreen";
  }
  if (!fsSupported()) $('[data-cm="fullscreen"]').hidden = true;

  // ------------------------------------------------------------ activity timer
  // Purely a visual countdown for class activities: it never stops, submits or locks anything.
  function startTimer(sec) {
    stopTimer();
    if (!sec) return;
    s.timer = { end: Date.now() + sec * 1000, total: sec * 1000, id: setInterval(paintTimer, 250) };
    paintTimer();
  }
  function stopTimer() {
    if (s.timer) clearInterval(s.timer.id);
    s.timer = null;
    const b = $('[data-cm="timer"]');
    b.classList.remove("is-running", "is-low", "is-over");
    $(".cm-timer-text").textContent = "Timer";
  }
  function paintTimer() {
    if (!s.timer) return;
    const left = s.timer.end - Date.now();
    const b = $('[data-cm="timer"]');
    b.classList.add("is-running");
    b.classList.toggle("is-low", left > 0 && left <= 10000);
    b.classList.toggle("is-over", left <= 0);
    $(".cm-timer-text").textContent = left > 0 ? formatClock(left) : "Time!";
    if (left <= -15000) stopTimer(); // the "Time!" sign stays for 15 s
  }
  const timerMenu = $(".cm-timer-menu");

  // ------------------------------------------------------------ events
  root.addEventListener("click", (e) => {
    if (!e.target.closest(".cm-timer-wrap")) timerMenu.hidden = true;
    const t = e.target.closest("[data-cm-timer]");
    if (t) { startTimer(Number(t.dataset.cmTimer)); timerMenu.hidden = true; return; }
    const opt = e.target.closest("[data-opt]");
    if (opt) { choose(opt.dataset.opt); return; }
    const dot = e.target.closest("[data-cm-go]");
    if (dot) { go(Number(dot.dataset.cmGo)); return; }
    const b = e.target.closest("[data-cm]");
    if (!b || b.disabled) return;
    switch (b.dataset.cm) {
      case "prev": prev(); break;
      case "next": next(); break;
      case "reset": reset(); break;
      case "reveal": toggleReveal(); break;
      case "explain": toggleExplain(); break;
      case "fullscreen": toggleFullscreen(); break;
      case "timer": timerMenu.hidden = !timerMenu.hidden; break;
      case "exit": close(); break;
      case "review": s.finished = false; go(0); break;
      case "restart": s.marks.clear(); s.finished = false; go(0); break;
      default:
    }
  });
  root.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-cm-short]");
    if (!form) return;
    e.preventDefault();
    choose(form.querySelector("input").value);
  });

  // Keys are handled here first and never reach the dashboard's own shortcuts.
  function onKey(e) {
    if (!root.isConnected) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = e.target.matches?.("input, textarea, select");
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!timerMenu.hidden) { timerMenu.hidden = true; return; }
      if (!isFs()) close();
      return;
    }
    if (typing) { e.stopPropagation(); return; }
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.key === "ArrowRight" || e.key === "PageDown" || k === "n") next();
    else if (e.key === "ArrowLeft" || e.key === "PageUp" || k === "p") prev();
    else if (k === "r") reset();
    else if (k === "s" || k === "h") toggleReveal();
    else if (k === "e") toggleExplain();
    else if (k === "f") toggleFullscreen();
    else if (k === "t") timerMenu.hidden = !timerMenu.hidden;
    else if (!s.finished && q()?.type !== "short_answer" && /^[1-9]$/.test(k)) { const o = q().options[Number(k) - 1]; if (o) choose(o.id); }
    else if (!s.finished && q()?.type !== "short_answer" && /^[a-d]$/.test(k)) { const o = q().options[LETTERS.indexOf(k.toUpperCase())]; if (o) choose(o.id); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    else e.stopPropagation();
  }
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  function close() {
    stopTimer();
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    if (isFs()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
    root.remove();
    document.body.classList.remove("cm-open");
    if (current?.root === root) current = null;
    previousFocus?.focus?.({ preventScroll: true });
  }
  current = { root, close };

  // ------------------------------------------------------------ load
  try {
    s.questions = await loadQuestions(quiz);
  } catch (err) {
    console.error(err);
    if (!root.isConnected) return;
    $(".cm-stage").innerHTML = `<div class="cm-card cm-error"><h2>Could not open this quiz</h2><p>${escapeHtml(err?.code === "permission-denied" ? "You don't have permission to open the answers of this quiz." : friendlyError(err))}</p><button type="button" class="btn btn-lg" data-cm="exit" data-icon="none">Close</button></div>`;
    return;
  }
  if (!root.isConnected) return;
  if (!s.questions.length) {
    $(".cm-stage").innerHTML = '<div class="cm-card cm-error"><h2>No questions to show</h2><p>This quiz has no answer key. Add its question bank again and choose Replace.</p><button type="button" class="btn btn-lg" data-cm="exit" data-icon="none">Close</button></div>';
    return;
  }
  $(".cm-foot").hidden = false;
  $(".cm-dots").hidden = false;
  render();
  $(".cm-stage").focus({ preventScroll: true });
}
