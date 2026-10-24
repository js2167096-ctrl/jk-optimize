// Regras e interpretadores dos módulos: energia, processos, serviços, inicialização,
// aplicativos, rede, Windows, telemetria, monitoramento e diagnóstico.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePowercfgList } from '../src/main/modules/power'
import { CRITICAL_PROCESSES, protectionReason } from '../src/main/modules/processes'
import { classifyService, PROTECTED_SERVICES } from '../src/main/modules/services'
import { approvalBytesFor, approvalEnabled } from '../src/main/modules/startup'
import { appxBlockReason, parseCommandLine } from '../src/main/modules/apps'
import { classifyAddress, latencyCsv, latencyStats, parseWlan, type LatencySample } from '../src/main/modules/network'
import { compareRuns, CRASH_MARKERS, lastPercent, type BenchmarkRun } from '../src/main/modules/windows'
import { parseSample } from '../src/main/modules/sampler'
import { diagnoseCpu } from '../src/main/modules/performance'
import { parseSettings, shouldAlert, withGaps } from '../src/main/modules/monitoring'

// ---------------------------------------------------------------------------
// Energia

test('powercfg /list em português e inglês', () => {
  const pt = `Esquemas de Energia Existentes (* Ativos)
-----------------------------------
GUID do Esquema de Energia: 150e2ee8-fe46-4b91-a25b-f98157151549  (Desempenho Máximo) *
GUID do Esquema de Energia: 381b4222-f694-41f0-9685-ff5bb260df2e  (Equilibrado)`
  const en = `Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance) *`
  assert.deepEqual(parsePowercfgList(pt), [
    { guid: '150e2ee8-fe46-4b91-a25b-f98157151549', name: 'Desempenho Máximo', active: true },
    { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Equilibrado', active: false }
  ])
  assert.equal(parsePowercfgList(en)[0].name, 'High performance')
  assert.deepEqual(parsePowercfgList('saída inesperada'), [])
})

// ---------------------------------------------------------------------------
// Processos

test('processos críticos, de sistema e de outras sessões são protegidos', () => {
  const me = 1
  assert.ok(protectionReason('lsass', 'C:\\Windows\\System32\\lsass.exe', 0, me, 100, 700))
  assert.ok(protectionReason('csrss', null, 1, me, 100, 600))
  assert.ok(protectionReason('MsMpEng', null, 1, me, 100, 800), 'antivírus nunca é encerrado')
  assert.ok(protectionReason('qualquer', 'C:\\Program Files\\x.exe', 0, me, 100, 900), 'sessão 0')
  assert.ok(protectionReason('outro', 'C:\\Program Files\\x.exe', 2, me, 100, 901), 'outra sessão')
  assert.ok(protectionReason('dwm', null, 1, me, 100, 902))
  assert.ok(protectionReason('jk optimize', null, 1, me, 100, 100), 'o próprio app')
  assert.ok(protectionReason('wininit', null, 1, me, 100, 4), 'PIDs de sistema')
  assert.ok(protectionReason('cmd', 'C:\\Windows\\System32\\cmd.exe', 1, me, 100, 903), 'componente do Windows em System32')
  assert.equal(protectionReason('notepad', 'C:\\Windows\\System32\\notepad.exe', 1, me, 100, 904), null)
  assert.equal(protectionReason('chrome', 'C:\\Program Files\\Google\\chrome.exe', 1, me, 100, 905), null)
  assert.ok(CRITICAL_PROCESSES.has('svchost'))
})

// ---------------------------------------------------------------------------
// Serviços

test('serviços essenciais e de segurança são protegidos; classificação por origem', () => {
  for (const s of ['WinDefend', 'MpsSvc', 'wuauserv', 'RpcSs', 'EventLog', 'BFE', 'Dhcp', 'Dnscache']) {
    assert.ok(PROTECTED_SERVICES.has(s.toLowerCase()), s)
    assert.equal(classifyService(s, 'C:\\Windows\\system32\\svchost.exe -k netsvcs'), 'essential')
  }
  assert.equal(classifyService('SysMain', 'C:\\Windows\\system32\\svchost.exe -k LocalSystemNetworkRestricted'), 'windows')
  assert.equal(classifyService('Steam Client Service', '"C:\\Program Files (x86)\\Common Files\\Steam\\steamservice.exe" /RunAsService'), 'third-party')
})

// ---------------------------------------------------------------------------
// Inicialização

test('StartupApproved: estado e bytes gravados como o Gerenciador de Tarefas', () => {
  assert.equal(approvalEnabled(null), true, 'sem valor = ativado')
  assert.equal(approvalEnabled([2, 0, 0, 0]), true)
  assert.equal(approvalEnabled([6, 0, 0, 0]), true)
  assert.equal(approvalEnabled([3, 0, 0, 0]), false)
  assert.equal(approvalEnabled([7, 0, 0, 0]), false)
  const off = approvalBytesFor(false, new Date('2026-01-01T00:00:00Z'))
  assert.equal(off.length, 12)
  assert.equal(off[0], 3)
  assert.equal(approvalEnabled(off), false)
  assert.ok(off.slice(4).some((b) => b !== 0), 'FILETIME preenchido')
  assert.deepEqual(approvalBytesFor(true), [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
})

// ---------------------------------------------------------------------------
// Aplicativos

test('linha de desinstalação é separada sem shell', () => {
  assert.deepEqual(parseCommandLine('"C:\\Program Files\\App\\uninst.exe" /S --flag "com espaço"'), {
    exe: 'C:\\Program Files\\App\\uninst.exe',
    args: ['/S', '--flag', 'com espaço']
  })
  assert.deepEqual(parseCommandLine('C:\\Apps\\x\\remove.exe /quiet'), { exe: 'C:\\Apps\\x\\remove.exe', args: ['/quiet'] })
  assert.equal(parseCommandLine('rundll32 algo,Função'), null, 'somente executáveis .exe')
  assert.equal(parseCommandLine('"C:\\x\\script.bat"'), null)
})

test('pacotes Appx essenciais não podem ser removidos', () => {
  assert.ok(appxBlockReason('Microsoft.WindowsStore', false, false, 'Store'))
  assert.ok(appxBlockReason('Microsoft.VCLibs.140.00', false, true, 'Store'))
  assert.ok(appxBlockReason('Microsoft.Windows.ShellExperienceHost', true, false, 'System'))
  assert.ok(appxBlockReason('Algo', false, false, 'System'))
  assert.equal(appxBlockReason('Microsoft.BingWeather', false, false, 'Store'), null)
})

// ---------------------------------------------------------------------------
// Rede

const sample = (ms: number | null, status: LatencySample['status'] = ms === null ? 'timeout' : 'ok'): LatencySample => ({ t: Date.now(), ms, status, detail: null })

test('latência: estatísticas reais, timeout separado de erro', () => {
  const s = latencyStats([sample(10), sample(20), sample(null), sample(30), { ...sample(null), status: 'error', detail: 'DestinationHostUnreachable' }])
  assert.equal(s.sent, 5)
  assert.equal(s.replies, 3)
  assert.equal(s.timeouts, 1)
  assert.equal(s.errors, 1)
  assert.equal(s.minMs, 10)
  assert.equal(s.maxMs, 30)
  assert.equal(s.avgMs, 20)
  assert.equal(s.jitterMs, 10)
  assert.equal(s.timeoutPct, 20)
  const empty = latencyStats([])
  assert.equal(empty.avgMs, null)
  assert.equal(empty.jitterMs, null)
})

test('exportação CSV contém apenas amostras reais e escapa campos', () => {
  const csv = latencyCsv({
    id: 'x',
    host: '1.1.1.1',
    startedAt: '',
    durationSec: 1,
    intervalMs: 1000,
    cancelled: false,
    stats: latencyStats([]),
    samples: [sample(12), { t: 0, ms: null, status: 'error', detail: 'falha, "estranha"' }]
  })
  const lines = csv.trim().split('\r\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0], 'timestamp_utc,host,status,latency_ms,detail')
  assert.ok(lines[1].includes(',ok,12,'))
  assert.ok(!lines[2].includes('"'))
})

test('netsh wlan em português sem expor senhas', () => {
  const text = `
Há 1 interface no sistema:

    Nome                   : Wi-Fi
    Estado                 : conectado
    SSID                   : MinhaRede
    BSSID                  : aa:bb:cc:dd:ee:ff
    Tipo de rádio          : 802.11ac
    Banda                  : 5 GHz
    Canal                  : 44
    Sinal                  : 87%
    Conteúdo da Chave      : segredo
`
  const [w] = parseWlan(text)
  assert.equal(w.ssid, 'MinhaRede')
  assert.equal(w.signal, '87%')
  assert.equal(w.band, '5 GHz')
  assert.ok(!JSON.stringify(w.raw).includes('segredo'))
})

test('classificação de endereços', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'local')
  assert.equal(classifyAddress('192.168.0.10'), 'private')
  assert.equal(classifyAddress('172.20.1.1'), 'private')
  assert.equal(classifyAddress('8.8.8.8'), 'public')
  assert.equal(classifyAddress(null), null)
})

// ---------------------------------------------------------------------------
// Windows

test('progresso de SFC/DISM é lido do log', () => {
  assert.equal(lastPercent('Verificação 12% concluída.\rVerificação 45% concluída.'), 45)
  assert.equal(lastPercent('[==========                 25.0%                          ]'), 25)
  assert.equal(lastPercent('[=====   87,5%   ]'), 87.5)
  assert.equal(lastPercent('sem progresso'), null)
})

test('marcadores de travamento só por correlação de provedor + id', () => {
  const m = CRASH_MARKERS.find((x) => x.id === 41)!
  assert.ok(m.provider.test('Microsoft-Windows-Kernel-Power'))
  assert.ok(!CRASH_MARKERS.some((x) => x.id === 41 && x.provider.test('Outro-Provedor')))
})

const run = (over: Partial<BenchmarkRun> = {}, metrics: Record<string, number | null> = {}): BenchmarkRun => ({
  id: 'r',
  at: '',
  appVersion: '1',
  label: 'x',
  metrics: { cpuSingleMBps: 500, cpuMultiMBps: 1800, memoryCopyGBps: 10, diskWriteMBps: null, diskReadMBps: null, ...metrics },
  conditions: { powerPlan: 'Equilibrado', onBattery: false, cpuLoadBeforePct: 5, threads: 4 },
  ...over
})

test('benchmark compara só métricas presentes nas duas execuções e aponta condições diferentes', () => {
  const r = compareRuns(run(), run({ conditions: { powerPlan: 'Alto desempenho', onBattery: false, cpuLoadBeforePct: 40, threads: 4 } }, { cpuSingleMBps: 550 }))
  const single = r.metrics.find((m) => m.metric === 'cpuSingleMBps')!
  assert.equal(single.changePct, 10)
  assert.equal(r.metrics.find((m) => m.metric === 'diskWriteMBps')!.changePct, null)
  assert.ok(r.warnings.some((w) => w.includes('Planos de energia diferentes')))
  assert.ok(r.warnings.some((w) => w.includes('40%')))
})

// ---------------------------------------------------------------------------
// Telemetria

test('amostra: núcleos ordenados, GPU por LUID, Kelvin → °C e ausência ≠ zero', () => {
  const s = parseSample(
    {
      ts: 1000,
      cpu: { total: 30, perf: 90, freq: 3600, limit: 100 },
      cores: [
        { name: '0,10', pct: 5 },
        { name: '0,2', pct: 50 }
      ],
      mem: { avail: 8e9, com: 9e9, lim: 18e9, pct: 50, pages: 3 },
      eng: [
        { n: 'pid_100_luid_0x00000000_0x0000E31F_phys_0_eng_0_engtype_3D', u: 40 },
        { n: 'pid_200_luid_0x00000000_0x0000E31F_phys_0_eng_0_engtype_3D', u: 20 },
        { n: 'pid_100_luid_0x00000000_0x0000E31F_phys_0_eng_3_engtype_VideoDecode', u: 5 }
      ],
      gmem: [
        { n: 'luid_0x00000000_0x0000E31F_phys_0', d: 3e8, s: 6e7 },
        { n: 'luid_0x00000000_0x0000EECC_phys_0', d: 0, s: 8192 }
      ],
      th: [{ n: 'TZ0', hp: 3231.5, k: 323, pl: 100, tr: 0 }],
      procs: [{ pid: 100, name: 'GTA5#1', cpu: 25, ws: 1e9, pb: 2e9 }],
      nv: [],
      errs: []
    },
    ['AMD Radeon(TM) Vega 8 Graphics']
  )
  assert.deepEqual(s.cpu.perCore.map((c) => c.name), ['0,2', '0,10'])
  assert.equal(s.cpu.effectiveMHz, 3240)
  const main = s.gpus.find((g) => g.luid.endsWith('E31F'))!
  assert.equal(main.utilizationPct, 60)
  assert.equal(main.name, 'AMD Radeon(TM) Vega 8 Graphics')
  assert.equal(s.gpus.find((g) => g.luid.endsWith('EECC'))!.name, null, 'adaptador sem associação segura fica sem nome')
  assert.equal(s.thermal[0].celsius, 50)
  assert.equal(s.topCpu[0].name, 'GTA5')
  const empty = parseSample({ ts: 1, cpu: null, mem: null }, [])
  assert.equal(empty.cpu.totalPct, null)
  assert.equal(empty.memory.availableBytes, null)
  assert.deepEqual(empty.thermal, [])
})

test('diagnóstico de CPU só afirma o que as evidências mostram', () => {
  assert.equal(diagnoseCpu(null, { activeName: null, activeUltimate: false, hasBattery: false }, { nominalMHz: null, reportedMHz: null })[0].title, 'Sem amostras ainda')
  const base = parseSample({ ts: 1, cpu: { total: 40, perf: 90, freq: 3600, limit: 70 }, cores: [], mem: null }, [])
  const f = diagnoseCpu(base, { activeName: 'Equilibrado', activeUltimate: false, hasBattery: true }, { nominalMHz: 3600, reportedMHz: 3600 })
  assert.ok(f.some((x) => x.title === 'Desempenho da CPU limitado' && x.severity === 'warn'))
  assert.ok(f.some((x) => x.title === 'Temperatura não disponível'))
  const ok = parseSample({ ts: 1, cpu: { total: 10, perf: 100, freq: 3600, limit: 100 }, cores: [], mem: null }, [])
  assert.ok(diagnoseCpu(ok, { activeName: 'Equilibrado', activeUltimate: false, hasBattery: false }, { nominalMHz: 3600, reportedMHz: 3600 }).some((x) => x.severity === 'ok'))
})

// ---------------------------------------------------------------------------
// Monitoramento

test('histórico marca buracos como ausência de dados', () => {
  const p = (t: number) => ({ t, cpu: 1, maxCore: 1, gpu: 1, commit: 1, availGB: 1, tempC: null })
  const out = withGaps([p(0), p(30_000), p(600_000)], 30)
  assert.equal(out.length, 4)
  assert.ok('gap' in out[2])
})

test('alertas respeitam o intervalo mínimo', () => {
  const last = new Map<string, number>()
  assert.equal(shouldAlert('temp', 0, 30, last), true)
  assert.equal(shouldAlert('temp', 60_000, 30, last), false)
  assert.equal(shouldAlert('memory', 60_000, 30, last), true)
  assert.equal(shouldAlert('temp', 31 * 60_000, 30, last), true)
})

test('configurações de monitoramento são validadas', () => {
  const valid = {
    overlay: { enabled: true, position: 'top-left', scale: 1, opacity: 0.8, metrics: ['cpu', 'fps'], fpsProcess: 'FiveM_GTAProcess.exe' },
    alerts: { enabled: true, muted: false, tempC: 90, memoryPct: 90, diskFreePct: 10, cooldownMin: 30 },
    history: { enabled: true, retentionDays: 7, intervalSec: 30 }
  }
  assert.equal(parseSettings(valid).overlay.fpsProcess, 'FiveM_GTAProcess.exe')
  assert.throws(() => parseSettings({ ...valid, alerts: { ...valid.alerts, tempC: 500 } }))
  assert.throws(() => parseSettings({ ...valid, overlay: { ...valid.overlay, fpsProcess: 'cmd.exe & del *' } }))
  assert.throws(() => parseSettings({ ...valid, history: { ...valid.history, retentionDays: 0 } }))
})
