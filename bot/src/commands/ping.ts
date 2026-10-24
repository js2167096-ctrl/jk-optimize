import { MessageFlags, SlashCommandBuilder } from 'discord.js'
import type { Command } from './types.js'

export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Verifica se o bot está respondendo.').toJSON(),
  adminOnly: false,
  async execute(interaction, deps) {
    const ws = deps.wsPing()
    await interaction.reply({ content: `🏓 Online. Latência do gateway: ${ws >= 0 ? `${ws} ms` : 'ainda não medida'}.`, flags: MessageFlags.Ephemeral })
  }
}
