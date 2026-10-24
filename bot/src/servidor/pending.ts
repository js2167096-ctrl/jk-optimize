import { randomBytes } from 'node:crypto'

export type PendingAction =
  | { kind: 'apply'; userId: string; guildId: string; templateId: string }
  | { kind: 'undo'; userId: string; guildId: string; batchId: number }

interface Entry {
  action: PendingAction
  expiresAt: number
}

/** Confirmações pendentes em memória: expiram e só valem para quem as pediu. */
export class PendingStore {
  private entries = new Map<string, Entry>()
  constructor(private readonly ttlMs = 5 * 60_000) {}

  create(action: PendingAction, now = Date.now()): string {
    this.sweep(now)
    const token = randomBytes(9).toString('base64url')
    this.entries.set(token, { action, expiresAt: now + this.ttlMs })
    return token
  }

  /** Retorna e consome a ação, se ainda válida. */
  take(token: string, userId: string, now = Date.now()): PendingAction | null {
    const e = this.entries.get(token)
    if (!e || e.expiresAt < now || e.action.userId !== userId) return null
    this.entries.delete(token)
    return e.action
  }

  discard(token: string, userId: string): boolean {
    const e = this.entries.get(token)
    if (!e || e.action.userId !== userId) return false
    this.entries.delete(token)
    return true
  }

  private sweep(now: number): void {
    for (const [k, e] of this.entries) if (e.expiresAt < now) this.entries.delete(k)
  }
}

export const pending = new PendingStore()
