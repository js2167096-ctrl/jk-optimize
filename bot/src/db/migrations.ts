// Migrações versionadas. Nunca edite uma migração já publicada: adicione uma nova.
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'fundacao',
    sql: `
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        guild_id TEXT,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_audit_ts ON audit_log (ts);
      CREATE INDEX idx_audit_guild ON audit_log (guild_id, ts);
      CREATE INDEX idx_audit_actor ON audit_log (actor_id, ts);
    `
  },
  {
    version: 2,
    name: 'lotes-de-alteracoes',
    sql: `
      CREATE TABLE change_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applying','applied','partial','undone')),
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_batches_guild ON change_batches (guild_id, id);
      CREATE TABLE change_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL REFERENCES change_batches(id),
        kind TEXT NOT NULL CHECK (kind IN ('role','category','channel')),
        discord_id TEXT NOT NULL,
        name TEXT NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_items_batch ON change_items (batch_id, id);
    `
  }
]
