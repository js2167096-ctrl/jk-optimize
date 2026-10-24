// Otimização 2: o catálogo avançado, as operações administrativas permitidas, as regras de limpeza e as leituras de segurança.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describe, planChanges, TWEAKS, lastAccessFsutilValue, type Snapshot } from '../src/main/modules/tweaks'
import { SERVICES_ALLOWED, validateOps, type ElevOp } from '../src/main/modules/elevops'
import { buildSecurityRows, planVolumeOp, type SecurityRaw } from '../src/main/modules/advanced'
import { extraTargets } from '../src/main/modules/cleanup-extra'
import { WIN2_BOOSTER, WIN2_SCRIPTS, WIN2_TWEAKS } from '../src/shared/constants/windows2'

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
function snapshot(reg: Record<string, string | number | null> = {}, extra?: Snapshot['extra']): Snapshot {
  return {
    ctx: { build: 19045, hasBattery: false, schemes: [{ guid: BALANCED, name: 'Equilibrado', active: true, ultimate: false }] },
    reg: new Map(Object.entries(reg)),
    power: new Map(Object.entries({ procMin: 5, usbSuspend: 1, pcieAspm: 1 })),
    extra
  }
}
const byId = new Map(TWEAKS.map((t) => [t.id, t]))

test('catálogo: scripts, seções e Booster só usam ajustes e valores que existem', () => {
  const ctx = snapshot().ctx
  const ids = new Set(TWEAKS.map((t) => t.id))
  const valid = (id: string, value: string) => assert.ok(byId.get(id)!.options(ctx).some((o) => o.value === value), `${id}=${value} não é uma opção`)
  for (const id of [...WIN2_TWEAKS.basic, ...WIN2_TWEAKS.disable]) assert.ok(ids.has(id), `ajuste ausente: ${id}`)
  for (const b of WIN2_BOOSTER) {
    assert.ok(ids.has(b.id), `Booster: ${b.id}`)
    valid(b.id, b.value)
  }
  for (const s of WIN2_SCRIPTS) {
    if (s.step.kind !== 'tweaks') continue
    for (const [id, v] of Object.entries(s.step.changes)) {
      assert.ok(ids.has(id), `${s.name}: ajuste ausente ${id}`)
      valid(id, v)
    }
  }
  assert.equal(new Set(WIN2_SCRIPTS.map((s) => s.name)).size, WIN2_SCRIPTS.length)
  assert.equal(WIN2_SCRIPTS.length, 22, 'todos os scripts da lista do adendo')
})

test('toda operação administrativa que o catálogo gera passa na validação (e a restauração também)', () => {
  const s = snapshot()
  for (const t of TWEAKS.filter((x) => x.elevOps)) {
    for (const o of t.options(s.ctx)) {
      const ops = t.elevOps!(o.value, s)
      assert.ok(ops.length > 0, `${t.id}:${o.value}`)
      assert.doesNotThrow(() => validateOps(ops), `${t.id}:${o.value}`)
    }
    assert.ok(t.elevated, `${t.id} deve declarar administrador`)
  }
})

test('validateOps recusa chaves, serviços e tarefas fora da lista permitida', () => {
  const bad: ElevOp[][] = [
    [{ k: 'reg', key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows Defender', name: 'DisableAntiSpyware', type: 'DWord', data: 1 }],
    [{ k: 'reg', key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WinDefend', name: 'Start', type: 'DWord', data: 4 }],
    [{ k: 'reg', key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', name: 'Nome;ruim', type: 'DWord', data: 0 }],
    [{ k: 'svc', name: 'WinDefend', start: 'disabled', run: false }],
    [{ k: 'svc', name: 'wuauserv', start: 'disabled', run: false }],
    [{ k: 'svc', name: 'mpssvc', start: 'disabled', run: false }],
    [{ k: 'task', path: '\\Microsoft\\Windows\\Windows Defender\\', name: 'Windows Defender Scheduled Scan', enable: false }],
    [{ k: 'lastaccess', value: 9 as 1 }],
    []
  ]
  for (const ops of bad) assert.throws(() => validateOps(ops), undefined, JSON.stringify(ops))
  assert.deepEqual([...SERVICES_ALLOWED].sort(), ['DiagTrack', 'WSearch', 'bthserv'])
})

test('nenhum ajuste do catálogo toca em Defender, firewall, Windows Update ou UAC', () => {
  const s = snapshot()
  for (const t of TWEAKS.filter((x) => x.elevOps)) {
    for (const o of t.options(s.ctx)) {
      for (const op of t.elevOps!(o.value, s)) {
        const text = JSON.stringify(op)
        assert.doesNotMatch(text, /defender|WinDefend|Sense|mpssvc|wuauserv|EnableLUA|ConsentPrompt|SmartScreen|Firewall/i, `${t.id}: ${text}`)
      }
    }
  }
})

test('leitura: política ausente = padrão; valores gravados aparecem como estado', () => {
  const key = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection|AllowTelemetry'
  assert.equal(describe(snapshot(), {}).find((t) => t.id === 'telemetry')!.current, 'default')
  assert.equal(describe(snapshot({ [key]: 0 }), {}).find((t) => t.id === 'telemetry')!.current, 'off')
  assert.equal(describe(snapshot({ [key]: 1 }), {}).find((t) => t.id === 'telemetry')!.current, 'basic')
  assert.match(describe(snapshot({ [key]: 3 }), {}).find((t) => t.id === 'telemetry')!.currentLabel, /Personalizado/)
  const net = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile|NetworkThrottlingIndex'
  assert.equal(describe(snapshot({ [net]: -1 }), {}).find((t) => t.id === 'netThrottle')!.current, 'off')
  assert.equal(describe(snapshot({ [net]: 10 }), {}).find((t) => t.id === 'netThrottle')!.current, 'default')
})

test('serviços: tipo de inicialização lido do registro e restauração exata', () => {
  const k = (n: string) => `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${n}`
  const t = (n: string, reg: Record<string, number | null>) => describe(snapshot(Object.fromEntries(Object.entries(reg).map(([name, v]) => [`${k(n)}|${name}`, v]))), {}).find((x) => x.id === { WSearch: 'indexing', DiagTrack: 'diagTrack', bthserv: 'bluetooth' }[n])!
  assert.equal(t('WSearch', { Start: 2, DelayedAutostart: 1 }).current, 'delayed')
  assert.equal(t('DiagTrack', { Start: 2 }).current, 'auto')
  assert.equal(t('bthserv', { Start: 3 }).current, 'manual')
  assert.equal(t('bthserv', { Start: 4 }).current, 'off')
  assert.match(t('bthserv', { Start: null as unknown as number }).unavailable ?? '', /não existe/)
  const idx = byId.get('indexing')!
  assert.deepEqual(idx.elevRestore!({ start: 2, delayed: 1 }, snapshot()), [{ k: 'svc', name: 'WSearch', start: 'delayed', run: true }])
  assert.deepEqual(idx.elevRestore!({ start: 3, delayed: null }, snapshot()), [{ k: 'svc', name: 'WSearch', start: 'manual', run: null }])
  assert.deepEqual(idx.elevOps!('off', snapshot()), [{ k: 'svc', name: 'WSearch', start: 'disabled', run: false }])
})

test('hibernação, Inicialização Rápida, último acesso NTFS e SilentCleanup', () => {
  const hib = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power|HibernateEnabled'
  const fast = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power|HiberbootEnabled'
  const st = (s: Snapshot) => new Map(describe(s, {}).map((t) => [t.id, t]))
  assert.equal(st(snapshot({ [hib]: 1 })).get('hibernation')!.current, 'on')
  assert.equal(st(snapshot({ [hib]: 0 })).get('hibernation')!.current, 'off')
  assert.match(st(snapshot()).get('hibernation')!.unavailable ?? '', /suporte à hibernação/)
  assert.match(st(snapshot({ [hib]: 0, [fast]: 1 })).get('fastStartup')!.unavailable ?? '', /hibernação ativada/)
  assert.equal(st(snapshot({ [hib]: 1, [fast]: 0 })).get('fastStartup')!.current, 'off')
  // último acesso: 0x80000002 (gerenciado pelo sistema, ativo) = -2147483646 no PowerShell
  const la = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem|NtfsDisableLastAccessUpdate'
  assert.equal(st(snapshot({ [la]: -2147483646 })).get('lastAccess')!.current, 'on')
  assert.equal(st(snapshot({ [la]: -2147483645 })).get('lastAccess')!.current, 'off')
  assert.equal(st(snapshot({ [la]: 1 })).get('lastAccess')!.current, 'off')
  assert.equal(lastAccessFsutilValue(-2147483646), 2)
  assert.equal(lastAccessFsutilValue(-2147483645), 3)
  assert.equal(lastAccessFsutilValue(0), 0)
  assert.equal(lastAccessFsutilValue(1), 1)
  assert.equal(lastAccessFsutilValue(null), 2)
  const sc = (state: string | null) => st(snapshot({}, { silentCleanup: state, cortana: false })).get('silentCleanup')!
  assert.equal(sc('Ready').current, 'on')
  assert.equal(sc('Disabled').current, 'off')
  assert.match(sc(null).unavailable ?? '', /não existe/)
  assert.match(st(snapshot({}, { silentCleanup: 'Ready', cortana: false })).get('cortana')!.unavailable ?? '', /não está instalada/)
  assert.equal(st(snapshot({}, { silentCleanup: 'Ready', cortana: true })).get('cortana')!.unavailable, null)
})

test('plano de aplicação: política que impede Game DVR individual é informada e o lote não esconde a falha', () => {
  const dvr = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR|AllowGameDVR'
  const plan = planChanges(snapshot({ [dvr]: 0 }), { gameDvr: 'off', gameDvrPolicy: 'on' })
  assert.equal(plan.apply.length, 1)
  assert.match(plan.skipped.join(' '), /política/)
  const ids = planChanges(snapshot(), { gameDvr: 'off', gameDvrPolicy: 'off', appCapture: 'off' }).apply.map((x) => x.t.id)
  assert.ok(ids.indexOf('gameDvrPolicy') > ids.indexOf('gameDvr'), 'a política vem depois dos ajustes individuais')
})

test('limpeza ampliada: alvos únicos, administrador onde precisa e filtros de nome', () => {
  const t = extraTargets()
  assert.equal(new Set(t.map((x) => x.id)).size, t.length)
  const by = new Map(t.map((x) => [x.id, x]))
  assert.equal(by.get('temp-user')!.needsAdmin, false)
  for (const id of ['temp-system', 'prefetch', 'logs-system']) assert.equal(by.get(id)!.needsAdmin, true, id)
  assert.ok(by.get('explorer-cache')!.match!.test('thumbcache_256.db'))
  assert.ok(by.get('explorer-cache')!.match!.test('iconcache_48.db'))
  assert.ok(!by.get('explorer-cache')!.match!.test('settings.dat'))
  assert.ok(by.get('prefetch')!.match!.test('NOTEPAD.EXE-D8414F97.pf'))
  assert.ok(!by.get('prefetch')!.match!.test('Layout.ini'))
  assert.ok(by.get('logs-system')!.paths.some((p) => /CBS$/.test(p)))
  assert.ok(by.get('logs-system')!.minAgeHours >= 24)
  assert.equal(by.get('update-download')!.needsAdmin, true)
  assert.ok(by.get('update-download')!.paths[0].endsWith('SoftwareDistribution\\Download'))
  // Navegadores: só pastas de cache, nunca cookies, senhas ou histórico.
  for (const p of by.get('browser-chromium')!.paths) assert.ok(/\\(Cache|Code Cache)$/.test(p), p)
})

test('segurança: estados lidos viram linhas sem inventar proteção', () => {
  const raw: SecurityRaw = {
    defender: { service: true, antivirus: true, realtime: false, tamper: true, mode: 'Normal', signatureAge: 1 },
    antivirus: ['Windows Defender'],
    firewall: [{ name: 'Domain', enabled: 'True' }, { name: 'Private', enabled: 'False' }, { name: 'Public', enabled: 'True' }],
    smartscreen: { explorer: 'Warn', policy: null },
    uac: { lua: 1, admin: 5, secure: 1 }
  }
  const rows = new Map(buildSecurityRows(raw).map((r) => [r.id, r]))
  assert.equal(rows.get('defender')!.state, 'parcial')
  assert.match(rows.get('defender')!.summary, /desativada/)
  assert.equal(rows.get('firewall')!.state, 'parcial')
  assert.equal(rows.get('smartscreen')!.state, 'ativo')
  assert.equal(rows.get('uac')!.state, 'ativo')
  assert.match(rows.get('uac')!.summary, /padrão/)
  const off = buildSecurityRows({ ...raw, defender: null, uac: { lua: 0, admin: 0, secure: 0 }, smartscreen: { explorer: 'Off', policy: 0 }, firewall: [] })
  assert.equal(off.find((r) => r.id === 'defender')!.state, 'desconhecido')
  assert.equal(off.find((r) => r.id === 'uac')!.state, 'desativado')
  assert.equal(off.find((r) => r.id === 'smartscreen')!.state, 'desativado')
  assert.equal(off.find((r) => r.id === 'firewall')!.state, 'desconhecido')
})

test('volumes: SSD recebe TRIM, HDD desfragmentação, sistema de arquivos não suportado é ignorado', () => {
  assert.equal(planVolumeOp('NTFS', 'SSD').op, 'retrim')
  assert.equal(planVolumeOp('NTFS', 'HDD').op, 'defrag')
  assert.equal(planVolumeOp('NTFS', 'Unspecified').op, 'auto')
  assert.equal(planVolumeOp('FAT32', 'HDD').op, null)
  assert.equal(planVolumeOp('exFAT', 'SSD').op, null)
})

test('todo caminho de registro do catálogo é válido (HKCU:\... ou HKLM:\...)', () => {
  for (const t of TWEAKS) {
    for (const e of (t as unknown as { entries?: { key: string }[] }).entries ?? []) assert.match(e.key, /^HK(CU|LM):\\[A-Za-z ]/, `${t.id}: ${e.key}`)
  }
})

test('segurança: sem resposta do Defender, o estado é "desconhecido" e mostra só configuração, sem inventar proteção', () => {
  const raw: SecurityRaw = {
    defender: null,
    antivirus: ['Windows Defender'],
    antivirusDetail: ['Windows Defender (productState 0x062100)'],
    defenderRegistry: { tamper: 5, disableRealtime: null, policyDisable: null },
    firewall: [{ name: 'Public', enabled: 'True' }],
    smartscreen: { explorer: null, policy: null },
    uac: { lua: 1, admin: 5, secure: 1 }
  }
  const d = buildSecurityRows(raw).find((r) => r.id === 'defender')!
  assert.equal(d.state, 'desconhecido')
  assert.ok(d.details.some((x) => /productState 0x062100/.test(x)))
  assert.ok(d.details.some((x) => /adulteração \(registro\): ativa/.test(x)))
  assert.ok(d.details.some((x) => /não o estado em execução/.test(x)))
})
