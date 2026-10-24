// Logs estruturados (NDJSON, um arquivo por dia) com retenção e limite de tamanho.
// Segredos são removidos antes da gravação.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LogEntry, LogLevel, LogQuery } from '@shared/types/ops'
import { dataPath } from '../services/store'
import { redactText } from './redact'

const RETENTION_DAYS = 14
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_QUERY = 1000

const logDir = () => dataPath('logs')
const dayFile = (date: Date) => join(logDir(), `${date.toISOString().slice(0, 10)}.ndjson`)

let lastCleanup = 0

function cleanup(): void {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return
  lastCleanup = Date.now()
  const limit = Date.now() - RETENTION_DAYS * 86_400_000
  for (const name of readdirSync(logDir())) {
    const match = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name)
    if (match && new Date(match[1]).getTime() < limit) rmSync(join(logDir(), name), { force: true })
  }
}

export function writeLog(entry: Omit<LogEntry, 'ts'>): void {
  try {
    mkdirSync(logDir(), { recursive: true })
    const file = dayFile(new Date())
    if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) return
    const line: LogEntry = { ...entry, ts: new Date().toISOString(), message: redactText(entry.message).slice(0, 4000) }
    appendFileSync(file, JSON.stringify(line) + '\n', 'utf8')
    cleanup()
  } catch (error) {
    console.error('[log] falha ao gravar:', error)
  }
}

export const log = {
  info: (module: string, message: string, extra: Partial<LogEntry> = {}) => writeLog({ level: 'info', module, message, ...extra }),
  warn: (module: string, message: string, extra: Partial<LogEntry> = {}) => writeLog({ level: 'warn', module, message, ...extra }),
  error: (module: string, message: string, extra: Partial<LogEntry> = {}) => writeLog({ level: 'error', module, message, ...extra })
}

export function queryLogs(q: LogQuery): LogEntry[] {
  if (!existsSync(logDir())) return []
  const days = Math.min(Math.max(q.fromDays ?? 7, 1), RETENTION_DAYS)
  const limit = Math.min(Math.max(q.limit ?? 300, 1), MAX_QUERY)
  const text = q.text?.toLowerCase().trim()
  const out: LogEntry[] = []
  for (let d = 0; d < days && out.length < limit; d++) {
    const file = dayFile(new Date(Date.now() - d * 86_400_000))
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      let entry: LogEntry
      try {
        entry = JSON.parse(line) as LogEntry
      } catch {
        continue
      }
      if (q.module && entry.module !== q.module) continue
      if (q.level && entry.level !== (q.level as LogLevel)) continue
      if (text && !`${entry.message} ${entry.module} ${entry.actionId ?? ''}`.toLowerCase().includes(text)) continue
      out.push(entry)
      if (out.length >= limit) break
    }
  }
  return out
}
