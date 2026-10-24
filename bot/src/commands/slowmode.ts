import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js'
import { LIMITS } from '../servidor/validate.js'
import type { Command } from './types.js'

export const slowmode: Command = {
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Define o modo lento de um canal de texto (0 desativa).')
    .setDMPermission(false)
    .addChannelOption((o) => o.setName('canal').setDescription('Canal de texto').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addIntegerOption((o) =>
      o.setName('segundos').setDescription('Intervalo entre mensagens, de 0 a 21600').setMinValue(0).setMaxValue(LIMITS.slowmodeMax).setRequired(true)
    )
    .toJSON(),
  adminOnly: true,
  async execute(i, deps) {
    const channel = i.options.getChannel('canal')
    const seconds = i.options.getInteger('segundos')
    const port = i.guildId ? deps.guildPort(i.guildId) : null
    if (!channel || seconds === null || !port) {
      await i.reply({ content: 'Use este comando em um servidor, informando canal e segundos.', flags: MessageFlags.Ephemeral })
      return
    }
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > LIMITS.slowmodeMax) {
      await i.reply({ content: `Os segundos devem ficar entre 0 e ${LIMITS.slowmodeMax}.`, flags: MessageFlags.Ephemeral })
      return
    }
    const ok = await port.setSlowmode(channel.id, seconds, `JK Optimize Bot: modo lento por ${i.user.id}`)
    await i.reply({
      content: ok ? (seconds === 0 ? `Modo lento desativado em <#${channel.id}>.` : `Modo lento de ${seconds}s definido em <#${channel.id}>.`) : 'Não foi possível: o canal não é de texto ou não existe.',
      flags: MessageFlags.Ephemeral
    })
  }
}
