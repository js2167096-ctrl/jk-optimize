// Diário de alterações feitas pelo JK Optimize, com backup do estado anterior.
// Cada backup é gravado uma única vez (sem sobrescrita) e tem SHA-256 registrado,
// conferido antes de qualquer reversão. Módulo puro: recebe a pasta base.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeRecord, ChangeStatus, OpModule } from '../../shared/types/ops'

export const MAX_CHANGES = 500

export interface BackupFile {
  formatVersion: 1
  id: string
  actionId: string
  createdAt: string
  before: unknown
  after: unknown
}

export class BackupIntegrityError extends Error {}

export interface NewChange {
  actionId: string
  module: OpModule
  title: string
  summaryBefore: string
  summaryAfter: string
  reversible: boolean
  before: unknown
  after: unknown
}

export class Journal {
  private readonly baseDir: () => string

  constructor(baseDir: () => string) {
    this.baseDir = baseDir
  }

  private get indexFile(): string {
    return join(this.baseDir(), 'index.json')
  }

  private backupFile(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new BackupIntegrityError('Identificador de alteração inválido.')
    return join(this.baseDir(), 'backups', `${id}.json`)
  }

  list(): ChangeRecord[] {
    if (!existsSync(this.indexFile)) return []
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8').replace(/^﻿/, ''))
      return Array.isArray(raw) ? (raw as ChangeRecord[]).filter((r) => r && r.formatVersion === 1) : []
    } catch {
      return []
    }
  }

  get(id: string): ChangeRecord | undefined {
    return this.list().find((r) => r.id === id)
  }

  private writeIndex(records: ChangeRecord[]): void {
    mkdirSync(this.baseDir(), { recursive: true })
    const tmp = `${this.indexFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8')
    renameSync(tmp, this.indexFile)
  }

  add(change: NewChange): ChangeRecord {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const backup: BackupFile = { formatVersion: 1, id, actionId: change.actionId, createdAt, before: change.before, after: change.after }
    const content = JSON.stringify(backup, null, 2)
    mkdirSync(join(this.baseDir(), 'backups'), { recursive: true })
    // 'wx': falha se o arquivo já existir, protegendo contra sobrescrita acidental.
    writeFileSync(this.backupFile(id), content, { encoding: 'utf8', flag: 'wx' })
    const record: ChangeRecord = {
      id,
      formatVersion: 1,
      actionId: change.actionId,
      module: change.module,
      title: change.title,
      createdAt,
      summaryBefore: change.summaryBefore,
      summaryAfter: change.summaryAfter,
      reversible: change.reversible,
      status: 'applied',
      revertedAt: null,
      revertError: null,
      backupSha256: createHash('sha256').update(content).digest('hex')
    }
    let records = [record, ...this.list()]
    if (records.length > MAX_CHANGES) {
      // Remove primeiro os mais antigos já revertidos ou irreversíveis.
      const removable = records.filter((r) => r.status !== 'applied' || !r.reversible).reverse()
      while (records.length > MAX_CHANGES && removable.length > 0) {
        const drop = removable.shift()!
        records = records.filter((r) => r.id !== drop.id)
        rmSync(this.backupFile(drop.id), { force: true })
      }
    }
    this.writeIndex(records)
    return record
  }

  /** Lê o backup conferindo o SHA-256 registrado. */
  readBackup(id: string): BackupFile {
    const record = this.get(id)
    if (!record) throw new BackupIntegrityError('Alteração não encontrada no diário.')
    const file = this.backupFile(id)
    if (!existsSync(file)) throw new BackupIntegrityError('O backup desta alteração não existe mais.')
    const content = readFileSync(file, 'utf8')
    if (createHash('sha256').update(content).digest('hex') !== record.backupSha256) {
      throw new BackupIntegrityError('O backup foi modificado ou está corrompido. A reversão foi bloqueada.')
    }
    const parsed = JSON.parse(content) as BackupFile
    if (parsed.formatVersion !== 1 || parsed.id !== id || parsed.actionId !== record.actionId) {
      throw new BackupIntegrityError('O backup não corresponde a esta alteração.')
    }
    return parsed
  }

  setStatus(id: string, status: ChangeStatus, error: string | null = null): ChangeRecord {
    const records = this.list()
    const record = records.find((r) => r.id === id)
    if (!record) throw new BackupIntegrityError('Alteração não encontrada no diário.')
    record.status = status
    record.revertedAt = status === 'reverted' ? new Date().toISOString() : record.revertedAt
    record.revertError = error
    this.writeIndex(records)
    return record
  }
}
