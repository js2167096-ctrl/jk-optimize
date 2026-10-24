import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PermissionFlagsBits } from 'discord.js'
import { commandMap } from '../src/commands/index.js'
import type { Deps, InteractionLike } from '../src/commands/types.js'
import { ConfigError, loadConfig } from '../src/config.js'
import { openDatabase, schemaVersion, writeAudit } from '../src/db/index.js'
import { handleCommand, RateLimiter } from '../src/handler.js'
import { createLogger, redactText } from '../src/logger.js'
import { ADMIN_PERMISSIONS, BASE_PERMISSIONS, buildInviteUrl, combine, isBotAdmin, missingPermissions } from '../src/permissions.js'

const ID = '123456789012345678'
const FAKE_TOKEN = `${'A'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(30)}`
const validEnv = { DISCORD_TOKEN: FAKE_TOKEN, DISCORD_CLIENT_ID: ID }

test('config: aceita ambiente válido e aplica padrões', () => {
  const c = loadConfig({ ...validEnv, BOT_OWNER_IDS: `${ID}, 223456789012345678` })
  assert.equal(c.clientId, ID)
  assert.deepEqual(c.ownerIds, [ID, '223456789012345678'])
  assert.equal(c.devGuildId, null)
  assert.equal(c.logLevel, 'info')
  assert.equal(c.databasePath, './data/bot.sqlite')
})

test('config: falha com mensagens claras quando faltam credenciais', () => {
  assert.throws(
    () => loadConfig({}),
    (e: unknown) => e instanceof ConfigError && e.problems.length === 2 && /DISCORD_TOKEN/.test(e.message) && /DISCORD_CLIENT_ID/.test(e.message)
  )
})

test('config: rejeita IDs, token e nível de log inválidos', () => {
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 'abc', DISCORD_CLIENT_ID: 'x', BOT_OWNER_IDS: '12', LOG_LEVEL: 'tudo' }), (e: unknown) => e instanceof ConfigError && e.problems.length === 4)
})

test('config: o convite não exige token', () => {
  assert.equal(loadConfig({ DISCORD_CLIENT_ID: ID }, { requireToken: false }).token, '')
})

test('logger: redige token do bot, keys JKO1 e segredos informados', () => {
  const lines: string[] = []
  const log = createLogger({ level: 'debug', secrets: ['segredo-super-longo'], write: (l) => lines.push(l) })
  log.info(`token ${FAKE_TOKEN} key JKO1.abcDEF_123.xyz-987 ${'segredo-super-longo'}`)
  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes(FAKE_TOKEN))
  assert.ok(!lines[0].includes('JKO1.abcDEF_123'))
  assert.ok(!lines[0].includes('segredo-super-longo'))
  assert.match(lines[0], /\[REDACTED\]/)
})

test('logger: respeita o nível mínimo', () => {
  const lines: string[] = []
  const log = createLogger({ level: 'warn', write: (l) => lines.push(l) })
  log.info('x')
  log.warn('y')
  assert.equal(lines.length, 1)
})

test('banco: migrações são aplicadas uma vez e são idempotentes', () => {
  const db = openDatabase(':memory:')
  assert.equal(schemaVersion(db), 2)
  assert.equal(schemaVersion(db), 2)
  db.close()
})

test('banco: migração com erro faz rollback e informa a versão', () => {
  assert.throws(() => openDatabase(':memory:', [{ version: 1, name: 'quebrada', sql: 'CREATE TABLE a (x); ISSO NAO E SQL;' }]), /migração 1 \(quebrada\)/)
})

test('auditoria: grava e redige segredos nos detalhes', () => {
  const db = openDatabase(':memory:')
  writeAudit(db, { guildId: ID, actorId: ID, action: 'teste', outcome: 'ok', details: { key: 'JKO1.aaa.bbb' } })
  const row = db.prepare('SELECT action, details_json FROM audit_log').get() as { action: string; details_json: string }
  assert.equal(row.action, 'teste')
  assert.ok(!row.details_json.includes('JKO1.aaa'))
  assert.throws(() => db.prepare("INSERT INTO audit_log (ts, actor_id, action, outcome) VALUES ('t','a','b','invalido')").run())
  db.close()
})

test('permissões: convite com escopos corretos e permissões mínimas', () => {
  const url = new URL(buildInviteUrl(ID, BASE_PERMISSIONS))
  assert.equal(url.searchParams.get('client_id'), ID)
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands')
  assert.equal(url.searchParams.get('permissions'), combine(BASE_PERMISSIONS).toString())
  assert.ok(!(combine(BASE_PERMISSIONS) & PermissionFlagsBits.Administrator))
  assert.ok(!(combine(ADMIN_PERMISSIONS) & PermissionFlagsBits.Administrator), 'nunca pedir Administrador')
})

test('permissões: detecta o que falta e respeita Administrador', () => {
  assert.deepEqual(missingPermissions(combine(BASE_PERMISSIONS), BASE_PERMISSIONS), [])
  assert.ok(missingPermissions(combine(BASE_PERMISSIONS), ADMIN_PERMISSIONS).includes('ManageRoles'))
  assert.deepEqual(missingPermissions(PermissionFlagsBits.Administrator, ADMIN_PERMISSIONS), [])
})

test('permissões: só donos, admins e quem gerencia o servidor são administradores do bot', () => {
  assert.equal(isBotAdmin({ userId: ID, memberPermissions: null }, [ID]), true)
  assert.equal(isBotAdmin({ userId: ID, memberPermissions: PermissionFlagsBits.ManageGuild }, []), true)
  assert.equal(isBotAdmin({ userId: ID, memberPermissions: PermissionFlagsBits.Administrator }, []), true)
  assert.equal(isBotAdmin({ userId: ID, memberPermissions: PermissionFlagsBits.SendMessages }, []), false)
  assert.equal(isBotAdmin({ userId: ID, memberPermissions: null }, []), false)
})

test('limitador: bloqueia acima do limite e libera após a janela', () => {
  const l = new RateLimiter(2, 1000)
  assert.ok(l.allow('u', 0))
  assert.ok(l.allow('u', 10))
  assert.ok(!l.allow('u', 20))
  assert.ok(l.allow('outro', 20))
  assert.ok(l.allow('u', 2000))
})

function fakeInteraction(over: Partial<InteractionLike> = {}) {
  const replies: string[] = []
  const i: InteractionLike = {
    commandName: 'diagnostico',
    user: { id: ID },
    guildId: '323456789012345678',
    memberPermissions: { bitfield: PermissionFlagsBits.SendMessages },
    appPermissions: { bitfield: combine(BASE_PERMISSIONS) },
    options: { getSubcommand: () => '', getString: () => null, getInteger: () => null, getChannel: () => null },
    replied: false,
    deferred: false,
    reply: async (o) => {
      replies.push(o.content)
    },
    followUp: async (o) => {
      replies.push(o.content)
    },
    ...over
  }
  return { i, replies }
}

function makeDeps(ownerIds: string[] = []): Deps {
  const lines: string[] = []
  return {
    config: { token: FAKE_TOKEN, clientId: ID, devGuildId: null, ownerIds, databasePath: ':memory:', logLevel: 'error' },
    db: openDatabase(':memory:'),
    log: createLogger({ level: 'error', write: (l) => lines.push(l) }),
    startedAt: Date.now() - 65_000,
    wsPing: () => 42,
    guildPort: () => null
  }
}

test('handler: nega comando administrativo a membro comum e audita a negação', async () => {
  const { i, replies } = fakeInteraction()
  const deps = makeDeps()
  await handleCommand(i, commandMap(), deps, new RateLimiter(5, 1000))
  assert.match(replies[0], /não tem permissão/)
  const row = deps.db.prepare('SELECT outcome, action FROM audit_log').get() as { outcome: string; action: string }
  assert.deepEqual({ ...row }, { outcome: 'denied', action: 'command:diagnostico' })
})

test('handler: administrador recebe o diagnóstico real e a execução é auditada', async () => {
  const { i, replies } = fakeInteraction({ memberPermissions: { bitfield: PermissionFlagsBits.ManageGuild } })
  const deps = makeDeps()
  await handleCommand(i, commandMap(), deps, new RateLimiter(5, 1000))
  assert.match(replies[0], /Banco de dados: OK \(migração v2\)/)
  assert.match(replies[0], /Gateway: 42 ms/)
  assert.match(replies[0], /Permissões básicas neste canal: OK/)
  assert.match(replies[0], /faltam .*ManageRoles/)
  const row = deps.db.prepare('SELECT outcome FROM audit_log').get() as { outcome: string }
  assert.equal(row.outcome, 'ok')
})

test('handler: /ping é aberto a todos e não gera auditoria', async () => {
  const { i, replies } = fakeInteraction({ commandName: 'ping' })
  const deps = makeDeps()
  await handleCommand(i, commandMap(), deps, new RateLimiter(5, 1000))
  assert.match(replies[0], /Online/)
  assert.equal((deps.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 0)
})

test('handler: comando desconhecido e limite de uso', async () => {
  const deps = makeDeps()
  const a = fakeInteraction({ commandName: 'inexistente' })
  await handleCommand(a.i, commandMap(), deps, new RateLimiter(5, 1000))
  assert.match(a.replies[0], /desconhecido/)

  const limiter = new RateLimiter(1, 10_000)
  const b = fakeInteraction({ commandName: 'ping' })
  await handleCommand(b.i, commandMap(), deps, limiter)
  const c = fakeInteraction({ commandName: 'ping' })
  await handleCommand(c.i, commandMap(), deps, limiter)
  assert.match(c.replies[0], /rápido demais/)
})

test('handler: erro no comando vira resposta genérica, log e auditoria de erro', async () => {
  const { i, replies } = fakeInteraction({ memberPermissions: { bitfield: PermissionFlagsBits.ManageGuild } })
  const deps = makeDeps()
  deps.wsPing = () => {
    throw new Error('boom')
  }
  await handleCommand(i, commandMap(), deps, new RateLimiter(5, 1000))
  assert.match(replies[0], /Ocorreu um erro/)
  const row = deps.db.prepare('SELECT outcome FROM audit_log').get() as { outcome: string }
  assert.equal(row.outcome, 'error')
})

test('redactText: não altera texto comum', () => {
  assert.equal(redactText('olá mundo'), 'olá mundo')
})
