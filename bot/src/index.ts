import { Client, Events, GatewayIntentBits } from 'discord.js'
import { COMMANDS, commandMap } from './commands/index.js'
import type { Deps, InteractionLike } from './commands/types.js'
import { ConfigError, loadConfig } from './config.js'
import { openDatabase } from './db/index.js'
import { handleCommand, RateLimiter } from './handler.js'
import { createLogger } from './logger.js'

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\nCopie .env.example para .env e preencha os valores.\n`)
      process.exit(1)
    }
    throw error
  }

  const log = createLogger({ level: config.logLevel, secrets: [config.token] })
  const db = openDatabase(config.databasePath)
  // Fase 1 só precisa do intent Guilds (não privilegiado).
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  const deps: Deps = { config, db, log, startedAt: Date.now(), wsPing: () => client.ws.ping }
  const commands = commandMap(COMMANDS)
  const limiter = new RateLimiter(5, 10_000)

  client.once(Events.ClientReady, (ready) => {
    log.info('Bot conectado ao Discord', { user: ready.user.tag, guilds: ready.guilds.cache.size })
  })
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return
    void handleCommand(interaction as unknown as InteractionLike, commands, deps, limiter)
  })
  client.on(Events.Error, (error) => log.error('Erro do cliente Discord', { error }))

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    log.info('Encerrando', { signal })
    await client.destroy()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await client.login(config.token)
}

main().catch((error: unknown) => {
  process.stderr.write(`Falha ao iniciar: ${(error as Error).message}\n`)
  process.exit(1)
})
