/**
 * D&D 5e Character Sheet — Cloudflare Worker API
 *
 * Single-file, zero-dependency Worker (paste directly into the Cloudflare
 * dashboard's Worker code editor — no build step, no npm).
 *
 * Bindings required (set in the dashboard under Worker → Settings → Variables):
 *   - D1 database binding named `DB`   (Settings → Bindings → D1 Database)
 *   - Variable `ALLOWED_ORIGIN`        (e.g. https://your-pages-app.pages.dev)
 *   - Variable `OWNER_EMAIL`           (email владельца: управляет доступом и правами мастеров; регистрируется без кода)
 *
 * Routes:
 *   POST   /api/register        { email, password }                -> { token, user }
 *   POST   /api/login           { email, password }                -> { token, user }
 *   POST   /api/logout          (auth)                              -> { ok: true }
 *   GET    /api/me              (auth)                              -> { user }
 *   GET    /api/characters      (auth)                              -> { characters: [...] }
 *   POST   /api/characters      (auth) { name, edition, data }      -> { character }
 *   GET    /api/characters/:id  (auth)                              -> { character }
 *   PUT    /api/characters/:id  (auth) { name, edition, data }      -> { character }
 *   DELETE /api/characters/:id  (auth)                              -> { ok: true }
 *   Кампании: GET/POST /api/campaigns, POST /api/campaigns/join, GET/PUT/DELETE /api/campaigns/:id,
 *             PUT /api/campaigns/:id/character, DELETE /api/campaigns/:id/membership,
 *             DELETE /api/campaigns/:id/members/:userId, POST /api/campaigns/:id/roll (дубль броска в Discord)
 */

const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

// ---------- helpers ----------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function uuid() {
  return crypto.randomUUID();
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes.buffer;
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBuf(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bufToHex(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isOwnerEmail(env, email) {
  return !!env.OWNER_EMAIL && String(email).toLowerCase() === String(env.OWNER_EMAIL).toLowerCase().trim();
}

async function getUserFromRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT s.user_id as user_id, s.expires_at as expires_at, u.id as id, u.email as email, u.status as status, u.is_gm as is_gm
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
      .bind(token)
      .first();
  } catch {
    // миграция доступа ещё не выполнена
    row = await env.DB.prepare(
      `SELECT s.user_id as user_id, s.expires_at as expires_at, u.id as id, u.email as email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
      .bind(token)
      .first();
  }

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const owner = isOwnerEmail(env, row.email);
  return {
    id: row.id,
    email: row.email,
    token,
    blocked: !owner && row.status === "blocked",
    role: owner ? "owner" : row.is_gm ? "gm" : "player",
  };
}

// Игрок (не владелец и не мастер) имеет доступ, только пока состоит в кампании активного мастера.
async function playerHasAccess(env, userId) {
  try {
    const r = await env.DB.prepare(
      `SELECT 1 AS ok FROM campaign_members m
       JOIN campaigns c ON c.id = m.campaign_id
       JOIN users o ON o.id = c.owner_id
       WHERE m.user_id = ? AND COALESCE(o.status, 'active') != 'blocked' LIMIT 1`
    )
      .bind(userId)
      .first();
    return !!r;
  } catch {
    return true; // таблицы кампаний ещё не созданы
  }
}

function characterRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    edition: row.edition,
    classLabel: row.class_label,
    level: row.level,
    data: JSON.parse(row.data),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

// Pull a short "Класс N ур." label + level out of the free-form sheet JSON for list views.
function summarize(data) {
  const classes = Array.isArray(data.classes) ? data.classes : [];
  const level = classes.reduce((sum, c) => sum + (Number(c.level) || 0), 0) || 1;
  const classLabel = classes.length
    ? classes.map((c) => `${c.name || "Класс"} ${c.level || 1}`).join(" / ")
    : "Без класса";
  return { level, classLabel };
}

// ---------- route handlers ----------

async function handleRegister(request, env) {
  const body = await readJson(request);
  if (!body || !isValidEmail(body.email) || typeof body.password !== "string" || body.password.length < 8) {
    return json({ error: "Укажите корректный email и пароль от 8 символов." }, 400);
  }
  const email = body.email.toLowerCase().trim();

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json({ error: "Пользователь с таким email уже существует." }, 409);

  // Регистрация только по коду приглашения мастера (владелец регистрируется свободно).
  let invite = null;
  if (!isOwnerEmail(env, email)) {
    const code = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
    if (!code) return json({ error: "Для регистрации нужен код приглашения от мастера." }, 403);
    try {
      invite = await env.DB.prepare(
        `SELECT c.id AS id, COALESCE(o.status, 'active') AS ostatus FROM campaigns c JOIN users o ON o.id = c.owner_id WHERE c.join_code = ?`
      ).bind(code).first();
    } catch {
      invite = null;
    }
    if (!invite || invite.ostatus === "blocked") return json({ error: "Код приглашения не найден." }, 403);
  }

  const salt = randomHex(16);
  const passwordHash = await hashPassword(body.password, salt);
  const userId = uuid();

  await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)")
    .bind(userId, email, passwordHash, salt)
    .run();
  if (invite) {
    await env.DB.prepare("INSERT OR IGNORE INTO campaign_members (campaign_id, user_id) VALUES (?, ?)").bind(invite.id, userId).run();
  }

  return startSession(env, userId, email);
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body || !isValidEmail(body.email) || typeof body.password !== "string") {
    return json({ error: "Укажите email и пароль." }, 400);
  }
  const email = body.email.toLowerCase().trim();

  let user;
  try {
    user = await env.DB.prepare("SELECT id, email, password_hash, salt, status FROM users WHERE email = ?").bind(email).first();
  } catch {
    user = await env.DB.prepare("SELECT id, email, password_hash, salt FROM users WHERE email = ?").bind(email).first();
  }
  if (!user) return json({ error: "Неверный email или пароль." }, 401);

  const attemptedHash = await hashPassword(body.password, user.salt);
  if (!timingSafeEqual(attemptedHash, user.password_hash)) {
    return json({ error: "Неверный email или пароль." }, 401);
  }
  if (user.status === "blocked" && !isOwnerEmail(env, user.email)) {
    return json({ error: "Доступ закрыт владельцем.", code: "BLOCKED" }, 403);
  }

  return startSession(env, user.id, user.email);
}

async function startSession(env, userId, email) {
  const token = randomHex(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expiresAt)
    .run();
  return json({ token, user: { id: userId, email } });
}

async function handleLogout(request, env, user) {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(user.token).run();
  return json({ ok: true });
}

async function handleMe(request, env, user) {
  const access = user.role !== "player" || (await playerHasAccess(env, user.id));
  return json({ user: { id: user.id, email: user.email, role: user.role, access } });
}

// ---------- администрирование (только владелец) ----------

async function handleAdminListUsers(request, env, user) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.created_at, COALESCE(u.status,'active') AS status, COALESCE(u.is_gm,0) AS is_gm,
            (SELECT COUNT(*) FROM characters c WHERE c.user_id = u.id) AS chars,
            (SELECT COUNT(*) FROM campaigns c WHERE c.owner_id = u.id) AS owned,
            (SELECT GROUP_CONCAT(c.name, ', ') FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id WHERE m.user_id = u.id) AS campaigns
     FROM users u ORDER BY u.created_at`
  ).all();
  return json({
    users: results.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.created_at,
      status: r.status,
      isGm: !!r.is_gm,
      isOwner: isOwnerEmail(env, r.email),
      characters: r.chars,
      ownedCampaigns: r.owned,
      campaigns: r.campaigns || "",
    })),
  });
}

async function handleAdminUpdateUser(request, env, user, id) {
  const body = await readJson(request);
  if (!body) return json({ error: "Некорректное тело запроса." }, 400);
  const target = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(id).first();
  if (!target) return json({ error: "Пользователь не найден." }, 404);
  if (isOwnerEmail(env, target.email)) return json({ error: "Владельца изменить нельзя." }, 400);
  if (body.status === "blocked" || body.status === "active") {
    await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(body.status, id).run();
    if (body.status === "blocked") await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  }
  if (typeof body.isGm === "boolean") {
    await env.DB.prepare("UPDATE users SET is_gm = ? WHERE id = ?").bind(body.isGm ? 1 : 0, id).run();
  }
  return json({ ok: true });
}

async function handleListCharacters(request, env, user) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM characters WHERE user_id = ? ORDER BY updated_at DESC"
  )
    .bind(user.id)
    .all();
  return json({ characters: results.map(characterRowToJson) });
}

async function handleCreateCharacter(request, env, user) {
  const body = await readJson(request);
  if (!body || typeof body !== "object") return json({ error: "Некорректное тело запроса." }, 400);

  const data = body.data && typeof body.data === "object" ? body.data : {};
  const { level, classLabel } = summarize(data);
  const id = uuid();
  const name = (body.name || data.name || "Безымянный герой").toString().slice(0, 200);
  const edition = body.edition === "2024" ? "2024" : "2014";

  await env.DB.prepare(
    `INSERT INTO characters (id, user_id, name, edition, class_label, level, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, user.id, name, edition, classLabel, level, JSON.stringify(data))
    .run();

  const row = await env.DB.prepare("SELECT * FROM characters WHERE id = ?").bind(id).first();
  return json({ character: characterRowToJson(row) }, 201);
}

async function handleGetCharacter(request, env, user, id) {
  const row = await env.DB.prepare("SELECT * FROM characters WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first();
  if (!row) return json({ error: "Персонаж не найден." }, 404);
  const character = characterRowToJson(row);
  try {
    const m = await env.DB.prepare(
      "SELECT campaign_id FROM campaign_members WHERE character_id = ? AND user_id = ? LIMIT 1"
    )
      .bind(id, user.id)
      .first();
    if (m) character.campaignId = m.campaign_id;
  } catch {
    /* таблицы кампаний ещё нет */
  }
  return json({ character });
}

async function handleUpdateCharacter(request, env, user, id) {
  const existing = await env.DB.prepare("SELECT id FROM characters WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first();
  if (!existing) return json({ error: "Персонаж не найден." }, 404);

  const body = await readJson(request);
  if (!body || typeof body !== "object") return json({ error: "Некорректное тело запроса." }, 400);

  const data = body.data && typeof body.data === "object" ? body.data : {};
  const { level, classLabel } = summarize(data);
  const name = (body.name || data.name || "Безымянный герой").toString().slice(0, 200);
  const edition = body.edition === "2024" ? "2024" : "2014";

  const summary = body.summary && typeof body.summary === "object" ? JSON.stringify(body.summary).slice(0, 20000) : null;
  try {
    await env.DB.prepare(
      `UPDATE characters
       SET name = ?, edition = ?, class_label = ?, level = ?, data = ?, summary = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(name, edition, classLabel, level, JSON.stringify(data), summary, id, user.id)
      .run();
  } catch {
    // колонка summary ещё не добавлена миграцией — сохраняем без неё
    await env.DB.prepare(
      `UPDATE characters
       SET name = ?, edition = ?, class_label = ?, level = ?, data = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
      .bind(name, edition, classLabel, level, JSON.stringify(data), id, user.id)
      .run();
  }

  const row = await env.DB.prepare("SELECT * FROM characters WHERE id = ?").bind(id).first();
  return json({ character: characterRowToJson(row) });
}

async function handleDeleteCharacter(request, env, user, id) {
  await env.DB.prepare("DELETE FROM characters WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}


// ---------- кампании ----------

const WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeJoinCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function maskWebhook(url) {
  if (!url) return "";
  const m = url.match(/^(https:\/\/[^/]+\/api\/webhooks\/\d+\/)([\w-]+)$/);
  return m ? `${m[1]}…${m[2].slice(-4)}` : "задан";
}

async function getCampaignRole(env, campaignId, userId) {
  const c = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(campaignId).first();
  if (!c) return { campaign: null, role: null };
  if (c.owner_id === userId) return { campaign: c, role: "gm" };
  const m = await env.DB.prepare("SELECT * FROM campaign_members WHERE campaign_id = ? AND user_id = ?")
    .bind(campaignId, userId)
    .first();
  return { campaign: c, role: m ? "player" : null, member: m };
}

async function handleListCampaigns(request, env, user) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.join_code, c.owner_id,
            (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id = c.id) AS members
     FROM campaigns c
     WHERE c.owner_id = ? OR c.id IN (SELECT campaign_id FROM campaign_members WHERE user_id = ?)
     ORDER BY c.created_at DESC`
  )
    .bind(user.id, user.id)
    .all();
  return json({
    campaigns: results.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.owner_id === user.id ? "gm" : "player",
      joinCode: c.owner_id === user.id ? c.join_code : undefined,
      members: c.members,
    })),
  });
}

async function handleCreateCampaign(request, env, user) {
  if (user.role === "player") return json({ error: "Создавать кампании может только мастер. Попросите владельца выдать права мастера." }, 403);
  const body = await readJson(request);
  const name = body && typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (!name) return json({ error: "Укажите название кампании." }, 400);
  const id = uuid();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const code = makeJoinCode();
      await env.DB.prepare("INSERT INTO campaigns (id, owner_id, name, join_code) VALUES (?, ?, ?, ?)")
        .bind(id, user.id, name, code)
        .run();
      return json({ campaign: { id, name, role: "gm", joinCode: code, members: 0 } }, 201);
    } catch (e) {
      if (attempt === 4) throw e;
    }
  }
}

async function handleJoinCampaign(request, env, user) {
  const body = await readJson(request);
  const code = body && typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return json({ error: "Введите код приглашения." }, 400);
  const c = await env.DB.prepare("SELECT * FROM campaigns WHERE join_code = ?").bind(code).first();
  if (!c) return json({ error: "Кампания с таким кодом не найдена." }, 404);
  if (c.owner_id !== user.id) {
    await env.DB.prepare("INSERT OR IGNORE INTO campaign_members (campaign_id, user_id) VALUES (?, ?)")
      .bind(c.id, user.id)
      .run();
  }
  return json({ campaign: { id: c.id, name: c.name, role: c.owner_id === user.id ? "gm" : "player" } });
}

async function handleGetCampaign(request, env, user, id) {
  const { campaign, role, member } = await getCampaignRole(env, id, user.id);
  if (!campaign || !role) return json({ error: "Кампания не найдена." }, 404);
  if (role === "player") {
    return json({
      campaign: { id: campaign.id, name: campaign.name, role, hasWebhook: !!campaign.webhook_url },
      myCharacterId: member.character_id || null,
    });
  }
  let rows = [];
  try {
    const q = await env.DB.prepare(
      `SELECT m.user_id AS user_id, u.email AS email, m.character_id AS character_id,
              c.name AS cname, c.class_label AS class_label, c.level AS level, c.summary AS summary, c.updated_at AS updated_at
       FROM campaign_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN characters c ON c.id = m.character_id
       WHERE m.campaign_id = ?
       ORDER BY m.joined_at`
    )
      .bind(id)
      .all();
    rows = q.results;
  } catch {
    const q = await env.DB.prepare(
      `SELECT m.user_id AS user_id, u.email AS email, m.character_id AS character_id,
              c.name AS cname, c.class_label AS class_label, c.level AS level, NULL AS summary, c.updated_at AS updated_at
       FROM campaign_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN characters c ON c.id = m.character_id
       WHERE m.campaign_id = ?`
    )
      .bind(id)
      .all();
    rows = q.results;
  }
  return json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      role,
      joinCode: campaign.join_code,
      hasWebhook: !!campaign.webhook_url,
      webhookMasked: maskWebhook(campaign.webhook_url),
    },
    members: rows.map((r) => {
      let summary = null;
      try { summary = r.summary ? JSON.parse(r.summary) : null; } catch { /* ignore */ }
      return {
        userId: r.user_id,
        email: r.email,
        characterId: r.character_id,
        name: r.cname,
        classLabel: r.class_label,
        level: r.level,
        updatedAt: r.updated_at,
        summary,
      };
    }),
  });
}

async function handleUpdateCampaign(request, env, user, id) {
  const { campaign, role } = await getCampaignRole(env, id, user.id);
  if (!campaign || role !== "gm") return json({ error: "Кампания не найдена." }, 404);
  const body = await readJson(request);
  if (!body) return json({ error: "Некорректное тело запроса." }, 400);
  let name = campaign.name;
  let webhook = campaign.webhook_url;
  if (typeof body.name === "string" && body.name.trim()) name = body.name.trim().slice(0, 100);
  if (typeof body.webhookUrl === "string") {
    const w = body.webhookUrl.trim();
    if (w === "") webhook = null;
    else if (WEBHOOK_RE.test(w)) webhook = w;
    else return json({ error: "Это не похоже на ссылку Discord webhook (https://discord.com/api/webhooks/…)." }, 400);
  }
  await env.DB.prepare("UPDATE campaigns SET name = ?, webhook_url = ? WHERE id = ?").bind(name, webhook, id).run();
  return json({ ok: true, hasWebhook: !!webhook, webhookMasked: maskWebhook(webhook), name });
}

async function handleDeleteCampaign(request, env, user, id) {
  const { campaign, role } = await getCampaignRole(env, id, user.id);
  if (!campaign || role !== "gm") return json({ error: "Кампания не найдена." }, 404);
  await env.DB.prepare("DELETE FROM campaign_members WHERE campaign_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function handleSetMyCharacter(request, env, user, id) {
  const { campaign, role } = await getCampaignRole(env, id, user.id);
  if (!campaign || role !== "player") return json({ error: "Вы не участвуете в этой кампании." }, 404);
  const body = await readJson(request);
  const characterId = body && typeof body.characterId === "string" && body.characterId ? body.characterId : null;
  if (characterId) {
    const ch = await env.DB.prepare("SELECT id FROM characters WHERE id = ? AND user_id = ?").bind(characterId, user.id).first();
    if (!ch) return json({ error: "Персонаж не найден." }, 404);
  }
  await env.DB.prepare("UPDATE campaign_members SET character_id = ? WHERE campaign_id = ? AND user_id = ?")
    .bind(characterId, id, user.id)
    .run();
  return json({ ok: true });
}

async function handleLeaveCampaign(request, env, user, id) {
  await env.DB.prepare("DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

async function handleKickMember(request, env, user, id, memberId) {
  const { campaign, role } = await getCampaignRole(env, id, user.id);
  if (!campaign || role !== "gm") return json({ error: "Кампания не найдена." }, 404);
  await env.DB.prepare("DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?").bind(id, memberId).run();
  return json({ ok: true });
}

// Дубль броска в Discord: webhook хранится только на сервере и игрокам не отдаётся.
async function handleCampaignRoll(request, env, user, id, ctx) {
  const { campaign, role } = await getCampaignRole(env, id, user.id);
  if (!campaign || !role) return json({ error: "Кампания не найдена." }, 404);
  if (!campaign.webhook_url) return json({ ok: true, sent: false });
  const body = await readJson(request);
  if (!body) return json({ error: "Некорректное тело запроса." }, 400);
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const payload = {
    username: str(body.characterName || "Герой", 80) || "Герой",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: str(body.label, 250) || "Бросок",
        description: str(body.detail, 1500),
        color: body.isCrit ? 0x2ecc71 : body.isFumble ? 0xe74c3c : 0x8e44ad,
        fields: [{ name: "Результат", value: str(body.total, 100) || "—", inline: true }],
      },
    ],
  };
  const post = fetch(campaign.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(post);
  else await post;
  return json({ ok: true, sent: true });
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      let response;

      if (path === "/api/register" && request.method === "POST") {
        response = await handleRegister(request, env);
      } else if (path === "/api/login" && request.method === "POST") {
        response = await handleLogin(request, env);
      } else if (path.startsWith("/api/")) {
        // everything below requires auth
        const user = await getUserFromRequest(request, env);
        if (!user) {
          response = json({ error: "Требуется авторизация." }, 401);
        } else if (user.blocked) {
          response = json({ error: "Доступ закрыт владельцем.", code: "BLOCKED" }, 403);
        } else if (
          user.role === "player" &&
          !["/api/logout", "/api/me", "/api/campaigns", "/api/campaigns/join"].includes(path) &&
          !(await playerHasAccess(env, user.id))
        ) {
          response = json({ error: "Нет доступа: вы не состоите ни в одной кампании. Введите код приглашения мастера.", code: "NO_CAMPAIGN" }, 403);
        } else if (path === "/api/admin/users" && request.method === "GET" && user.role === "owner") {
          response = await handleAdminListUsers(request, env, user);
        } else if (/^\/api\/admin\/users\/[a-zA-Z0-9-]+$/.test(path) && request.method === "PUT" && user.role === "owner") {
          response = await handleAdminUpdateUser(request, env, user, path.split("/").pop());
        } else if (path === "/api/logout" && request.method === "POST") {
          response = await handleLogout(request, env, user);
        } else if (path === "/api/me" && request.method === "GET") {
          response = await handleMe(request, env, user);
        } else if (path === "/api/characters" && request.method === "GET") {
          response = await handleListCharacters(request, env, user);
        } else if (path === "/api/characters" && request.method === "POST") {
          response = await handleCreateCharacter(request, env, user);
        } else if (path === "/api/campaigns" && request.method === "GET") {
          response = await handleListCampaigns(request, env, user);
        } else if (path === "/api/campaigns" && request.method === "POST") {
          response = await handleCreateCampaign(request, env, user);
        } else if (path === "/api/campaigns/join" && request.method === "POST") {
          response = await handleJoinCampaign(request, env, user);
        } else if (/^\/api\/campaigns\//.test(path)) {
          const m = path.match(/^\/api\/campaigns\/([a-zA-Z0-9-]+)(?:\/([a-z]+)(?:\/([a-zA-Z0-9-]+))?)?$/);
          if (!m) response = json({ error: "Not found." }, 404);
          else if (!m[2] && request.method === "GET") response = await handleGetCampaign(request, env, user, m[1]);
          else if (!m[2] && request.method === "PUT") response = await handleUpdateCampaign(request, env, user, m[1]);
          else if (!m[2] && request.method === "DELETE") response = await handleDeleteCampaign(request, env, user, m[1]);
          else if (m[2] === "character" && request.method === "PUT") response = await handleSetMyCharacter(request, env, user, m[1]);
          else if (m[2] === "membership" && request.method === "DELETE") response = await handleLeaveCampaign(request, env, user, m[1]);
          else if (m[2] === "members" && m[3] && request.method === "DELETE") response = await handleKickMember(request, env, user, m[1], m[3]);
          else if (m[2] === "roll" && request.method === "POST") response = await handleCampaignRoll(request, env, user, m[1], ctx);
          else response = json({ error: "Not found." }, 404);
        } else {
          const match = path.match(/^\/api\/characters\/([a-zA-Z0-9-]+)$/);
          if (match && request.method === "GET") {
            response = await handleGetCharacter(request, env, user, match[1]);
          } else if (match && request.method === "PUT") {
            response = await handleUpdateCharacter(request, env, user, match[1]);
          } else if (match && request.method === "DELETE") {
            response = await handleDeleteCharacter(request, env, user, match[1]);
          } else {
            response = json({ error: "Not found." }, 404);
          }
        }
      } else {
        response = json({ error: "Not found." }, 404);
      }

      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    } catch (err) {
      return json({ error: "Внутренняя ошибка сервера.", detail: String(err && err.message || err) }, 500, cors);
    }
  },
};
