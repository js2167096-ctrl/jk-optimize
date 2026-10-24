// Peças da aba Otimização para Jogos: tipos das consultas, capa com cache e fila, selos de estado.
import { useEffect, useState } from 'react'
import { Badge, cx, type Tone } from '../../components/ui'
import type { GameDef } from '@shared/constants/games-catalog'
import { query } from '../../services/ops'

export interface RunningProcess {
  name: string
  pid: number
  role: string
}

export interface Detection {
  id: string
  state: 'installed' | 'not-detected' | 'unknown'
  confidence: 'alta' | 'média' | null
  sources: string[]
  path: string | null
  exe: string | null
  version: string | null
  running: RunningProcess[]
  note: string | null
}

export interface ScanResult {
  detections: Detection[]
  scannedAt: string
  failed: string[]
}

export interface PlanRow {
  kind: 'tweak' | 'graphics' | 'info'
  id: string
  label: string
  current: string
  intended: string
  status: 'apply' | 'already' | 'unavailable' | 'skipped' | 'info'
  why: string
  reason: string | null
  elevated: boolean
  needsRestart: boolean
}

export interface GamePlan {
  gameId: string
  level: 'basic' | 'intermediate' | 'promax'
  rows: PlanRow[]
  warnings: string[]
  blocked: string | null
  hardware: { cpu: string | null; cores: number | null; threads: number | null; ramGB: number; gpus: string[]; integratedGpu: boolean; hasBattery: boolean }
}

export interface RunEntry {
  id: string
  at: string
  gameId: string
  level: 'basic' | 'intermediate' | 'promax'
  outcome: 'ok' | 'partial' | 'failed'
  summary: string
  rows: { label: string; value: string; tone: 'ok' | 'warn' | 'error' }[]
  metricsBefore: { cpuPct: number | null; ramAvailableGB: number | null; commitPct: number | null } | null
  metricsAfter: { cpuPct: number | null; ramAvailableGB: number | null; commitPct: number | null } | null
  change: { changeId: string; status: string; revertedAt: string | null; reversible: boolean } | null
}

export const LEVEL_NAME = { basic: 'Básica', intermediate: 'Intermediária', promax: 'Pro Max' } as const

export function stateOf(d: Detection | undefined, game: GameDef): { label: string; tone: Tone } {
  if (!d) return { label: 'Detectando…', tone: 'neutral' }
  if (game.viaEmulator) return d.sources.length ? { label: 'Depende do emulador', tone: 'info' } : { label: 'Não detectado', tone: 'neutral' }
  if (d.state === 'installed') return { label: d.confidence === 'média' ? 'Instalado (provável)' : 'Instalado', tone: 'ok' }
  if (d.state === 'unknown') return { label: 'Estado desconhecido', tone: 'warn' }
  return { label: 'Não detectado', tone: 'neutral' }
}

export function StateBadge({ detection, game }: { detection: Detection | undefined; game: GameDef }) {
  const s = stateOf(detection, game)
  return <Badge tone={s.tone}>{s.label}</Badge>
}

// ---------------------------------------------------------------------------
// Capas: o processo principal guarda a imagem em disco; aqui só uma fila curta para não disparar tudo de uma vez.
// ---------------------------------------------------------------------------

interface CoverResult {
  dataUrl: string | null
  source: 'cache' | 'steam' | null
  reason: string | null
}

const memo = new Map<string, Promise<CoverResult>>()
let active = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (active < 3) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(() => (active++, resolve())))
}

function release() {
  active--
  waiting.shift()?.()
}

export function loadCover(id: string): Promise<CoverResult> {
  let p = memo.get(id)
  if (!p) {
    p = acquire().then(async () => {
      try {
        return await query<CoverResult>('games.cover', { id })
      } catch (e) {
        return { dataUrl: null, source: null, reason: (e as Error).message }
      } finally {
        release()
      }
    })
    memo.set(id, p)
  }
  return p
}

/** Capa do jogo: imagem real quando existe; senão um fundo elegante com a cor e as iniciais do jogo. */
export function GameCover({ game, className, large }: { game: GameDef; className?: string; large?: boolean }) {
  const [cover, setCover] = useState<CoverResult | null | undefined>(game.steamAppIds?.length ? undefined : null)
  useEffect(() => {
    let alive = true
    if (game.steamAppIds?.length) void loadCover(game.id).then((r) => alive && setCover(r))
    return () => {
      alive = false
    }
  }, [game.id, game.steamAppIds])
  const initials = game.name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <div className={cx('relative aspect-[460/215] w-full overflow-hidden bg-surface-2', className)} data-cover={cover?.dataUrl ? 'image' : cover === undefined ? 'loading' : 'placeholder'}>
      {cover?.dataUrl ? (
        <img src={cover.dataUrl} alt={`Capa de ${game.name}`} draggable={false} className="size-full object-cover" />
      ) : (
        <div className="grid size-full place-items-center" style={{ background: `linear-gradient(135deg, ${game.accent}33, #05070d 70%)` }} role="img" aria-label={`Sem capa disponível para ${game.name}`}>
          <span className={cx('font-black tracking-tight', large ? 'text-5xl' : 'text-3xl')} style={{ color: game.accent }}>
            {initials}
          </span>
          {cover === undefined && <span className="cover-shimmer absolute inset-0" />}
        </div>
      )}
    </div>
  )
}
