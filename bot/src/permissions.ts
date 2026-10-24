import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'

/** Mínimo para a Fase 1 (responder comandos e enviar embeds). */
export const BASE_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
]

/** Necessárias para os módulos de administração (Fase 2+). Solicitadas só com `--admin`. */
export const ADMIN_PERMISSIONS: readonly bigint[] = [
  ...BASE_PERMISSIONS,
  // O bot só consegue conceder em cargos e canais o que ele mesmo possui.
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers
]

export function combine(perms: readonly bigint[]): bigint {
  return perms.reduce((acc, p) => acc | p, 0n)
}

export function missingPermissions(granted: bigint, required: readonly bigint[]): string[] {
  const have = new PermissionsBitField(granted)
  if (have.has(PermissionFlagsBits.Administrator)) return []
  return required.filter((p) => !have.has(p)).flatMap((p) => new PermissionsBitField(p).toArray())
}

/** Link OAuth2 de convite (escopos bot + applications.commands). */
export function buildInviteUrl(clientId: string, perms: readonly bigint[]): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions: combine(perms).toString()
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}

export interface Actor {
  userId: string
  memberPermissions: bigint | null
}

/** Dono configurado em BOT_OWNER_IDS ou quem tem "Gerenciar Servidor" no servidor. */
export function isBotAdmin(actor: Actor, ownerIds: readonly string[]): boolean {
  if (ownerIds.includes(actor.userId)) return true
  if (actor.memberPermissions === null) return false
  const p = new PermissionsBitField(actor.memberPermissions)
  return p.has(PermissionFlagsBits.Administrator) || p.has(PermissionFlagsBits.ManageGuild)
}
