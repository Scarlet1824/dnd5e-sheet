// Local smoke test for worker.js against an in-memory mock of Cloudflare D1.
// Run with: node worker/test-worker.mjs
import worker from "./worker.js";

function makeMockDB() {
  const users = [];
  const sessions = [];
  const characters = [];
  const campaigns = [];
  const members = [];

  function prepare(sql) {
    let bound = [];
    const api = {
      bind(...args) { bound = args; return api; },
      async first() {
        const r = run();
        return r[0] || null;
      },
      async all() {
        return { results: run() };
      },
      async run() {
        run();
        return { success: true };
      },
    };

    function run() {
      const s = sql.trim();
      if (s.startsWith("SELECT c.id AS id, COALESCE(o.status")) {
        const c = campaigns.find((x) => x.join_code === bound[0]);
        if (!c) return [];
        const o = users.find((u) => u.id === c.owner_id);
        return [{ id: c.id, ostatus: o.status || "active" }];
      }
      if (s.startsWith("INSERT OR IGNORE INTO campaign_members")) {
        if (!members.find((m) => m.campaign_id === bound[0] && m.user_id === bound[1])) members.push({ campaign_id: bound[0], user_id: bound[1] });
        return [];
      }
      if (s.includes("FROM campaign_members m") && s.includes("JOIN campaigns c ON c.id = m.campaign_id") && s.includes("JOIN users o")) {
        return members.filter((m) => m.user_id === bound[0]).filter((m) => {
          const c = campaigns.find((x) => x.id === m.campaign_id);
          const o = users.find((u) => u.id === c.owner_id);
          return (o.status || "active") !== "blocked";
        }).slice(0, 1).map(() => ({ ok: 1 }));
      }
      if (s.startsWith("SELECT id, email FROM users WHERE id")) return users.filter((u) => u.id === bound[0]);
      if (s.startsWith("UPDATE users SET status")) { const u = users.find((x) => x.id === bound[1]); if (u) u.status = bound[0]; return []; }
      if (s.startsWith("UPDATE users SET is_gm")) { const u = users.find((x) => x.id === bound[1]); if (u) u.is_gm = bound[0]; return []; }
      if (s.startsWith("DELETE FROM sessions WHERE user_id")) { for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].user_id === bound[0]) sessions.splice(i, 1); return []; }
      if (s.startsWith("SELECT id, email, password_hash, salt, status FROM users WHERE email")) return users.filter((u) => u.email === bound[0]);
      if (s.startsWith("SELECT id FROM users WHERE email")) {
        return users.filter((u) => u.email === bound[0]);
      }
      if (s.startsWith("INSERT INTO users")) {
        const [id, email, password_hash, salt] = bound;
        users.push({ id, email, password_hash, salt, created_at: new Date().toISOString() });
        return [];
      }
      if (s.startsWith("SELECT id, email, password_hash, salt FROM users WHERE email")) {
        return users.filter((u) => u.email === bound[0]);
      }
      if (s.startsWith("INSERT INTO sessions")) {
        const [token, user_id, expires_at] = bound;
        sessions.push({ token, user_id, expires_at });
        return [];
      }
      if (s.includes("FROM sessions s JOIN users u")) {
        const token = bound[0];
        const sess = sessions.find((x) => x.token === token);
        if (!sess) return [];
        const u = users.find((x) => x.id === sess.user_id);
        if (!u) return [];
        return [{ user_id: u.id, expires_at: sess.expires_at, id: u.id, email: u.email, status: u.status || "active", is_gm: u.is_gm || 0 }];
      }
      if (s.startsWith("DELETE FROM sessions")) {
        const idx = sessions.findIndex((x) => x.token === bound[0]);
        if (idx >= 0) sessions.splice(idx, 1);
        return [];
      }
      if (s.startsWith("INSERT INTO characters")) {
        const [id, user_id, name, edition, class_label, level, data] = bound;
        characters.push({ id, user_id, name, edition, class_label, level, data, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        return [];
      }
      if (s.startsWith("SELECT * FROM characters WHERE id = ? AND user_id")) {
        return characters.filter((c) => c.id === bound[0] && c.user_id === bound[1]);
      }
      if (s.startsWith("SELECT * FROM characters WHERE id")) {
        return characters.filter((c) => c.id === bound[0]);
      }
      if (s.startsWith("SELECT * FROM characters WHERE user_id")) {
        return characters.filter((c) => c.user_id === bound[0]).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      }
      if (s.startsWith("SELECT id FROM characters WHERE id = ? AND user_id")) {
        return characters.filter((c) => c.id === bound[0] && c.user_id === bound[1]);
      }
      if (s.startsWith("UPDATE characters")) {
        const hasSum = bound.length === 8;
        const [name, edition, class_label, level, data] = bound;
        const [id, user_id] = bound.slice(hasSum ? 6 : 5);
        const c = characters.find((x) => x.id === id && x.user_id === user_id);
        if (c) Object.assign(c, { name, edition, class_label, level, data, updated_at: new Date().toISOString() });
        return [];
      }
      if (s.startsWith("DELETE FROM characters")) {
        const idx = characters.findIndex((x) => x.id === bound[0] && x.user_id === bound[1]);
        if (idx >= 0) characters.splice(idx, 1);
        return [];
      }
      throw new Error("Unhandled SQL in mock: " + s);
    }
    return api;
  }

  return { prepare, _debug: { users, sessions, characters, campaigns, members } };
}

const env = { DB: makeMockDB(), ALLOWED_ORIGIN: "*", OWNER_EMAIL: "gm@example.com" };

function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new Request(`https://worker.test${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  let failures = 0;
  const assert = (cond, msg) => {
    if (!cond) { console.error("FAIL:", msg); failures++; }
    else console.log("ok:", msg);
  };

  // Register
  let res = await worker.fetch(req("POST", "/api/register", { email: "gm@example.com", password: "supersecret1" }), env);
  let body = await res.json();
  assert(res.status === 200, "register returns 200");
  assert(!!body.token, "register returns a token");
  const token = body.token;

  // Duplicate register should fail
  res = await worker.fetch(req("POST", "/api/register", { email: "gm@example.com", password: "supersecret1" }), env);
  assert(res.status === 409, "duplicate register rejected with 409");

  // Wrong password login
  res = await worker.fetch(req("POST", "/api/login", { email: "gm@example.com", password: "wrongpass" }), env);
  assert(res.status === 401, "wrong password rejected");

  // Correct login
  res = await worker.fetch(req("POST", "/api/login", { email: "gm@example.com", password: "supersecret1" }), env);
  body = await res.json();
  assert(res.status === 200 && !!body.token, "correct login succeeds");

  // No auth -> 401
  res = await worker.fetch(req("GET", "/api/characters"), env);
  assert(res.status === 401, "unauthenticated request rejected");

  // Create character
  res = await worker.fetch(
    req("POST", "/api/characters", { name: "Тестовый Герой", edition: "2014", data: { classes: [{ name: "Воин", level: 3 }] } }, token),
    env
  );
  body = await res.json();
  assert(res.status === 201, "create character returns 201");
  assert(body.character.level === 3, "character level summarized from classes");
  const charId = body.character.id;

  // List characters
  res = await worker.fetch(req("GET", "/api/characters", undefined, token), env);
  body = await res.json();
  assert(body.characters.length === 1, "list returns 1 character");

  // Get single character
  res = await worker.fetch(req("GET", `/api/characters/${charId}`, undefined, token), env);
  assert(res.status === 200, "get character by id works");

  // Update character
  res = await worker.fetch(
    req("PUT", `/api/characters/${charId}`, { name: "Обновлённый Герой", edition: "2014", data: { classes: [{ name: "Воин", level: 4 }] } }, token),
    env
  );
  body = await res.json();
  assert(body.character.name === "Обновлённый Герой" && body.character.level === 4, "update character persists changes");

  // Another user cannot access this character
  res = await worker.fetch(req("POST", "/api/register", { email: "player@example.com", password: "supersecret2" }), env);
  assert(res.status === 403, "register without invite code rejected");
  const ownerId = env.DB._debug.users.find((u) => u.email === "gm@example.com").id;
  env.DB._debug.campaigns.push({ id: "camp1", owner_id: ownerId, name: "T", join_code: "ABC234" });
  res = await worker.fetch(req("POST", "/api/register", { email: "player@example.com", password: "supersecret2", inviteCode: "abc234" }), env);
  assert(res.status === 200, "register with valid invite code works");
  const otherToken = (await res.json()).token;
  res = await worker.fetch(req("GET", `/api/characters/${charId}`, undefined, otherToken), env);
  assert(res.status === 404, "other user cannot read this character");

  // Access control
  const playerId = env.DB._debug.users.find((u) => u.email === "player@example.com").id;
  res = await worker.fetch(req("POST", "/api/campaigns", { name: "X" }, otherToken), env);
  assert(res.status === 403, "player cannot create campaign");
  res = await worker.fetch(req("GET", "/api/admin/users", undefined, otherToken), env);
  assert(res.status !== 200, "player cannot use admin API");
  res = await worker.fetch(req("PUT", `/api/admin/users/${playerId}`, { status: "blocked" }, token), env);
  assert(res.status === 200, "owner blocks player");
  res = await worker.fetch(req("GET", "/api/characters", undefined, otherToken), env);
  assert(res.status === 401 || res.status === 403, "blocked player loses access");
  res = await worker.fetch(req("POST", "/api/login", { email: "player@example.com", password: "supersecret2" }), env);
  assert(res.status === 403, "blocked player cannot log in");
  await worker.fetch(req("PUT", `/api/admin/users/${playerId}`, { status: "active" }, token), env);
  res = await worker.fetch(req("POST", "/api/login", { email: "player@example.com", password: "supersecret2" }), env);
  const t2 = (await res.json()).token;
  res = await worker.fetch(req("GET", "/api/characters", undefined, t2), env);
  assert(res.status === 200, "unblocked player has access again");
  env.DB._debug.members.length = 0;
  res = await worker.fetch(req("GET", "/api/characters", undefined, t2), env);
  assert(res.status === 403, "player without campaign has no access");
  res = await worker.fetch(req("PUT", `/api/admin/users/${playerId}`, { isGm: true }, token), env);
  res = await worker.fetch(req("GET", "/api/characters", undefined, t2), env);
  assert(res.status === 200, "GM has access without membership");

  // Delete character
  res = await worker.fetch(req("DELETE", `/api/characters/${charId}`, undefined, token), env);
  assert(res.status === 200, "delete character succeeds");
  res = await worker.fetch(req("GET", "/api/characters", undefined, token), env);
  body = await res.json();
  assert(body.characters.length === 0, "character list empty after delete");

  // CORS preflight
  res = await worker.fetch(new Request("https://worker.test/api/characters", { method: "OPTIONS" }), env);
  assert(res.status === 204, "OPTIONS preflight returns 204");

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
