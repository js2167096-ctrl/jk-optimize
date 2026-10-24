// Aplicação e reversão de planos. Cada item criado é gravado na hora, então uma falha no meio
// deixa um registro exato do que existe e permite desfazer apenas o que o bot criou.
import { writeAudit, type Db } from '../db/index.js'
import { diffPlan } from './diff.js'
import type { GuildPort, PlanDiff, ResolvedOverwrite, ServerPlan } from './types.js'
import { PermissionFlagsBits } from 'discord.js'
import { resolveOverwrites, validatePlan } from './validate.js'

const REASON = (actorId: string, template: string): string => `JK Optimize Bot: modelo "${template}" aplicado por ${actorId}`

export interface ApplyReport {
  ok: boolean
  batchId: number | null
  created: { roles: number; categories: number; channels: number }
  skipped: number
  /** Motivo da falha ou conflitos que impediram o início. */
  problems: string[]
}

export interface Preview {
  diff: PlanDiff
  problems: string[]
}

/** Valida o plano e compara com o servidor, sem alterar nada. */
export async function preview(plan: ServerPlan, port: GuildPort): Promise<Preview> {
  const problems = validatePlan(plan)
  if (problems.length > 0) return { diff: { items: [], conflicts: [] }, problems }
  const diff = diffPlan(plan, await port.snapshot(), port.botPermissions())
  return { diff, problems: diff.conflicts }
}

/** O bot precisa enxergar e escrever nas áreas privadas que ele mesmo cria. */
function withBotAccess(botId: string, list: ResolvedOverwrite[]): ResolvedOverwrite[] {
  if (list.length === 0) return list
  const own: ResolvedOverwrite = {
    id: botId,
    type: 'member',
    allow: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory,
    deny: 0n
  }
  return [...list.filter((o) => o.id !== botId), own]
}

export async function applyPlan(db: Db, plan: ServerPlan, port: GuildPort, actorId: string): Promise<ApplyReport> {
  const report: ApplyReport = { ok: false, batchId: null, created: { roles: 0, categories: 0, channels: 0 }, skipped: 0, problems: [] }
  const pre = await preview(plan, port)
  if (pre.problems.length > 0) {
    report.problems = pre.problems
    writeAudit(db, { guildId: port.id, actorId, action: 'servidor:aplicar', target: plan.id, outcome: 'denied', details: { problems: pre.problems } })
    return report
  }

  const now = new Date().toISOString()
  const batchId = Number(
    db.prepare("INSERT INTO change_batches (guild_id, actor_id, template_id, status, created_at) VALUES (?, ?, ?, 'applying', ?)").run(port.id, actorId, plan.id, now).lastInsertRowid
  )
  report.batchId = batchId
  const record = (kind: 'role' | 'category' | 'channel', discordId: string, name: string): void => {
    db.prepare('INSERT INTO change_items (batch_id, kind, discord_id, name) VALUES (?, ?, ?, ?)').run(batchId, kind, discordId, name)
  }
  const reason = REASON(actorId, plan.id)
  const roleIds = new Map<string, string>()
  const categoryIds = new Map<string, string>()
  let current = ''

  try {
    for (const item of pre.diff.items) {
      current = `${item.kind} "${item.name}"`
      if (item.kind === 'role') {
        if (item.action === 'exists' && item.existingId) {
          roleIds.set(item.spec.key, item.existingId)
          report.skipped++
        } else {
          const role = await port.createRole(
            { name: item.spec.name, color: item.spec.color, hoist: item.spec.hoist, mentionable: item.spec.mentionable, permissions: resolvePerms(item.spec.permissions) },
            reason
          )
          roleIds.set(item.spec.key, role.id)
          record('role', role.id, item.name)
          report.created.roles++
        }
      } else if (item.kind === 'category') {
        if (item.action === 'exists' && item.existingId) {
          categoryIds.set(item.name, item.existingId)
          report.skipped++
        } else {
          const overwrites = withBotAccess(port.botId, resolveOverwrites(port.id, roleIds, item.spec.overwrites))
          const cat = await port.createCategory(item.name, overwrites, reason)
          categoryIds.set(item.name, cat.id)
          record('category', cat.id, item.name)
          report.created.categories++
        }
      } else if (item.action === 'exists') {
        report.skipped++
      } else {
        const parentId = categoryIds.get(item.categoryName)
        if (!parentId) throw new Error(`Categoria "${item.categoryName}" não foi resolvida.`)
        const category = plan.categories.find((c) => c.name === item.categoryName)
        const overwrites = withBotAccess(port.botId, resolveOverwrites(port.id, roleIds, category?.overwrites, item.spec.overwrites))
        const ch = await port.createChannel(
          { name: item.spec.name, type: item.spec.type, parentId, topic: item.spec.topic, slowmode: item.spec.slowmode, overwrites },
          reason
        )
        record('channel', ch.id, item.name)
        report.created.channels++
      }
    }
    report.ok = true
    finish(db, batchId, 'applied')
    writeAudit(db, { guildId: port.id, actorId, action: 'servidor:aplicar', target: plan.id, outcome: 'ok', details: { batchId, created: report.created, skipped: report.skipped } })
  } catch (error) {
    report.problems = [`Falha em ${current}: ${(error as Error).message}`]
    finish(db, batchId, 'partial')
    writeAudit(db, { guildId: port.id, actorId, action: 'servidor:aplicar', target: plan.id, outcome: 'error', details: { batchId, created: report.created, failedAt: current, message: (error as Error).message } })
  }
  return report
}

function resolvePerms(names: ServerPlan['roles'][number]['permissions']): bigint {
  return names.reduce((acc, n) => acc | PermissionFlagsBits[n], 0n)
}

function finish(db: Db, batchId: number, status: 'applied' | 'partial' | 'undone'): void {
  db.prepare('UPDATE change_batches SET status = ?, finished_at = ? WHERE id = ?').run(status, new Date().toISOString(), batchId)
}

export interface BatchInfo {
  id: number
  templateId: string
  status: string
  items: { id: number; kind: 'role' | 'category' | 'channel'; discordId: string; name: string }[]
}

/** Último lote do servidor que ainda tem itens a desfazer. */
export function lastUndoableBatch(db: Db, guildId: string): BatchInfo | null {
  const b = db.prepare("SELECT id, template_id, status FROM change_batches WHERE guild_id = ? AND status IN ('applied','partial') ORDER BY id DESC LIMIT 1").get(guildId) as
    | { id: number; template_id: string; status: string }
    | undefined
  if (!b) return null
  const items = db.prepare('SELECT id, kind, discord_id, name FROM change_items WHERE batch_id = ? AND undone = 0 ORDER BY id').all(b.id) as {
    id: number
    kind: 'role' | 'category' | 'channel'
    discord_id: string
    name: string
  }[]
  return { id: b.id, templateId: b.template_id, status: b.status, items: items.map((i) => ({ id: i.id, kind: i.kind, discordId: i.discord_id, name: i.name })) }
}

export interface UndoReport {
  removed: number
  alreadyGone: number
  /** Categorias mantidas porque ganharam canais que o bot não criou. */
  keptNonEmpty: string[]
  problems: string[]
}

/** Remove somente o que o bot criou no lote, do mais novo ao mais antigo. */
export async function undoBatch(db: Db, batch: BatchInfo, port: GuildPort, actorId: string): Promise<UndoReport> {
  const report: UndoReport = { removed: 0, alreadyGone: 0, keptNonEmpty: [], problems: [] }
  const reason = `JK Optimize Bot: desfazendo o lote ${batch.id} (${actorId})`
  const markUndone = db.prepare('UPDATE change_items SET undone = 1 WHERE id = ?')

  for (const item of [...batch.items].reverse()) {
    try {
      if (item.kind === 'category' && (await port.childCount(item.discordId)) > 0) {
        report.keptNonEmpty.push(item.name)
        continue
      }
      const deleted = item.kind === 'role' ? await port.deleteRole(item.discordId, reason) : await port.deleteChannel(item.discordId, reason)
      if (deleted) report.removed++
      else report.alreadyGone++
      markUndone.run(item.id)
    } catch (error) {
      report.problems.push(`${item.kind} "${item.name}": ${(error as Error).message}`)
    }
  }
  const left = (db.prepare('SELECT COUNT(*) AS n FROM change_items WHERE batch_id = ? AND undone = 0').get(batch.id) as { n: number }).n
  if (left === 0) finish(db, batch.id, 'undone')
  writeAudit(db, {
    guildId: port.id,
    actorId,
    action: 'servidor:desfazer',
    target: String(batch.id),
    outcome: report.problems.length === 0 ? 'ok' : 'error',
    details: { removed: report.removed, alreadyGone: report.alreadyGone, kept: report.keptNonEmpty, problems: report.problems }
  })
  return report
}
