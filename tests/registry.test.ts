// Fluxo obrigatório das ações: pré-visualização, confirmação, exclusão mútua,
// cancelamento, registro no diário, reversão com validação e integridade.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppFailure } from '../src/main/security/validate'
import { cancelJob, defineAction, executeAction, journal, previewAction, revertChange, runQuery, defineQuery } from '../src/main/ops/registry'
import { obj, int } from '../src/main/ops/params'

let systemValue = 1
let runs = 0

defineAction<{ value: number }, { value: number }>({
  id: 'test.set',
  module: 'power',
  title: 'Teste: alterar valor',
  description: 'Ação de teste',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'test',
  parse: (raw) => ({ value: int(obj(raw, ['value']).value, 'valor', 0, 100) }),
  async preview({ value }) {
    return { summary: 'ok', changes: [{ target: 'valor', current: String(systemValue), intended: String(value) }], warnings: [], blocked: value === systemValue ? 'Já está assim.' : null }
  },
  async precheck({ value }) {
    return value === 99 ? 'Bloqueado no momento da execução.' : null
  },
  async execute({ value }) {
    runs++
    await new Promise((r) => setTimeout(r, 30))
    const before = systemValue
    systemValue = value
    return { ok: true, verified: systemValue === value, summary: 'feito', change: { before: { value: before }, after: { value }, summaryBefore: String(before), summaryAfter: String(value) } }
  },
  async revert(before, after, ctx) {
    if (systemValue !== (after as { value: number }).value && !ctx.force) throw new AppFailure('state-changed', 'mudou')
    systemValue = before.value
    return 'restaurado'
  }
})

defineQuery({
  id: 'test.slow',
  module: 'power',
  parse: () => ({}),
  async run(_p, ctx) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000)
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new Error('abortado'))
      })
    })
    return 'terminou'
  }
})

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).constructor.name
  }
}

test('ações irreversíveis exigem justificativa e reversíveis exigem revert', () => {
  assert.throws(() =>
    defineAction({ id: 'test.bad1', module: 'power', title: '', description: '', risk: 'low', reversible: false, requiresElevation: false, parse: () => ({}), preview: async () => ({ summary: '', changes: [], warnings: [] }), execute: async () => ({ ok: true, verified: true, summary: '' }) })
  )
  assert.throws(() =>
    defineAction({ id: 'test.bad2', module: 'power', title: '', description: '', risk: 'low', reversible: true, requiresElevation: false, parse: () => ({}), preview: async () => ({ summary: '', changes: [], warnings: [] }), execute: async () => ({ ok: true, verified: true, summary: '' }) })
  )
})

test('execução sem pré-visualização válida é recusada', async () => {
  assert.equal(await code(executeAction(randomUUID(), true, undefined)), 'preview-expired')
  assert.equal(await code(executeAction(42, true, undefined)), 'ValidationError')
})

test('parâmetros inválidos e ações desconhecidas são recusados', async () => {
  assert.equal(await code(previewAction('test.set', { value: 500 })), 'ValidationError')
  assert.equal(await code(previewAction('test.set', { value: 5, extra: true })), 'ValidationError')
  assert.equal(await code(previewAction('nao.existe', {})), 'unknown-action')
  assert.equal(await code(runQuery('nao.existe', {}, undefined)), 'unknown-query')
})

test('confirmação explícita é obrigatória e a pré-visualização é de uso único', async () => {
  systemValue = 1
  const p1 = await previewAction('test.set', { value: 5 })
  assert.equal(p1.changes[0].current, '1')
  assert.equal(await code(executeAction(p1.previewId, false, undefined)), 'confirmation-required')
  const p2 = await previewAction('test.set', { value: 5 })
  const outcome = await executeAction(p2.previewId, true, undefined)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.verified, true)
  assert.ok(outcome.changeId)
  assert.equal(systemValue, 5)
  assert.equal(await code(executeAction(p2.previewId, true, undefined)), 'preview-expired')
})

test('bloqueio no momento da execução impede a alteração', async () => {
  systemValue = 1
  const before = runs
  const p = await previewAction('test.set', { value: 99 })
  assert.equal(await code(executeAction(p.previewId, true, undefined)), 'blocked')
  assert.equal(runs, before)
  assert.equal(systemValue, 1)
})

test('execuções incompatíveis simultâneas são impedidas', async () => {
  systemValue = 1
  const a = await previewAction('test.set', { value: 10 })
  const b = await previewAction('test.set', { value: 20 })
  const results = await Promise.all([code(executeAction(a.previewId, true, undefined)), code(executeAction(b.previewId, true, undefined))])
  assert.deepEqual(results.sort(), ['already-running', 'ok'])
})

test('reversão valida o estado atual, aceita forçar e registra o resultado', async () => {
  systemValue = 1
  const p = await previewAction('test.set', { value: 7 })
  const { changeId } = await executeAction(p.previewId, true, undefined)
  systemValue = 8 // alguém mudou depois
  assert.equal(await code(revertChange(changeId, false)), 'state-changed')
  assert.equal(journal.get(changeId!)?.status, 'applied', 'divergência não marca falha definitiva')
  const record = await revertChange(changeId, true)
  assert.equal(record.status, 'reverted')
  assert.equal(systemValue, 1)
  assert.equal(await code(revertChange(changeId, false)), 'already-reverted')
})

test('backup adulterado impede a reversão', async () => {
  systemValue = 1
  const p = await previewAction('test.set', { value: 3 })
  const { changeId } = await executeAction(p.previewId, true, undefined)
  const dir = join(process.env.JKO_TEST_DATA!, 'jk-data', 'journal', 'backups')
  const file = join(dir, readdirSync(dir).find((f) => f.startsWith(changeId!))!)
  writeFileSync(file, readFileSync(file, 'utf8').replace('"value": 1', '"value": 66'))
  assert.equal(await code(revertChange(changeId, false)), 'backup-integrity')
  assert.equal(systemValue, 3)
})

test('operação longa pode ser cancelada pelo jobId', async () => {
  const jobId = randomUUID()
  const pending = code(runQuery('test.slow', {}, jobId))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(cancelJob(jobId), true)
  assert.equal(await pending, 'cancelled')
  assert.equal(cancelJob(jobId), false)
})
