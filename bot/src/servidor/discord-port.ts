// Implementação de GuildPort com discord.js.
import { ChannelType, OverwriteType, type Guild } from 'discord.js'
import type { GuildPort, GuildSnapshot, ResolvedOverwrite } from './types.js'

const toDiscordOverwrites = (list: ResolvedOverwrite[]) =>
  list.map((o) => ({ id: o.id, type: o.type === 'role' ? OverwriteType.Role : OverwriteType.Member, allow: o.allow, deny: o.deny }))

/** Trata "não encontrado" (10003 canal, 10011 cargo) como já removido. */
const isUnknown = (error: unknown): boolean => {
  const code = (error as { code?: number }).code
  return code === 10003 || code === 10011
}

export function discordGuildPort(guild: Guild): GuildPort {
  const me = (): NonNullable<Guild['members']['me']> => {
    if (!guild.members.me) throw new Error('O bot ainda não carregou seu próprio membro neste servidor.')
    return guild.members.me
  }
  return {
    id: guild.id,
    get botId() {
      return me().id
    },
    botPermissions: () => me().permissions.bitfield,
    async snapshot(): Promise<GuildSnapshot> {
      const [roles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()])
      return {
        roles: [...roles.values()].map((r) => ({ id: r.id, name: r.name, managed: r.managed })),
        channels: [...channels.values()].flatMap((c) =>
          c
            ? [
                {
                  id: c.id,
                  name: c.name,
                  kind:
                    c.type === ChannelType.GuildCategory ? ('category' as const) : c.type === ChannelType.GuildText ? ('text' as const) : c.type === ChannelType.GuildVoice ? ('voice' as const) : ('other' as const),
                  parentId: c.parentId
                }
              ]
            : []
        )
      }
    },
    async createRole(spec, reason) {
      const role = await guild.roles.create({ name: spec.name, color: spec.color, hoist: spec.hoist, mentionable: spec.mentionable, permissions: spec.permissions, reason })
      return { id: role.id }
    },
    async createCategory(name, overwrites, reason) {
      const c = await guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: toDiscordOverwrites(overwrites), reason })
      return { id: c.id }
    },
    async createChannel(spec, reason) {
      const c = await guild.channels.create({
        name: spec.name,
        type: spec.type === 'text' ? ChannelType.GuildText : ChannelType.GuildVoice,
        parent: spec.parentId,
        ...(spec.topic ? { topic: spec.topic } : {}),
        ...(spec.slowmode ? { rateLimitPerUser: spec.slowmode } : {}),
        permissionOverwrites: toDiscordOverwrites(spec.overwrites),
        reason
      })
      return { id: c.id }
    },
    async deleteRole(id, reason) {
      try {
        await guild.roles.delete(id, reason)
        return true
      } catch (error) {
        if (isUnknown(error)) return false
        throw error
      }
    },
    async deleteChannel(id, reason) {
      try {
        await guild.channels.delete(id, reason)
        return true
      } catch (error) {
        if (isUnknown(error)) return false
        throw error
      }
    },
    async childCount(categoryId) {
      const channels = await guild.channels.fetch()
      return [...channels.values()].filter((c) => c?.parentId === categoryId).length
    },
    async setSlowmode(channelId, seconds, reason) {
      const channel = await guild.channels.fetch(channelId)
      if (!channel || channel.type !== ChannelType.GuildText) return false
      await channel.setRateLimitPerUser(seconds, reason)
      return true
    }
  }
}
