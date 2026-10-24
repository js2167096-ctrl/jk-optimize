// Motor de otimização: proteção de serviços (erro 5), estatísticas de quadros, classificação
// de gargalos, controladores (RAM, térmico, CPU), perfis gráficos, Game Boost e autoridade de licenças.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { explainWinError, serviceProtection, winErrorFromText } from '../src/main/security/protection'
import { describeServiceFailure } from '../src/main/modules/services'
import { compareSessions, MIN_FRAMES_FOR_1_LOW, summarizeFrames, downsample } from '../src/main/modules/framestats'
import { classify, pearson, summarizeTelemetry, type TelemetryPoint, type TelemetrySummary } from '../src/main/modules/telemetry'
import { analyzeCpu, memoryPressure, thermalPowerFindings } from '../src/main/modules/controllers'
import { buildGraphicsProfile } from '../src/main/modules/fivem'
import { parseBoostSettings } from '../src/main/modules/gameboost'
import { compareLabSessions, type LabSession } from '../src/main/modules/fpslab'
import { acceptList, EMPTY_AUTHORITY, maskId, signRevocationList, verificationOverdue } from '../src/main/security/license-authority'

// ---------------------------------------------------------------------------
// Serviços protegidos e erro 5

test('MDCoreSvc e Defender: protegidos por nome, caminho ou LaunchProtected', () => {
  assert.equal(serviceProtection({ name: 'MDCoreSvc', path: null, launchProtected: null, runningDependents: [] })?.kind, 'security')
  assert.equal(serviceProtection({ name: 'Qualquer', path: 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\x\\MsMpEng.exe', launchProtected: 0, runningDependents: [] })?.kind, 'security')
  assert.equal(serviceProtection({ name: 'Terceiro', path: 'C:\\x.exe', launchProtected: 3, runningDependents: [] })?.kind, 'protected')
  assert.equal(serviceProtection({ name: 'wuauserv', path: null, launchProtected: 0, runningDependents: [] })?.kind, 'security')
  assert.equal(serviceProtection({ name: 'RpcSs', path: null, launchProtected: 0, runningDependents: [] })?.kind, 'essential')
  assert.equal(serviceProtection({ name: 'Base', path: null, launchProtected: 0, runningDependents: ['Outro'] })?.kind, 'dependency')
  assert.equal(serviceProtection({ name: 'Spooler', path: 'C:\\Windows\\System32\\spoolsv.exe', launchProtected: 0, runningDependents: [] }), null)
})

test('erro 5 e demais códigos do Windows viram mensagens específicas', () => {
  assert.equal(explainWinError(5).kind, 'access-denied')
  assert.match(explainWinError(5).message, /código 5/)
  assert.equal(explainWinError(1060).kind, 'not-found')
  assert.equal(explainWinError(1051).kind, 'dependency')
  assert.equal(explainWinError(null).kind, 'unexpected')
  assert.match(explainWinError(9999).message, /9999/)
  assert.equal(winErrorFromText('[SC] OpenService FALHA 5:\n\nAcesso negado.'), 5)
  assert.equal(winErrorFromText('[SC] ChangeServiceConfig FAILED 1060:'), 1060)
  assert.equal(winErrorFromText('Exception from HRESULT: 0x80070005'), 5)
  assert.equal(winErrorFromText('Access is denied'), 5)
  assert.equal(winErrorFromText('nada reconhecível'), null)
  assert.equal(describeServiceFailure(0, 'FALHA 5: Acesso negado').kind, 'access-denied')
  assert.equal(describeServiceFailure(1058, '').kind, 'disabled')
})

// ---------------------------------------------------------------------------
// Quadros: FPS, frametime, 1% low, comparação

test('1% low só existe com quadros suficientes', () => {
  const few = summarizeFrames(Array(MIN_FRAMES_FOR_1_LOW - 1).fill(16.67))
  assert.equal(few.low1Fps, null)
  assert.ok(few.avgFps! > 59 && few.avgFps! < 61)
  const frames = [...Array(990).fill(10), ...Array(10).fill(50)]
  const s = summarizeFrames(frames)
  assert.equal(s.frames, 1000)
  assert.equal(s.low1Fps, 20, '1% mais lentos = 50 ms = 20 FPS')
  assert.equal(s.low01Fps, null, '0,1% low exige 3000 quadros')
  assert.equal(s.medianFrametimeMs, 10)
  assert.equal(s.frametimeMaxMs, 50)
})

test('frametimes inválidos são descartados e sem quadros não há FPS', () => {
  const s = summarizeFrames([0, -1, NaN, 99999])
  assert.equal(s.frames, 0)
  assert.equal(s.avgFps, null)
  assert.equal(downsample([1, 2, 3, 4], 2).length, 2)
})

test('comparação: sem FPS ou poucos segundos = dados insuficientes', () => {
  const none = { ...summarizeFrames([]) }
  const short = summarizeFrames(Array(600).fill(16.67))
  assert.equal(compareSessions(none, short).verdict, 'insufficient-data')
  assert.equal(compareSessions(short, short).verdict, 'insufficient-data')
})

test('comparação: diferença dentro da variação não é declarada melhora', () => {
  const noisy = (base: number) => {
    const f: number[] = []
    for (let s = 0; s < 30; s++) {
      const fps = base + (s % 2 === 0 ? 8 : -8)
      for (let i = 0; i < fps; i++) f.push(1000 / fps)
    }
    return summarizeFrames(f)
  }
  assert.equal(compareSessions(noisy(60), noisy(61)).verdict, 'no-significant-change')
  const steady = (fps: number) => summarizeFrames(Array(fps * 30).fill(1000 / fps))
  assert.equal(compareSessions(steady(60), steady(72)).verdict, 'improved')
  assert.equal(compareSessions(steady(72), steady(60)).verdict, 'worse')
})

// ---------------------------------------------------------------------------
// Gargalos

const summary = (over: Partial<TelemetrySummary> = {}): TelemetrySummary => ({
  samples: 30,
  cpuAvgPct: 40,
  cpuMaxCoreAvgPct: 60,
  cpuCoreSaturatedPct: 10,
  gpuAvgPct: 70,
  gpuHighPctTime: 10,
  vramMaxBytes: null,
  commitAvgPct: 50,
  commitMaxPct: 60,
  availMinBytes: 4 * 1024 ** 3,
  pagesPerSecAvg: 0,
  tempMaxC: null,
  effectiveMHzAvg: null,
  perfLimitMinPct: 100,
  perfLimitedPct: 0,
  gameWorkingSetMaxBytes: null,
  coreFpsCorrelation: null,
  ...over
})
const fps = { avgFps: 60, frametimeP99Ms: 25, frametimeAvgMs: 16.7 }

test('classificação: cada categoria só com evidência', () => {
  assert.equal(classify(summary({ samples: 3 }), fps).primary, 'insufficient-data')
  assert.equal(classify(summary({ gpuHighPctTime: 85, gpuAvgPct: 97 }), fps).primary, 'gpu-confirmed')
  assert.equal(classify(summary({ gpuHighPctTime: 85, gpuAvgPct: 97 }), null).primary, 'gpu-probable')
  assert.equal(classify(summary({ cpuCoreSaturatedPct: 70, gpuAvgPct: 50 }), fps).primary, 'cpu-confirmed')
  assert.equal(classify(summary({ cpuCoreSaturatedPct: 70, gpuAvgPct: 50 }), null).primary, 'cpu-probable')
  assert.equal(classify(summary({ commitMaxPct: 95 }), fps).primary, 'memory-pressure')
  assert.equal(classify(summary({ perfLimitedPct: 60, perfLimitMinPct: 40 }), fps).primary, 'thermal-power')
  assert.equal(classify(summary(), fps).primary, 'external-inconclusive')
})

test('classificação: sem sensor de temperatura e sem FPS ficam registrados como limitações', () => {
  const c = classify(summary(), null)
  assert.ok(c.limitations.some((l) => l.includes('Sem sensor de temperatura')))
  assert.ok(c.limitations.some((l) => l.includes('Sem FPS medido')))
  const gpu = classify(summary({ gpuHighPctTime: 90 }), fps)
  assert.ok(gpu.recommendedKeys.some((r) => r.key === 'MSAA'))
  assert.ok(!gpu.recommendedKeys.some((r) => r.key === 'CityDensity'), 'ajustes de CPU não aparecem para gargalo de GPU')
})

test('telemetria: resumo com sensores ausentes e correlação', () => {
  const pts: TelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
    t: i,
    cpu: 50,
    maxCore: 50 + i * 5,
    gpu: null,
    vram: null,
    commit: 60,
    avail: 1e9,
    pages: null,
    temp: null,
    effMHz: null,
    perfLimit: null,
    fps: 100 - i * 5,
    gameWorkingSet: null
  }))
  const s = summarizeTelemetry(pts)
  assert.equal(s.samples, 10)
  assert.equal(s.gpuAvgPct, null)
  assert.equal(s.tempMaxC, null)
  assert.ok(s.coreFpsCorrelation! < -0.9)
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, 'sem variação = sem correlação')
})

// ---------------------------------------------------------------------------
// Controladores

test('pressão de memória: só recomenda fechar quando há pressão real', () => {
  const m = (commitPct: number | null, avail: number | null) => ({ totalBytes: 16e9, availableBytes: avail, commitPct, usedPct: null, pagesPerSec: null, standbyBytes: null, modifiedBytes: null, freeBytes: null, systemCacheBytes: null }) as never
  assert.equal(memoryPressure(m(50, 8e9)).recommendClosing, false)
  assert.equal(memoryPressure(m(85, 6e9)).level, 'moderate')
  assert.equal(memoryPressure(m(95, 1e9)).level, 'high')
  assert.equal(memoryPressure(m(null, null)).level, 'unknown')
})

test('térmico/energia: sem sensor é informado, não inventado', () => {
  const base = { temps: [], perfLimitPct: 100, effectiveMHz: null, nominalMHz: null, cpuPct: 20, plan: 'Equilibrado', onAc: true, firmwareLimitEvents: 0, unexpectedShutdowns: 0 }
  const f = thermalPowerFindings(base)
  assert.ok(f.some((x) => x.title === 'Sensor não disponível'))
  assert.ok(!f.some((x) => x.severity === 'warn'))
  const hot = thermalPowerFindings({ ...base, temps: [{ label: 'CPU', celsius: 95 }], perfLimitPct: 70, firmwareLimitEvents: 2, onAc: false })
  assert.ok(hot.some((x) => x.title === 'Temperatura alta'))
  assert.ok(hot.some((x) => x.title.includes('limitado')))
  assert.ok(hot.some((x) => x.title.includes('Firmware')))
})

test('CPU Bottleneck Fixer: veredito por evidência', () => {
  assert.equal(analyzeCpu(summary({ samples: 2 }), [], null).verdict, 'inconclusive')
  assert.equal(analyzeCpu(summary({ cpuAvgPct: 95 }), [], null).verdict, 'global-saturation')
  assert.equal(analyzeCpu(summary({ cpuCoreSaturatedPct: 70, gpuAvgPct: 40 }), [], null).verdict, 'thread-limited')
  assert.equal(analyzeCpu(summary({ perfLimitedPct: 50 }), [], null).verdict, 'frequency-limited')
  assert.equal(analyzeCpu(summary({ effectiveMHzAvg: 1200, cpuAvgPct: 60 }), [], 3000).verdict, 'frequency-limited')
  const r = analyzeCpu(summary(), [{ name: 'chrome', avgPct: 12 }], null)
  assert.equal(r.verdict, 'not-limiting')
  assert.ok(r.evidence.some((e) => e.includes('chrome')))
})

// ---------------------------------------------------------------------------
// Perfis gráficos e Game Boost

test('perfil gráfico: só chaves existentes, valores permitidos e comparação numérica', () => {
  const values = { MSAA: '4', ShadowQuality: '0', LodScale: '0.000000', CityDensity: '1.000000', ScreenWidth: '1920' }
  const perf = buildGraphicsProfile(values, { integratedGpu: false, ramGB: 16 }, 'performance')
  const keys = perf.map((r) => r.key)
  assert.ok(keys.includes('MSAA'))
  assert.ok(keys.includes('CityDensity'))
  assert.ok(!keys.includes('ShadowQuality'), 'já está no valor do perfil')
  assert.ok(!keys.includes('LodScale'), '0.000000 == 0')
  assert.ok(!keys.includes('ScreenWidth'), 'resolução nunca é editada')
  assert.ok(!keys.includes('TextureQuality'), 'chave ausente no arquivo não é criada')
  const quality = buildGraphicsProfile({ MSAA: '0' }, { integratedGpu: true, ramGB: 8 }, 'quality')
  assert.equal(quality.length, 0, 'GPU integrada não recebe MSAA no perfil Qualidade')
})

test('Game Boost: configuração validada e processos críticos recusados', () => {
  const ok = parseBoostSettings({ enabled: true, powerPlan: 'high', priority: 'AboveNormal', closeApps: ['Discord.exe', 'discord.exe'], graphicsProfile: 'balanced', notify: true, recordSession: false })
  assert.deepEqual(ok.closeApps, ['discord.exe'])
  assert.throws(() => parseBoostSettings({ closeApps: ['lsass.exe'] }), /não pode ser encerrado/)
  assert.throws(() => parseBoostSettings({ closeApps: ['FiveM.exe'] }), /não pode ser encerrado/)
  assert.throws(() => parseBoostSettings({ priority: 'RealTime' }))
  assert.throws(() => parseBoostSettings({ closeApps: ['..\\x.exe'] }))
})

// ---------------------------------------------------------------------------
// FPS Lab: comparação de sessões

test('Lab: comparação avisa condições diferentes e lista ajustes alterados', () => {
  const session = (over: Partial<LabSession>): LabSession => ({
    id: 'a',
    label: 'A',
    tag: '',
    at: '',
    durationSec: 60,
    processName: 'FiveM_GTAProcess.exe',
    sources: { fps: 'PresentMon', telemetry: 'Windows', calculated: [] },
    fps: null,
    fpsUnavailableReason: null,
    frametimeSeries: [],
    telemetry: summary(),
    classification: classify(summary(), null),
    hardware: { cpu: 'x', gpus: [], ramGB: 16 },
    conditions: { powerPlan: 'Equilibrado', settings: { MSAA: '4' }, settingsFile: null },
    ...over
  })
  const c = compareLabSessions(session({}), session({ conditions: { powerPlan: 'Alto desempenho', settings: { MSAA: '0' }, settingsFile: null } }))
  assert.equal(c.comparison.verdict, 'insufficient-data')
  assert.ok(c.warnings.some((w) => w.includes('Planos de energia diferentes')))
  assert.ok(c.warnings.some((w) => w.includes('não prova')))
  assert.deepEqual(c.settingsChanges, [{ key: 'MSAA', before: '4', after: '0' }])
})

// ---------------------------------------------------------------------------
// Autoridade de licenças (revogação)

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const ID = 'ABCDEF-123456-ABCDEF-123456'

test('autoridade: lista assinada aceita, adulterada recusada, antiga recusada', () => {
  const now = new Date('2026-10-21T12:00:00Z')
  const list = signRevocationList({ format: 'jk-optimize-revocations', version: 1, sequence: 200, issuedAt: now.toISOString(), revoked: [ID] }, privateKey)
  const ok = acceptList(EMPTY_AUTHORITY, list, pem, now)
  assert.equal(ok.outcome, 'accepted')
  assert.deepEqual(ok.state.revoked, [ID])
  assert.equal(ok.state.lastSuccess, now.toISOString())

  const tampered = { ...list, revoked: [] }
  const bad = acceptList(ok.state, tampered, pem, now)
  assert.equal(bad.outcome, 'invalid')
  assert.deepEqual(bad.state.revoked, [ID], 'lista inválida não apaga revogações já aceitas')

  const older = signRevocationList({ format: 'jk-optimize-revocations', version: 1, sequence: 100, issuedAt: now.toISOString(), revoked: [] }, privateKey)
  assert.equal(acceptList(ok.state, older, pem, now).outcome, 'rollback')

  const other = generateKeyPairSync('ed25519').privateKey
  assert.equal(acceptList(EMPTY_AUTHORITY, signRevocationList({ format: 'jk-optimize-revocations', version: 1, sequence: 300, issuedAt: now.toISOString(), revoked: [] }, other), pem, now).outcome, 'invalid')
  assert.equal(acceptList(EMPTY_AUTHORITY, '<html>erro</html>', pem, now).outcome, 'invalid')
})

test('autoridade: política offline com prazo de tolerância', () => {
  const day = 86_400_000
  const now = Date.parse('2026-10-21T12:00:00Z')
  const recent = { ...EMPTY_AUTHORITY, lastSuccess: new Date(now - 2 * day).toISOString() }
  assert.equal(verificationOverdue(recent, null, now), false)
  assert.equal(verificationOverdue({ ...EMPTY_AUTHORITY, lastSuccess: new Date(now - 8 * day).toISOString() }, null, now), true)
  assert.equal(verificationOverdue(EMPTY_AUTHORITY, new Date(now - day).toISOString(), now), false, 'ativação recente conta como verificação')
  assert.equal(maskId(ID).includes('123456'), false, 'log nunca mostra a key inteira')
})
