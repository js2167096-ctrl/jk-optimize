// Registro central de consultas e ações. É a lista permitida: o renderer só
// consegue pedir operações registradas aqui, pelo identificador, e os parâmetros
// são validados por cada definição.
//
// Regras aplicadas a TODAS as ações:
// - pré-visualização obrigatória: a execução usa o previewId devolvido pela
//   pré-visualização, com os mesmos parâmetros e prazo de validade;
// - confirmação explícita para qualquer risco diferente de 'none';
// - exclusão mútua por grupo (evita execuções duplicadas incompatíveis);
// - registro no diário de alterações (com backup) e nos logs.
import { createHash, randomUUID } from 'node:crypto'
import type { TaskDetailSection } from '@shared/types'
import type {
  ActionDescriptor,
  ActionOutcome,
  ActionPreview,
  ChangeLine,
  ChangeRecord,
  JobProgress,
  OpAccess,
  OpModule,
  OpRisk
} from '@shared/types/ops'
import { AppFailure, ValidationError } from '../security/validate'
import { dataPath } from '../services/store'
import { BackupIntegrityError, Journal } from './journal'
import { log } from './log'
import { redactValue } from './redact'

export interface OpContext {
  signal: AbortSignal
  jobId: string | null
  progress(message: string, done?: number, total?: number | null, data?: unknown): void
}

export interface QueryDef<P = unknown, R = unknown> {
  id: string
  module: OpModule
  access?: OpAccess
  parse: (raw: unknown) => P
  run: (params: P, ctx: OpContext) => Promise<R>
}

export interface PreviewBody {
  summary: string
  changes: ChangeLine[]
  warnings: string[]
  blocked?: string | null
}

export interface ExecResult<B> {
  ok: boolean
  verified: boolean
  summary: string
  sections?: TaskDetailSection[]
  /** Presente quando algo no sistema foi alterado. */
  change?: { before: B; after: unknown; summaryBefore: string; summaryAfter: string }
}

export interface ActionDef<P = unknown, B = unknown> {
  id: string
  module: OpModule
  title: string
  description: string
  access?: OpAccess
  risk: OpRisk
  reversible: boolean
  irreversibleReason?: string
  requiresElevation: boolean | ((params: P) => boolean)
  /** Ações com o mesmo grupo não rodam ao mesmo tempo. */
  exclusive?: string
  parse: (raw: unknown) => P
  preview: (params: P, ctx: OpContext) => Promise<PreviewBody>
  /** Revalidação rápida no momento da execução; devolve o motivo do bloqueio ou null. */
  precheck?: (params: P, ctx: OpContext) => Promise<string | null>
  execute: (params: P, ctx: OpContext) => Promise<ExecResult<B>>
  /** Recebe o estado anterior salvo; deve validar o estado atual antes de reverter. */
  revert?: (before: B, after: unknown, ctx: OpContext & { force: boolean }) => Promise<string>
}

const PREVIEW_TTL_MS = 10 * 60 * 1000

/* eslint-disable @typescript-eslint/no-explicit-any */
const queries = new Map<string, QueryDef<any, any>>()
const actions = new Map<string, ActionDef<any, any>>()
/* eslint-enable @typescript-eslint/no-explicit-any */
const previews = new Map<string, { actionId: string; params: unknown; hash: string; expires: number }>()
const runningGroups = new Set<string>()
const jobs = new Map<string, AbortController>()

export const journal = new Journal(() => dataPath('journal'))

let progressSink: (progress: JobProgress) => void = () => undefined
export function setProgressSink(sink: (progress: JobProgress) => void): void {
  progressSink = sink
}

export function defineQuery<P, R>(def: QueryDef<P, R>): QueryDef<P, R> {
  if (queries.has(def.id)) throw new Error(`Consulta duplicada: ${def.id}`)
  queries.set(def.id, def)
  return def
}

export function defineAction<P, B>(def: ActionDef<P, B>): ActionDef<P, B> {
  if (actions.has(def.id)) throw new Error(`Ação duplicada: ${def.id}`)
  if (def.reversible && !def.revert) throw new Error(`Ação reversível sem revert: ${def.id}`)
  if (!def.reversible && !def.irreversibleReason) throw new Error(`Ação irreversível sem justificativa: ${def.id}`)
  actions.set(def.id, def)
  return def
}

function hashParams(params: unknown): string {
  return createHash('sha256').update(JSON.stringify(params ?? null)).digest('hex')
}

function validJobId(jobId: unknown): string | null {
  if (jobId === undefined || jobId === null) return null
  if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/.test(jobId)) throw new ValidationError('jobId inválido.')
  return jobId
}

function makeContext(jobId: string | null): { ctx: OpContext; done: () => void } {
  const controller = new AbortController()
  if (jobId) jobs.set(jobId, controller)
  const ctx: OpContext = {
    signal: controller.signal,
    jobId,
    progress(message, done = 0, total = null, data) {
      if (jobId) progressSink({ jobId, message, done, total, data })
    }
  }
  return { ctx, done: () => jobId && jobs.delete(jobId) }
}

function parseWith<P>(parse: (raw: unknown) => P, raw: unknown): P {
  try {
    return parse(raw)
  } catch (error) {
    if (error instanceof ValidationError || error instanceof AppFailure) throw error
    throw new ValidationError(error instanceof Error ? error.message : 'Parâmetros inválidos.')
  }
}

function elevationOf<P>(def: ActionDef<P, unknown>, params: P): boolean {
  return typeof def.requiresElevation === 'function' ? def.requiresElevation(params) : def.requiresElevation
}

export function getQueryAccess(id: string): OpAccess {
  const def = queries.get(id)
  if (!def) throw new AppFailure('unknown-query', 'Consulta não registrada.')
  return def.access ?? 'protected'
}

export function getActionAccess(id: string): OpAccess {
  const def = actions.get(id)
  if (!def) throw new AppFailure('unknown-action', 'Ação não registrada.')
  return def.access ?? 'protected'
}

export function previewAccess(previewId: unknown): OpAccess {
  const entry = typeof previewId === 'string' ? previews.get(previewId) : undefined
  return entry ? getActionAccess(entry.actionId) : 'protected'
}

export async function runQuery(id: string, raw: unknown, rawJobId: unknown): Promise<unknown> {
  const def = queries.get(id)
  if (!def) throw new AppFailure('unknown-query', 'Consulta não registrada.')
  const params = parseWith(def.parse, raw)
  const { ctx, done } = makeContext(validJobId(rawJobId))
  try {
    return await def.run(params, ctx)
  } catch (error) {
    if (ctx.signal.aborted) throw new AppFailure('cancelled', 'Operação cancelada.')
    throw error
  } finally {
    done()
  }
}

export function listActions(): ActionDescriptor[] {
  return [...actions.values()].map((a) => ({
    id: a.id,
    module: a.module,
    title: a.title,
    description: a.description,
    risk: a.risk,
    reversible: a.reversible,
    irreversibleReason: a.irreversibleReason ?? null,
    requiresElevation: typeof a.requiresElevation === 'function' ? true : a.requiresElevation,
    access: a.access ?? 'protected'
  }))
}

export async function previewAction(actionId: string, raw: unknown): Promise<ActionPreview> {
  const def = actions.get(actionId)
  if (!def) throw new AppFailure('unknown-action', 'Ação não registrada.')
  const params = parseWith(def.parse, raw)
  const { ctx, done } = makeContext(null)
  let body: PreviewBody
  try {
    body = await def.preview(params, ctx)
  } finally {
    done()
  }
  const now = Date.now()
  for (const [id, p] of previews) if (p.expires < now) previews.delete(id)
  const previewId = randomUUID()
  previews.set(previewId, { actionId, params, hash: hashParams(params), expires: now + PREVIEW_TTL_MS })
  return {
    previewId,
    actionId,
    title: def.title,
    summary: body.summary,
    changes: body.changes,
    warnings: body.warnings,
    risk: def.risk,
    reversible: def.reversible,
    irreversibleReason: def.irreversibleReason ?? null,
    requiresElevation: elevationOf(def, params),
    blocked: body.blocked ?? null,
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString()
  }
}

export async function executeAction(rawPreviewId: unknown, confirmed: unknown, rawJobId: unknown): Promise<ActionOutcome> {
  if (typeof rawPreviewId !== 'string') throw new ValidationError('previewId inválido.')
  const entry = previews.get(rawPreviewId)
  if (!entry || entry.expires < Date.now()) {
    previews.delete(rawPreviewId)
    throw new AppFailure('preview-expired', 'A pré-visualização expirou. Gere uma nova antes de executar.')
  }
  previews.delete(rawPreviewId) // uso único
  const def = actions.get(entry.actionId)!
  if (hashParams(entry.params) !== entry.hash) throw new AppFailure('preview-mismatch', 'Parâmetros diferentes da pré-visualização.')
  if (def.risk !== 'none' && confirmed !== true) {
    throw new AppFailure('confirmation-required', 'Esta ação precisa de confirmação explícita.')
  }

  // Revalida o bloqueio no momento da execução (o estado pode ter mudado).
  const { ctx, done } = makeContext(validJobId(rawJobId))
  const group = def.exclusive ?? def.id
  if (runningGroups.has(group)) {
    done()
    throw new AppFailure('already-running', 'Uma operação incompatível já está em andamento.')
  }
  runningGroups.add(group)
  const started = Date.now()
  try {
    const blocked = def.precheck ? await def.precheck(entry.params, ctx) : null
    if (blocked) throw new AppFailure('blocked', blocked)
    const result = await def.execute(entry.params, ctx)
    let changeId: string | null = null
    if (result.change) {
      changeId = journal.add({
        actionId: def.id,
        module: def.module,
        title: def.title,
        summaryBefore: result.change.summaryBefore,
        summaryAfter: result.change.summaryAfter,
        reversible: def.reversible,
        before: result.change.before,
        after: result.change.after
      }).id
    }
    const level = result.ok ? 'info' : 'warn'
    log[level](def.module, `${def.title}: ${result.summary}`, {
      actionId: def.id,
      durationMs: Date.now() - started
    })
    return { ok: result.ok, verified: result.verified, summary: result.summary, sections: result.sections ?? [], changeId }
  } catch (error) {
    const cancelled = ctx.signal.aborted
    const message = cancelled ? 'Operação cancelada.' : error instanceof Error ? error.message : String(error)
    log[cancelled ? 'warn' : 'error'](def.module, `${def.title} falhou: ${message}`, {
      actionId: def.id,
      durationMs: Date.now() - started
    })
    if (cancelled) throw new AppFailure('cancelled', 'Operação cancelada.')
    throw error
  } finally {
    runningGroups.delete(group)
    done()
  }
}

export async function revertChange(changeId: unknown, force: unknown): Promise<ChangeRecord & { revertSummary?: string }> {
  if (typeof changeId !== 'string') throw new ValidationError('changeId inválido.')
  const record = journal.get(changeId)
  if (!record) throw new AppFailure('change-not-found', 'Alteração não encontrada.')
  if (!record.reversible) throw new AppFailure('not-reversible', 'Esta alteração não permite reversão.')
  if (record.status === 'reverted') throw new AppFailure('already-reverted', 'Esta alteração já foi revertida.')
  const def = actions.get(record.actionId)
  if (!def?.revert) throw new AppFailure('not-reversible', 'A ação original não oferece reversão.')

  let backup
  try {
    backup = journal.readBackup(changeId)
  } catch (error) {
    if (error instanceof BackupIntegrityError) throw new AppFailure('backup-integrity', error.message)
    throw error
  }
  const group = def.exclusive ?? def.id
  if (runningGroups.has(group)) throw new AppFailure('already-running', 'Uma operação incompatível está em andamento.')
  runningGroups.add(group)
  const { ctx, done } = makeContext(null)
  const started = Date.now()
  try {
    const summary = await def.revert(backup.before, backup.after, { ...ctx, force: force === true })
    log.info(def.module, `Reversão de "${def.title}": ${summary}`, { actionId: def.id, durationMs: Date.now() - started })
    return { ...journal.setStatus(changeId, 'reverted'), revertSummary: summary }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(def.module, `Reversão de "${def.title}" falhou: ${message}`, { actionId: def.id })
    // Falha por estado divergente não marca como falha definitiva: o usuário pode forçar.
    if (!(error instanceof AppFailure && error.code === 'state-changed')) journal.setStatus(changeId, 'revert-failed', message)
    throw error
  } finally {
    runningGroups.delete(group)
    done()
  }
}

/** Valida parâmetros de uma ação sem executá-la (usado pelas ações rápidas). */
export function validateActionParams(actionId: string, raw: unknown): unknown {
  const def = actions.get(actionId)
  if (!def) throw new AppFailure('unknown-action', 'Ação não registrada.')
  return parseWith(def.parse, raw)
}

export function cancelJob(jobId: unknown): boolean {
  const id = validJobId(jobId)
  const controller = id ? jobs.get(id) : undefined
  if (!controller) return false
  controller.abort()
  return true
}

export function listChanges(): ChangeRecord[] {
  return journal.list()
}

/** Para gravar parâmetros em logs sem segredos. */
export function safeParams(params: unknown): unknown {
  return redactValue(params)
}
