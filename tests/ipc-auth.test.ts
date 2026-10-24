// Comunicação IPC e autorização: origem confiável, ativação e permissões de proprietário,
// verificadas no processo principal (não pela interface).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlers } from './electron-stub'
import { registerIpc } from '../src/main/ipc'
import { IPC } from '../src/shared/constants/ipc'

const TRUSTED = 'file:///app/index.html'
registerIpc((url) => url === TRUSTED)

type Result = { ok: boolean; error?: { code: string } }
const call = (channel: string, url: string, ...args: unknown[]) =>
  handlers.get(channel)!({ senderFrame: { url }, sender: {} }, ...args) as Promise<Result>

test('todos os canais da lista permitida estão registrados e nenhum outro', () => {
  const expected = new Set(Object.values(IPC))
  for (const channel of handlers.keys()) assert.ok(expected.has(channel as never), `canal inesperado: ${channel}`)
  for (const channel of expected) assert.ok(handlers.has(channel), `canal ausente: ${channel}`)
})

test('origem não confiável é recusada antes de qualquer serviço', async () => {
  const r = await call(IPC.opsQuery, 'https://site-malicioso.example/', 'power.plans', {})
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'forbidden-sender')
})

test('sem ativação, operações protegidas são negadas', async () => {
  for (const [channel, args] of [
    [IPC.opsQuery, ['power.plans', {}]],
    [IPC.opsPreview, ['power.plan.set', { guid: '381b4222-f694-41f0-9685-ff5bb260df2e' }]],
    [IPC.opsExecute, ['00000000-0000-0000-0000-000000000000', true]],
    [IPC.opsChanges, []],
    [IPC.systemGetMetrics, []],
    [IPC.executorRun, [{ taskId: 'executor.self-check', params: {}, confirmed: false }]]
  ] as const) {
    const r = await call(channel, TRUSTED, ...args)
    assert.equal(r.ok, false, channel)
    assert.equal(r.error?.code, 'access-denied', channel)
  }
})

test('funções de proprietário são negadas sem a sessão do proprietário', async () => {
  const r = await call(IPC.keysList, TRUSTED)
  assert.equal(r.ok, false)
  assert.ok(['owner-required', 'access-denied'].includes(r.error!.code))
  const g = await call(IPC.keysGenerate, TRUSTED, { label: 'x', validDays: null, machineId: null })
  assert.equal(g.ok, false)
})

test('canais públicos respondem sem expor dados protegidos', async () => {
  const r = (await call(IPC.appGetAccess, TRUSTED)) as Result & { data?: { kind: string } }
  assert.equal(r.ok, true)
  assert.ok(['activation-required', 'unconfigured'].includes(r.data!.kind))
})
