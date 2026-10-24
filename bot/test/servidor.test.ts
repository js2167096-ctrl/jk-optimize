import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PermissionFlagsBits } from 'discord.js'
import type { ButtonLike, Deps } from '../src/commands/types.js'
import { openDatabase } from '../src/db/index.js'
import { createLogger } from '../src/logger.js'
import { ADMIN_PERMISSIONS, combine } from '../src/permissions.js'
import { applyPlan, lastUndoableBatch, preview, undoBatch } from '../src/servidor/apply.js'
import { CANCEL_PREFIX, CONFIRM_PREFIX, handleButton } from '../src/servidor/buttons.js'
import { diffPlan, normalizeName } from '../src/servidor/diff.js'
import { PendingStore } from '../src/servidor/pending.js'
import { findTemplate, TEMPLATES } from '../src/servidor/templates.js'
import type { GuildPort, GuildSnapshot, ResolvedOverwrite, ServerPlan } from '../src/servidor/types.js'
import { bits, validatePlan } from '../src/servidor/validate.js'

const GUILD = '323456789012345678'
const BOT = '423456789012345678'
const USER = '123456789012345678'

interface FakeOptions {
  botPermissions?: bigint
  failOnChannel?: string
}

function fakePort(opts: FakeOptions = {}) {
  let n = 1000
  const roles = new Map<string, { name: string; permissions: bigint }>()
  const channels = new Map<string, { name: string; kind: 'category' | 'text' | 'voice'; parentId: string | null; overwrites: ResolvedOverwrite[]; slowmode?: number }>()
  const port: GuildPort = {
    id: GUILD,
    botId: BOT,
    botPermissions: () => opts.botPermissions ?? combine(ADMIN_PERMISSIONS),
    async snapshot(): Promise<GuildSnapshot> {
      return {
        roles: [...roles].map(([id, r]) => ({ id, name: r.name, managed: false })),
        channels: [...channels].map(([id, c]) => ({ id, name: c.name, kind: c.kind, parentId: c.parentId }))
      }
    },
    async createRole(spec) {
      const id = String(++n)
      roles.set(id, { name: spec.name, permissions: spec.permissions })
      return { id }
    },
    async createCategory(name, overwrites) {
      const id = String(++n)
      channels.set(id, { name, kind: 'category', parentId: null, overwrites })
      return { id }
    },
    async createChannel(spec) {
      if (opts.failOnChannel && spec.name === opts.failOnChannel) throw new Error('Missing Permissions')
      const id = String(++n)
      channels.set(id, { name: spec.name, kind: spec.type, parentId: spec.parentId, overwrites: spec.overwrites, slowmode: spec.slowmode })
      return { id }
    },
    async deleteRole(id) {
      return roles.delete(id)
    },
    async deleteChannel(id) {
      return channels.delete(id)
    },
    async childCount(categoryId) {
      return [...channels.values()].filter((c) => c.parentId === categoryId).length
    },
    async setSlowmode(id, seconds) {
      const c = channels.get(id)
      if (!c || c.kind !== 'text') return false
      c.slowmode = seconds
      return true
    }
  }
  return { port, roles, channels }
}

const mini: ServerPlan = {
  id: 'mini',
  title: 'Mini',
  description: 'teste',
  roles: [
    { key: 'dono', name: '👑 Dono', permissions: ['ManageMessages'] },
    { key: 'cliente', name: '💎 Cliente', permissions: [] }
  ],
  categories: [
    {
      name: '🔐｜EQUIPE',
      overwrites: [{ role: 'everyone', deny: ['ViewChannel'] }, { role: 'dono', allow: ['ViewChannel', 'SendMessages'] }],
      channels: [{ name: '🔐｜staff-chat', type: 'text', slowmode: 5 }, { name: '🔊 Sala', type: 'voice' }]
    },
    { name: '📢｜INFO', channels: [{ name: '📜｜regras', type: 'text' }] }
  ]
}

test('modelos: todos os modelos embutidos são válidos e não concedem permissões perigosas', () => {
  assert.ok(TEMPLATES.length >= 6)
  for (const t of TEMPLATES) assert.deepEqual(validatePlan(t), [], `modelo ${t.id}`)
  assert.ok(findTemplate('clientes-jk'))
  assert.equal(findTemplate('nao-existe'), undefined)
})

test('modelos: as permissões usadas cabem nas que o convite --admin pede', () => {
  const bot = combine(ADMIN_PERMISSIONS)
  for (const t of TEMPLATES) {
    const needed = [
      ...t.roles.flatMap((r) => r.permissions),
      ...t.categories.flatMap((c) => [...(c.overwrites ?? []), ...c.channels.flatMap((ch) => ch.overwrites ?? [])].flatMap((o) => o.allow ?? []))
    ]
    for (const p of needed) assert.ok((bot & bits([p])) === bits([p]), `${t.id}: bot sem ${p}`)
  }
})

test('validação: recusa Administrator, cargos inexistentes, nomes e modo lento inválidos', () => {
  const bad: ServerPlan = {
    ...mini,
    roles: [{ key: 'a', name: 'A', permissions: ['Administrator'] }, { key: 'a', name: 'B', permissions: [] }],
    categories: [{ name: 'X', overwrites: [{ role: 'fantasma', allow: ['ViewChannel'] }], channels: [{ name: '', type: 'voice', slowmode: 5 }] }]
  }
  const problems = validatePlan(bad).join('\n')
  assert.match(problems, /não pode conceder Administrator/)
  assert.match(problems, /Cargo duplicado/)
  assert.match(problems, /"fantasma" não existe/)
  assert.match(problems, /nome vazio/)
  assert.match(problems, /modo lento/)
})

test('diff: servidor vazio cria tudo; itens existentes são preservados', async () => {
  const { port, roles } = fakePort()
  roles.set('1', { name: '👑 dono', permissions: 0n })
  const diff = diffPlan(mini, await port.snapshot(), port.botPermissions())
  assert.equal(diff.items.find((i) => i.name === '👑 Dono')?.action, 'exists')
  assert.equal(diff.items.find((i) => i.name === '💎 Cliente')?.action, 'create')
  assert.equal(diff.items.filter((i) => i.action === 'create').length, 7 - 1)
  assert.equal(diff.conflicts.length, 0)
  assert.equal(normalizeName(' Sala  Geral '), 'sala-geral')
})

test('diff: conflita quando o bot não tem permissões ou não pode conceder', async () => {
  const { port } = fakePort({ botPermissions: PermissionFlagsBits.ViewChannel })
  const diff = diffPlan(mini, await port.snapshot(), port.botPermissions())
  const text = diff.conflicts.join('\n')
  assert.match(text, /Gerenciar Cargos/)
  assert.match(text, /Gerenciar Canais/)
  assert.match(text, /não possui ManageMessages/)
})

test('aplicar: cria na ordem, registra o lote, aplica permissões privadas e dá acesso ao bot', async () => {
  const db = openDatabase(':memory:')
  const { port, roles, channels } = fakePort()
  const report = await applyPlan(db, mini, port, USER)
  assert.equal(report.ok, true)
  assert.deepEqual(report.created, { roles: 2, categories: 2, channels: 3 })
  assert.equal(roles.size, 2)

  const team = [...channels.values()].find((c) => c.name === '🔐｜EQUIPE')!
  const everyone = team.overwrites.find((o) => o.id === GUILD)!
  assert.ok((everyone.deny & PermissionFlagsBits.ViewChannel) !== 0n, '@everyone não vê a categoria privada')
  assert.ok(team.overwrites.some((o) => o.id === BOT && o.type === 'member'), 'o bot mantém acesso')
  const staff = [...channels.values()].find((c) => c.name === '🔐｜staff-chat')!
  assert.ok(staff.overwrites.some((o) => o.id === GUILD), 'o canal herda as regras da categoria explicitamente')
  assert.equal(staff.slowmode, 5)

  const items = (db.prepare('SELECT COUNT(*) AS n FROM change_items').get() as { n: number }).n
  assert.equal(items, 7)
  assert.equal((db.prepare('SELECT status FROM change_batches').get() as { status: string }).status, 'applied')
  assert.equal((db.prepare("SELECT outcome FROM audit_log WHERE action = 'servidor:aplicar'").get() as { outcome: string }).outcome, 'ok')
})

test('aplicar: é idempotente (segunda execução não cria nada)', async () => {
  const db = openDatabase(':memory:')
  const { port, channels } = fakePort()
  await applyPlan(db, mini, port, USER)
  const before = channels.size
  const second = await applyPlan(db, mini, port, USER)
  assert.equal(second.ok, true)
  assert.deepEqual(second.created, { roles: 0, categories: 0, channels: 0 })
  assert.equal(channels.size, before)
})

test('aplicar: falha no meio gera lote parcial com o que já foi criado e permite desfazer', async () => {
  const db = openDatabase(':memory:')
  const { port, roles, channels } = fakePort({ failOnChannel: '📜｜regras' })
  const report = await applyPlan(db, mini, port, USER)
  assert.equal(report.ok, false)
  assert.match(report.problems[0], /regras.*Missing Permissions/)
  assert.deepEqual(report.created, { roles: 2, categories: 2, channels: 2 })
  assert.equal((db.prepare('SELECT status FROM change_batches').get() as { status: string }).status, 'partial')

  const batch = lastUndoableBatch(db, GUILD)!
  assert.equal(batch.items.length, 6)
  const undo = await undoBatch(db, batch, port, USER)
  assert.equal(undo.removed, 6)
  assert.equal(roles.size + channels.size, 0)
  assert.equal(lastUndoableBatch(db, GUILD), null)
})

test('aplicar: conflitos impedem qualquer alteração e são auditados', async () => {
  const db = openDatabase(':memory:')
  const { port, roles, channels } = fakePort({ botPermissions: 0n })
  const report = await applyPlan(db, mini, port, USER)
  assert.equal(report.ok, false)
  assert.equal(report.batchId, null)
  assert.equal(roles.size + channels.size, 0)
  assert.equal((db.prepare("SELECT outcome FROM audit_log").get() as { outcome: string }).outcome, 'denied')
})

test('desfazer: apaga só o que o bot criou, mantém categoria com canais de terceiros e tolera itens já removidos', async () => {
  const db = openDatabase(':memory:')
  const { port, roles, channels } = fakePort()
  await applyPlan(db, mini, port, USER)

  const info = [...channels].find(([, c]) => c.name === '📢｜INFO')!
  channels.set('9999', { name: 'canal-do-usuario', kind: 'text', parentId: info[0], overwrites: [] })
  const goneId = [...channels].find(([, c]) => c.name === '🔊 Sala')![0]
  channels.delete(goneId)
  roles.set('8888', { name: 'cargo-do-usuario', permissions: 0n })

  const undo = await undoBatch(db, lastUndoableBatch(db, GUILD)!, port, USER)
  assert.deepEqual(undo.keptNonEmpty, ['📢｜INFO'])
  assert.equal(undo.alreadyGone, 1)
  assert.ok(channels.has('9999'), 'canal de terceiros preservado')
  assert.ok(roles.has('8888'), 'cargo de terceiros preservado')
  assert.ok(channels.has(info[0]), 'categoria não vazia preservada')
  assert.equal(lastUndoableBatch(db, GUILD)?.items.length, 1)
})

test('preview: não altera nada e reporta problemas de validação', async () => {
  const { port, roles, channels } = fakePort()
  const ok = await preview(mini, port)
  assert.equal(ok.problems.length, 0)
  assert.equal(roles.size + channels.size, 0)
  const bad = await preview({ ...mini, roles: [{ key: 'x', name: 'X', permissions: ['Administrator'] }] }, port)
  assert.ok(bad.problems.length > 0)
})

test('confirmações pendentes: expiram, são consumidas uma vez e só valem para quem pediu', () => {
  const s = new PendingStore(1000)
  const t = s.create({ kind: 'apply', userId: USER, guildId: GUILD, templateId: 'x' }, 0)
  assert.equal(s.take(t, 'outro', 10), null)
  assert.ok(s.take(t, USER, 10))
  assert.equal(s.take(t, USER, 10), null)
  const e = s.create({ kind: 'apply', userId: USER, guildId: GUILD, templateId: 'x' }, 0)
  assert.equal(s.take(e, USER, 5000), null)
})

function makeDeps(port: GuildPort | null, ownerIds: string[] = [USER]): Deps {
  return {
    config: { token: 't', clientId: BOT, devGuildId: null, ownerIds, databasePath: ':memory:', logLevel: 'error' },
    db: openDatabase(':memory:'),
    log: createLogger({ level: 'error', write: () => undefined }),
    startedAt: Date.now(),
    wsPing: () => 1,
    guildPort: () => port
  }
}

function fakeButton(customId: string, userId = USER, perms = 0n) {
  const sent: string[] = []
  const b: ButtonLike = {
    customId,
    user: { id: userId },
    guildId: GUILD,
    memberPermissions: { bitfield: perms },
    reply: async (o) => void sent.push(o.content),
    update: async (o) => void sent.push(o.content)
  }
  return { b, sent }
}

test('botões: usuário sem permissão não confirma; cancelar não altera nada', async () => {
  const { port, roles, channels } = fakePort()
  const deps = makeDeps(port, [])
  const store = new PendingStore()
  const token = store.create({ kind: 'apply', userId: USER, guildId: GUILD, templateId: 'suporte-tecnico' })

  const denied = fakeButton(`${CONFIRM_PREFIX}${token}`)
  await handleButton(denied.b, deps, store)
  assert.match(denied.sent[0], /não tem permissão/)
  assert.equal(roles.size + channels.size, 0)

  const owner = makeDeps(port, [USER])
  const cancel = fakeButton(`${CANCEL_PREFIX}${token}`)
  await handleButton(cancel.b, owner, store)
  assert.match(cancel.sent[0], /Cancelado/)
  const late = fakeButton(`${CONFIRM_PREFIX}${token}`)
  await handleButton(late.b, owner, store)
  assert.match(late.sent[0], /expirou/)
  assert.equal(roles.size + channels.size, 0)
})

test('botões: confirmar aplica o modelo e depois desfazer remove, ambos com confirmação', async () => {
  const { port, roles, channels } = fakePort()
  const deps = makeDeps(port)
  const store = new PendingStore()

  const t1 = store.create({ kind: 'apply', userId: USER, guildId: GUILD, templateId: 'suporte-tecnico' })
  const apply = fakeButton(`${CONFIRM_PREFIX}${t1}`)
  await handleButton(apply.b, deps, store)
  assert.match(apply.sent.at(-1)!, /Modelo aplicado/)
  assert.ok(roles.size > 0 && channels.size > 0)

  const batch = lastUndoableBatch(deps.db, GUILD)!
  const t2 = store.create({ kind: 'undo', userId: USER, guildId: GUILD, batchId: batch.id })
  const undo = fakeButton(`${CONFIRM_PREFIX}${t2}`)
  await handleButton(undo.b, deps, store)
  assert.match(undo.sent.at(-1)!, /Desfazer concluído/)
  assert.equal(roles.size + channels.size, 0)
})
