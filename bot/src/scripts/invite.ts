// Imprime o link OAuth2 para convidar o bot. Use --admin para pedir também as permissões de administração (Fase 2+).
import { ConfigError, loadConfig } from '../config.js'
import { ADMIN_PERMISSIONS, BASE_PERMISSIONS, buildInviteUrl } from '../permissions.js'

try {
  const config = loadConfig(process.env, { requireToken: false })
  const admin = process.argv.includes('--admin')
  process.stdout.write(`${buildInviteUrl(config.clientId, admin ? ADMIN_PERMISSIONS : BASE_PERMISSIONS)}\n`)
  process.stdout.write(
    admin
      ? 'Link com permissões de administração (cargos, canais, mensagens, castigo).\n'
      : 'Link com permissões básicas. Use --admin quando for ativar os módulos de administração.\n'
  )
} catch (error) {
  process.stderr.write(`${error instanceof ConfigError ? error.message : (error as Error).message}\n`)
  process.exit(1)
}
