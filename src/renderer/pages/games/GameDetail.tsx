// Página de um jogo: detecção real, hardware, três perfis com análise de compatibilidade, aplicação com progresso real,
// histórico com reversão e (FiveM/GTA V) cache, medição antes/depois e aplicativos em segundo plano.
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, CircleCheck, FolderOpen, History, LoaderCircle, RefreshCw, Rocket, Undo2 } from 'lucide-react'
import { OPT_LEVELS, type GameDef, type OptLevel } from '@shared/constants/games-catalog'
import { formatBytes } from '@shared/format'
import { OperationProgress, useBatch } from '../../components/OperationProgress'
import { Badge, Button, Card, cx, Notice, Spinner } from '../../components/ui'
import { useAsync } from '../../hooks/useAsync'
import { errorMessage } from '../../services/api'
import { newJobId, ops, query } from '../../services/ops'
import { GameCover, LEVEL_NAME, StateBadge, type Detection, type GamePlan, type PlanRow, type RunEntry } from './parts'

const STATUS_LABEL: Record<PlanRow['status'], string> = { apply: 'Será aplicado', already: 'Já configurado', unavailable: 'Indisponível', skipped: 'Ignorado', info: 'Informação' }

export function GameDetail({ game, detection, scanning, onBack, onRefresh }: { game: GameDef; detection: Detection | undefined; scanning: boolean; onBack: () => void; onRefresh: () => void }) {
  const [tick, setTick] = useState(0)
  const bump = useCallback(() => setTick((n) => n + 1), [])
  const batch = useBatch(bump)
  const hardware = useAsync(() => query<{ cpu: string | null; cores: number | null; threads: number | null; ramGB: number; gpus: string[]; integratedGpu: boolean; hasBattery: boolean }>('games.hardware'), [])
  const history = useAsync(() => query<RunEntry[]>('games.history', { id: game.id }), [game.id, tick])
  const usable = detection?.state === 'installed' || (!!game.viaEmulator && !!detection?.sources.length)
  const isFivemFamily = game.profile === 'fivem' || game.profile === 'gta5'
  const [pathError, setPathError] = useState<string | null>(null)

  const lastApplied = history.data?.find((r) => r.outcome !== 'failed' && r.change?.status === 'applied')
  const lastRun = history.data?.[0]

  const pick = async () => {
    setPathError(null)
    try {
      await query('games.path.pick', { id: game.id })
      onRefresh()
    } catch (e) {
      setPathError(errorMessage(e))
    }
  }
  const clearPath = async () => {
    await query('games.path.clear', { id: game.id })
    onRefresh()
  }

  return (
    <div data-page="game-detail" data-game={game.id} className="game-detail space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button icon={ArrowLeft} variant="ghost" onClick={onBack} data-games-back>
          Biblioteca
        </Button>
        <Button icon={RefreshCw} onClick={onRefresh} loading={scanning} data-games-refresh>
          Atualizar detecção
        </Button>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="grid md:grid-cols-[minmax(0,340px)_1fr]">
          <GameCover game={game} large className="md:h-full md:min-h-[190px] md:[aspect-ratio:auto]" />
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-fg">{game.name}</h1>
              <StateBadge detection={detection} game={game} />
              {(detection?.running.length ?? 0) > 0 && !game.viaEmulator && (
                <Badge tone="ok">
                  <span className="game-live-dot mr-1 inline-block size-1.5 rounded-full bg-optimize" />
                  Em execução
                </Badge>
              )}
            </div>
            <p className="text-[12.5px] text-muted">
              {game.category} · Launchers: {game.launchers.join(', ')}
            </p>
            {game.note && <p className="text-[12px] text-subtle">{game.note}</p>}
            <dl className="grid gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2" data-game-info>
              <Info label="Executável detectado" value={detection?.exe ?? (usable ? 'Não confirmado na pasta' : '—')} />
              <Info label="Pasta de instalação" value={detection?.path ?? '—'} />
              <Info label="Origem da detecção" value={detection?.sources.length ? `${detection.sources.join('; ')}${detection.confidence ? ` · confiança ${detection.confidence}` : ''}` : (detection?.note ?? '—')} />
              <Info label="Versão" value={detection?.version ?? 'Não informada'} />
              <Info label="Processos em execução" value={detection?.running.length ? detection.running.map((r) => `${r.role}: ${r.name} (${r.pid})`).join('; ') : 'Nenhum'} />
              <Info label="Perfil atual" value={lastApplied ? `${LEVEL_NAME[lastApplied.level]} (aplicado em ${new Date(lastApplied.at).toLocaleDateString('pt-BR')})` : 'Nenhum aplicado'} />
              <Info label="Última otimização" value={lastRun ? `${new Date(lastRun.at).toLocaleString('pt-BR')} · ${lastRun.outcome === 'ok' ? 'concluída' : lastRun.outcome === 'partial' ? 'parcial' : 'falhou'}` : 'Nenhuma'} />
              <Info label="Hardware detectado" value={hardware.data ? `${hardware.data.cpu ?? 'CPU'} · ${hardware.data.ramGB} GB · ${hardware.data.gpus.join(', ') || 'GPU não informada'}${hardware.data.integratedGpu ? ' (integrada)' : ''}` : hardware.error ? 'Indisponível' : 'Lendo…'} />
            </dl>
            {!game.viaEmulator && game.exes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button icon={FolderOpen} onClick={() => void pick()} data-game-pick-path>
                  Indicar pasta manualmente
                </Button>
                {detection?.sources.includes('Caminho informado manualmente') && (
                  <Button variant="ghost" onClick={() => void clearPath()}>
                    Remover caminho informado
                  </Button>
                )}
              </div>
            )}
            {pathError && <Notice tone="error">{pathError}</Notice>}
          </div>
        </div>
      </div>

      {!usable && (
        <Notice tone={detection?.state === 'unknown' ? 'warn' : 'info'} title={detection?.state === 'unknown' ? 'Detecção inconclusiva' : 'Jogo não detectado'} data-game-blocked>
          {detection?.state === 'unknown' ? (detection.note ?? 'Não foi possível verificar a instalação.') : `${game.name} não foi encontrado neste computador. Os ajustes específicos só ficam disponíveis para instalações detectadas; o catálogo mostra apenas as informações do jogo.`}
        </Notice>
      )}

      {usable && <Profiles game={game} tick={tick} batch={batch} />}
      {usable && <BackgroundApps batch={batch} />}
      {usable && game.profile === 'fivem' && <FivemCache batch={batch} detection={detection} />}
      {usable && isFivemFamily && <Measurement game={game} detection={detection} />}
      <HistoryCard game={game} entries={history} onChanged={bump} />
      {batch.state && <OperationProgress state={batch.state} onClose={batch.close} />}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-wider text-subtle uppercase">{label}</dt>
      <dd className="selectable break-words text-fg">{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Perfis
// ---------------------------------------------------------------------------

function Profiles({ game, tick, batch }: { game: GameDef; tick: number; batch: ReturnType<typeof useBatch> }) {
  const [plans, setPlans] = useState<Record<string, { loading: boolean; data?: GamePlan; error?: string }>>({})
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setPlans({ basic: { loading: true }, intermediate: { loading: true }, promax: { loading: true } })
    for (const l of OPT_LEVELS) {
      query<GamePlan>('games.plan', { id: game.id, level: l.id }).then(
        (data) => alive && setPlans((p) => ({ ...p, [l.id]: { loading: false, data } })),
        (e) => alive && setPlans((p) => ({ ...p, [l.id]: { loading: false, error: errorMessage(e) } }))
      )
    }
    return () => {
      alive = false
    }
  }, [game.id, tick])

  const apply = async (level: OptLevel, plan: GamePlan) => {
    const rows = plan.rows.filter((r) => r.status === 'apply')
    const items = [...rows.filter((r) => r.kind === 'tweak').map((r) => ({ id: `tweak:${r.id}`, name: r.label })), ...(rows.some((r) => r.kind === 'graphics') ? [{ id: 'graphics', name: 'Configurações gráficas' }] : [])]
    await batch.start({ title: `${OPT_LEVELS.find((l) => l.id === level)!.name} · ${game.name}`, actionId: 'games.profile.apply', params: { id: game.id, level }, items, message: 'Deseja aplicar esta otimização?', details: true })
  }

  return (
    <section data-profiles>
      <h2 className="mb-3 text-[12px] font-semibold tracking-[0.12em] text-subtle uppercase">Níveis de otimização</h2>
      <div className="grid gap-4 lg:grid-cols-3">
        {OPT_LEVELS.map((l) => {
          const st = plans[l.id]
          const plan = st?.data
          const count = (s: PlanRow['status']) => plan?.rows.filter((r) => r.status === s).length ?? 0
          return (
            <article key={l.id} data-profile={l.id} className="flex flex-col rounded-card border border-line bg-surface p-5">
              <h3 className="text-[15px] font-semibold text-fg">{l.name}</h3>
              <p className="mt-1 text-[12.5px] text-muted">{l.description}</p>
              <div className="my-3 flex-1 text-[12px]" data-profile-summary>
                {st?.loading && <Spinner label="Analisando compatibilidade…" />}
                {st?.error && <p className="text-danger">{st.error}</p>}
                {plan && (
                  <>
                    <p className="text-subtle">
                      <strong className="text-fg">{count('apply')}</strong> a aplicar · {count('already')} já configurado(s) · {count('unavailable') + count('skipped')} indisponível(is)
                    </p>
                    <button type="button" className="mt-1 text-subtle hover:text-muted hover:underline" onClick={() => setOpen(open === l.id ? null : l.id)} data-profile-toggle={l.id}>
                      {open === l.id ? 'Ocultar detalhes' : 'Ver detalhes'}
                    </button>
                    {open === l.id && (
                      <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto" data-profile-rows>
                        {plan.rows.map((r) => (
                          <li key={`${r.kind}${r.id}`} className="rounded-control border border-line px-2.5 py-1.5">
                            <p className="flex items-center justify-between gap-2 text-fg">
                              <span>{r.label}</span>
                              <span className={cx('shrink-0 text-[11px]', r.status === 'apply' ? 'text-optimize' : r.status === 'already' ? 'text-subtle' : 'text-alert')}>{STATUS_LABEL[r.status]}</span>
                            </p>
                            <p className="text-subtle">
                              {r.status === 'apply' || r.status === 'info' ? `${r.current} → ${r.intended}` : (r.reason ?? r.current)}
                              {r.elevated ? ' · administrador' : ''}
                              {r.needsRestart ? ' · exige reinício' : ''}
                            </p>
                            {r.status === 'apply' && <p className="text-subtle">{r.why}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {plan.blocked && <p className="mt-2 text-alert" data-profile-blocked>{plan.blocked}</p>}
                  </>
                )}
              </div>
              <Button variant="primary" icon={Rocket} className="game-apply" disabled={!plan || !!plan.blocked || !!batch.state} onClick={() => plan && void apply(l.id, plan)} data-apply-level={l.id}>
                {l.apply}
              </Button>
            </article>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] text-subtle">Básica, Intermediária e Pro Max indicam a abrangência dos ajustes, não uma garantia de FPS. Cada ajuste é conferido depois de aplicado e pode ser revertido no histórico abaixo.</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Aplicativos em segundo plano (o usuário escolhe; nada é fechado automaticamente)
// ---------------------------------------------------------------------------

function BackgroundApps({ batch }: { batch: ReturnType<typeof useBatch> }) {
  const [apps, setApps] = useState<{ name: string; count: number; ramBytes: number; title: string | null }[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setApps(await query('games.apps.candidates'))
      setChecked(new Set())
    } catch (e) {
      setError(errorMessage(e))
    }
    setLoading(false)
  }
  const close = async () => {
    const names = [...checked]
    await batch.start({ title: 'Fechar aplicativos em segundo plano', actionId: 'games.apps.close', params: { names }, items: names.map((n) => ({ id: n, name: n })), message: 'Deseja fechar os aplicativos selecionados?', details: true })
    void load()
  }
  return (
    <Card title="Aplicativos em segundo plano" accent="optimize" action={<Button onClick={() => void load()} loading={loading} data-bg-analyze>{apps ? 'Reanalisar' : 'Analisar'}</Button>}>
      <p className="mb-3 text-[12.5px] text-muted">Lista os aplicativos com janela aberta que podem ser fechados com segurança (processos do Windows e de segurança nunca aparecem). Você escolhe quais fechar; o fechamento é normal, nunca forçado.</p>
      {error && <Notice tone="error">{error}</Notice>}
      {apps && apps.length === 0 && <p className="text-[12.5px] text-subtle">Nenhum aplicativo candidato aberto agora.</p>}
      {apps && apps.length > 0 && (
        <>
          <ul data-bg-list>
            {apps.map((a) => (
              <li key={a.name} className="flex items-center justify-between gap-3 border-b border-line py-2 text-[12.5px] last:border-0">
                <label className="flex min-w-0 items-center gap-2 text-fg">
                  <input type="checkbox" className="no-drag size-4" checked={checked.has(a.name)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(a.name) : n.delete(a.name); return n })} data-bg-pick={a.name} />
                  <span className="truncate">{a.name}</span>
                  <span className="truncate text-subtle">{a.title ? `— ${a.title}` : ''}</span>
                </label>
                <span className="shrink-0 text-subtle tabular-nums">{a.count > 1 ? `${a.count} janelas · ` : ''}{formatBytes(a.ramBytes)}</span>
              </li>
            ))}
          </ul>
          <Button className="mt-3" variant="primary" disabled={checked.size === 0 || !!batch.state} onClick={() => void close()} data-bg-close>
            Fechar selecionados ({checked.size})
          </Button>
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Cache do FiveM
// ---------------------------------------------------------------------------

interface CacheScan {
  found: boolean
  categories: { id: string; label: string; path: string; heavy: boolean; files: number; bytes: number }[]
  running: string[]
  preserved?: string[]
}

function FivemCache({ batch }: { batch: ReturnType<typeof useBatch>; detection: Detection | undefined }) {
  const [scan, setScan] = useState<CacheScan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await query<CacheScan>('fivem.cache.scan')
      setScan(r)
      setChecked(new Set(r.categories.filter((c) => !c.heavy).map((c) => c.id)))
    } catch (e) {
      setError(errorMessage(e))
    }
    setLoading(false)
  }
  const total = scan?.categories.filter((c) => checked.has(c.id)).reduce((s, c) => s + c.bytes, 0) ?? 0
  const clean = async () => {
    const ids = [...checked]
    await batch.start({ title: 'Limpar cache do FiveM', actionId: 'fivem.cache.clean', params: { ids }, items: ids.map((id) => ({ id, name: scan?.categories.find((c) => c.id === id)?.label ?? id })), message: 'Deseja limpar o cache selecionado do FiveM?', details: true })
    void load()
  }
  return (
    <Card title="Cache do FiveM" accent="advanced" action={<Button onClick={() => void load()} loading={loading} data-cache-scan>{scan ? 'Reanalisar' : 'Analisar cache'}</Button>}>
      <p className="mb-3 text-[12.5px] text-muted">Mostra quanto cada categoria ocupa antes de apagar e mede o espaço realmente liberado depois. Nunca apaga a pasta inteira: configurações, mods, plugins, dados de interface dos servidores e arquivos de personagem são preservados. Arquivos apagados do cache não são recuperáveis (o FiveM baixa de novo o necessário).</p>
      {error && <Notice tone="error">{error}</Notice>}
      {scan && !scan.found && <p className="text-[12.5px] text-subtle">Pasta de dados do FiveM não encontrada.</p>}
      {scan?.found && (
        <>
          <ul data-cache-list>
            {scan.categories.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-[12.5px] last:border-0">
                <label className="flex items-center gap-2 text-fg">
                  <input type="checkbox" className="no-drag size-4" checked={checked.has(c.id)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(c.id) : n.delete(c.id); return n })} data-cache-pick={c.id} />
                  {c.label}
                  {c.heavy && <Badge tone="warn">Pesado</Badge>}
                </label>
                <span className="shrink-0 text-subtle tabular-nums">{c.files.toLocaleString('pt-BR')} arquivos · {formatBytes(c.bytes)}</span>
              </li>
            ))}
          </ul>
          {scan.running.length > 0 && <Notice tone="warn">Feche {scan.running.join(', ')} antes de limpar.</Notice>}
          <Button className="mt-3" variant="primary" disabled={checked.size === 0 || scan.running.length > 0 || !!batch.state} onClick={() => void clean()} data-cache-clean>
            Limpar selecionados ({formatBytes(total)})
          </Button>
          {scan.preserved && <p className="mt-2 text-[11.5px] text-subtle">Preservados: {scan.preserved.join(' · ')}</p>}
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Medição antes/depois (FPS Lab do app: PresentMon quando configurado; sem ele, só telemetria)
// ---------------------------------------------------------------------------

interface LabRow {
  id: string
  label: string
  tag: string
  at: string
  durationSec: number
  processName: string | null
  fps: { avgFps: number; low1Fps: number | null } | null
  fpsUnavailableReason: string | null
  telemetry: { cpuAvgPct: number | null; gpuAvgPct: number | null; commitAvgPct: number | null; tempMaxC: number | null }
}

interface Compare {
  metrics: { label: string; before: number | null; after: number | null; unit: string }[]
  warnings: string[]
  comparison: { label: string }
}

function Measurement({ game, detection }: { game: GameDef; detection: Detection | undefined }) {
  const [tick, setTick] = useState(0)
  const sessions = useAsync(() => query<LabRow[]>('fivem.lab.list'), [tick])
  const pm = useAsync(() => query<{ configured: boolean; exists: boolean }>('fivem.presentmon.status'), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [cmp, setCmp] = useState<Compare | null>(null)
  const proc = detection?.running.find((r) => /GTAProcess|^GTA5/i.test(r.name))?.name ?? null

  const capture = async (tag: 'antes' | 'depois') => {
    if (!proc) return
    setBusy(tag)
    setError(null)
    try {
      await query('fivem.lab.capture', { label: `${game.name} - ${tag}`, tag, processName: proc, durationSec: 60, elevated: false }, newJobId())
      setTick((n) => n + 1)
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(null)
  }
  const compare = async () => {
    setError(null)
    try {
      setCmp(await query<Compare>('fivem.lab.compare', { a: picked[0], b: picked[1] }))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const mine = (sessions.data ?? []).filter((s) => !s.processName || /GTAProcess|GTA5/i.test(s.processName))
  const fpsOk = pm.data?.configured && pm.data.exists
  return (
    <Card title="Medição de desempenho" accent="diagnostic">
      <p className="mb-3 text-[12.5px] text-muted">
        Capture 60 s de jogo antes e depois da otimização, em cena semelhante. {fpsOk ? 'O FPS é medido pelo PresentMon configurado.' : 'FPS indisponível: o PresentMon não está configurado (Otimização › Game Optimization). Sem ele, só uso de CPU, GPU e memória é registrado.'} Cena, servidor, resolução e temperatura alteram os resultados.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void capture('antes')} loading={busy === 'antes'} disabled={!proc || busy !== null} data-measure="antes">
          Medir 60 s (antes)
        </Button>
        <Button onClick={() => void capture('depois')} loading={busy === 'depois'} disabled={!proc || busy !== null} data-measure="depois">
          Medir 60 s (depois)
        </Button>
        {!proc && <span className="text-[12px] text-subtle">Abra o jogo para medir (processo do jogo não encontrado).</span>}
      </div>
      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      {mine.length > 0 && (
        <div className="mt-4" data-measure-list>
          <table className="w-full text-left text-[12px]">
            <thead className="text-subtle">
              <tr><th className="py-1" /><th>Sessão</th><th>FPS médio</th><th>CPU</th><th>GPU</th><th>Memória</th></tr>
            </thead>
            <tbody>
              {mine.slice(0, 8).map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-1.5"><input type="checkbox" className="size-4" checked={picked.includes(s.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id].slice(-2) : p.filter((x) => x !== s.id)))} aria-label={`Selecionar ${s.label}`} /></td>
                  <td className="text-fg">{s.label} <span className="text-subtle">· {new Date(s.at).toLocaleString('pt-BR')} · {s.durationSec} s</span></td>
                  <td>{s.fps ? `${s.fps.avgFps.toFixed(0)} FPS` : <span className="text-subtle">indisponível</span>}</td>
                  <td>{s.telemetry.cpuAvgPct ?? '—'}%</td>
                  <td>{s.telemetry.gpuAvgPct ?? '—'}%</td>
                  <td>{s.telemetry.commitAvgPct ?? '—'}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button className="mt-2" disabled={picked.length !== 2} onClick={() => void compare()}>Comparar as duas selecionadas</Button>
        </div>
      )}
      {cmp && (
        <div className="mt-3 text-[12px]" data-measure-compare>
          <p className="mb-1 font-medium text-fg">{cmp.comparison.label}</p>
          <ul>{cmp.metrics.filter((m) => m.before !== null || m.after !== null).map((m) => <li key={m.label} className="flex justify-between border-t border-line py-1"><span>{m.label}</span><span className="tabular-nums">{m.before ?? '—'} → {m.after ?? '—'} {m.unit}</span></li>)}</ul>
          <ul className="mt-2 text-subtle">{cmp.warnings.map((w) => <li key={w}>• {w}</li>)}</ul>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Histórico e reversão
// ---------------------------------------------------------------------------

function HistoryCard({ game, entries, onChanged }: { game: GameDef; entries: { data: RunEntry[] | null; error: string | null; loading: boolean; reload: () => void }; onChanged: () => void }) {
  const [reverting, setReverting] = useState<string | null>(null)
  const [message, setMessage] = useState<{ id: string; tone: 'ok' | 'error'; text: string; force?: boolean } | null>(null)
  const revert = async (changeId: string, force: boolean) => {
    setReverting(changeId)
    setMessage(null)
    try {
      const r = await ops.revert(changeId, force)
      setMessage({ id: changeId, tone: 'ok', text: (r as { revertSummary?: string }).revertSummary ?? 'Ajustes revertidos.' })
    } catch (e) {
      setMessage({ id: changeId, tone: 'error', text: errorMessage(e), force: /preserv|alterad|modificad/i.test(errorMessage(e)) })
    }
    setReverting(null)
    entries.reload()
    onChanged()
  }
  const list = entries.data ?? []
  return (
    <Card title="Histórico deste jogo" icon={History} accent="neutral">
      {entries.error && <Notice tone="error">{entries.error}</Notice>}
      {!entries.error && list.length === 0 && <p className="text-[12.5px] text-subtle" data-history-empty>Nenhuma otimização aplicada a {game.name} ainda.</p>}
      <ul data-history-list>
        {list.map((r) => (
          <li key={r.id} data-history-entry={r.id} className="border-b border-line py-3 text-[12.5px] last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-fg">
                {r.outcome === 'ok' ? <CircleCheck className="size-4 text-optimize" /> : <span className="size-2 rounded-full bg-alert" />}
                {LEVEL_NAME[r.level]} · {new Date(r.at).toLocaleString('pt-BR')}
                <Badge tone={r.outcome === 'ok' ? 'ok' : r.outcome === 'partial' ? 'warn' : 'error'}>{r.outcome === 'ok' ? 'Concluída' : r.outcome === 'partial' ? 'Parcial' : 'Falhou'}</Badge>
                {r.change?.status === 'reverted' && <Badge tone="neutral">Revertida</Badge>}
              </p>
              {r.change && r.change.status === 'applied' && r.change.reversible && (
                <Button icon={reverting === r.change.changeId ? LoaderCircle : Undo2} loading={reverting === r.change.changeId} onClick={() => void revert(r.change!.changeId, false)} data-revert={r.id}>
                  {reverting === r.change.changeId ? 'Revertendo ajustes…' : 'Reverter'}
                </Button>
              )}
            </div>
            <p className="mt-1 text-muted">{r.summary}</p>
            <details className="mt-1 text-subtle">
              <summary className="cursor-pointer">Resultado de cada ajuste</summary>
              <ul className="selectable mt-1 space-y-0.5">{r.rows.map((x, i) => <li key={i} className={x.tone === 'error' ? 'text-danger' : x.tone === 'warn' ? 'text-alert' : ''}>• {x.label}: {x.value}</li>)}</ul>
              {(r.metricsBefore || r.metricsAfter) && <p className="mt-1">Instantâneos do Windows (não são FPS): antes — RAM livre {r.metricsBefore?.ramAvailableGB ?? '—'} GB, CPU {r.metricsBefore?.cpuPct ?? '—'}%; depois — RAM livre {r.metricsAfter?.ramAvailableGB ?? '—'} GB, CPU {r.metricsAfter?.cpuPct ?? '—'}%.</p>}
            </details>
            {message && r.change?.changeId === message.id && (
              <div className="mt-2">
                <Notice tone={message.tone === 'ok' ? 'info' : 'error'}>{message.text}</Notice>
                {message.force && <Button className="mt-2" onClick={() => void revert(message.id, true)}>Forçar reversão (sobrescreve alterações posteriores)</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] text-subtle">A reversão restaura os valores anteriores registrados pelo JK Optimize e não sobrescreve, sem avisar, alterações feitas depois. Arquivos de cache apagados não são recuperados pela reversão.</p>
    </Card>
  )
}
