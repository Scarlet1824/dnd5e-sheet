-- Раунд 81: управление доступом. Выполнить один раз в D1 Console.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';  -- 'active' | 'blocked'
ALTER TABLE users ADD COLUMN is_gm INTEGER NOT NULL DEFAULT 0;       -- 1 = мастер (может создавать кампании)
