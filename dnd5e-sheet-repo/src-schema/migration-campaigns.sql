-- Миграция «Кампании» (раунд 80): выполнить один раз в консоли D1 (после schema.sql).
-- Если ALTER выдаёт "duplicate column name: summary" — колонка уже есть, просто выполните остальные запросы.
ALTER TABLE characters ADD COLUMN summary TEXT;

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- мастер
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,                                  -- код для игроков
  webhook_url TEXT,                                                  -- Discord webhook (виден только мастеру)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_owner ON campaigns(owner_id);

CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON campaign_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_character ON campaign_members(character_id);
