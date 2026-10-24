import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'
import type { Config } from '../config.js'
import type { Db } from '../db/index.js'
import type { Logger } from '../logger.js'
import type { GuildPort } from '../servidor/types.js'

export interface ReplyOptions {
  content: string
  flags?: number
  /** Linhas de componentes (botões) do discord.js. */
  components?: unknown[]
}

/** Subconjunto da interação do discord.js usado pelos comandos (facilita testes sem conexão). */
export interface InteractionLike {
  commandName: string
  user: { id: string }
  guildId: string | null
  /** Permissões do usuário no canal (null fora de servidores). */
  memberPermissions: { bitfield: bigint } | null
  /** Permissões do bot no canal (null fora de servidores). */
  appPermissions: { bitfield: bigint } | null
  options: {
    getSubcommand(): string
    getString(name: string): string | null
    getInteger(name: string): number | null
    getChannel(name: string): { id: string } | null
  }
  replied: boolean
  deferred: boolean
  reply(options: ReplyOptions): Promise<unknown>
  followUp(options: ReplyOptions): Promise<unknown>
}

/** Clique em botão de confirmação. */
export interface ButtonLike {
  customId: string
  user: { id: string }
  guildId: string | null
  memberPermissions: { bitfield: bigint } | null
  reply(options: ReplyOptions): Promise<unknown>
  update(options: ReplyOptions): Promise<unknown>
}

export interface Deps {
  config: Config
  db: Db
  log: Logger
  startedAt: number
  /** Latência do WebSocket em ms (-1 se ainda não medida). */
  wsPing: () => number
  /** Acesso às operações do Discord de um servidor onde o bot está (null se não estiver). */
  guildPort: (guildId: string) => GuildPort | null
}

export interface Command {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody
  /** true = exige dono do bot (BOT_OWNER_IDS) ou "Gerenciar Servidor". */
  adminOnly: boolean
  execute(interaction: InteractionLike, deps: Deps): Promise<void>
}
