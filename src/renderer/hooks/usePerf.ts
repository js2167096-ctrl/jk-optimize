import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PerfSample } from '@shared/types/perf'
import { api } from '../services/api'
import { query } from '../services/ops'

// Armazém único de telemetria: o coletor do processo principal envia cada amostra por evento (sem consulta
// periódica da interface) e todos os componentes compartilham a mesma leitura. A assinatura só existe enquanto
// houver algum componente usando; uma consulta leve a cada 20 s mantém o coletor ligado (ele desliga sem demanda).

const KEEPALIVE_MS = 20_000
const HISTORY_MAX = 120

let latest: PerfSample | null = null
let history: PerfSample[] = []
let error: string | null = null
let receivedAt = 0
let version = 0
const subscribers = new Set<() => void>()
let unlisten: (() => void) | null = null
let keepalive: ReturnType<typeof setInterval> | null = null

/** Latências medidas (ms): coleta no coletor, entrega ao renderer e até o próximo quadro pintado. Só leitura, para diagnóstico e testes. */
export const perfStats = { firstAt: 0, samples: 0, collectMs: 0, deliveryMs: 0, paintMs: 0, collectMax: 0, deliveryMax: 0, paintMax: 0 }
;(globalThis as unknown as { __jkPerfStats: typeof perfStats }).__jkPerfStats = perfStats

function emit() {
  version++
  for (const s of subscribers) s()
}

function accept(sample: PerfSample) {
  if (latest && sample.ts <= latest.ts) return // fora de ordem ou repetida
  latest = sample
  history = [...history, sample].slice(-HISTORY_MAX)
  error = null
  receivedAt = Date.now()
  const t0 = performance.now()
  if (!perfStats.firstAt) perfStats.firstAt = Math.round(t0)
  const delivery = Math.max(0, receivedAt - sample.ts)
  emit()
  requestAnimationFrame(() => {
    const paint = performance.now() - t0
    const n = ++perfStats.samples
    const avg = (prev: number, v: number) => prev + (v - prev) / n
    perfStats.collectMs = avg(perfStats.collectMs, sample.collectMs ?? 0)
    perfStats.deliveryMs = avg(perfStats.deliveryMs, delivery)
    perfStats.paintMs = avg(perfStats.paintMs, paint)
    perfStats.collectMax = Math.max(perfStats.collectMax, sample.collectMs ?? 0)
    perfStats.deliveryMax = Math.max(perfStats.deliveryMax, delivery)
    perfStats.paintMax = Math.max(perfStats.paintMax, paint)
  })
}

function prime() {
  query<{ sample: PerfSample | null }>('perf.snapshot')
    .then(({ sample }) => {
      if (sample) accept(sample)
    })
    .catch((e: Error) => {
      error = e.message
      emit()
    })
}

function connect() {
  unlisten = api.perf.onSample(accept)
  prime()
  keepalive = setInterval(prime, KEEPALIVE_MS)
}

function disconnect() {
  unlisten?.()
  unlisten = null
  if (keepalive) clearInterval(keepalive)
  keepalive = null
}

function subscribe(onChange: () => void) {
  subscribers.add(onChange)
  if (subscribers.size === 1) connect()
  return () => {
    subscribers.delete(onChange)
    if (subscribers.size === 0) disconnect()
  }
}

export interface PerfView {
  sample: PerfSample | null
  history: PerfSample[]
  error: string | null
  /** Idade da última leitura (ms), atualizada a cada segundo; null se ainda não há leitura. */
  ageMs: number | null
  /** true quando a leitura está velha demais para ser mostrada como atual. */
  stale: boolean
  /** Atraso entre a coleta e a chegada na interface (ms), da última amostra. */
  deliveryMs: number | null
}

/** Amostras reais do coletor. `intervalSeconds` define quando uma leitura é considerada velha. */
export function usePerf(intervalSeconds: number, historySize = 90): PerfView {
  useSyncExternalStore(subscribe, () => version)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const ageMs = latest ? Math.max(0, now - latest.ts) : null
  const limit = Math.max(6000, intervalSeconds * 1000 * 3 + 3000)
  const stale = ageMs !== null ? ageMs > limit : false
  return {
    sample: latest,
    history: history.slice(-historySize),
    error: error ?? (latest === null && subscribers.size > 0 && now - (receivedAt || now) > 15_000 ? 'Telemetria sem resposta.' : null),
    ageMs,
    stale,
    deliveryMs: latest && receivedAt ? Math.max(0, receivedAt - latest.ts) : null
  }
}

/**
 * Espera a primeira amostra do coletor mais nova que `ts` (ms). Serve para medir "depois" de uma ação sem usar o valor
 * capturado na renderização anterior. Devolve null se nenhuma chegar dentro de `timeoutMs`.
 */
export function nextSampleAfter(ts: number, timeoutMs: number): Promise<PerfSample | null> {
  if (latest && latest.ts > ts) return Promise.resolve(latest)
  return new Promise((resolve) => {
    const watcher = () => {
      if (latest && latest.ts > ts) done(latest)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    const done = (sample: PerfSample | null) => {
      clearTimeout(timer)
      subscribers.delete(watcher)
      if (subscribers.size === 0) disconnect()
      resolve(sample)
    }
    subscribers.add(watcher)
    if (subscribers.size === 1) connect()
  })
}

export const maxGpu =(s: PerfSample | null) => (s && s.gpus.length ? Math.max(...s.gpus.map((g) => g.utilizationPct)) : null)

export function temperatures(s: PerfSample | null): { label: string; celsius: number; source: string }[] {
  if (!s) return []
  return [
    ...s.thermal.map((t) => ({ label: t.name, celsius: t.celsius, source: 'Zona térmica do Windows' })),
    ...s.nvidia.filter((g) => g.temperatureC !== null).map((g) => ({ label: g.name, celsius: g.temperatureC!, source: 'nvidia-smi' }))
  ]
}
