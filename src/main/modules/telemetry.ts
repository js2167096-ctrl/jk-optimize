// Coletor de telemetria de sessão (CPU, GPU, memória, sensores, processos do jogo)
// e classificação de gargalos baseada em evidências. A classificação é pura e testável.
import type { PerfSample } from '@shared/types/perf'
import { onSample, setPersistentConsumer } from './sampler'
import { liveStats } from './presentmon'

const GAME = /^(gta5|gta5_enhanced|fivem|fivem_.*)$/i

export interface TelemetryPoint {
  t: number
  cpu: number | null
  maxCore: number | null
  gpu: number | null
  vram: number | null
  commit: number | null
  avail: number | null
  pages: number | null
  temp: number | null
  effMHz: number | null
  perfLimit: number | null
  /** FPS do último segundo (PresentMon), quando a captura contínua estiver ativa. */
  fps: number | null
  gameWorkingSet: number | null
}

export interface TelemetrySummary {
  samples: number
  cpuAvgPct: number | null
  cpuMaxCoreAvgPct: number | null
  /** % das amostras com algum processador lógico ≥ 90%. */
  cpuCoreSaturatedPct: number | null
  gpuAvgPct: number | null
  /** % das amostras com a GPU ≥ 95%. */
  gpuHighPctTime: number | null
  vramMaxBytes: number | null
  commitAvgPct: number | null
  commitMaxPct: number | null
  availMinBytes: number | null
  pagesPerSecAvg: number | null
  tempMaxC: number | null
  effectiveMHzAvg: number | null
  perfLimitMinPct: number | null
  /** % das amostras com o desempenho da CPU limitado pelo Windows (< 100%). */
  perfLimitedPct: number | null
  gameWorkingSetMaxBytes: number | null
  /** Correlação (Pearson) entre o núcleo mais carregado e o FPS, quando há FPS por amostra. */
  coreFpsCorrelation: number | null
}

export function pointFromSample(s: PerfSample, fps: number | null): TelemetryPoint {
  const temps = [...s.thermal.map((t) => t.celsius), ...s.nvidia.map((g) => g.temperatureC).filter((x): x is number => x !== null)]
  const game = s.topMemory.filter((p) => GAME.test(p.name))
  return {
    t: s.ts,
    cpu: s.cpu.totalPct,
    maxCore: s.cpu.perCore.length ? Math.max(...s.cpu.perCore.map((c) => c.pct)) : null,
    gpu: s.gpus.length ? Math.max(...s.gpus.map((g) => g.utilizationPct)) : null,
    vram: s.gpus.length ? Math.max(...s.gpus.map((g) => g.dedicatedBytes ?? 0)) || null : null,
    commit: s.memory.commitPct,
    avail: s.memory.availableBytes,
    pages: s.memory.pagesPerSec,
    temp: temps.length ? Math.max(...temps) : null,
    effMHz: s.cpu.effectiveMHz,
    perfLimit: s.cpu.performanceLimitPct,
    fps,
    gameWorkingSet: game.length ? game.reduce((a, p) => a + p.workingSetPrivate, 0) : null
  }
}

const vals = (pts: TelemetryPoint[], k: keyof TelemetryPoint) => pts.map((p) => p[k]).filter((x): x is number => typeof x === 'number')
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)
const pctOf = (xs: number[], pred: (x: number) => boolean) => (xs.length ? Math.round((xs.filter(pred).length / xs.length) * 100) : null)

export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 5) return null
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da === 0 || db === 0 ? null : Math.round((num / Math.sqrt(da * db)) * 100) / 100
}

export function summarizeTelemetry(pts: TelemetryPoint[]): TelemetrySummary {
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null)
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null)
  const paired = pts.filter((p) => p.fps !== null && p.maxCore !== null)
  return {
    samples: pts.length,
    cpuAvgPct: avg(vals(pts, 'cpu')),
    cpuMaxCoreAvgPct: avg(vals(pts, 'maxCore')),
    cpuCoreSaturatedPct: pctOf(vals(pts, 'maxCore'), (x) => x >= 90),
    gpuAvgPct: avg(vals(pts, 'gpu')),
    gpuHighPctTime: pctOf(vals(pts, 'gpu'), (x) => x >= 95),
    vramMaxBytes: max(vals(pts, 'vram')),
    commitAvgPct: avg(vals(pts, 'commit')),
    commitMaxPct: max(vals(pts, 'commit')),
    availMinBytes: min(vals(pts, 'avail')),
    pagesPerSecAvg: avg(vals(pts, 'pages')),
    tempMaxC: max(vals(pts, 'temp')),
    effectiveMHzAvg: avg(vals(pts, 'effMHz')),
    perfLimitMinPct: min(vals(pts, 'perfLimit')),
    perfLimitedPct: pctOf(vals(pts, 'perfLimit'), (x) => x < 100),
    gameWorkingSetMaxBytes: max(vals(pts, 'gameWorkingSet')),
    coreFpsCorrelation: pearson(paired.map((p) => p.maxCore!), paired.map((p) => p.fps!))
  }
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

export type BottleneckKind =
  | 'cpu-confirmed'
  | 'cpu-probable'
  | 'gpu-confirmed'
  | 'gpu-probable'
  | 'memory-pressure'
  | 'thermal-power'
  | 'external-inconclusive'
  | 'insufficient-data'

export const BOTTLENECK_LABEL: Record<BottleneckKind, string> = {
  'cpu-confirmed': 'Gargalo de CPU confirmado pelas métricas',
  'cpu-probable': 'Gargalo de CPU provável',
  'gpu-confirmed': 'Gargalo de GPU confirmado pelas métricas',
  'gpu-probable': 'Gargalo de GPU provável',
  'memory-pressure': 'Pressão de memória',
  'thermal-power': 'Limitação térmica ou energética',
  'external-inconclusive': 'Limitação externa ou inconclusiva',
  'insufficient-data': 'Dados insuficientes'
}

export interface Classification {
  primary: BottleneckKind
  label: string
  /** Todas as condições detectadas, em ordem de relevância. */
  kinds: BottleneckKind[]
  evidence: string[]
  /** Ajustes sugeridos (chaves do settings.xml) coerentes com a causa detectada. */
  recommendedKeys: { key: string; direction: 'reduce' | 'disable'; reason: string }[]
  limitations: string[]
}

export const MIN_SAMPLES = 8

export function classify(t: TelemetrySummary, fps: { avgFps: number | null; frametimeP99Ms: number | null; frametimeAvgMs: number | null } | null): Classification {
  const evidence: string[] = []
  const limitations: string[] = []
  const kinds: BottleneckKind[] = []
  const hasFps = !!fps && fps.avgFps !== null
  if (!hasFps) limitations.push('Sem FPS medido (PresentMon): as conclusões ficam como "prováveis".')
  if (t.tempMaxC === null) limitations.push('Sem sensor de temperatura: limitação térmica só pode ser inferida pelo limite de desempenho do Windows.')
  if (t.samples < MIN_SAMPLES) {
    return {
      primary: 'insufficient-data',
      label: BOTTLENECK_LABEL['insufficient-data'],
      kinds: ['insufficient-data'],
      evidence: [`Apenas ${t.samples} amostras de telemetria (mínimo ${MIN_SAMPLES}).`],
      recommendedKeys: [],
      limitations
    }
  }

  if ((t.perfLimitedPct ?? 0) >= 30 || (t.tempMaxC ?? 0) >= 90) {
    kinds.push('thermal-power')
    if ((t.perfLimitedPct ?? 0) >= 30) evidence.push(`O Windows limitou o desempenho da CPU em ${t.perfLimitedPct}% das amostras (mínimo ${t.perfLimitMinPct}%).`)
    if ((t.tempMaxC ?? 0) >= 90) evidence.push(`Temperatura máxima registrada: ${t.tempMaxC} °C.`)
  }
  if ((t.gpuHighPctTime ?? 0) >= 70) {
    kinds.push(hasFps ? 'gpu-confirmed' : 'gpu-probable')
    evidence.push(`GPU acima de 95% em ${t.gpuHighPctTime}% das amostras (média ${t.gpuAvgPct}%).`)
  }
  const singleThread = (t.cpuCoreSaturatedPct ?? 0) >= 50 && (t.gpuAvgPct ?? 100) < 85
  const globalCpu = (t.cpuAvgPct ?? 0) >= 90
  if (singleThread || globalCpu) {
    kinds.push(hasFps ? 'cpu-confirmed' : 'cpu-probable')
    if (globalCpu) evidence.push(`CPU saturada como um todo: média de ${t.cpuAvgPct}% em todos os núcleos.`)
    else evidence.push(`Limitação em poucos threads: algum núcleo ≥ 90% em ${t.cpuCoreSaturatedPct}% das amostras, com a GPU em ${t.gpuAvgPct}%.`)
    if (t.coreFpsCorrelation !== null && t.coreFpsCorrelation <= -0.3) evidence.push(`Quando o núcleo mais carregado sobe, o FPS cai (correlação ${t.coreFpsCorrelation}).`)
  }
  if ((t.commitMaxPct ?? 0) >= 90 || (t.availMinBytes !== null && t.availMinBytes < 512 * 1024 ** 2)) {
    kinds.push('memory-pressure')
    evidence.push(`Memória comprometida chegou a ${t.commitMaxPct}% e a disponível caiu a ${t.availMinBytes === null ? '—' : `${Math.round(t.availMinBytes / 1024 ** 2)} MB`}.`)
  }
  if (kinds.length === 0) {
    kinds.push('external-inconclusive')
    evidence.push(
      `Nem a CPU (núcleo mais carregado em média ${t.cpuMaxCoreAvgPct ?? '—'}%) nem a GPU (${t.gpuAvgPct ?? '—'}%) ficaram saturadas. O limite pode vir do servidor, de V-Sync/limite de quadros, do próprio jogo ou de fatores não medidos.`
    )
  }
  if (fps?.frametimeP99Ms && fps.frametimeAvgMs && fps.frametimeP99Ms > fps.frametimeAvgMs * 2.5) {
    evidence.push(`Frametime instável: p99 de ${fps.frametimeP99Ms} ms contra média de ${fps.frametimeAvgMs} ms.`)
  }

  const order: BottleneckKind[] = ['thermal-power', 'gpu-confirmed', 'cpu-confirmed', 'gpu-probable', 'cpu-probable', 'memory-pressure', 'external-inconclusive']
  kinds.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const primary = kinds[0]

  const rec: Classification['recommendedKeys'] = []
  if (kinds.some((k) => k.startsWith('gpu'))) {
    rec.push(
      { key: 'MSAA', direction: 'disable', reason: 'MSAA é um dos ajustes mais caros para a GPU.' },
      { key: 'ShadowQuality', direction: 'reduce', reason: 'Sombras pesam na GPU.' },
      { key: 'GrassQuality', direction: 'reduce', reason: 'A grama é muito pesada em áreas abertas.' },
      { key: 'ReflectionQuality', direction: 'reduce', reason: 'Reflexos exigem renderização adicional.' },
      { key: 'PostFX', direction: 'reduce', reason: 'Pós-processamento consome GPU.' }
    )
  }
  if (kinds.some((k) => k.startsWith('cpu'))) {
    rec.push(
      { key: 'CityDensity', direction: 'reduce', reason: 'Menos pedestres e veículos simulados aliviam a CPU.' },
      { key: 'PedVarietyMultiplier', direction: 'reduce', reason: 'Menos variedade de pedestres reduz trabalho de CPU e streaming.' },
      { key: 'VehicleVarietyMultiplier', direction: 'reduce', reason: 'Menos variedade de veículos reduz trabalho de CPU e streaming.' },
      { key: 'LodScale', direction: 'reduce', reason: 'Distância de detalhes menor reduz chamadas de desenho (CPU).' },
      { key: 'MaxLodScale', direction: 'reduce', reason: 'Escala de distância estendida aumenta muito a carga da CPU.' }
    )
  }
  if (kinds.includes('memory-pressure')) rec.push({ key: 'TextureQuality', direction: 'reduce', reason: 'Texturas menores reduzem o uso de memória.' })
  return { primary, label: BOTTLENECK_LABEL[primary], kinds, evidence, recommendedKeys: rec, limitations }
}

// ---------------------------------------------------------------------------
// Coletor
// ---------------------------------------------------------------------------

export class TelemetryCollector {
  readonly points: TelemetryPoint[] = []
  private off: (() => void) | null = null
  private readonly id: string

  constructor(id: string) {
    this.id = id
  }

  start(onPoint?: (p: TelemetryPoint) => void): void {
    setPersistentConsumer(this.id, true)
    this.off = onSample((s) => {
      const live = liveStats()
      const fps = live.active && Date.now() - live.lastFrameAt < 2000 ? live.fps : null
      const p = pointFromSample(s, fps)
      if (this.points.length < 20_000) this.points.push(p)
      onPoint?.(p)
    })
  }

  stop(): TelemetrySummary {
    this.off?.()
    this.off = null
    setPersistentConsumer(this.id, false)
    return summarizeTelemetry(this.points)
  }
}
