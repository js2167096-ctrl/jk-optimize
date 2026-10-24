// Estatísticas de quadros (FPS e frametime) a partir de frametimes MEDIDOS pelo
// PresentMon. Módulo puro, testável. Valores calculados são marcados como tal; o
// "1% low" só é informado quando há quadros suficientes para ser estatisticamente válido.

export const MIN_FRAMES_FOR_1_LOW = 300
export const MIN_FRAMES_FOR_01_LOW = 3000
export const MIN_SECONDS_FOR_COMPARISON = 20

export interface FrameSummary {
  frames: number
  durationSec: number
  /** FPS médio = quadros / tempo total (calculado a partir dos frametimes medidos). */
  avgFps: number | null
  medianFrametimeMs: number | null
  frametimeAvgMs: number | null
  frametimeP5Ms: number | null
  frametimeP95Ms: number | null
  frametimeP99Ms: number | null
  frametimeMaxMs: number | null
  frametimeStdevMs: number | null
  /** FPS médio dos 1% quadros mais lentos (null quando há menos de 300 quadros). */
  low1Fps: number | null
  /** FPS médio dos 0,1% quadros mais lentos (null quando há menos de 3000 quadros). */
  low01Fps: number | null
  /** FPS de cada segundo completo da sessão (base para a comparação entre sessões). */
  perSecondFps: number[]
  notes: string[]
}

const r1 = (n: number) => Math.round(n * 10) / 10
const r2 = (n: number) => Math.round(n * 100) / 100

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function summarizeFrames(frametimesMs: number[]): FrameSummary {
  const frames = frametimesMs.filter((v) => Number.isFinite(v) && v > 0 && v < 5000)
  const notes: string[] = []
  if (frames.length === 0) {
    return {
      frames: 0,
      durationSec: 0,
      avgFps: null,
      medianFrametimeMs: null,
      frametimeAvgMs: null,
      frametimeP5Ms: null,
      frametimeP95Ms: null,
      frametimeP99Ms: null,
      frametimeMaxMs: null,
      frametimeStdevMs: null,
      low1Fps: null,
      low01Fps: null,
      perSecondFps: [],
      notes: ['Nenhum quadro válido foi medido.']
    }
  }
  const total = frames.reduce((a, b) => a + b, 0)
  const mean = total / frames.length
  const sorted = [...frames].sort((a, b) => a - b)
  const variance = frames.reduce((a, b) => a + (b - mean) ** 2, 0) / frames.length
  const slowest = (fraction: number) => {
    const n = Math.max(1, Math.floor(sorted.length * fraction))
    const tail = sorted.slice(sorted.length - n)
    return 1000 / (tail.reduce((a, b) => a + b, 0) / tail.length)
  }
  const perSecond: number[] = []
  let acc = 0
  let count = 0
  for (const ft of frames) {
    acc += ft
    count++
    if (acc >= 1000) {
      perSecond.push(r1((count * 1000) / acc))
      acc = 0
      count = 0
    }
  }
  if (frames.length < MIN_FRAMES_FOR_1_LOW) notes.push(`1% low não calculado: são necessários pelo menos ${MIN_FRAMES_FOR_1_LOW} quadros (medidos: ${frames.length}).`)
  return {
    frames: frames.length,
    durationSec: r1(total / 1000),
    avgFps: r1(1000 / mean),
    medianFrametimeMs: r2(percentile(sorted, 50)),
    frametimeAvgMs: r2(mean),
    frametimeP5Ms: r2(percentile(sorted, 5)),
    frametimeP95Ms: r2(percentile(sorted, 95)),
    frametimeP99Ms: r2(percentile(sorted, 99)),
    frametimeMaxMs: r2(sorted[sorted.length - 1]),
    frametimeStdevMs: r2(Math.sqrt(variance)),
    low1Fps: frames.length >= MIN_FRAMES_FOR_1_LOW ? r1(slowest(0.01)) : null,
    low01Fps: frames.length >= MIN_FRAMES_FOR_01_LOW ? r1(slowest(0.001)) : null,
    perSecondFps: perSecond,
    notes
  }
}

/** Reduz uma série longa para no máximo `points` valores (média por balde) para gráficos. */
export function downsample(values: number[], points = 600): number[] {
  if (values.length <= points) return values.map(r2)
  const bucket = values.length / points
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const slice = values.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket))
    out.push(r2(slice.reduce((a, b) => a + b, 0) / slice.length))
  }
  return out
}

export type Verdict = 'improved' | 'worse' | 'no-significant-change' | 'insufficient-data'

export interface SessionComparison {
  verdict: Verdict
  label: string
  avgFpsDeltaPct: number | null
  low1DeltaPct: number | null
  /** Margem estatística (2 erros-padrão) sobre a diferença de FPS médio por segundo. */
  marginFps: number | null
  reasons: string[]
}

function meanSd(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1))
  return { m, sd }
}

/**
 * Compara duas sessões usando o FPS de cada segundo: a diferença só é considerada
 * significativa quando supera 2 erros-padrão E 3% do FPS da sessão de referência.
 * Frametimes consecutivos são correlacionados; por isso a margem é tratada como
 * indicativa, e não como prova de causa.
 */
export function compareSessions(before: FrameSummary, after: FrameSummary): SessionComparison {
  const reasons: string[] = []
  if (before.avgFps === null || after.avgFps === null) {
    return { verdict: 'insufficient-data', label: 'Dados insuficientes', avgFpsDeltaPct: null, low1DeltaPct: null, marginFps: null, reasons: ['Uma das sessões não tem FPS medido.'] }
  }
  if (before.perSecondFps.length < MIN_SECONDS_FOR_COMPARISON || after.perSecondFps.length < MIN_SECONDS_FOR_COMPARISON) {
    reasons.push(`Cada sessão precisa de pelo menos ${MIN_SECONDS_FOR_COMPARISON} s de medição.`)
    return { verdict: 'insufficient-data', label: 'Dados insuficientes', avgFpsDeltaPct: null, low1DeltaPct: null, marginFps: null, reasons }
  }
  const a = meanSd(before.perSecondFps)
  const b = meanSd(after.perSecondFps)
  const delta = b.m - a.m
  const se = Math.sqrt(a.sd ** 2 / before.perSecondFps.length + b.sd ** 2 / after.perSecondFps.length)
  const margin = 2 * se
  const deltaPct = (delta / a.m) * 100
  const low1DeltaPct = before.low1Fps && after.low1Fps ? r1(((after.low1Fps - before.low1Fps) / before.low1Fps) * 100) : null
  const significant = Math.abs(delta) > margin && Math.abs(deltaPct) >= 3
  if (!significant) reasons.push(`A diferença (${r1(delta)} FPS) está dentro da variação medida (±${r1(margin)} FPS) ou abaixo de 3%.`)
  if (low1DeltaPct !== null) reasons.push(`1% low: ${low1DeltaPct > 0 ? '+' : ''}${low1DeltaPct}%.`)
  const verdict: Verdict = !significant ? 'no-significant-change' : delta > 0 ? 'improved' : 'worse'
  return {
    verdict,
    label: verdict === 'improved' ? 'Melhorou' : verdict === 'worse' ? 'Piorou' : 'Sem diferença significativa',
    avgFpsDeltaPct: r1(deltaPct),
    low1DeltaPct,
    marginFps: r1(margin),
    reasons
  }
}
