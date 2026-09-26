import { route, notFound, startRouter, navigate } from "./router.js";
import { getToken } from "./api.js";
import { renderAuth } from "./views/auth.js";
import { renderList } from "./views/list.js";
import { renderSheet } from "./views/sheet.js";
import { renderWizard } from "./views/wizard.js";

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
route("#/wizard", requireAuth(renderWizard));
route("#/", () => navigate(getToken() ? "#/characters" : "#/login"));
notFound(() => navigate("#/"));

startRouter();
