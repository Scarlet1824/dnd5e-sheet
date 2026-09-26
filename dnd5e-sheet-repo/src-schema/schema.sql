-- D&D 5e Character Sheet — Cloudflare D1 schema
-- Paste this into the D1 "Console" tab in the Cloudflare dashboard and run it once
-- against your newly created database.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,             -- hex(sha256(salt + password)), see worker/auth.js
  salt          TEXT NOT NULL,             -- hex, random per user
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,             -- random 32-byte hex token, sent as Bearer token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS characters (
  id          TEXT PRIMARY KEY,            -- uuid
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'Безымянный герой',
  edition     TEXT NOT NULL DEFAULT '2014',  -- '2014' | '2024'
  class_label TEXT NOT NULL DEFAULT '',      -- denormalized "Класс уровня N" for the list view
  level       INTEGER NOT NULL DEFAULT 1,
  data        TEXT NOT NULL,                 -- full character sheet as JSON, see worker/sheetSchema.js
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);

-- Roll log is intentionally NOT persisted server-side (client-only, like the Daggerheart
-- reference app) to keep writes cheap. Revisit if the user wants cross-device roll history.
