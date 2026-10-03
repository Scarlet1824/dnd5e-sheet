// Кампании: мастер видит сводку игроков и подключает Discord-вебхук; игроки вступают по коду.
import { mount, on, freshApp, escapeHtml } from "../dom.js";
import { api, getUser } from "../api.js";
import { navigate } from "../router.js";

function topBar() {
  return `<div class="top-bar"><a href="#/characters" class="brand">⚔ D&D 5e</a>
    <div class="row"><a href="#/characters" class="small-link">Персонажи</a><a href="#/campaigns" class="small-link">Кампании</a></div></div>`;
}

export async function renderCampaigns() {
  const app = freshApp();
  mount(`${topBar()}<div class="panel"><p class="muted">Загрузка…</p></div>`);
  let list = [];
  const draw = (err = "") => {
    mount(`${topBar()}
      <div class="panel">
        <h2>Кампании</h2>
        ${err ? `<p class="error-text">${escapeHtml(err)}</p>` : ""}
        ${list.length ? list.map((c) => `
          <div class="campaign-row" data-action="open" data-id="${c.id}">
            <strong>${escapeHtml(c.name)}</strong>
            <span class="muted">${c.role === "gm" ? `Мастер · игроков: ${c.members}` : "Игрок"}</span>
          </div>`).join("") : `<p class="muted">Пока нет кампаний.</p>`}
      </div>
      <div class="panel">
        <h3>Создать кампанию (я мастер)</h3>
        <div class="row"><input data-new-name placeholder="Название" maxlength="100" /><button data-action="create">Создать</button></div>
      </div>
      <div class="panel">
        <h3>Вступить по коду (я игрок)</h3>
        <div class="row"><input data-join-code placeholder="Код приглашения" maxlength="12" style="text-transform:uppercase" /><button data-action="join">Вступить</button></div>
      </div>`);
  };
  try { list = (await api.listCampaigns()).campaigns; } catch (e) { draw(e.message); wire(); return; }
  draw();
  wire();
  function wire() {
    on(app, "click", "[data-action=open]", (e, el) => navigate(`#/campaigns/${el.dataset.id}`));
    on(app, "click", "[data-action=create]", async () => {
      const name = document.querySelector("[data-new-name]").value.trim();
      if (!name) return;
      try { const r = await api.createCampaign(name); navigate(`#/campaigns/${r.campaign.id}`); } catch (e) { draw(e.message); }
    });
    on(app, "click", "[data-action=join]", async () => {
      const code = document.querySelector("[data-join-code]").value.trim();
      if (!code) return;
      try { const r = await api.joinCampaign(code); navigate(`#/campaigns/${r.campaign.id}`); } catch (e) { draw(e.message); }
    });
  }
}

const COND_NAMES = {};
function ago(iso) {
  if (!iso) return "—";
  const t = Date.parse(String(iso).replace(" ", "T") + (String(iso).includes("Z") ? "" : "Z"));
  if (!t) return "—";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`;
}
function online(iso) {
  const t = Date.parse(String(iso || "").replace(" ", "T") + "Z");
  return t && Date.now() - t < 5 * 60000;
}

function memberCard(m) {
  const s = m.summary;
  const name = m.name ? escapeHtml(m.name) : `<span class="muted">персонаж не выбран</span>`;
  const head = `<div class="row" style="justify-content:space-between"><strong>${name}</strong>
    <span class="muted">${online(m.updatedAt) ? "🟢 " : ""}${escapeHtml(m.email || "")}</span></div>
    <div class="muted" style="font-size:.8rem">${escapeHtml(m.classLabel || "")}${m.level ? ` · ур. ${m.level}` : ""} · обновлено: ${ago(m.updatedAt)}</div>`;
  const kick = `<button class="small" data-action="kick" data-user="${m.userId}">Убрать</button>`;
  if (!s) return `<div class="panel member-card">${head}<p class="muted">Нет данных — игрок ещё не сохранял лист после обновления.</p>${kick}</div>`;
  const pct = Math.max(0, Math.min(100, s.hp.max ? Math.round((s.hp.cur / s.hp.max) * 100) : 0));
  const col = pct > 60 ? "#3a9d4f" : pct > 30 ? "#d4a017" : "#c0392b";
  const stat = (k, v) => v == null ? "" : `<span class="mstat"><b>${v}</b><small>${k}</small></span>`;
  const sgn = (n) => (n >= 0 ? `+${n}` : n);
  return `<div class="panel member-card">${head}
    <div class="hp-bar"><div style="width:${pct}%;background:${col}"></div><span>${s.hp.cur}/${s.hp.max}${s.hp.temp ? ` (+${s.hp.temp})` : ""}</span></div>
    <div class="mstats">${stat("КД", s.ac)}${stat("Иниц.", s.init != null ? sgn(s.init) : null)}${stat("Пасс. воспр.", s.pp)}${stat("СЛ", s.dc)}${stat("Атака", s.atk != null ? sgn(s.atk) : null)}${s.hd ? stat("Кости хитов", `${s.hd.cur}/${s.hd.total}к${s.hd.die}`) : ""}${s.exh ? stat("Истощение", s.exh) : ""}</div>
    ${s.cond && s.cond.length ? `<div class="muted" style="font-size:.85rem">Состояния: ${s.cond.map(escapeHtml).join(", ")}</div>` : ""}
    ${s.slots && s.slots.length ? `<div style="font-size:.85rem">Ячейки: ${s.slots.map((x) => `${x.l}: ${x.left}/${x.max}`).join(" · ")}</div>` : ""}
    ${s.res && s.res.length ? `<div style="font-size:.8rem" class="muted">${s.res.map((r) => `${escapeHtml(r.n)} ${r.left}/${r.max}`).join(" · ")}</div>` : ""}
    ${kick}</div>`;
}

export async function renderCampaign(id) {
  const app = freshApp();
  mount(`${topBar()}<div class="panel"><p class="muted">Загрузка…</p></div>`);
  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  window.addEventListener("hashchange", stop, { once: true });
  let res;
  try { res = await api.getCampaign(id); } catch (e) {
    mount(`${topBar()}<div class="panel"><p class="error-text">${escapeHtml(e.message)}</p></div>`); return;
  }
  const isGm = res.campaign.role === "gm";

  if (!isGm) {
    let chars = [];
    try { chars = (await api.listCharacters()).characters; } catch { /* ignore */ }
    let mine = res.myCharacterId;
    const draw = (msg = "") => mount(`${topBar()}
      <div class="panel"><h2>${escapeHtml(res.campaign.name)}</h2>
        <p class="muted">Вы игрок. Мастер видит сводку выбранного персонажа, а броски дублируются в Discord${res.campaign.hasWebhook ? "" : " (вебхук пока не настроен)"}.</p>
        <label>Мой персонаж
          <select data-char><option value="">— не выбран —</option>
            ${chars.map((c) => `<option value="${c.id}" ${c.id === mine ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
          </select></label>
        ${msg ? `<p class="muted">${msg}</p>` : ""}
        <div class="row"><button class="small" data-action="leave">Покинуть кампанию</button></div>
      </div>`);
    draw();
    on(app, "change", "[data-char]", async (e, el) => {
      try { await api.setMyCharacter(id, el.value || null); mine = el.value; draw("Сохранено ✓ (откройте лист заново, чтобы включить дубли бросков)"); } catch (er) { draw(er.message); }
    });
    on(app, "click", "[data-action=leave]", async () => {
      if (!confirm("Покинуть кампанию?")) return;
      try { await api.leaveCampaign(id); navigate("#/campaigns"); } catch (er) { draw(er.message); }
    });
    return;
  }

  // мастер
  let members = res.members;
  let camp = res.campaign;
  const draw = (msg = "") => {
    const keep = document.querySelector("[data-hook-input]")?.value || "";
    mount(`${topBar()}
      <div class="panel">
        <div class="row" style="justify-content:space-between"><h2>${escapeHtml(camp.name)}</h2>
          <span>Код приглашения: <b class="join-code">${escapeHtml(camp.joinCode)}</b></span></div>
        <details ${camp.hasWebhook ? "" : "open"}><summary>Discord-вебхук ${camp.hasWebhook ? `(задан: ${escapeHtml(camp.webhookMasked)})` : "(не задан)"}</summary>
          <p class="muted" style="font-size:.85rem">Канал Discord → Настройки → Интеграции → Вебхуки → Создать вебхук → Копировать URL.</p>
          <div class="row"><input data-hook-input type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…" value="${escapeHtml(keep)}" style="flex:1" />
            <button data-action="save-hook">Сохранить</button>${camp.hasWebhook ? `<button class="small" data-action="clear-hook">Отключить</button>` : ""}</div>
        </details>
        <div class="row" style="margin-top:8px"><button class="small" data-action="rename">Переименовать</button><button class="small danger" data-action="delete">Удалить кампанию</button></div>
        ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
      </div>
      <h3>Игроки (${members.length}) <small class="muted">— обновляется каждые 10 с</small></h3>
      <div data-members>${members.length ? members.map(memberCard).join("") : `<p class="muted">Пока никого. Раздайте игрокам код.</p>`}</div>`);
  };
  draw();
  timer = setInterval(async () => {
    if (!document.querySelector("[data-members]")) return stop();
    try {
      const r = await api.getCampaign(id);
      members = r.members;
      const box = document.querySelector("[data-members]");
      if (box) box.innerHTML = members.length ? members.map(memberCard).join("") : `<p class="muted">Пока никого. Раздайте игрокам код.</p>`;
    } catch { /* ignore */ }
  }, 10000);

  const reload = async (msg) => { camp = (await api.getCampaign(id)).campaign; members = (await api.getCampaign(id)).members; draw(msg); };
  on(app, "click", "[data-action=save-hook]", async () => {
    const url = document.querySelector("[data-hook-input]").value.trim();
    if (!url) return;
    try { await api.updateCampaign(id, { webhookUrl: url }); await reload("Вебхук сохранён ✓"); } catch (e) { draw(e.message); }
  });
  on(app, "click", "[data-action=clear-hook]", async () => {
    try { await api.updateCampaign(id, { webhookUrl: "" }); await reload("Вебхук отключён"); } catch (e) { draw(e.message); }
  });
  on(app, "click", "[data-action=rename]", async () => {
    const name = prompt("Новое название", camp.name);
    if (!name) return;
    try { await api.updateCampaign(id, { name }); await reload("Переименовано ✓"); } catch (e) { draw(e.message); }
  });
  on(app, "click", "[data-action=delete]", async () => {
    if (!confirm("Удалить кампанию? Игроки будут отвязаны, листы сохранятся.")) return;
    try { await api.deleteCampaign(id); stop(); navigate("#/campaigns"); } catch (e) { draw(e.message); }
  });
  on(app, "click", "[data-action=kick]", async (e, el) => {
    if (!confirm("Убрать игрока из кампании?")) return;
    try { await api.kickMember(id, el.dataset.user); await reload("Игрок убран"); } catch (er) { draw(er.message); }
  });
}
