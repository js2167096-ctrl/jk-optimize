// Finalização do design: índice de otimização verificável, estado final da tela de aplicação
// (sucesso, falha parcial, cancelamento, reinício), reinício sempre confirmado e tema salvo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DISK_FREE_MIN_PCT, evaluateIndex, MEMORY_LIMIT_PCT, STARTUP_LIMIT, type IndexInput } from '../src/shared/optimization-index'
import { classifyResult, restartNamesFor, settleTasks, type ApplyTask } from '../src/shared/apply-tasks'
import { previewAction, executeAction } from '../src/main/ops/registry'
import { restartArgs, RESTART_DELAY_SEC } from '../src/main/modules/restart'
import { getSettings, updateSettings } from '../src/main/services/settings'
import { DEFAULT_SETTINGS } from '../src/shared/constants/app'
import { SOCIAL_LINKS } from '../src/shared/constants/links'
import { THEME_IDS } from '../src/shared/constants/themes'

// ---------------------------------------------------------------------------
// Índice de otimização

const good: IndexInput = { powerPlan: 'Desempenho Máximo', gameMode: 'ativado', startupEnabled: 8, memoryCommitPct: 50, perfLimitPct: 100, minDiskFreePct: 40, executorReady: true }

test('índice: tudo atendido = 7 de 7 e 100%', () => {
  const r = evaluateIndex(good)
  assert.equal(r.total, 7)
  assert.equal(r.evaluated, 7)
  assert.equal(r.passed, 7)
  assert.equal(r.percent, 100)
  assert.ok(r.criteria.every((c) => c.state === 'ok' && c.recommendation === null))
})

test('índice: cada critério falha pelo limite documentado e gera recomendação com destino', () => {
  const r = evaluateIndex({ powerPlan: 'Economia de energia', gameMode: 'desativado', startupEnabled: STARTUP_LIMIT + 1, memoryCommitPct: MEMORY_LIMIT_PCT, perfLimitPct: 70, minDiskFreePct: DISK_FREE_MIN_PCT - 1, executorReady: false })
  assert.equal(r.passed, 0)
  assert.equal(r.percent, 0)
  for (const c of r.criteria) {
    assert.equal(c.state, 'fail', c.id)
    assert.ok(c.recommendation, `${c.id} sem recomendação`)
  }
  assert.equal(r.criteria.find((c) => c.id === 'power')!.section, 'power')
  // Limites exatos: no limite ainda passa onde o critério é "até", e falha onde é "abaixo de".
  const edge = evaluateIndex({ ...good, startupEnabled: STARTUP_LIMIT, memoryCommitPct: MEMORY_LIMIT_PCT - 1, minDiskFreePct: DISK_FREE_MIN_PCT })
  assert.ok(edge.criteria.filter((c) => ['startup', 'memory', 'disk'].includes(c.id)).every((c) => c.state === 'ok'))
})

test('índice: critério sem dado fica indisponível e não entra na conta (nada inventado)', () => {
  const r = evaluateIndex({ powerPlan: null, gameMode: null, startupEnabled: null, memoryCommitPct: null, perfLimitPct: null, minDiskFreePct: null, executorReady: true })
  assert.equal(r.evaluated, 1)
  assert.equal(r.passed, 1)
  assert.equal(r.percent, null, 'poucos critérios avaliados: sem percentual')
  assert.equal(r.criteria.filter((c) => c.state === 'unknown').length, 6)
  const partial = evaluateIndex({ ...good, perfLimitPct: null, minDiskFreePct: null })
  assert.equal(partial.evaluated, 5)
  assert.equal(partial.percent, 100)
})

test('índice: "Equilibrado" não é tratado como economia; "Economia" sim', () => {
  assert.equal(evaluateIndex({ ...good, powerPlan: 'Equilibrado' }).criteria[0].state, 'ok')
  assert.equal(evaluateIndex({ ...good, powerPlan: 'Power saver' }).criteria[0].state, 'fail')
  assert.equal(evaluateIndex({ ...good, gameMode: 'padrão (ativado)' }).criteria[1].state, 'ok')
})

// ---------------------------------------------------------------------------
// Tela de aplicação: estado final das tarefas

const task = (id: string, name: string): ApplyTask => ({ id, name, from: 'A', to: 'B', state: 'wait' })
const tasks = [task('a', 'Ajuste A'), task('b', 'Ajuste B'), task('c', 'Ajuste C')]

test('aplicação: sucesso total só quando o Windows relido confirma todos', () => {
  const rows = tasks.map((t) => ({ label: t.name, value: 'A → B (conferido)', tone: 'ok' }))
  const done = settleTasks(tasks, rows, new Set(['a', 'b', 'c']), null)
  assert.ok(done.every((t) => t.state === 'ok'))
  assert.equal(classifyResult(done, false), 'success')
  // A operação disse "ok", mas o Windows não confirma: não é sucesso.
  const doubt = settleTasks(tasks, rows, new Set(['a', 'b']), null)
  assert.equal(doubt.find((t) => t.id === 'c')!.state, 'skip')
  assert.equal(classifyResult(doubt, false), 'partial')
})

test('aplicação: falha parcial mostra o motivo e não declara sucesso', () => {
  const rows = [
    { label: 'Ajuste A', value: 'A → B (conferido)', tone: 'ok' },
    { label: 'Ajuste B', value: 'Falhou: acesso negado', tone: 'error' },
    { label: 'Ajuste C', value: 'Cancelado antes de aplicar', tone: 'warn' }
  ]
  const done = settleTasks(tasks, rows, new Set(['a']), null)
  assert.deepEqual(done.map((t) => t.state), ['ok', 'fail', 'skip'])
  assert.equal(done[1].detail, 'Falhou: acesso negado')
  assert.equal(classifyResult(done, false), 'partial')
})

test('aplicação: cancelamento sem nada aplicado e erro total não ficam "presos" nem viram sucesso', () => {
  const none = settleTasks(tasks, tasks.map((t) => ({ label: t.name, value: 'Cancelado antes de aplicar', tone: 'warn' })), new Set(), null)
  assert.ok(none.every((t) => t.state === 'skip'))
  assert.equal(classifyResult(none, true), 'cancelled')
  assert.equal(classifyResult(none, false), 'failure')
  const crashed = settleTasks(tasks, [], null, 'Falha de comunicação')
  assert.ok(crashed.every((t) => t.state === 'fail' && t.detail === 'Falha de comunicação'))
  assert.equal(classifyResult(crashed, false), 'failure')
  assert.equal(classifyResult([], false), 'failure')
})

test('reinício: só é oferecido para ajustes aplicados com sucesso que exigem reiniciar', () => {
  const done = settleTasks(tasks, tasks.map((t) => ({ label: t.name, value: 'ok', tone: 'ok' })), new Set(['a', 'c']), null)
  assert.deepEqual(restartNamesFor(done, (id) => id === 'a' || id === 'b'), ['Ajuste A'], 'b não foi aplicado; c não exige reinício')
  assert.deepEqual(restartNamesFor(done, () => false), [])
})

// ---------------------------------------------------------------------------
// Reinício: sempre confirmado, comando fixo e cancelável

test('reinício: argumentos fixos do shutdown, com contagem limitada', () => {
  assert.deepEqual(restartArgs().slice(0, 3), ['/r', '/t', String(RESTART_DELAY_SEC)])
  assert.equal(restartArgs(1)[2], '10')
  assert.equal(restartArgs(99999)[2], '300')
  assert.ok(restartArgs().every((a) => typeof a === 'string'))
  assert.ok(!restartArgs().includes('/f'), 'nunca força o fechamento de aplicativos')
})

test('reinício: a ação exige confirmação e a prévia avisa sobre trabalho não salvo (nada é executado)', async () => {
  const p = await previewAction('system.restart', {})
  assert.equal(p.risk, 'high')
  assert.equal(p.reversible, false)
  assert.equal(p.blocked ?? null, null)
  assert.ok(p.warnings.some((w) => /salve/i.test(w)))
  // Sem confirmação explícita a execução é recusada (e, portanto, o computador NÃO reinicia).
  await assert.rejects(executeAction(p.previewId, false, undefined), (e: { code?: string }) => e.code === 'confirmation-required')
})

// ---------------------------------------------------------------------------
// Tema e links

test('tema: padrão azul, os 7 temas são validados e persistidos', () => {
  assert.equal(DEFAULT_SETTINGS.theme, 'blue')
  assert.equal(getSettings().theme, 'blue')
  assert.equal(updateSettings({ theme: 'red' }).theme, 'red')
  assert.equal(getSettings().theme, 'red')
  for (const t of THEME_IDS) assert.equal(updateSettings({ theme: t }).theme, t)
  assert.deepEqual([...THEME_IDS], ['blue', 'red', 'ruby', 'violet', 'emerald', 'gold', 'cyan'])
  assert.throws(() => updateSettings({ theme: 'verde' }), /use um destes/)
  assert.throws(() => updateSettings({ theme: 'red', corAleatoria: 1 }))
  assert.equal(updateSettings({ theme: 'blue' }).theme, 'blue')
})

test('links sociais: nenhum endereço inventado (só aparecem quando configurados)', () => {
  for (const [rede, url] of Object.entries(SOCIAL_LINKS)) assert.ok(url === null || /^https:\/\//.test(url), `${rede}: ${url}`)
})
