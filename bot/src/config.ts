// Leitura e validação das variáveis de ambiente. Falha com mensagens claras.
const SNOWFLAKE = /^\d{17,20}$/
const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LEVELS)[number]

export interface Config {
  token: string
  clientId: string
  devGuildId: string | null
  ownerIds: string[]
  databasePath: string
  logLevel: LogLevel
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuração inválida:\n- ${problems.join('\n- ')}`)
    this.name = 'ConfigError'
  }
}

export interface LoadOptions {
  /** Scripts como `invite` não precisam do token. */
  requireToken?: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): Config {
  const { requireToken = true } = options
  const problems: string[] = []
  const get = (name: string): string => (env[name] ?? '').trim()

  const token = get('DISCORD_TOKEN')
  if (requireToken) {
    if (token === '') problems.push('DISCORD_TOKEN não definido (Developer Portal -> Bot -> Reset Token).')
    else if (token.split('.').length !== 3) problems.push('DISCORD_TOKEN não parece um token de bot válido.')
  }

  const clientId = get('DISCORD_CLIENT_ID')
  if (clientId === '') problems.push('DISCORD_CLIENT_ID não definido (Developer Portal -> General Information).')
  else if (!SNOWFLAKE.test(clientId)) problems.push('DISCORD_CLIENT_ID deve ser um ID numérico do Discord.')

  const devGuildId = get('DISCORD_DEV_GUILD_ID')
  if (devGuildId !== '' && !SNOWFLAKE.test(devGuildId)) problems.push('DISCORD_DEV_GUILD_ID deve ser um ID numérico do Discord.')

  const ownerIds = get('BOT_OWNER_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const id of ownerIds) if (!SNOWFLAKE.test(id)) problems.push(`BOT_OWNER_IDS contém um ID inválido: "${id}".`)

  const logLevel = (get('LOG_LEVEL') || 'info').toLowerCase()
  if (!(LEVELS as readonly string[]).includes(logLevel)) problems.push(`LOG_LEVEL deve ser um de: ${LEVELS.join(', ')}.`)

  if (problems.length > 0) throw new ConfigError(problems)
  return {
    token,
    clientId,
    devGuildId: devGuildId === '' ? null : devGuildId,
    ownerIds,
    databasePath: get('DATABASE_PATH') || './data/bot.sqlite',
    logLevel: logLevel as LogLevel
  }
}
