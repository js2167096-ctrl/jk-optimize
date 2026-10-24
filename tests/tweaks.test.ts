// Central de ajustes: leitura a partir do estado real, perfis distintos, plano de aplicação
// (já configurado, indisponível, valor não suportado), validação de entrada e "Meus ajustes".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describe, parseChanges, parseMyTweaks, planChanges, TWEAKS, type Snapshot } from '../src/main/modules/tweaks'

const ULTIMATE = '150e2ee8-fe46-4b91-a25b-f98157151549'
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

function snapshot(over: { reg?: Record<string, string | number | null>; power?: Record<string, number | null>; battery?: boolean; build?: number; ultimate?: boolean } = {}): Snapshot {
  const schemes = [
    { guid: BALANCED, name: 'Equilibrado', active: true, ultimate: false },
    { guid: HIGH, name: 'Alto desempenho', active: false, ultimate: false },
    ...(over.ultimate === false ? [] : [{ guid: ULTIMATE, name: 'Desempenho Máximo', active: false, ultimate: true }])
  ]
  return {
    ctx: { build: over.build ?? 19045, hasBattery: over.battery ?? false, schemes },
    reg: new Map(Object.entries(over.reg ?? {})),
    power: new Map(Object.entries({ procMin: 5, usbSuspend: 1, pcieAspm: 1, ...(over.power ?? {}) }))
  }
}

const state = (s: Snapshot, base: Record<string, { value: string }> = {}) => new Map(describe(s, base).map((t) => [t.id, t]))

test('leitura: valor ausente no registro segue o padrão do Windows; valor desconhecido vira personalizado', () => {
  const s = snapshot({ reg: { 'HKCU:\\Control Panel\\Desktop|MenuShowDelay': '250', 'HKCU:\\Control Panel\\Mouse|MouseSpeed': '0' } })
  const t = state(s)
  assert.equal(t.get('transparency')!.current, 'on', 'EnableTransparency ausente = ativado')
  assert.equal(t.get('mouseAccel')!.current, 'off')
  assert.equal(t.get('menuDelay')!.current, 'custom:250')
  assert.match(t.get('menuDelay')!.currentLabel, /Personalizado \(250\)/)
  assert.equal(t.get('powerPlan')!.current, BALANCED)
  assert.equal(t.get('usbSuspend')!.current, 'on')
})

test('indisponibilidade só desabilita o ajuste afetado', () => {
  const t = state(snapshot({ build: 22631, power: { pcieAspm: null } }))
  assert.match(t.get('hags')!.unavailable!, /HwSchMode ausente/)
  assert.match(t.get('bgApps')!.unavailable!, /Windows 11/)
  assert.match(t.get('pcieAspm')!.unavailable!, /não existe no plano/)
  assert.equal(t.get('transparency')!.unavailable, null)
  const dvr = state(snapshot({ reg: { 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR|AllowGameDVR': 0 } }))
  assert.match(dvr.get('gameDvr')!.unavailable!, /política/)
})

test('perfis Padrão, Ideal e Máximo são distintos e respeitam o hardware', () => {
  const desk = state(snapshot({ reg: { 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers|HwSchMode': 1 } }), { transparency: { value: 'on' }, powerPlan: { value: BALANCED } })
  const values = (p: 'default' | 'ideal' | 'max') => JSON.stringify([...desk.values()].map((t) => t.profiles[p]))
  assert.notEqual(values('default'), values('ideal'))
  assert.notEqual(values('ideal'), values('max'))
  assert.equal(desk.get('powerPlan')!.profiles.default, BALANCED, 'Padrão = perfil-base registrado')
  assert.equal(desk.get('powerPlan')!.profiles.ideal, HIGH)
  assert.equal(desk.get('powerPlan')!.profiles.max, ULTIMATE)
  assert.equal(desk.get('procMin')!.profiles.max, '100')
  assert.equal(desk.get('hags')!.profiles.max, 'on')
  assert.equal(desk.get('transparency')!.profiles.max, 'off')
  const laptop = state(snapshot({ battery: true, ultimate: false }))
  assert.equal(laptop.get('powerPlan')!.profiles.ideal, BALANCED, 'notebook: Equilibrado no Ideal')
  assert.equal(laptop.get('powerPlan')!.profiles.max, HIGH)
  assert.equal(laptop.get('procMin')!.profiles.max, '5', 'notebook não força 100% de estado mínimo')
  assert.equal(laptop.get('usbSuspend')!.profiles.max, 'on', 'notebook mantém a suspensão de USB')
})

test('nenhum perfil mexe em serviços, Defender, firewall ou atualizações', () => {
  const ids = TWEAKS.map((t) => t.id.toLowerCase()).join(' ')
  assert.doesNotMatch(ids, /defender|firewall|update|service|thermal/)
})

test('plano de aplicação: já configurado, indisponível, valor não suportado e ordem', () => {
  const s = snapshot({ build: 22631 })
  const plan = planChanges(s, { usbSuspend: 'off', transparency: 'on', bgApps: 'off', powerPlan: HIGH, menuDelay: '999' })
  assert.deepEqual(plan.apply.map((x) => x.t.id), ['powerPlan', 'usbSuspend'], 'plano de energia antes das configurações do plano')
  assert.deepEqual(plan.already, ['Efeitos de transparência'])
  assert.equal(plan.skipped.length, 2)
  assert.ok(plan.skipped.some((x) => x.includes('Windows 11')))
  assert.ok(plan.skipped.some((x) => x.includes('não suportado')))
  assert.equal(planChanges(s, { powerPlan: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }).apply.length, 0, 'plano inexistente não é aplicado')
})

test('entrada validada: ajuste desconhecido, valor com comando e lista vazia', () => {
  assert.throws(() => parseChanges({ changes: { naoExiste: 'on' } }), /desconhecido/)
  assert.throws(() => parseChanges({ changes: { transparency: 'on; Remove-Item C:\\' } }))
  assert.throws(() => parseChanges({ changes: {} }), /pelo menos um/)
  assert.throws(() => parseChanges({ changes: { transparency: 'on' }, extra: 1 }))
  assert.deepEqual(parseChanges({ changes: { transparency: 'off' } }), { transparency: 'off' })
})

test('Meus ajustes: perfis salvos não carregam ajustes desconhecidos nem valores perigosos', () => {
  const data = parseMyTweaks({
    favorites: ['transparency', 'naoExiste', 'transparency'],
    profiles: [
      { id: 'a', name: 'Meu perfil', createdAt: 'x', values: { transparency: 'off', shell: 'x', menuDelay: 'cmd /c del' } },
      { id: 'b', name: '<script>', values: {} }
    ]
  })
  assert.deepEqual(data.favorites, ['transparency'])
  assert.equal(data.profiles.length, 1)
  assert.deepEqual(data.profiles[0].values, { transparency: 'off' })
})

test('reinício: só os ajustes que dependem de reiniciar o Windows avisam', () => {
  const t = state(snapshot({ reg: { 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers|HwSchMode': 1 } }))
  assert.equal(t.get('hags')!.needsRestart, true)
  const needs = [...t.values()].filter((x) => x.needsRestart).map((x) => x.id).sort()
  assert.deepEqual(needs, ['fastStartup', 'hags', 'lastAccess', 'netThrottle'])
})
