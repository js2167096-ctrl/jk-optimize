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
  }
]
