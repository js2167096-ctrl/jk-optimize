import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js'
import { preview, lastUndoableBatch } from '../servidor/apply.js'
import { CANCEL_PREFIX, CONFIRM_PREFIX } from '../servidor/buttons.js'
import { formatConflicts, formatPreview, formatUndoPreview } from '../servidor/format.js'
import { pending } from '../servidor/pending.js'
import { findTemplate, TEMPLATES } from '../servidor/templates.js'
import type { Command, InteractionLike } from './types.js'

const choices = TEMPLATES.map((t) => ({ name: t.title, value: t.id }))

const data = new SlashCommandBuilder()
  .setName('servidor')
  .setDescription('Organiza o servidor com modelos (cargos, categorias, canais e permissões).')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('modelos').setDescription('Lista os modelos disponíveis.'))
  .addSubcommand((s) =>
    s
      .setName('previa')
      .setDescription('Mostra o que um modelo criaria, sem alterar nada.')
      .addStringOption((o) => o.setName('modelo').setDescription('Modelo').setRequired(true).addChoices(...choices))
  )
  .addSubcommand((s) =>
    s
      .setName('aplicar')
      .setDescription('Aplica um modelo depois de você confirmar a prévia. Só cria; nunca apaga.')
      .addStringOption((o) => o.setName('modelo').setDescription('Modelo').setRequired(true).addChoices(...choices))
  )
  .addSubcommand((s) => s.setName('desfazer').setDescription('Remove o que o último modelo aplicado criou (com confirmação).'))
  .toJSON()

function buttons(token: string, confirmLabel: string, style: ButtonStyle): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONFIRM_PREFIX}${token}`).setLabel(confirmLabel).setStyle(style),
    new ButtonBuilder().setCustomId(`${CANCEL_PREFIX}${token}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
  )
}

const ephemeral = MessageFlags.Ephemeral

async function templateFrom(i: InteractionLike) {
  const id = i.options.getString('modelo')
  return id ? findTemplate(id) : undefined
}

export const servidor: Command = {
  data,
  adminOnly: true,
  async execute(i, deps) {
    const sub = i.options.getSubcommand()
    if (sub === 'modelos') {
      const lines = ['**Modelos disponíveis**', ...TEMPLATES.map((t) => `• \`${t.id}\` — **${t.title}**: ${t.description}`)]
      await i.reply({ content: lines.join('\n'), flags: ephemeral })
      return
    }

    const guildId = i.guildId
    const port = guildId ? deps.guildPort(guildId) : null
    if (!guildId || !port) {
      await i.reply({ content: 'Use este comando dentro de um servidor onde o bot esteja.', flags: ephemeral })
      return
    }

    if (sub === 'desfazer') {
      const batch = lastUndoableBatch(deps.db, guildId)
      if (!batch || batch.items.length === 0) {
        await i.reply({ content: 'Não há nada criado pelo bot para desfazer neste servidor.', flags: ephemeral })
        return
      }
      const token = pending.create({ kind: 'undo', userId: i.user.id, guildId, batchId: batch.id })
      await i.reply({ content: formatUndoPreview(batch), components: [buttons(token, 'Apagar estes itens', ButtonStyle.Danger)], flags: ephemeral })
      return
    }

    const plan = await templateFrom(i)
    if (!plan) {
      await i.reply({ content: 'Modelo não encontrado. Use `/servidor modelos`.', flags: ephemeral })
      return
    }
    const result = await preview(plan, port)
    if (result.problems.length > 0) {
      await i.reply({ content: formatConflicts(result.problems), flags: ephemeral })
      return
    }
    const text = formatPreview(plan, result.diff)
    const creates = result.diff.items.filter((x) => x.action === 'create').length
    if (sub === 'previa' || creates === 0) {
      await i.reply({ content: creates === 0 ? `${text}\n\nNada a criar: tudo deste modelo já existe.` : text, flags: ephemeral })
      return
    }
    const token = pending.create({ kind: 'apply', userId: i.user.id, guildId, templateId: plan.id })
    await i.reply({ content: text, components: [buttons(token, 'Confirmar e criar', ButtonStyle.Success)], flags: ephemeral })
  }
}
