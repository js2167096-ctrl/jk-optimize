// FPS & Frametime Lab: sessões de medição com FPS/frametime do PresentMon e
// telemetria do Windows, classificação de gargalos, histórico, comparação e exportação.
// Cada métrica registra a origem; o que é calculado fica marcado como calculado.
import { BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { AppFailure } from '../security/validate'
import { defineQuery } from '../ops/registry'
import { bool, int, noParams, obj, str } from '../ops/params'
import { JsonStore } from '../services/store'
import { getStaticInfo } from '../services/system'
import { log } from '../ops/log'
import { compareSessions, downsample, summarizeFrames, type FrameSummary } from './framestats'
import { beginRecording, captureFrames, endRecording, liveStats, PROCESS_NAME, recordingSize, startLive, stopLive } from './presentmon'
import { classify, TelemetryCollector, type Classification, type TelemetrySummary } from './telemetry'
import { getPresentMonPath, hardwareProfile, readSettingsFile, TUNABLE } from './fivem'
import { getPowerState } from './power'

export interface LabSession {
  id: string
  label: string
  /** Rótulo livre para agrupar (ex.: "antes", "depois", nome do perfil). */
  tag: string
  at: string
  durationSec: number
  processName: string | null
  sources: { fps: string | null; telemetry: string; calculated: string[] }
  fps: FrameSummary | null
  fpsUnavailableReason: string | null
  /** Frametimes medidos, reduzidos para no máximo 600 pontos (gráfico). */
  frametimeSeries: number[]
  telemetry: TelemetrySummary
  classification: Classification
  hardware: { cpu: string | null; gpus: string[]; ramGB: number }
  conditions: { powerPlan: string | null; settings: Record<string, string> | null; settingsFile: string | null }
}

const store = new JsonStore<LabSession[]>('fivem-lab.json', (raw) => (Array.isArray(raw) ? (raw as LabSession[]).filter((s) => typeof s?.id === 'string').slice(0, 80) : []))

interface Running {
  id: string
  label: string
  tag: string
  processName: string | null
  startedAt: number
  collector: TelemetryCollector
  withFps: boolean
  maxSeconds: number
  timer: NodeJS.Timeout
}

let running: Running | null = null

function settingsSnapshot(): { values: Record<string, string> | null; file: string | null } {
  const data = readSettingsFile('fivem') ?? readSettingsFile('gta')
  if (!data) return { values: null, file: null }
  const values: Record<string, string> = {}
  for (const k of Object.keys(TUNABLE)) if (data.values[k] !== undefined) values[k] = data.values[k]
  return { values, file: data.path }
}

async function buildSession(base: { id: string; label: string; tag: string; processName: string | null; startedAt: number }, frames: number[] | null, telemetry: TelemetrySummary, fpsReason: string | null): Promise<LabSession> {
  const fps = frames && frames.length > 0 ? summarizeFrames(frames) : null
  const [hw, info, power] = await Promise.all([hardwareProfile(), getStaticInfo(false), getPowerState().catch(() => null)])
  const snap = settingsSnapshot()
  return {
    id: base.id,
    label: base.label,
    tag: base.tag,
    at: new Date(base.startedAt).toISOString(),
    durationSec: Math.round((Date.now() - base.startedAt) / 1000),
    processName: base.processName,
    sources: {
      fps: fps ? 'PresentMon (eventos ETW do Windows) — frametimes medidos' : null,
      telemetry: 'Contadores de desempenho do Windows (CIM), uma amostra por intervalo do monitor',
      calculated: ['FPS médio, mediana e percentis: calculados a partir dos frametimes medidos', '1% e 0,1% low: média dos quadros mais lentos (só com amostra suficiente)', 'Médias de CPU/GPU/memória: calculadas a partir das amostras']
    },
    fps,
    fpsUnavailableReason: fps ? null : fpsReason ?? (frames ? 'Nenhum quadro recebido do PresentMon (o jogo estava em primeiro plano?).' : 'FPS indisponível: PresentMon não configurado ou não solicitado.'),
    frametimeSeries: frames ? downsample(frames, 600) : [],
    telemetry,
    classification: classify(telemetry, fps),
    hardware: { cpu: info.cpus[0]?.name ?? null, gpus: hw.gpus, ramGB: hw.ramGB },
    conditions: { powerPlan: power?.active?.name ?? null, settings: snap.values, settingsFile: snap.file }
  }
}

function save(session: LabSession): LabSession {
  if (session.telemetry.samples > 0 || session.fps) store.write([session, ...store.read()].slice(0, 80))
  return session
}

// ---------------------------------------------------------------------------
// Sessão contínua (iniciar / parar)
// ---------------------------------------------------------------------------

export async function startSession(p: { label: string; tag: string; processName: string | null; maxSeconds: number }): Promise<{ id: string; withFps: boolean; fpsNote: string | null }> {
  if (running) throw new AppFailure('already-running', 'Já existe uma sessão de medição em andamento.')
  const pm = getPresentMonPath()
  let withFps = false
  let fpsNote: string | null = null
  if (pm && p.processName) {
    try {
      startLive(pm, p.processName)
      beginRecording()
      withFps = true
    } catch (error) {
      fpsNote = (error as Error).message
    }
  } else fpsNote = !pm ? 'PresentMon não configurado: a sessão terá só telemetria (FPS indisponível).' : 'Informe o processo do jogo para medir FPS.'
  const collector = new TelemetryCollector('fpslab')
  collector.start()
  const id = randomUUID()
  running = {
    id,
    ...p,
    startedAt: Date.now(),
    collector,
    withFps,
    timer: setTimeout(() => void stopSession().catch((e) => log.error('fivem', `Sessão do Lab: ${(e as Error).message}`)), p.maxSeconds * 1000)
  }
  log.info('fivem', `FPS Lab: sessão "${p.label}" iniciada${withFps ? ` (FPS de ${p.processName})` : ' (sem FPS)'}.`)
  return { id, withFps, fpsNote }
}

export async function stopSession(): Promise<LabSession> {
  if (!running) throw new AppFailure('not-running', 'Nenhuma sessão em andamento.')
  const r = running
  running = null
  clearTimeout(r.timer)
  const telemetry = r.collector.stop()
  let frames: number[] | null = null
  let reason: string | null = null
  if (r.withFps) {
    frames = endRecording()
    reason = liveStats().error
    stopLive()
  }
  const session = await buildSession(r, frames, telemetry, reason)
  log.info('fivem', `FPS Lab: sessão "${r.label}" encerrada — ${session.fps ? `${session.fps.avgFps} FPS médio` : 'sem FPS'}, ${telemetry.samples} amostras; ${session.classification.label}.`)
  return save(session)
}

export function sessionStatus() {
  if (!running) return { running: false as const }
  const live = liveStats()
  return {
    running: true as const,
    id: running.id,
    label: running.label,
    processName: running.processName,
    elapsedSec: Math.round((Date.now() - running.startedAt) / 1000),
    maxSeconds: running.maxSeconds,
    frames: recordingSize(),
    fpsNow: live.active && Date.now() - live.lastFrameAt < 2000 ? live.fps : null,
    fpsError: running.withFps ? live.error : null,
    samples: running.collector.points.length,
    lastPoint: running.collector.points.at(-1) ?? null
  }
}

const LABEL = /^[\p{L}\p{N} .,_()+-]+$/u

defineQuery({
  id: 'fivem.lab.start',
  module: 'fivem',
  parse(raw) {
    const p = obj(raw, ['label', 'tag', 'processName', 'maxSeconds'])
    return {
      label: str(p.label, 'rótulo', 60, LABEL, 'Sessão'),
      tag: p.tag === undefined || p.tag === '' ? '' : str(p.tag, 'grupo', 30, LABEL),
      processName: p.processName === undefined || p.processName === '' ? null : str(p.processName, 'processo', 84, PROCESS_NAME),
      maxSeconds: int(p.maxSeconds, 'duração máxima (s)', 10, 3600, 600)
    }
  },
  run: (p) => startSession(p)
})

defineQuery({ id: 'fivem.lab.stop', module: 'fivem', parse: noParams, run: () => stopSession() })
defineQuery({ id: 'fivem.lab.status', module: 'fivem', parse: noParams, run: async () => sessionStatus() })

// ---------------------------------------------------------------------------
// Captura cronometrada (permite PresentMon como administrador)
// ---------------------------------------------------------------------------

defineQuery({
  id: 'fivem.lab.capture',
  module: 'fivem',
  parse(raw) {
    const p = obj(raw, ['label', 'tag', 'processName', 'durationSec', 'elevated'])
    return {
      label: str(p.label, 'rótulo', 60, LABEL, 'Sessão'),
      tag: p.tag === undefined || p.tag === '' ? '' : str(p.tag, 'grupo', 30, LABEL),
      processName: str(p.processName, 'processo', 84, PROCESS_NAME),
      durationSec: int(p.durationSec, 'duração (s)', 15, 600, 60),
      elevated: bool(p.elevated, 'administrador', false)
    }
  },
  async run(p, ctx) {
    if (running) throw new AppFailure('already-running', 'Já existe uma sessão de medição em andamento.')
    const pm = getPresentMonPath()
    const collector = new TelemetryCollector('fpslab-timed')
    const startedAt = Date.now()
    collector.start((pt) => ctx.progress(`${Math.round((Date.now() - startedAt) / 1000)} s de ${p.durationSec} s`, Date.now() - startedAt, p.durationSec * 1000, pt))
    let frames: number[] | null = null
    let reason: string | null = null
    if (pm) {
      try {
        frames = (await captureFrames(pm, p.processName, p.durationSec, { elevated: p.elevated, signal: ctx.signal })).frames
      } catch (error) {
        reason = (error as Error).message
      }
    } else {
      reason = 'PresentMon não configurado: FPS indisponível.'
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, p.durationSec * 1000)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    // A telemetria é encerrada mesmo quando a captura de FPS falha.
    const telemetry = collector.stop()
    return save(await buildSession({ id: randomUUID(), label: p.label, tag: p.tag, processName: p.processName, startedAt }, frames, telemetry, reason))
  }
})

// ---------------------------------------------------------------------------
// Histórico, comparação e exportação
// ---------------------------------------------------------------------------

defineQuery({
  id: 'fivem.lab.list',
  module: 'fivem',
  parse: noParams,
  async run() {
    return store.read().map(({ frametimeSeries: _s, fps, ...rest }) => ({ ...rest, fps: fps ? { ...fps, perSecondFps: [] } : null }))
  }
})

defineQuery({
  id: 'fivem.lab.get',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'sessão', 40) }),
  async run({ id }) {
    const s = store.read().find((x) => x.id === id)
    if (!s) throw new AppFailure('not-found', 'Sessão não encontrada.')
    return s
  }
})

defineQuery({
  id: 'fivem.lab.delete',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'sessão', 40) }),
  run: async ({ id }) => store.write(store.read().filter((s) => s.id !== id)).length
})

/** Comparação completa entre duas sessões (métricas, configurações e avisos). Exportada para testes. */
export function compareLabSessions(a: LabSession, b: LabSession) {
  const warnings: string[] = []
  if (a.processName !== b.processName) warnings.push('Processos medidos diferentes: as sessões não são comparáveis.')
  if (Math.abs(a.durationSec - b.durationSec) > Math.max(a.durationSec, b.durationSec) * 0.5) warnings.push('Durações muito diferentes entre as sessões.')
  if (a.conditions.powerPlan !== b.conditions.powerPlan) warnings.push(`Planos de energia diferentes: "${a.conditions.powerPlan}" × "${b.conditions.powerPlan}".`)
  if (JSON.stringify(a.hardware) !== JSON.stringify(b.hardware)) warnings.push('O hardware detectado mudou entre as sessões.')
  warnings.push('Cena, servidor e número de jogadores alteram o FPS; mesmo uma diferença significativa não prova que um ajuste a causou.')
  const settingsChanges: { key: string; before: string | null; after: string | null }[] = []
  const keys = new Set([...Object.keys(a.conditions.settings ?? {}), ...Object.keys(b.conditions.settings ?? {})])
  for (const k of keys) {
    const x = a.conditions.settings?.[k] ?? null
    const y = b.conditions.settings?.[k] ?? null
    if (x !== y) settingsChanges.push({ key: k, before: x, after: y })
  }
  const metric = (label: string, x: number | null | undefined, y: number | null | undefined, unit: string) => ({ label, before: x ?? null, after: y ?? null, unit })
  return {
    comparison: a.fps && b.fps ? compareSessions(a.fps, b.fps) : { verdict: 'insufficient-data' as const, label: 'Dados insuficientes', avgFpsDeltaPct: null, low1DeltaPct: null, marginFps: null, reasons: ['As duas sessões precisam de FPS medido.'] },
    metrics: [
      metric('FPS médio', a.fps?.avgFps, b.fps?.avgFps, 'FPS'),
      metric('1% low', a.fps?.low1Fps, b.fps?.low1Fps, 'FPS'),
      metric('Frametime mediano', a.fps?.medianFrametimeMs, b.fps?.medianFrametimeMs, 'ms'),
      metric('Frametime p99', a.fps?.frametimeP99Ms, b.fps?.frametimeP99Ms, 'ms'),
      metric('CPU média', a.telemetry.cpuAvgPct, b.telemetry.cpuAvgPct, '%'),
      metric('Núcleo mais carregado (média)', a.telemetry.cpuMaxCoreAvgPct, b.telemetry.cpuMaxCoreAvgPct, '%'),
      metric('GPU média', a.telemetry.gpuAvgPct, b.telemetry.gpuAvgPct, '%'),
      metric('Memória comprometida (média)', a.telemetry.commitAvgPct, b.telemetry.commitAvgPct, '%'),
      metric('Temperatura máxima', a.telemetry.tempMaxC, b.telemetry.tempMaxC, '°C'),
      metric('Frequência efetiva média', a.telemetry.effectiveMHzAvg, b.telemetry.effectiveMHzAvg, 'MHz')
    ],
    settingsChanges,
    warnings
  }
}

defineQuery({
  id: 'fivem.lab.compare',
  module: 'fivem',
  parse(raw) {
    const p = obj(raw, ['a', 'b'])
    return { a: str(p.a, 'sessão A', 40), b: str(p.b, 'sessão B', 40) }
  },
  async run({ a, b }) {
    const all = store.read()
    const ra = all.find((s) => s.id === a)
    const rb = all.find((s) => s.id === b)
    if (!ra || !rb) throw new AppFailure('not-found', 'Sessão não encontrada.')
    return { a: { id: ra.id, label: ra.label, at: ra.at }, b: { id: rb.id, label: rb.label, at: rb.at }, ...compareLabSessions(ra, rb) }
  }
})

defineQuery({
  id: 'fivem.lab.export',
  module: 'fivem',
  parse(raw) {
    const p = obj(raw, ['id', 'format'])
    const format = p.format === 'csv' ? 'csv' : 'json'
    return { id: str(p.id, 'sessão', 40), format }
  },
  async run({ id, format }) {
    const s = store.read().find((x) => x.id === id)
    if (!s) throw new AppFailure('not-found', 'Sessão não encontrada.')
    const win = BrowserWindow.getFocusedWindow()
    const options = { title: 'Exportar sessão do FPS Lab', defaultPath: `fps-lab-${s.label.replace(/\s+/g, '-')}-${s.at.slice(0, 10)}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { saved: null }
    if (format === 'json') writeFileSync(picked.filePath, JSON.stringify(s, null, 2), 'utf8')
    else {
      const lines = ['segundo,fps_medido']
      ;(s.fps?.perSecondFps ?? []).forEach((v, i) => lines.push(`${i + 1},${v}`))
      lines.push('', 'metrica,valor,origem')
      const add = (k: string, v: unknown, src: string) => lines.push(`${k},${v ?? ''},${src}`)
      add('fps_medio', s.fps?.avgFps, 'calculado de frametimes medidos')
      add('low_1pct', s.fps?.low1Fps, 'calculado')
      add('frametime_p99_ms', s.fps?.frametimeP99Ms, 'calculado')
      add('cpu_media_pct', s.telemetry.cpuAvgPct, 'contador do Windows')
      add('gpu_media_pct', s.telemetry.gpuAvgPct, 'contador do Windows')
      add('memoria_comprometida_media_pct', s.telemetry.commitAvgPct, 'contador do Windows')
      add('temperatura_max_c', s.telemetry.tempMaxC, s.telemetry.tempMaxC === null ? 'sem sensor' : 'sensor')
      writeFileSync(picked.filePath, lines.join('\r\n') + '\r\n', 'utf8')
    }
    return { saved: picked.filePath }
  }
})
