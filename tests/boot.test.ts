// Tela de carregamento: progresso calculado somente por etapas reais concluídas, e prazos da inicialização.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOOT_STAGES, bootLabel, bootProgress, currentStage, type BootStage } from '../src/shared/boot'
import { withDeadline } from '../src/main/startup'

test('progresso: pesos somam 100, começa em 0 e só chega a 100 com todas as etapas concluídas', () => {
  assert.equal(BOOT_STAGES.reduce((n, s) => n + s.weight, 0), 100)
  assert.equal(bootProgress(new Set()), 0)
  const all = new Set<BootStage>(BOOT_STAGES.map((s) => s.id))
  assert.equal(bootProgress(all), 100)
  all.delete('executor')
  assert.equal(bootProgress(all), 75)
})

test('progresso: cada etapa concluída soma o seu peso e nunca diminui', () => {
  const done = new Set<BootStage>()
  let last = 0
  for (const s of BOOT_STAGES) {
    done.add(s.id)
    const p = bootProgress(done)
    assert.ok(p > last, `${s.id}: ${p} deveria ser maior que ${last}`)
    assert.equal(p - last, s.weight)
    last = p
  }
})

test('progresso: etapas fora de ordem (paralelas) contam normalmente; o texto mostra a primeira pendente', () => {
  const done = new Set<BootStage>(['executor', 'identity'])
  assert.equal(bootProgress(done), 35)
  assert.equal(currentStage(done)?.id, 'resources')
  assert.equal(bootLabel(done), 'Carregando recursos...')
  done.add('resources').add('settings')
  assert.equal(bootLabel(done), 'Verificando a licença...')
  for (const s of BOOT_STAGES) done.add(s.id)
  assert.equal(bootLabel(done), 'Pronto')
  assert.equal(currentStage(done), null)
})

test('prazo: usa o resultado quando chega a tempo e o valor alternativo quando demora ou falha', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 200, 0), 7)
  assert.equal(await withDeadline(new Promise<number>((r) => setTimeout(() => r(7), 300)), 30, 0), 0)
  assert.equal(await withDeadline(Promise.reject(new Error('x')), 200, () => 5), 5)
})
