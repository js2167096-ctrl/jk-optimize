// Monitoramento: overlay de desempenho, alertas, histórico persistente e ações rápidas.
import { BrowserWindow, Notification, screen } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, appendFileSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PerfSample } from '@shared/types/perf'
import type { QuickAction } from '@shared/types/ops'
import { AppFailure } from '../security/validate'
import { defineQuery, listActions, validateActionParams } from '../ops/registry'
import { bool, int, noParams, num, obj, oneOf, str } from '../ops/params'
import { log } from '../ops/log'
import { dataPath, JsonStore } from '../services/store'
import { getStaticInfo } from '../services/system'
import { DEV_URL, RENDERER_FILE, secureWebPreferences } from '../target'
import { demandSample, onSample, setPersistentConsumer } from './sampler'
import { liveStats, startLive, stopLive } from './presentmon'
import { getPresentMonPath } from './fivem'

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

export const OVERLAY_METRICS = ['fps', 'frametime', 'cpu', 'gpu', 'ram', 'temp'] as const
type OverlayMetric = (typeof OVERLAY_METRICS)[number]
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

export interface MonitoringSettings {
  overlay: { enabled: boolean; position: (typeof POSITIONS)[number]; scale: number; opacity: number; metrics: OverlayMetric[]; fpsProcess: string | null }
  alerts: { enabled: boolean; muted: boolean; tempC: number; memoryPct: number; diskFreePct: number; cooldownMin: number }
  history: { enabled: boolean; retentionDays: number; intervalSec: number }
}

const DEFAULTS: MonitoringSettings = {
  overlay: { enabled: false, position: 'top-left', scale: 1, opacity: 0.85, metrics: ['fps', 'frametime', 'cpu', 'gpu', 'ram', 'temp'], fpsProcess: null },
  alerts: { enabled: false, muted: false, tempC: 90, memoryPct: 90, diskFreePct: 10, cooldownMin: 30 },
  history: { enabled: false, retentionDays: 7, intervalSec: 30 }
}

const store = new JsonStore<MonitoringSettings>('monitoring.json', (raw) => {
  const r = (raw ?? {}) as Partial<MonitoringSettings>
  try {
    return parseSettings({ ...DEFAULTS, ...r, overlay: { ...DEFAULTS.overlay, ...r.overlay }, alerts: { ...DEFAULTS.alerts, ...r.alerts }, history: { ...DEFAULTS.history, ...r.history } })
  } catch {
    return DEFAULTS
  }
})

export function parseSettings(raw: unknown): MonitoringSettings {
  const p = obj(raw, ['overlay', 'alerts', 'history'])
  const o = obj(p.overlay, ['enabled', 'position', 'scale', 'opacity', 'metrics', 'fpsProcess'])
  const a = obj(p.alerts, ['enabled', 'muted', 'tempC', 'memoryPct', 'diskFreePct', 'cooldownMin'])
  const h = obj(p.history, ['enabled', 'retentionDays', 'intervalSec'])
  if (!Array.isArray(o.metrics)) throw new AppFailure('invalid-input', 'Métricas do overlay inválidas.')
  return {
    overlay: {
      enabled: bool(o.enabled, 'overlay'),
      position: oneOf(o.position, 'posição', POSITIONS),
      scale: num(o.scale, 'tamanho', 0.75, 1.75),
      opacity: num(o.opacity, 'opacidade', 0.3, 1),
      metrics: [...new Set(o.metrics.map((m) => oneOf(m, 'métrica', OVERLAY_METRICS)))],
      fpsProcess: o.fpsProcess === null || o.fpsProcess === undefined || o.fpsProcess === '' ? null : str(o.fpsProcess, 'processo', 84, /^[A-Za-z0-9 _.()-]{1,80}\.exe$/)
    },
    alerts: {
      enabled: bool(a.enabled, 'alertas'),
      muted: bool(a.muted, 'silenciar'),
      tempC: int(a.tempC, 'temperatura (°C)', 50, 110),
      memoryPct: int(a.memoryPct, 'memória (%)', 50, 99),
      diskFreePct: int(a.diskFreePct, 'espaço livre (%)', 1, 50),
      cooldownMin: int(a.cooldownMin, 'intervalo entre alertas (min)', 5, 240)
    },
    history: {
      enabled: bool(h.enabled, 'histórico'),
      retentionDays: int(h.retentionDays, 'retenção (dias)', 1, 90),
      intervalSec: int(h.intervalSec, 'intervalo (s)', 5, 300)
    }
  }
}

defineQuery({ id: 'monitoring.settings', module: 'monitoring', parse: noParams, run: async () => store.read() })

defineQuery({
  id: 'monitoring.settings.save',
  module: 'monitoring',
  parse: (raw) => parseSettings(raw),
  async run(settings) {
    store.write(settings)
    applySettings()
    return settings
  }
})

// ---------------------------------------------------------------------------
// 11.3 Histórico persistente (NDJSON por dia, com retenção)
// ---------------------------------------------------------------------------

export interface HistoryPoint {
  t: number
  cpu: number | null
  maxCore: number | null
  gpu: number | null
  commit: number | null
  availGB: number | null
  tempC: number | null
}

const historyDir = () => dataPath('history')
let lastHistoryWrite = 0

function recordHistory(s: PerfSample): void {
  const settings = store.read().history
  if (!settings.enabled || s.ts - lastHistoryWrite < settings.intervalSec * 1000 - 250) return
  lastHistoryWrite = s.ts
  const point: HistoryPoint = {
    t: s.ts,
    cpu: s.cpu.totalPct,
    maxCore: s.cpu.perCore.length ? Math.max(...s.cpu.perCore.map((c) => c.pct)) : null,
    gpu: s.gpus.length ? Math.max(...s.gpus.map((g) => g.utilizationPct)) : null,
    commit: s.memory.commitPct,
    availGB: s.memory.availableBytes === null ? null : Math.round((s.memory.availableBytes / 1024 ** 3) * 100) / 100,
    tempC: s.thermal.length ? Math.max(...s.thermal.map((t) => t.celsius)) : s.nvidia.length ? Math.max(...s.nvidia.map((g) => g.temperatureC ?? -1)) : null
  }
  if (point.tempC !== null && point.tempC < 0) point.tempC = null
  try {
    mkdirSync(historyDir(), { recursive: true })
    appendFileSync(join(historyDir(), `${new Date(s.ts).toISOString().slice(0, 10)}.ndjson`), JSON.stringify(point) + '\n')
  } catch (error) {
    log.error('monitoring', `Falha ao gravar histórico: ${(error as Error).message}`)
  }
}

function pruneHistory(): void {
  if (!existsSync(historyDir())) return
  const limit = Date.now() - store.read().history.retentionDays * 86_400_000
  for (const name of readdirSync(historyDir())) {
    const m = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name)
    if (m && new Date(m[1]).getTime() + 86_400_000 < limit) rmSync(join(historyDir(), name), { force: true })
  }
}

/** Insere null onde há buraco maior que 2,5× o intervalo (ausência de dados ≠ zero). Exportada para testes. */
export function withGaps(points: HistoryPoint[], intervalSec: number): (HistoryPoint | { t: number; gap: true })[] {
  const out: (HistoryPoint | { t: number; gap: true })[] = []
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].t - points[i - 1].t > intervalSec * 2500) out.push({ t: points[i - 1].t + intervalSec * 1000, gap: true })
    out.push(points[i])
  }
  return out
}

defineQuery({
  id: 'monitoring.history',
  module: 'monitoring',
  parse: (raw) => ({ hours: int(obj(raw, ['hours']).hours, 'período (h)', 1, 24 * 90, 24) }),
  async run({ hours }) {
    const from = Date.now() - hours * 3_600_000
    const points: HistoryPoint[] = []
    if (existsSync(historyDir())) {
      for (const name of readdirSync(historyDir()).sort()) {
        const m = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name)
        if (!m || new Date(m[1]).getTime() + 86_400_000 < from) continue
        for (const line of readFileSync(join(historyDir(), name), 'utf8').split('\n')) {
          if (!line) continue
          try {
            const p = JSON.parse(line) as HistoryPoint
            if (p.t >= from) points.push(p)
          } catch {
            // linha corrompida ignorada
          }
        }
      }
    }
    // Reduz para no máximo ~600 pontos (média por balde) para o gráfico.
    const settings = store.read().history
    const bucket = Math.max(1, Math.ceil(points.length / 600))
    const reduced: HistoryPoint[] = []
    for (let i = 0; i < points.length; i += bucket) {
      const slice = points.slice(i, i + bucket)
      const avg = (k: keyof HistoryPoint) => {
        const v = slice.map((p) => p[k]).filter((x): x is number => typeof x === 'number')
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null
      }
      reduced.push({ t: slice[0].t, cpu: avg('cpu'), maxCore: avg('maxCore'), gpu: avg('gpu'), commit: avg('commit'), availGB: avg('availGB'), tempC: avg('tempC') })
    }
    return {
      from,
      to: Date.now(),
      intervalSec: settings.intervalSec * bucket,
      enabled: settings.enabled,
      points: withGaps(reduced, settings.intervalSec * bucket),
      sources: {
        cpu: 'Contadores de desempenho (Processor Information)',
        gpu: 'Contadores GPU Engine (maior adaptador)',
        commit: 'Contador Memory: % Committed Bytes In Use',
        tempC: 'Zonas térmicas do Windows ou nvidia-smi (null = sem sensor)'
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 11.2 Alertas
// ---------------------------------------------------------------------------

const lastAlert = new Map<string, number>()
let lastDiskCheck = 0

/** Decide se um alerta pode ser disparado respeitando o intervalo mínimo. Exportada para testes. */
export function shouldAlert(key: string, now: number, cooldownMin: number, last: Map<string, number>): boolean {
  const prev = last.get(key)
  if (prev !== undefined && now - prev < cooldownMin * 60_000) return false
  last.set(key, now)
  return true
}

function notify(key: string, title: string, body: string): void {
  const s = store.read().alerts
  if (!shouldAlert(key, Date.now(), s.cooldownMin, lastAlert)) return
  log.warn('monitoring', `Alerta: ${title} — ${body}`)
  if (s.muted || !Notification.isSupported()) return
  new Notification({ title: `JK Optimize: ${title}`, body, silent: false }).show()
}

async function checkAlerts(s: PerfSample): Promise<void> {
  const a = store.read().alerts
  if (!a.enabled) return
  const temps = [...s.thermal.map((t) => t.celsius), ...s.nvidia.map((g) => g.temperatureC).filter((x): x is number => x !== null)]
  const maxTemp = temps.length ? Math.max(...temps) : null
  if (maxTemp !== null && maxTemp >= a.tempC) notify('temp', 'Temperatura alta', `${maxTemp} °C (limite ${a.tempC} °C).`)
  if (s.memory.commitPct !== null && s.memory.commitPct >= a.memoryPct) notify('memory', 'Memória quase esgotada', `${s.memory.commitPct}% da memória comprometida (limite ${a.memoryPct}%).`)
  if (Date.now() - lastDiskCheck > 5 * 60_000) {
    lastDiskCheck = Date.now()
    const info = await getStaticInfo(false)
    for (const d of info.disks) {
      try {
        const fs = statfsSync(`${d.drive}\\`)
        const pct = (fs.bavail / fs.blocks) * 100
        if (pct < a.diskFreePct) notify(`disk-${d.drive}`, `Pouco espaço em ${d.drive}`, `${pct.toFixed(1)}% livre (limite ${a.diskFreePct}%).`)
      } catch {
        // unidade indisponível
      }
    }
  }
}

defineQuery({
  id: 'monitoring.alerts.test',
  module: 'monitoring',
  parse: noParams,
  async run() {
    if (!Notification.isSupported()) return { shown: false, reason: 'Notificações não suportadas neste Windows.' }
    new Notification({ title: 'JK Optimize', body: 'Teste de notificação de alerta.' }).show()
    return { shown: true, reason: null }
  }
})

// ---------------------------------------------------------------------------
// 11.1 Overlay
// ---------------------------------------------------------------------------

let overlay: BrowserWindow | null = null

function overlayBounds(s: MonitoringSettings['overlay']) {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.round(220 * s.scale)
  const height = Math.round((24 + s.metrics.length * 22) * s.scale)
  const m = 16
  const x = s.position.endsWith('left') ? area.x + m : area.x + area.width - width - m
  const y = s.position.startsWith('top') ? area.y + m : area.y + area.height - height - m
  return { x, y, width, height }
}

function openOverlay(s: MonitoringSettings['overlay']): void {
  if (overlay && !overlay.isDestroyed()) {
    overlay.setBounds(overlayBounds(s))
    overlay.setOpacity(s.opacity)
    return
  }
  overlay = new BrowserWindow({
    ...overlayBounds(s),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: secureWebPreferences()
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setIgnoreMouseEvents(true)
  overlay.setOpacity(s.opacity)
  overlay.once('ready-to-show', () => overlay?.showInactive())
  overlay.on('closed', () => (overlay = null))
  if (DEV_URL) void overlay.loadURL(`${DEV_URL}#overlay`)
  else void overlay.loadFile(RENDERER_FILE, { hash: 'overlay' })
}

function closeOverlay(): void {
  overlay?.destroy()
  overlay = null
}

defineQuery({
  id: 'monitoring.overlay.data',
  module: 'monitoring',
  parse: noParams,
  async run() {
    const s = demandSample()
    const settings = store.read().overlay
    const fps = liveStats()
    const temps = s ? [...s.thermal.map((t) => t.celsius), ...s.nvidia.map((g) => g.temperatureC).filter((x): x is number => x !== null)] : []
    return {
      settings,
      at: s?.ts ?? null,
      cpuPct: s?.cpu.totalPct ?? null,
      gpuPct: s && s.gpus.length ? Math.max(...s.gpus.map((g) => g.utilizationPct)) : null,
      ramPct: s?.memory.commitPct ?? null,
      tempC: temps.length ? Math.max(...temps) : null,
      fps: fps.fps,
      frametimeMs: fps.frametimeMs,
      fpsSource: fps.active ? `PresentMon (${fps.processName})` : null,
      fpsError: fps.error ?? (settings.fpsProcess && !getPresentMonPath() ? 'Configure o PresentMon na aba FiveM → Gargalos.' : null)
    }
  }
})

// ---------------------------------------------------------------------------
// 11.4 Ações rápidas
// ---------------------------------------------------------------------------

const quick = new JsonStore<QuickAction[]>('quick-actions.json', (raw) => (Array.isArray(raw) ? (raw as QuickAction[]).filter((q) => typeof q?.actionId === 'string').slice(0, 30) : []))

defineQuery({ id: 'monitoring.quick.list', module: 'monitoring', parse: noParams, run: async () => quick.read() })

defineQuery({
  id: 'monitoring.quick.add',
  module: 'monitoring',
  parse(raw) {
    const p = obj(raw, ['actionId', 'label', 'params'])
    return { actionId: str(p.actionId, 'ação', 80), label: str(p.label, 'nome', 40), params: (p.params ?? {}) as Record<string, unknown> }
  },
  async run({ actionId, label, params }) {
    if (!listActions().some((a) => a.id === actionId)) throw new AppFailure('unknown-action', 'Ação não registrada.')
    // Os parâmetros são validados agora e de novo a cada uso (pré-visualização + confirmação).
    validateActionParams(actionId, params)
    const list = quick.read()
    if (list.length >= 30) throw new AppFailure('limit', 'Limite de 30 ações rápidas.')
    list.push({ id: randomUUID(), actionId, label, params, createdAt: new Date().toISOString() })
    return quick.write(list)
  }
})

defineQuery({
  id: 'monitoring.quick.remove',
  module: 'monitoring',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'id', 40) }),
  run: async ({ id }) => quick.write(quick.read().filter((q) => q.id !== id))
})

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null
let pruneTimer: NodeJS.Timeout | null = null

function applySettings(): void {
  const s = store.read()
  const needsSampler = s.overlay.enabled || s.alerts.enabled || s.history.enabled
  setPersistentConsumer('monitoring', needsSampler)
  if (s.overlay.enabled) openOverlay(s.overlay)
  else closeOverlay()
  const pm = getPresentMonPath()
  if (s.overlay.enabled && s.overlay.fpsProcess && pm && (s.overlay.metrics.includes('fps') || s.overlay.metrics.includes('frametime'))) {
    try {
      if (liveStats().processName !== s.overlay.fpsProcess) startLive(pm, s.overlay.fpsProcess)
    } catch (error) {
      log.warn('monitoring', `PresentMon não iniciou: ${(error as Error).message}`)
    }
  } else stopLive()
}

export function startMonitoring(): void {
  unsubscribe = onSample((s) => {
    recordHistory(s)
    void checkAlerts(s).catch((error) => log.error('monitoring', `Alertas: ${(error as Error).message}`))
  })
  pruneHistory()
  pruneTimer = setInterval(pruneHistory, 6 * 3_600_000)
  try {
    applySettings()
  } catch (error) {
    log.error('monitoring', `Falha ao aplicar configurações: ${(error as Error).message}`)
  }
}

export function stopMonitoring(): void {
  unsubscribe?.()
  if (pruneTimer) clearInterval(pruneTimer)
  stopLive()
  closeOverlay()
}
