// Custom form controls. The browser's own dropdown list and calendar popup
// cannot be styled, so every <select> and <input type="date"> on the site is
// shown through a styled control built here.
//
// The real <select>/<input> stays in the page (visually hidden): forms, the
// rest of the code and assistive technology keep using it. The custom control
// only mirrors it: choosing an item sets the real element's value and fires
// the usual "input" and "change" events; when code changes the real element
// (new options, a new value), the custom control updates itself.
//
// Opt out for one element with data-native.

const ENHANCED = new WeakMap(); // real element -> control
let openControl = null;

const el = (tag, cls, attrs = {}) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  return n;
};
const fire = (target) => {
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
};
let seq = 0;

function closeOpen() {
  if (openControl) openControl.close();
}

/** Places a popup under (or above) its trigger and inside the screen. */
function place(pop, trigger) {
  pop.style.left = "0px";
  pop.style.top = "0px";
  pop.style.minWidth = `${trigger.offsetWidth}px`;
  const r = trigger.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let left = Math.min(r.left, vw - w - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

// ------------------------------------------------------------------ select

class Select {
  constructor(select) {
    this.select = select;
    this.id = `cq-sel-${++seq}`;
    this.wrap = el("div", "cselect");
    this.button = el("button", "cselect-button", { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" });
    this.label = el("span", "cselect-label");
    this.button.append(this.label, el("span", "cselect-caret", { "aria-hidden": "true" }));
    this.list = el("div", "cselect-list", { role: "listbox", id: this.id, tabindex: "-1" });
    this.list.hidden = true;
    select.classList.add("native-hidden");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select.parentNode.insertBefore(this.wrap, select);
    this.wrap.append(select, this.button, this.list); // the list is position: fixed, so no container clips it
    // Label text for screen readers comes from the select's label or aria-label.
    const name = select.getAttribute("aria-label") || select.closest("label")?.querySelector("span")?.textContent
      || (select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent) || "";
    if (name) this.button.setAttribute("aria-label", name.trim());
    if (select.id) {
      const lab = document.querySelector(`label[for="${select.id}"]`);
      lab?.addEventListener("click", (e) => { e.preventDefault(); this.button.focus(); });
    }
    this.button.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.isOpen ? this.close() : this.open(); });
    this.button.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("mousedown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      e.preventDefault(); // the control may sit inside a <label>: don't pass the click on
      const item = e.target.closest(".cselect-option");
      if (!item || item.getAttribute("aria-disabled") === "true") return;
      this.choose(Number(item.dataset.index));
    });
    select.addEventListener("change", () => this.sync());
    new MutationObserver(() => this.sync()).observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
    this.sync();
  }

  get isOpen() { return !this.list.hidden; }

  sync() {
    const s = this.select;
    const opt = s.options[s.selectedIndex];
    this.label.textContent = opt ? opt.textContent : "";
    this.label.classList.toggle("is-placeholder", !opt || opt.value === "");
    this.button.disabled = s.disabled;
    this.wrap.classList.toggle("is-invalid", s.classList.contains("invalid"));
    if (this.isOpen) this.renderList();
  }

  renderList() {
    const s = this.select;
    this.list.innerHTML = "";
    [...s.options].forEach((o, i) => {
      if (o.hidden) return;
      const item = el("div", "cselect-option", { role: "option", "data-index": String(i), "aria-selected": String(i === s.selectedIndex) });
      if (o.disabled) item.setAttribute("aria-disabled", "true");
      item.textContent = o.textContent;
      this.list.appendChild(item);
    });
    this.active = s.selectedIndex;
    this.highlight();
  }

  highlight() {
    this.list.querySelectorAll(".cselect-option").forEach((n) => n.classList.toggle("is-active", Number(n.dataset.index) === this.active));
    const cur = this.list.querySelector(".is-active");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  open() {
    if (this.select.disabled) return;
    closeOpen();
    this.renderList();
    this.list.hidden = false;
    this.wrap.classList.add("is-open");
    this.button.setAttribute("aria-expanded", "true");
    place(this.list, this.button);
    this.highlight();
    openControl = this;
  }

  close() {
    this.list.hidden = true;
    this.wrap.classList.remove("is-open");
    this.button.setAttribute("aria-expanded", "false");
    if (openControl === this) openControl = null;
  }

  choose(index) {
    const s = this.select;
    const changed = s.selectedIndex !== index;
    s.selectedIndex = index;
    this.close();
    this.button.focus();
    this.sync();
    if (changed) fire(s);
  }

  move(step) {
    const opts = [...this.select.options];
    let i = this.active ?? this.select.selectedIndex;
    for (let n = 0; n < opts.length; n++) {
      i += step;
      if (i < 0 || i >= opts.length) return;
      if (!opts[i].disabled && !opts[i].hidden) break;
    }
    this.active = i;
    if (this.isOpen) this.highlight(); else this.choose(i);
  }

  onKey(e) {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); if (!this.isOpen && e.altKey) this.open(); else this.move(1); break;
      case "ArrowUp": e.preventDefault(); this.move(-1); break;
      case "Enter": case " ":
        e.preventDefault();
        if (this.isOpen) this.choose(this.active ?? this.select.selectedIndex); else this.open();
        break;
      case "Escape": if (this.isOpen) { e.preventDefault(); this.close(); this.button.focus(); } break;
      case "Tab": this.close(); break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) { // jump to the first option starting with the letter
          const k = e.key.toLowerCase();
          const i = [...this.select.options].findIndex((o, j) => j > (this.active ?? -1) && o.textContent.trim().toLowerCase().startsWith(k));
          const any = i >= 0 ? i : [...this.select.options].findIndex((o) => o.textContent.trim().toLowerCase().startsWith(k));
          if (any >= 0) { this.active = any; if (this.isOpen) this.highlight(); else this.choose(any); }
        }
    }
  }
}

// -------------------------------------------------------------- date input

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

class DateField {
  constructor(input) {
    this.input = input;
    this.wrap = el("div", "cdate");
    this.button = el("button", "cdate-button", { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" });
    this.label = el("span", "cdate-label");
    this.button.append(el("span", "cdate-icon", { "aria-hidden": "true" }), this.label);
    this.pop = el("div", "cdate-pop", { role: "dialog", "aria-label": "Choose a date" });
    this.pop.hidden = true;
    input.classList.add("native-hidden");
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.parentNode.insertBefore(this.wrap, input);
    this.wrap.append(input, this.button, this.pop);
    const name = input.getAttribute("aria-label") || input.closest("label")?.querySelector("span")?.textContent || "Date";
    this.button.setAttribute("aria-label", name.trim());
    this.button.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.isOpen ? this.close() : this.open(); });
    this.pop.addEventListener("mousedown", (e) => e.preventDefault());
    this.pop.addEventListener("click", (e) => this.onClick(e));
    this.pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { this.close(); this.button.focus(); } });
    input.addEventListener("change", () => this.sync());
    this.sync();
  }

  get isOpen() { return !this.pop.hidden; }

  sync() {
    const d = parseIso(this.input.value);
    this.label.textContent = d ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Any date";
    this.label.classList.toggle("is-placeholder", !d);
  }

  open() {
    closeOpen();
    const d = parseIso(this.input.value) || new Date();
    this.view = new Date(d.getFullYear(), d.getMonth(), 1);
    this.render();
    this.pop.hidden = false;
    this.wrap.classList.add("is-open");
    this.button.setAttribute("aria-expanded", "true");
    place(this.pop, this.button);
    openControl = this;
  }

  close() {
    this.pop.hidden = true;
    this.wrap.classList.remove("is-open");
    this.button.setAttribute("aria-expanded", "false");
    if (openControl === this) openControl = null;
  }

  render() {
    const v = this.view;
    const selected = this.input.value;
    const today = iso(new Date());
    const first = new Date(v.getFullYear(), v.getMonth(), 1);
    const start = (first.getDay() + 6) % 7; // weeks start on Monday
    const days = new Date(v.getFullYear(), v.getMonth() + 1, 0).getDate();
    let cells = "";
    for (let i = 0; i < start; i++) cells += "<span></span>";
    for (let day = 1; day <= days; day++) {
      const value = iso(new Date(v.getFullYear(), v.getMonth(), day));
      const cls = ["cdate-day", value === selected ? "is-selected" : "", value === today ? "is-today" : ""].filter(Boolean).join(" ");
      cells += `<button type="button" class="${cls}" data-date="${value}">${day}</button>`;
    }
    this.pop.innerHTML = `
      <div class="cdate-head">
        <button type="button" class="cdate-nav" data-nav="-1" aria-label="Previous month">‹</button>
        <span class="cdate-month">${MONTHS[v.getMonth()]} ${v.getFullYear()}</span>
        <button type="button" class="cdate-nav" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="cdate-week">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cdate-grid">${cells}</div>
      <div class="cdate-foot">
        <button type="button" class="cdate-link" data-pick="clear">Clear</button>
        <button type="button" class="cdate-link" data-pick="today">Today</button>
      </div>`;
    if (this.isOpen) place(this.pop, this.button);
  }

  set(value) {
    const changed = this.input.value !== value;
    this.input.value = value;
    this.sync();
    this.close();
    this.button.focus();
    if (changed) fire(this.input);
  }

  onClick(e) {
    e.preventDefault(); // the control may sit inside a <label>: don't pass the click on
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.nav) { this.view = new Date(this.view.getFullYear(), this.view.getMonth() + Number(b.dataset.nav), 1); this.render(); return; }
    if (b.dataset.date) { this.set(b.dataset.date); return; }
    if (b.dataset.pick === "clear") this.set("");
    if (b.dataset.pick === "today") this.set(iso(new Date()));
  }
}

// --------------------------------------------------------------- wiring

function enhance(root) {
  if (!root.querySelectorAll) return;
  const nodes = root.matches?.("select, input[type=date]") ? [root] : [];
  nodes.push(...root.querySelectorAll("select, input[type=date]"));
  nodes.forEach((n) => {
    if (ENHANCED.has(n) || n.hasAttribute("data-native") || n.multiple) return;
    if (n.closest("#printRoot")) return;
    ENHANCED.set(n, n.tagName === "SELECT" ? new Select(n) : new DateField(n));
  });
}

// Code that sets .value directly (filters reset, settings loaded) updates the control too.
for (const [proto, props] of [[HTMLSelectElement.prototype, ["value", "selectedIndex"]], [HTMLInputElement.prototype, ["value"]]]) {
  props.forEach((prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) { d.set.call(this, v); const c = ENHANCED.get(this); if (c) c.sync(); }
    });
  });
}

if (typeof document !== "undefined") {
  const start = () => {
    enhance(document.body);
    new MutationObserver((records) => {
      let removed = false;
      records.forEach((r) => {
        r.addedNodes.forEach((n) => { if (n.nodeType === 1) enhance(n); });
        if (r.removedNodes.length) removed = true;
      });
      if (removed && openControl && !document.body.contains(openControl.button)) closeOpen();
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  document.addEventListener("click", (e) => {
    if (!openControl) return;
    if (openControl.list?.contains(e.target) || openControl.pop?.contains(e.target) || openControl.wrap.contains(e.target)) return;
    closeOpen();
  });
  window.addEventListener("resize", closeOpen);
  // Dropdown menus (details.menu) close when clicking elsewhere or pressing Escape.
  document.addEventListener("click", (e) => {
    document.querySelectorAll("details.menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll("details.menu[open]").forEach((d) => { d.open = false; d.querySelector("summary")?.focus(); });
  });
  // File pickers (.file-drop): files can also be dropped on them.
  ["dragenter", "dragover"].forEach((type) => document.addEventListener(type, (e) => {
    const zone = e.target.closest?.(".file-drop");
    if (!zone) return;
    e.preventDefault();
    zone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((type) => document.addEventListener(type, (e) => {
    const zone = e.target.closest?.(".file-drop");
    if (!zone) return;
    e.preventDefault();
    if (type === "dragleave" && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("is-dragging");
    if (type !== "drop" || !e.dataTransfer?.files?.length) return;
    const input = zone.querySelector('input[type="file"]');
    const dt = new DataTransfer();
    [...e.dataTransfer.files].slice(0, input.multiple ? undefined : 1).forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }));
  document.addEventListener("scroll", (e) => {
    if (!openControl) return;
    const pop = openControl.list || openControl.pop;
    if (pop.contains(e.target)) return;
    closeOpen();
  }, true);
}

export { enhance };
