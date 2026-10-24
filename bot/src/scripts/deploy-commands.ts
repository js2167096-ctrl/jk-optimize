// Registra os slash commands na API do Discord (do servidor de testes se DISCORD_DEV_GUILD_ID existir; senão global).
import { REST, Routes } from 'discord.js'
import { COMMANDS } from '../commands/index.js'
import { ConfigError, loadConfig } from '../config.js'

try {
  const config = loadConfig()
  const rest = new REST({ version: '10' }).setToken(config.token)
  const body = COMMANDS.map((c) => c.data)
  const route = config.devGuildId
    ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
    : Routes.applicationCommands(config.clientId)
  const result = (await rest.put(route, { body })) as unknown[]
  process.stdout.write(`${result.length} comando(s) registrado(s) ${config.devGuildId ? `no servidor ${config.devGuildId}` : 'globalmente'}.\n`)
} catch (error) {
  process.stderr.write(`${error instanceof ConfigError ? error.message : `Falha ao registrar comandos: ${(error as Error).message}`}\n`)
  process.exit(1)
}
