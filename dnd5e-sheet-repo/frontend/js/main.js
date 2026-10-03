import { route, notFound, startRouter, navigate } from "./router.js";
import { getToken } from "./api.js";
import { renderAuth } from "./views/auth.js";
import { renderList } from "./views/list.js";
import { renderSheet } from "./views/sheet.js";
import { renderWizard } from "./views/wizard.js";
import { renderCampaigns, renderCampaign } from "./views/campaigns.js";

function requireAuth(fn) {
  return (params) => {
    if (!getToken()) {
      navigate("#/login");
      return;
    }
    fn(params);
  };
}

route("#/login", renderAuth);
route("#/characters", requireAuth(renderList));
route("#/characters/:id", requireAuth((p) => renderSheet(p.id)));
route("#/campaigns", requireAuth(renderCampaigns));
route("#/campaigns/:id", requireAuth((p) => renderCampaign(p.id)));
route("#/wizard", requireAuth(renderWizard));
route("#/", () => navigate(getToken() ? "#/characters" : "#/login"));
notFound(() => navigate("#/"));

startRouter();

// Fixed "scroll to top" button, shown on every page (sheet tabs, wizard, ...)
// once the page has been scrolled a bit; always sits in the same spot.
(function setupScrollTop() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "to-top";
  btn.title = "Наверх";
  btn.setAttribute("aria-label", "Наверх");
  btn.textContent = "↑";
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.body.appendChild(btn);
  const update = () => btn.classList.toggle("visible", window.scrollY > 250);
  window.addEventListener("scroll", update, { passive: true });
  update();
})();

// While a modal (card / description / roll window) is open the sheet behind it
// must not scroll: lock the page scroll for as long as #modal-root has content.
(function setupModalScrollLock() {
  const root = document.getElementById("modal-root");
  if (!root) return;
  const apply = () => document.documentElement.classList.toggle("modal-open", root.childElementCount > 0);
  new MutationObserver(apply).observe(root, { childList: true });
  apply();
})();
