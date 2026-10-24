// Aba Otimização para Jogos: biblioteca visual com detecção real, busca e filtros; ao escolher um jogo, a página dele.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gamepad2, RefreshCw, Search } from 'lucide-react'
import { GAME_CATALOG, GAME_CATEGORIES, gameById, type GameCategory, type GameDef } from '@shared/constants/games-catalog'
import { foldText } from '@shared/constants/apps-catalog'
import { Badge, Button, cx, Notice, PageHeader, Spinner } from '../components/ui'
import { useAsync } from '../hooks/useAsync'
import { query } from '../services/ops'
import { GameDetail } from './games/GameDetail'
import { GameCover, LEVEL_NAME, StateBadge, type Detection, type RunEntry, type RunningProcess, type ScanResult } from './games/parts'

export function GamesPage() {
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [category, setCategory] = useState<GameCategory | 'all'>('all')
  const [onlyInstalled, setOnlyInstalled] = useState(false)
  const [tick, setTick] = useState(0)
  const scan = useAsync(() => query<ScanResult>('games.scan', { refresh: tick > 0 }), [tick])
  const history = useAsync(() => query<RunEntry[]>('games.history'), [tick, selected])
  const [running, setRunning] = useState<Record<string, RunningProcess[]>>({})

  // Jogos em execução: consulta leve a cada 6 s, só enquanto a aba está aberta.
  useEffect(() => {
    let alive = true
    const poll = () =>
      query<{ running: Record<string, RunningProcess[]> }>('games.running')
        .then((r) => alive && setRunning(r.running))
        .catch(() => undefined)
    void poll()
    const t = setInterval(poll, 6000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const detections = useMemo(() => {
    const map = new Map<string, Detection>()
    for (const d of scan.data?.detections ?? []) map.set(d.id, { ...d, running: running[d.id] ?? (gameById(d.id)?.viaEmulator ? d.running : []) })
    return map
  }, [scan.data, running])

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  const list = useMemo(() => {
    const q = foldText(text)
    const rank = (g: GameDef) => ((detections.get(g.id)?.running.length ?? 0) > 0 && !g.viaEmulator ? 0 : detections.get(g.id)?.state === 'installed' ? 1 : 2)
    return GAME_CATALOG.filter((g) => {
      if (category !== 'all' && g.category !== category) return false
      if (onlyInstalled && detections.get(g.id)?.state !== 'installed') return false
      return !q || foldText(`${g.name} ${g.category} ${g.launchers.join(' ')}`).includes(q)
    }).sort((a, b) => rank(a) - rank(b))
  }, [text, category, onlyInstalled, detections])

  if (selected) {
    const game = gameById(selected)!
    return <GameDetail game={game} detection={detections.get(selected)} scanning={scan.loading} onBack={() => setSelected(null)} onRefresh={refresh} />
  }

  const all = [...detections.values()]
  const installedGames = all.filter((d) => d.state === 'installed' && gameById(d.id)?.kind === 'game').length
  const installedEmus = all.filter((d) => d.state === 'installed' && gameById(d.id)?.kind === 'emulator').length
  const runningNow = Object.entries(running).filter(([id, p]) => p.length > 0 && gameById(id)?.kind === 'game' && !gameById(id)?.viaEmulator).length
  const last = history.data?.[0]
  const detecting = scan.loading && !scan.data
  const failed = !!scan.error || (scan.data ? scan.data.failed.length > 0 : false)
  const stat = (v: number | string | null) => (detecting ? '…' : scan.error ? '—' : v)

  return (
    <div data-page="games">
      <div className="space-y-6">
        <PageHeader title="Otimização para Jogos" description="Detecte seus jogos e aplique ajustes de desempenho compatíveis com seu computador." icon={Gamepad2} accent="advanced" />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-games-stats>
          <Tile label="Jogos detectados" value={stat(installedGames)} data="games" />
          <Tile label="Emuladores detectados" value={stat(installedEmus)} data="emulators" />
          <Tile label="Jogos em execução" value={stat(runningNow)} data="running" live={runningNow > 0} />
          <Tile label="Último perfil aplicado" value={last ? `${gameById(last.gameId)?.name ?? last.gameId} · ${LEVEL_NAME[last.level]}` : 'Nenhum ainda'} small data="last" hint={last ? `${new Date(last.at).toLocaleString('pt-BR')} · ${last.outcome === 'ok' ? 'concluído' : last.outcome === 'partial' ? 'parcial' : 'falhou'}${last.change?.status === 'reverted' ? ' · revertido' : ''}` : undefined} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-10 w-72 max-w-full items-center gap-2 rounded-control border border-line-strong bg-elevated px-3">
            <Search className="size-4 text-subtle" />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pesquisar jogo ou emulador…" aria-label="Pesquisar jogo" className="w-full bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none" />
          </label>
          {(['all', ...GAME_CATEGORIES] as const).map((c) => (
            <button key={c} type="button" data-game-filter={c} onClick={() => setCategory(c)} className={cx('no-drag h-8 rounded-full border px-3 text-[12px] transition-colors', category === c ? 'border-performance/50 bg-performance/15 text-fg' : 'border-line-strong text-muted hover:text-fg')}>
              {c === 'all' ? 'Todos' : c}
            </button>
          ))}
          <label className="no-drag flex items-center gap-2 text-[12.5px] text-muted">
            <input type="checkbox" className="size-4" checked={onlyInstalled} onChange={(e) => setOnlyInstalled(e.target.checked)} data-only-installed />
            Somente instalados
          </label>
          <Button icon={RefreshCw} onClick={refresh} loading={scan.loading} data-games-refresh>
            Atualizar detecção
          </Button>
        </div>

        {scan.error && <Notice tone="error" title="A detecção falhou">{scan.error}. O catálogo continua disponível, mas o estado de instalação é desconhecido.</Notice>}
        {!scan.error && failed && scan.data && <Notice tone="warn" title="Detecção incompleta">Não foi possível ler: {scan.data.failed.join(', ')}. Jogos não encontrados aparecem como "Estado desconhecido", não como "não instalados".</Notice>}
        {detecting && <Spinner label="Detectando jogos e emuladores instalados…" />}
        {!detecting && !scan.error && installedGames + installedEmus === 0 && <Notice tone="info" title="Nenhum jogo ou emulador detectado">Nada do catálogo foi encontrado nas fontes verificadas. Se um jogo está instalado em outra pasta, abra-o no catálogo e use "Indicar pasta manualmente".</Notice>}

        {list.length === 0 && <p className="text-[13px] text-subtle" data-games-empty>Nenhum jogo encontrado.</p>}
        {GAME_CATEGORIES.map((cat) => {
          const items = list.filter((g) => g.category === cat)
          if (items.length === 0) return null
          return (
            <section key={cat} data-game-category={cat}>
              <h2 className="mb-3 text-[12px] font-semibold tracking-[0.12em] text-subtle uppercase">{cat}</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {items.map((g, i) => (
                  <Card key={g.id} game={g} index={i} detection={detections.get(g.id)} onOpen={() => setSelected(g.id)} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function Tile({ label, value, hint, live, small, data }: { label: string; value: number | string | null; hint?: string; live?: boolean; small?: boolean; data: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4" data-stat={data}>
      <p className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-subtle uppercase">
        {live && <span className="game-live-dot size-2 rounded-full bg-optimize" />}
        {label}
      </p>
      <p className={cx('mt-1.5 font-semibold text-fg tabular-nums', small ? 'truncate text-[14px]' : 'text-2xl')} data-stat-value>
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-[11.5px] text-subtle">{hint}</p>}
    </div>
  )
}

function Card({ game, index, detection, onOpen }: { game: GameDef; index: number; detection: Detection | undefined; onOpen: () => void }) {
  const isRunning = (detection?.running.length ?? 0) > 0 && !game.viaEmulator
  const installed = detection?.state === 'installed'
  return (
    <button
      type="button"
      onClick={onOpen}
      data-game-card={game.id}
      data-state={detection?.state ?? 'loading'}
      data-running={isRunning}
      style={{ '--i': index } as React.CSSProperties}
      className={cx('game-card no-drag group flex flex-col overflow-hidden rounded-card border border-line bg-surface text-left', !installed && detection && 'opacity-80')}
    >
      <GameCover game={game} />
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[14px] leading-tight font-semibold text-fg">{game.name}</h3>
          {isRunning && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-optimize" data-live>
              <span className="game-live-dot size-2 rounded-full bg-optimize" />
              Em execução
            </span>
          )}
        </div>
        <p className="text-[11.5px] text-subtle">{game.category}</p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <StateBadge detection={detection} game={game} />
          {detection?.sources[0] && installed && <Badge tone="neutral">{detection.sources[0].split(' (')[0]}</Badge>}
        </div>
      </div>
    </button>
  )
}
