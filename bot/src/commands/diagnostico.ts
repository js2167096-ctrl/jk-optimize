import { MessageFlags, SlashCommandBuilder, version as discordJsVersion } from 'discord.js'
import { schemaVersion } from '../db/index.js'
import { ADMIN_PERMISSIONS, BASE_PERMISSIONS, missingPermissions } from '../permissions.js'
import type { Command } from './types.js'

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${d}d ${h}h ${m}m ${s % 60}s`
}

export const diagnostico: Command = {
  data: new SlashCommandBuilder()
    .setName('diagnostico')
    .setDescription('Mostra o estado do bot e as permissões que ele tem neste canal.')
    .setDMPermission(false)
    .toJSON(),
  adminOnly: true,
  async execute(interaction, deps) {
    const lines: string[] = ['**Diagnóstico do JK Optimize Bot**']
    const ws = deps.wsPing()
    lines.push(`• Gateway: ${ws >= 0 ? `${ws} ms` : 'latência ainda não medida'}`)
    lines.push(`• Tempo ligado: ${formatUptime(Date.now() - deps.startedAt)}`)
    lines.push(`• Node ${process.versions.node} · discord.js ${discordJsVersion}`)

    try {
      lines.push(`• Banco de dados: OK (migração v${schemaVersion(deps.db)})`)
    } catch (error) {
      lines.push(`• Banco de dados: FALHA (${(error as Error).message})`)
    }

    if (interaction.appPermissions) {
      const granted = interaction.appPermissions.bitfield
      const base = missingPermissions(granted, BASE_PERMISSIONS)
      const admin = missingPermissions(granted, ADMIN_PERMISSIONS)
      lines.push(`• Permissões básicas neste canal: ${base.length === 0 ? 'OK' : `faltam ${base.join(', ')}`}`)
      lines.push(
        `• Permissões de administração (Fase 2+): ${admin.length === 0 ? 'OK' : `faltam ${admin.join(', ')}`}`
      )
    } else {
      lines.push('• Permissões: não disponíveis (use o comando dentro de um servidor).')
    }

    lines.push('• Módulos ativos: núcleo, comandos, banco, auditoria. Demais módulos ainda não foram implementados.')
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral })
  }
}
