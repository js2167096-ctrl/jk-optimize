import { MessageFlags } from 'discord.js'
import type { ButtonLike, Deps } from '../commands/types.js'
import { writeAudit } from '../db/index.js'
import { isBotAdmin } from '../permissions.js'
import { applyPlan, lastUndoableBatch, undoBatch } from './apply.js'
import { formatApplyReport, formatUndoReport } from './format.js'
import { pending, type PendingStore } from './pending.js'
import { findTemplate } from './templates.js'

export const CONFIRM_PREFIX = 'srv:ok:'
export const CANCEL_PREFIX = 'srv:no:'

/** Trata os botões Confirmar/Cancelar de /servidor aplicar e /servidor desfazer. */
export async function handleButton(i: ButtonLike, deps: Deps, store: PendingStore = pending): Promise<void> {
  const confirm = i.customId.startsWith(CONFIRM_PREFIX)
  const cancel = i.customId.startsWith(CANCEL_PREFIX)
  if (!confirm && !cancel) return
  const ephemeral = { flags: MessageFlags.Ephemeral }

  const actor = { userId: i.user.id, memberPermissions: i.memberPermissions?.bitfield ?? null }
  if (!isBotAdmin(actor, deps.config.ownerIds)) {
    writeAudit(deps.db, { guildId: i.guildId, actorId: actor.userId, action: 'servidor:botao', outcome: 'denied' })
    await i.reply({ content: 'Você não tem permissão para isso.', ...ephemeral })
    return
  }

  if (cancel) {
    store.discard(i.customId.slice(CANCEL_PREFIX.length), i.user.id)
    await i.update({ content: 'Cancelado. Nada foi alterado.', components: [] })
    return
  }

  const action = store.take(i.customId.slice(CONFIRM_PREFIX.length), i.user.id)
  if (!action || action.guildId !== i.guildId) {
    await i.update({ content: 'Esta confirmação expirou ou não é sua. Rode o comando de novo.', components: [] })
    return
  }
  const port = deps.guildPort(action.guildId)
  if (!port) {
    await i.update({ content: 'O bot não está mais neste servidor.', components: [] })
    return
  }

  try {
    if (action.kind === 'apply') {
      const plan = findTemplate(action.templateId)
      if (!plan) {
        await i.update({ content: 'Modelo não encontrado.', components: [] })
        return
      }
      await i.update({ content: '⏳ Aplicando… isso pode levar um minuto por causa dos limites do Discord.', components: [] })
      const report = await applyPlan(deps.db, plan, port, i.user.id)
      await i.reply({ content: formatApplyReport(report), ...ephemeral })
    } else {
      const batch = lastUndoableBatch(deps.db, action.guildId)
      if (!batch || batch.id !== action.batchId) {
        await i.update({ content: 'O lote mudou desde a prévia. Rode `/servidor desfazer` de novo.', components: [] })
        return
      }
      await i.update({ content: '⏳ Desfazendo…', components: [] })
      const report = await undoBatch(deps.db, batch, port, i.user.id)
      await i.reply({ content: formatUndoReport(report), ...ephemeral })
    }
  } catch (error) {
    deps.log.error('Falha ao processar confirmação', { kind: action.kind, error })
    writeAudit(deps.db, { guildId: action.guildId, actorId: i.user.id, action: `servidor:${action.kind}`, outcome: 'error', details: { message: (error as Error).message } })
    await i.reply({ content: 'Ocorreu um erro. O problema foi registrado.', ...ephemeral }).catch(() => undefined)
  }
}
