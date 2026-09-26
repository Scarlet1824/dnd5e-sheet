export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function mount(html) {
  document.getElementById("app").innerHTML = html;
}

// Each view (list/wizard/sheet/auth) wires its delegated click/change/input
// listeners onto the #app element once, at the top of its render function.
// Since #app itself is never removed from the DOM — only its innerHTML is
// replaced by mount() — those listeners stick around forever. Navigating
// back to the same view later calls its render function again, which wires
// a whole NEW set of listeners onto the very same #app node on top of the
// old ones, so after N visits a single click fires the handler N times (a
// confirm() dialog has to be dismissed N times before anything happens).
// freshApp() fixes this: it swaps #app for a shallow clone (same id, no
// children, no listeners) before a view wires anything, so each view visit
// starts from zero listeners. Every view's render entry point must call
// this instead of document.getElementById("app")/$("#app").
export function freshApp() {
  const old = document.getElementById("app");
  const clone = old.cloneNode(false);
  old.replaceWith(clone);
  return clone;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function $all(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

// Delegate a click/change/input listener from a root element to elements
// matching selector, calling handler(event, matchedEl). Returns an unbind fn.
export function on(root, eventName, selector, handler) {
  const listener = (e) => {
        const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(eventName, listener);
  return () => root.removeEventListener(eventName, listener);
}

let modalCloseHandler = null;
export function openModal(html, { onClose } = {}) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><div class="modal">${html}</div></div>`;
  modalCloseHandler = onClose || null;
  root.querySelector("[data-modal-backdrop]").addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-modal-backdrop")) closeModal();
  });
  return root.querySelector(".modal");
}
export function closeModal() {
  const root = document.getElementById("modal-root");
  root.innerHTML = "";
  if (modalCloseHandler) modalCloseHandler();
  modalCloseHandler = null;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
