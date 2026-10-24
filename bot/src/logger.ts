// Logger JSON em linhas, com redação de segredos (tokens do Discord e keys JKO1).
import type { LogLevel } from './config.js'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const PATTERNS: RegExp[] = [
  /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, // token de bot
  /JKO1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g // key de licença do JK Optimize
]

export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('[REDACTED]')
  for (const p of PATTERNS) out = out.replace(p, '[REDACTED]')
  return out
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

export interface LoggerOptions {
  level: LogLevel
  secrets?: readonly string[]
  write?: (line: string) => void
}

export function createLogger({ level, secrets = [], write = (l) => process.stdout.write(`${l}\n`) }: LoggerOptions): Logger {
  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...data }, (_k, v: unknown) =>
      v instanceof Error ? v.message : v
    )
    write(redactText(line, secrets))
  }
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d)
  }
}
