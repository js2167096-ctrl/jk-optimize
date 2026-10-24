// Verificação de configuração inicial: valida .env, banco e (se o token existir) a autenticação com o Discord.
import { REST, Routes } from 'discord.js'
import { ConfigError, loadConfig } from '../config.js'
import { openDatabase, schemaVersion } from '../db/index.js'

let failed = false
const report = (ok: boolean, text: string): void => {
  if (!ok) failed = true
  process.stdout.write(`${ok ? '[ok]   ' : '[FALHA]'} ${text}\n`)
}

try {
  const config = loadConfig()
  report(true, 'Variáveis de ambiente válidas.')

  try {
    const db = openDatabase(config.databasePath)
    report(true, `Banco de dados aberto (${config.databasePath}, migração v${schemaVersion(db)}).`)
    db.close()
  } catch (error) {
    report(false, `Banco de dados: ${(error as Error).message}`)
  }

  try {
    const rest = new REST({ version: '10' }).setToken(config.token)
    const app = (await rest.get(Routes.currentApplication())) as { id: string; name: string }
    report(app.id === config.clientId, app.id === config.clientId ? `Token autenticado na aplicação "${app.name}".` : 'DISCORD_CLIENT_ID não corresponde ao token informado.')
  } catch (error) {
    report(false, `Autenticação no Discord: ${(error as Error).message}`)
  }
} catch (error) {
  report(false, error instanceof ConfigError ? error.message : (error as Error).message)
}
process.exit(failed ? 1 : 0)
