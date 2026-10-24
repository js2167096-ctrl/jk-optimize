import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import type { Logger } from '../logger.js'

/** Subconjunto da interação do discord.js usado pelos comandos (facilita testes sem conexão). */
export interface InteractionLike {
  commandName: string
  user: { id: string }
  guildId: string | null
  /** Permissões do usuário no canal (null fora de servidores). */
  memberPermissions: { bitfield: bigint } | null
  /** Permissões do bot no canal (null fora de servidores). */
  appPermissions: { bitfield: bigint } | null
  replied: boolean
  deferred: boolean
  reply(options: { content: string; flags?: number }): Promise<unknown>
  followUp(options: { content: string; flags?: number }): Promise<unknown>
}

export interface Deps {
  config: Config
  db: Db
  log: Logger
  startedAt: number
  /** Latência do WebSocket em ms (-1 se ainda não medida). */
  wsPing: () => number
}

export interface Command {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody
  /** true = exige dono do bot (BOT_OWNER_IDS) ou "Gerenciar Servidor". */
  adminOnly: boolean
  execute(interaction: InteractionLike, deps: Deps): Promise<void>
}
