import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactText } from '../logger.js'
import { MIGRATIONS, type Migration } from './migrations.js'

export type Db = DatabaseSync

/** Abre (criando se preciso) o banco e aplica as migrações pendentes. Use ':memory:' em testes. */
export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  migrate(db, migrations)
  return db
}

export function migrate(db: Db, migrations: readonly Migration[]): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
  const current = schemaVersion(db)
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  for (const m of sorted) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`Falha na migração ${m.version} (${m.name}): ${(error as Error).message}`)
    }
  }
  return schemaVersion(db)
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  return row.v ?? 0
}

export interface AuditEntry {
  guildId: string | null
  actorId: string
  action: string
  target?: string | null
  outcome: 'ok' | 'denied' | 'error'
  details?: Record<string, unknown>
}

/** Registra quem fez o quê. Detalhes passam pela redação de segredos antes de gravar. */
export function writeAudit(db: Db, entry: AuditEntry): void {
  const details = redactText(JSON.stringify(entry.details ?? {}))
  db.prepare('INSERT INTO audit_log (ts, guild_id, actor_id, action, target, outcome, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    entry.guildId,
    entry.actorId,
    entry.action,
    entry.target ?? null,
    entry.outcome,
    details
  )
}
