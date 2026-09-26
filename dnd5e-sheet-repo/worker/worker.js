/**
 * D&D 5e Character Sheet — Cloudflare Worker API
 *
 * Single-file, zero-dependency Worker (paste directly into the Cloudflare
 * dashboard's Worker code editor — no build step, no npm).
 *
 * Bindings required (set in the dashboard under Worker → Settings → Variables):
 *   - D1 database binding named `DB`   (Settings → Bindings → D1 Database)
 *   - Variable `ALLOWED_ORIGIN`        (e.g. https://your-pages-app.pages.dev)
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

async function getUserFromRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT s.user_id as user_id, s.expires_at as expires_at, u.id as id, u.email as email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  )
    .bind(token)
    .first();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { id: row.id, email: row.email, token };
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

  const salt = randomHex(16);
  const passwordHash = await hashPassword(body.password, salt);
  const userId = uuid();

  await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, ?, ?)")
    .bind(userId, email, passwordHash, salt)
    .run();

  return startSession(env, userId, email);
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body || !isValidEmail(body.email) || typeof body.password !== "string") {
    return json({ error: "Укажите email и пароль." }, 400);
  }
  const email = body.email.toLowerCase().trim();

  const user = await env.DB.prepare("SELECT id, email, password_hash, salt FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (!user) return json({ error: "Неверный email или пароль." }, 401);

  const attemptedHash = await hashPassword(body.password, user.salt);
  if (!timingSafeEqual(attemptedHash, user.password_hash)) {
    return json({ error: "Неверный email или пароль." }, 401);
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
  return json({ user: { id: user.id, email: user.email } });
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
  return json({ character: characterRowToJson(row) });
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

  await env.DB.prepare(
    `UPDATE characters
     SET name = ?, edition = ?, class_label = ?, level = ?, data = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`
  )
    .bind(name, edition, classLabel, level, JSON.stringify(data), id, user.id)
    .run();

  const row = await env.DB.prepare("SELECT * FROM characters WHERE id = ?").bind(id).first();
  return json({ character: characterRowToJson(row) });
}

async function handleDeleteCharacter(request, env, user, id) {
  await env.DB.prepare("DELETE FROM characters WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

// ---------- router ----------

export default {
  async fetch(request, env) {
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
        } else if (path === "/api/logout" && request.method === "POST") {
          response = await handleLogout(request, env, user);
        } else if (path === "/api/me" && request.method === "GET") {
          response = await handleMe(request, env, user);
        } else if (path === "/api/characters" && request.method === "GET") {
          response = await handleListCharacters(request, env, user);
        } else if (path === "/api/characters" && request.method === "POST") {
          response = await handleCreateCharacter(request, env, user);
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
