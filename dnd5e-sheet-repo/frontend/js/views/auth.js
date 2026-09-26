import { mount, on, $, freshApp, escapeHtml } from "../dom.js";
import { api, setSession, isConfigured } from "../api.js";
import { navigate } from "../router.js";

export function renderAuth() {
  if (!isConfigured()) {
    mount(`
      <div class="center-screen">
        <div class="panel auth-box">
          <h1>⚔ D&D 5e — Лист персонажа</h1>
          <p class="error-text">API ещё не настроен: откройте <code>frontend/js/config.js</code> и укажите адрес развёрнутого Worker'а (<code>API_BASE_URL</code>).</p>
          <p class="muted">Инструкция — в README.md, раздел «Деплой».</p>
        </div>
      </div>`);
    return;
  }

  let mode = "login";
  // freshApp() (see dom.js) drops listeners left over from an earlier visit
  // to this view, so re-entering it doesn't stack duplicate handlers.
  const app = freshApp();

  // Wired once, outside draw() — draw() only ever calls mount() to
  // refresh content (e.g. switching the login/register tab), so it can be
  // called as often as needed without ever re-attaching (and thus
  // duplicating) these delegated listeners.
  on(app, "click", "[data-mode]", (e, el) => {
    mode = el.dataset.mode;
    draw();
  });
  on(app, "submit", "[data-auth-form]", async (e) => {
    e.preventDefault();
    const form = e.target;
    const email = form.email.value.trim();
    const password = form.password.value;
    const errorEl = $("[data-error]", app);
    errorEl.style.display = "none";
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      const res = mode === "login" ? await api.login(email, password) : await api.register(email, password);
      setSession(res.token, res.user);
      navigate("#/characters");
    } catch (err) {
      errorEl.textContent = err.message || "Ошибка. Попробуйте ещё раз.";
      errorEl.style.display = "block";
    } finally {
      submitBtn.disabled = false;
    }
  });

  function draw() {
    mount(`
      <div class="center-screen">
        <div class="panel auth-box">
          <h1 style="text-align:center;">⚔ D&D 5e</h1>
          <div class="auth-tabs">
            <button data-mode="login" class="${mode === "login" ? "active" : ""}">Вход</button>
            <button data-mode="register" class="${mode === "register" ? "active" : ""}">Регистрация</button>
          </div>
          <form data-auth-form class="col" style="gap:10px;">
            <div class="col">
              <label>Email</label>
              <input type="email" name="email" required autocomplete="email" />
            </div>
            <div class="col">
              <label>Пароль ${mode === "register" ? "(минимум 8 символов)" : ""}</label>
              <input type="password" name="password" required minlength="8" autocomplete="${mode === "login" ? "current-password" : "new-password"}" />
            </div>
            <p class="error-text" data-error style="display:none;"></p>
            <button type="submit" class="primary">${mode === "login" ? "Войти" : "Создать аккаунт"}</button>
          </form>
        </div>
      </div>`);
  }

  draw();
}
