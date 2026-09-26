import { mount, on, $, freshApp, escapeHtml } from "../dom.js";
import { api, getUser, clearSession } from "../api.js";
import { navigate } from "../router.js";
import { blankCharacter } from "../character.js";

function topBar(activeUser) {
  return `
    <div class="top-bar">
      <a href="#/characters" class="brand">⚔ D&D 5e</a>
      <div class="row">
        <span class="muted">${escapeHtml(activeUser?.email || "")}</span>
        <button data-action="logout" class="small">Выйти</button>
      </div>
    </div>`;
}

export async function renderList() {
  const user = getUser();
  // freshApp() swaps #app for a listener-free clone first, so re-entering
  // this view (e.g. navigating back after opening a character) can't pile
  // up duplicate delegated listeners on top of ones from a previous visit
  // (that's what made "delete" need several clicks — each click re-fired
  // one confirm() per accumulated listener).
  const app = freshApp();
  mount(`${topBar(user)}<div class="panel"><p class="muted">Загрузка персонажей…</p></div>`);
  let characters = [];
  on(app, "click", "[data-action=logout]", async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    clearSession();
    navigate("#/login");
  });
  on(app, "click", "[data-action=open]", (e, el) => navigate(`#/characters/${el.dataset.id}`));
  on(app, "click", "[data-action=new-manual]", async (e, el) => {
    el.disabled = true;
    try {
      const res = await api.createCharacter({ name: "Безымянный герой", edition: "2014", data: blankCharacter("2014") });
      navigate(`#/characters/${res.character.id}`);
    } catch (err) {
      alert(err.message);
      el.disabled = false;
    }
  });
  on(app, "click", "[data-action=new-wizard]", () => navigate("#/wizard"));
  on(app, "click", "[data-action=delete]", async (e, el) => {
    if (!confirm("Удалить этого персонажа безвозвратно?")) return;
    el.disabled = true;
    try {
      await api.deleteCharacter(el.dataset.id);
      characters = characters.filter((c) => c.id !== el.dataset.id);
      draw();
    } catch (err) {
      alert(err.message);
      el.disabled = false;
    }
  });

  try {
    const res = await api.listCharacters();
    characters = res.characters;
  } catch (err) {
    mount(`${topBar(user)}<div class="panel"><p class="error-text">${escapeHtml(err.message)}</p></div>`);
    return;
  }

  draw();

  function draw() {
    mount(`
      ${topBar(user)}
      <div class="row between">
        <h1>Мои персонажи</h1>
        <div class="row">
          <button data-action="new-manual">+ Пустой лист</button>
          <button data-action="new-wizard" class="primary">+ Мастер создания</button>
        </div>
      </div>
      ${
        characters.length === 0
          ? '<div class="panel"><p class="muted">Персонажей пока нет — создайте первого.</p></div>'
          : characters
              .map(
                (c) => `
        <div class="panel char-list-item">
          <div class="info">
            <div class="name">${escapeHtml(c.name)}</div>
            <div class="muted">${escapeHtml(c.classLabel || "Без класса")} · ур. ${c.level} · редакция ${c.edition}</div>
          </div>
          <div class="row">
            <button data-action="open" data-id="${c.id}" class="primary small">Открыть</button>
            <button data-action="delete" data-id="${c.id}" class="danger small">Удалить</button>
          </div>
        </div>`
              )
              .join("")
      }
    `);
  }
}
