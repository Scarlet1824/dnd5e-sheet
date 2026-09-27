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
export function openModal(html, { onClose, wide } = {}) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><div class="modal${wide ? " modal-wide" : ""}">${html}</div></div>`;
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

// Wires .spell-hover-name/.subclass-hover-name popovers (see spellCard.js's
// spellHoverNameHtml() and sheet.js's subclassHoverCardHtml()) to render in a
// body-level layer instead of in place. Plain CSS :hover/:focus-within can't
// do this: `overflow` on ANY ancestor (e.g. the level-up modal's own
// `overflow-y: auto`, needed so its long content scrolls) clips a descendant
// popover regardless of that popover's own position value, so a card
// anchored in a two-column grid's right column had no way to draw past the
// modal's edge -- moving it out to `document.body` on hover/focus sidesteps
// the clip entirely. Call once per container that renders these triggers
// (currently just the level-up modal); safe to call multiple times on the
// same root since the show/hide handlers below don't depend on wiring being
// idempotent, they just don't stack.
export function wireHoverCardPortal(root) {
  let floatEl = null;
  let currentTrigger = null;
  function place(trigger) {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    // Measure after appending (offsetWidth/Height need layout), then nudge
    // back inside the viewport on any edge it would otherwise overflow.
    const cardWidth = floatEl.offsetWidth;
    const cardHeight = floatEl.offsetHeight;
    let left = rect.left;
    if (left + cardWidth > window.innerWidth - margin) left = window.innerWidth - cardWidth - margin;
    if (left < margin) left = margin;
    let top = rect.bottom + 4;
    if (top + cardHeight > window.innerHeight - margin) top = rect.top - cardHeight - 4;
    if (top < margin) top = margin;
    floatEl.style.left = `${left}px`;
    floatEl.style.top = `${top}px`;
  }
  function hide() {
    if (floatEl) { floatEl.remove(); floatEl = null; }
    currentTrigger = null;
  }
  function show(trigger) {
    const source = trigger.querySelector(":scope > .spell-hover-card, :scope > .subclass-hover-card");
    if (!source) return;
    hide();
    currentTrigger = trigger;
    floatEl = document.createElement("div");
    floatEl.className = "hover-card-portal";
    floatEl.appendChild(source.cloneNode(true));
    document.body.appendChild(floatEl);
    place(trigger);
  }
  root.addEventListener("mouseover", (e) => {
    const trigger = e.target.closest(".spell-hover-name, .subclass-hover-name");
    if (trigger && trigger !== currentTrigger) show(trigger);
  });
  root.addEventListener("mouseout", (e) => {
    const trigger = e.target.closest(".spell-hover-name, .subclass-hover-name");
    if (trigger && trigger === currentTrigger && !trigger.contains(e.relatedTarget)) hide();
  });
  root.addEventListener("focusin", (e) => {
    const trigger = e.target.closest(".spell-hover-name, .subclass-hover-name");
    if (trigger) show(trigger);
  });
  root.addEventListener("focusout", (e) => {
    const trigger = e.target.closest(".spell-hover-name, .subclass-hover-name");
    if (trigger && trigger === currentTrigger && !trigger.contains(e.relatedTarget)) hide();
  });
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
