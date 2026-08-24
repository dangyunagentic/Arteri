// Arteri database — bun:sqlite, WAL, single file under DATA_DIR.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const DATA_DIR = process.env.DATA_DIR?.trim() || "./data";
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "arteri.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v2: a provider row is now a CONNECTION to a catalog provider (slug).
-- Legacy custom providers (catalog='custom') keep base_url + api_key inline.
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  catalog TEXT NOT NULL DEFAULT 'custom',   -- catalog id from catalog.ts
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT 'openai' CHECK (protocol IN ('openai','anthropic')),
  extra_headers TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  UNIQUE(provider_id, upstream_id)
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE, -- null for combo refs? no: combos live separately; keep nullable for safety
  upstream_id TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,           -- what clients send as "model"
  thinking_supported INTEGER NOT NULL DEFAULT 0,
  min_thinking INTEGER NOT NULL DEFAULT 0,  -- clamps for reasoning effort / budget_tokens
  max_thinking INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
DELETE FROM models WHERE provider_id IS NULL;

-- combos: ordered fallback / round-robin / weighted chains exposed as one model id
CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'fallback' CHECK (strategy IN ('fallback','round_robin','weighted')),
  enabled INTEGER NOT NULL DEFAULT 1,
  rr_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS combo_models (
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,                -- priority order (fallback) / cycle order (rr)
  target TEXT NOT NULL,                     -- "<providerSlug>:<upstreamId>" or nested "<comboPublicId>"
  weight INTEGER NOT NULL DEFAULT 100,      -- weighted strategy only
  PRIMARY KEY (combo_id, position)
);

CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,               -- sk-arteri-...
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  limit_total INTEGER,                      -- cumulative token cap (null = unlimited)
  used_total INTEGER NOT NULL DEFAULT 0,
  rpm INTEGER,                              -- requests per minute (null = unlimited)
  allowed_models TEXT NOT NULL DEFAULT '[]',-- JSON array of public_ids; [] = all
  share_slug TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER REFERENCES keys(id) ON DELETE CASCADE,
  model TEXT NOT NULL,                      -- public_id as requested (combo id stays combo id)
  resolved_model TEXT NOT NULL DEFAULT '',  -- actual upstream model that served it
  provider_slug TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 200,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_key_ts ON usage(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);

-- per-connection quota snapshots (fetched from upstream usage APIs where supported)
CREATE TABLE IF NOT EXISTS quota (
  connection_id INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL DEFAULT '',     -- e.g. five_hour | daily | weekly | monthly
  used INTEGER,                             -- tokens or requests depending on provider semantics
  total INTEGER,
  remaining INTEGER,
  resets_at INTEGER,                        -- unix ms
  fetched_at INTEGER NOT NULL
);
`);

// legacy DBs may lack v2 columns/tables — best-effort migration
try {
  db.exec("ALTER TABLE providers ADD COLUMN catalog TEXT NOT NULL DEFAULT 'custom'");
} catch {
  /* column exists */
}
for (const stmt of [
  "ALTER TABLE providers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'apikey'", // apikey|oauth
  "ALTER TABLE providers ADD COLUMN email TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE providers ADD COLUMN tokens TEXT NOT NULL DEFAULT ''", // encrypted-at-rest-ish JSON blob (access/refresh/expires)
]) {
  try {
    db.exec(stmt);
  } catch {
    /* exists */
  }
}

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string) {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
