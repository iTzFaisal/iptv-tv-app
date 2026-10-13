// Small DOM helpers: selectors, escaping, toasts, confirm dialog, category
// chips, and the chunked grid renderer used by every catalog view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export function fmtDate(ts) {
  if (!ts) return "";
  try {
    return new Date(Number(ts)).toLocaleDateString();
  } catch {
    return "";
  }
}

export function fmtDateTime(ts) {
  if (!ts) return "";
  try {
    return new Date(Number(ts)).toLocaleString();
  } catch {
    return "";
  }
}

/* --------------------------------- toasts --------------------------------- */

let toastRoot = null;

export function toast(message, { type = "info", ms = 4000 } = {}) {
  if (!toastRoot) {
    toastRoot = $("#toasts");
    if (!toastRoot) {
      toastRoot = el("div", { id: "toasts" });
      document.body.append(toastRoot);
    }
  }
  const node = el("div", { class: `toast toast-${type}` }, message);
  toastRoot.append(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 300);
  }, ms);
  return node;
}

/* ----------------------------- confirm dialog ----------------------------- */
// Returns a promise resolving to true/false. Message is text (not HTML).

export function confirmDialog(message, { okLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "dialog-overlay" });
    const box = el("div", { class: "dialog" });
    box.append(el("p", { class: "dialog-message" }, message));
    const actions = el("div", { class: "dialog-actions" });
    const cancelBtn = el("button", { class: "btn" }, cancelLabel);
    const okBtn = el("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}` }, okLabel);
    actions.append(cancelBtn, okBtn);
    box.append(actions);
    overlay.append(box);
    document.body.append(overlay);

    const done = (value) => {
      overlay.remove();
      resolve(value);
    };
    cancelBtn.addEventListener("click", () => done(false));
    okBtn.addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    okBtn.focus();
  });
}

/* ------------------------------ category chips ---------------------------- */

export function renderChips(container, categories, activeId, onSelect, { allLabel = "All", counts = null } = {}) {
  clear(container);
  const makeChip = (id, label, count) => {
    const chip = el("button", {
      class: `chip${String(activeId) === String(id) ? " active" : ""}`,
      dataset: { cat: String(id) },
    }, label, count != null ? el("span", { class: "chip-count" }, String(count)) : null);
    chip.addEventListener("click", () => onSelect(String(id)));
    return chip;
  };
  if (counts) {
    container.append(makeChip("all", allLabel, counts.all));
    for (const cat of categories) container.append(makeChip(cat.id, cat.name, counts.byId.get(cat.id)));
  } else {
    container.append(makeChip("all", allLabel));
    for (const cat of categories) container.append(makeChip(cat.id, cat.name));
  }
}

/* ------------------------------ chunked grid ------------------------------ */
// Renders items in chunks of 100 as the user scrolls, so a 17k-item catalog
// stays snappy.

export function createGrid(container, { chunk = 100, emptyText = "Nothing to show" } = {}) {
  let items = [];
  let renderItem = null;
  let shown = 0;

  const sentinel = el("div", { class: "grid-sentinel" });
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    },
    { rootMargin: "800px 0px" }
  );

  function toNode(value) {
    if (value instanceof Node) return value;
    const template = document.createElement("template");
    template.innerHTML = String(value).trim();
    return template.content.firstElementChild || document.createTextNode("");
  }

  function loadMore() {
    if (shown >= items.length) {
      sentinel.textContent = "";
      return;
    }
    const frag = document.createDocumentFragment();
    const end = Math.min(shown + chunk, items.length);
    for (let i = shown; i < end; i++) frag.append(toNode(renderItem(items[i], i)));
    container.insertBefore(frag, sentinel);
    shown = end;
    if (shown >= items.length) sentinel.textContent = "";
  }

  function render(newItems, newRenderItem) {
    items = newItems;
    renderItem = newRenderItem;
    shown = 0;
    observer.disconnect();
    clear(container);
    if (!items.length) {
      container.append(el("div", { class: "empty" }, emptyText));
      return;
    }
    container.append(sentinel);
    observer.observe(sentinel);
    loadMore();
  }

  return { render, get length() { return items.length; } };
}

/* --------------------------------- badges --------------------------------- */

export function offlineBadgeHTML(ts) {
  const d = ts ? fmtDate(ts) : "";
  return `<span class="badge badge-offline" title="Failed to play${d ? ` (${d})` : ""} — tap to retry">offline${d ? " " + d : ""}</span>`;
}

export function kindBadgeHTML(kind) {
  const labels = { live: "Live", movie: "Movie", series: "Series", episode: "Episode" };
  return `<span class="badge badge-kind">${labels[kind] || kind}</span>`;
}

/* ------------------------------ button status ----------------------------- */

export function setBusy(button, busy, busyLabel = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}
