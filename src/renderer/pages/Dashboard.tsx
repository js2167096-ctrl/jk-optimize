// Dashboard (referência: cartão 05 da segunda prancha): banner de boas-vindas com a logo oficial, quatro cartões
// de CPU, RAM, GPU e disco, recomendações e resultados recentes em cartões separados.
// Só dados realmente coletados. Fontes: telemetria do coletor (CPU, RAM, GPU), inventário do Windows (nomes e
// discos), diário de alterações (resultados) e verificações do índice. O índice de otimização é avaliado em
// momentos definidos (ao abrir, ao reavaliar, quando o executor muda de estado) e não varia a cada leitura.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CircleCheck, CircleHelp, CircleX, Cpu, CircuitBoard, HardDrive, History, Lightbulb, ListChecks, MemoryStick, RefreshCw } from 'lucide-react'
import { formatBytes, formatDateTime } from '@shared/format'
import { evaluateIndex, type Criterion } from '@shared/optimization-index'
import type { ChangeRecord } from '@shared/types/ops'
import type { PerfSample } from '@shared/types/perf'
import { useApp } from '../hooks/useApp'
import { useAsync } from '../hooks/useAsync'
import { useQuery } from '../hooks/useQuery'
import { maxGpu, temperatures, usePerf } from '../hooks/usePerf'
import { api, call } from '../services/api'
import { ops } from '../services/ops'
import { Badge, Button, Card, cx, Emblem, Spinner, type Tone } from '../components/ui'
import { SocialPanel } from '../components/brand'

interface OverviewData {
  powerPlan: string | null
  gameMode: string
  startupEnabled: number | null
}

const STATE_ICON = { ok: CircleCheck, fail: CircleX, unknown: CircleHelp }
const STATE_COLOR = { ok: 'text-optimize', fail: 'text-danger', unknown: 'text-subtle' }
const CHANGE_STATUS: Record<ChangeRecord['status'], { label: string; tone: Tone }> = {
  applied: { label: 'Aplicada', tone: 'ok' },
  reverted: { label: 'Revertida', tone: 'neutral' },
  'revert-failed': { label: 'Reversão falhou', tone: 'error' }
}

/** Anel compacto do índice de otimização (critérios atendidos ÷ avaliados). */
function IndexRing({ percent, passed, evaluated }: { percent: number | null; passed: number; evaluated: number }) {
  const r = 40
  const c = 2 * Math.PI * r
  const frac = percent === null ? 0 : percent / 100
  return (
    <div className="relative size-[88px] shrink-0" role="img" aria-label={percent === null ? 'Índice de otimização indisponível' : `${passed} de ${evaluated} critérios atendidos`}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--jk-surface-3)" strokeWidth="7" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--jk-accent)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} className="transition-[stroke-dasharray] duration-700 ease-out" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="text-[19px] leading-none font-bold text-fg tabular-nums" data-index-value>
            {percent === null ? '—' : `${percent}%`}
          </p>
          <p className="mt-0.5 text-[9.5px] text-subtle">{evaluated ? `${passed}/${evaluated}` : 'sem dados'}</p>
        </div>
      </div>
    </div>
  )
}

/** Cartão de métrica: rótulo, valor grande, detalhe e barra. Leitura velha ou ausente nunca aparece como atual. */
function MetricCard({ icon: Icon, label, value, detail, pct, state }: { icon: typeof Cpu; label: string; value: string; detail: string; pct: number | null; state: 'live' | 'stale' | 'unavailable' }) {
  return (
    <div className={cx('rounded-card border border-line bg-surface/90 p-4 transition-colors hover:border-performance/40', state !== 'live' && 'opacity-80')} data-status-tile={label} data-state={state}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-[0.16em] text-muted uppercase">{label}</span>
        <Icon className="size-4 text-performance" />
      </div>
      <p className="mt-2 text-[28px] leading-none font-semibold text-fg tabular-nums" data-metric-value>
        {state === 'unavailable' ? '—' : value}
      </p>
      <p className="mt-1.5 truncate text-[11.5px] text-subtle" title={detail}>
        {state === 'stale' ? `Sem atualização recente · ${detail}` : detail}
      </p>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-3">
        {/* scaleX (compositor) em vez de width: animar a largura a cada leitura forçava layout e repintura contínuos. */}
        <div className="h-full w-full origin-left rounded-full bg-performance transition-transform duration-500 ease-out" style={{ transform: `scaleX(${state === 'unavailable' || pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100})` }} />
      </div>
    </div>
  )
}

const memoryUsedPct = (s: PerfSample | null) =>
  s?.memory.totalBytes && s.memory.availableBytes !== null ? Math.round(((s.memory.totalBytes - s.memory.availableBytes) / s.memory.totalBytes) * 100) : null

export function DashboardPage() {
  const { settings, executor, navigate } = useApp()
  const perf = usePerf(settings.metricsIntervalSeconds, 2)
  const sample = perf.sample
  const overview = useQuery<OverviewData>('optimizer.overview', { light: true })
  const staticInfo = useAsync(() => call(api.system.getStatic(false)))
  const changes = useAsync(() => ops.changes())

  const disks = staticInfo.data?.disks ?? []
  // Unidade do sistema (C:) quando existir; senão a mais cheia. Espaço de armazenamento, não atividade de leitura e gravação.
  const mainDisk = disks.find((d) => d.drive.toUpperCase().startsWith('C')) ?? [...disks].sort((a, b) => b.totalBytes - a.totalBytes)[0]
  const minDiskFreePct = disks.length ? Math.round(Math.min(...disks.filter((d) => d.totalBytes > 0).map((d) => (d.freeBytes / d.totalBytes) * 100))) : null

  // Avaliação do índice: ocorre quando as leituras do Windows chegam (abrir, Reavaliar) ou o executor muda de estado.
  // Memória comprometida e limite de desempenho usam a leitura de telemetria do instante da avaliação.
  const sampleRef = useRef<PerfSample | null>(null)
  sampleRef.current = sample
  const [evaluation, setEvaluation] = useState<{ at: number; index: ReturnType<typeof evaluateIndex> } | null>(null)
  const haveSample = sample !== null
  useEffect(() => {
    if (!overview.data || !staticInfo.data || !haveSample) return
    const s = sampleRef.current
    setEvaluation({
      at: Date.now(),
      index: evaluateIndex({
        powerPlan: overview.data.powerPlan ?? null,
        gameMode: overview.data.gameMode ?? null,
        startupEnabled: overview.data.startupEnabled ?? null,
        memoryCommitPct: s?.memory.commitPct ?? null,
        perfLimitPct: s?.cpu.performanceLimitPct ?? null,
        minDiskFreePct: Number.isFinite(minDiskFreePct) ? minDiskFreePct : null,
        executorReady: executor.state === 'ready'
      })
    })
    // minDiskFreePct deriva de staticInfo.data; a telemetria entra pelo sampleRef de propósito (não reavalia a cada leitura).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.data, staticInfo.data, haveSample, executor.state])

  const index = evaluation?.index
  const collecting = !index
  const recommendations = index?.criteria.filter((c) => c.state === 'fail' && c.recommendation) ?? []
  const recent = useMemo(() => [...(changes.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5), [changes.data])

  const reevaluate = () => {
    overview.reload()
    staticInfo.reload()
    changes.reload()
  }
  const openSection = () => () => navigate('fps')

  const live = sample !== null && !perf.stale
  const stateOf = (hasValue: boolean): 'live' | 'stale' | 'unavailable' => (!hasValue ? 'unavailable' : live ? 'live' : 'stale')
  const cpu = staticInfo.data?.cpus[0]
  const cpuPct = sample?.cpu.totalPct ?? null
  const memPct = memoryUsedPct(sample)
  const gpuPct = maxGpu(sample)
  const gpuName = staticInfo.data?.gpus.find((g) => !/basic (display|render)/i.test(g.name))?.name ?? staticInfo.data?.gpus[0]?.name
  const gpu0 = sample?.gpus[0]
  const nv = sample?.nvidia[0]
  const temps = temperatures(sample)
  const ready = executor.state === 'ready'

  return (
    <div className="space-y-5" data-dashboard>
      <section className="relative overflow-hidden rounded-[18px] border border-line-strong bg-bg" style={{ backgroundImage: 'radial-gradient(60% 120% at 82% 40%, rgb(var(--jk-accent-rgb) / 0.20), transparent 70%), linear-gradient(135deg, var(--jk-surface) 0%, var(--jk-bg) 70%)' }} data-hero>
        <div className="grid items-center md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="px-8 py-9">
            <p className="text-[12px] font-semibold tracking-[0.04em] text-performance">Bem-vindo ao</p>
            <h1 className="mt-1 text-[38px] leading-none font-black tracking-tight uppercase">
              <span className="bg-gradient-to-b from-accent-hi to-performance bg-clip-text text-transparent">JK</span>{' '}
              <span className="bg-gradient-to-b from-silver-hi to-silver bg-clip-text text-transparent">Optimize</span>
            </h1>
            <p className="mt-3 text-[14px] text-muted">Mais desempenho, sem limites.</p>
            <p className="mt-5 flex items-center gap-2 text-[12px] text-muted" data-status>
              <span className={cx('size-2.5 rounded-full', ready ? 'bg-optimize' : executor.state === 'starting' ? 'bg-alert' : 'bg-danger')} />
              {ready ? 'Executor ativo' : executor.state === 'starting' ? 'Executor iniciando' : 'Executor indisponível'}
              <span className="text-subtle">·</span>
              {perf.error ? 'Telemetria indisponível' : sample ? (perf.stale ? 'Telemetria sem atualização recente' : 'Telemetria em execução') : 'Aguardando a primeira leitura'}
            </p>
            <div className="z-20 mt-5 inline-flex items-center gap-3 rounded-[14px] border border-line bg-bg/70 p-2 pr-4 xl:absolute xl:top-4 xl:right-4 xl:mt-0" data-index>
              <IndexRing percent={collecting ? null : index.percent} passed={index?.passed ?? 0} evaluated={index?.evaluated ?? 0} />
              <div className="max-w-[150px]">
                <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">Otimização</p>
                <p className="text-[11.5px] leading-snug text-subtle">{collecting ? 'Avaliando critérios…' : index.percent === null ? 'Dados insuficientes' : `${index.passed} de ${index.evaluated} critérios atendidos`}</p>
              </div>
            </div>
          </div>
          <div className="relative flex justify-center px-4 pb-4 md:justify-end md:pr-8 md:pb-0 xl:pr-[260px]">
            <Emblem brand="emblem" alt="Emblema do JK Optimize" enter hover className="h-auto w-full max-w-[250px]" />
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Estado do sistema">
        <MetricCard
          icon={Cpu}
          label="CPU"
          value={cpuPct !== null ? `${Math.round(cpuPct)}%` : '—'}
          detail={[cpu?.name, cpu?.cores ? `${cpu.cores}N/${cpu.threads ?? cpu.cores}T` : null, sample?.cpu.effectiveMHz ? `${(sample.cpu.effectiveMHz / 1000).toFixed(2)} GHz` : null].filter(Boolean).join(' · ') || (staticInfo.loading ? 'Detectando…' : 'Processador não identificado')}
          pct={cpuPct}
          state={stateOf(cpuPct !== null)}
        />
        <MetricCard
          icon={MemoryStick}
          label="RAM"
          value={memPct !== null ? `${memPct}%` : '—'}
          detail={sample?.memory.totalBytes && sample.memory.availableBytes !== null ? `${formatBytes(sample.memory.totalBytes - sample.memory.availableBytes, 1)} em uso de ${formatBytes(sample.memory.totalBytes, 1)} (física)` : 'Indisponível'}
          pct={memPct}
          state={stateOf(memPct !== null)}
        />
        <MetricCard
          icon={CircuitBoard}
          label="GPU"
          value={gpuPct !== null ? `${Math.round(gpuPct)}%` : '—'}
          detail={
            gpuPct === null
              ? `${gpuName ?? 'GPU'} · uso sem fonte de dados`
              : [gpuName, gpu0?.dedicatedBytes ? `${formatBytes(gpu0.dedicatedBytes, 1)} de VRAM em uso` : null, nv?.temperatureC != null ? `${nv.temperatureC} °C` : temps.length ? null : 'temperatura sem sensor'].filter(Boolean).join(' · ')
          }
          pct={gpuPct}
          state={stateOf(gpuPct !== null)}
        />
        <MetricCard
          icon={HardDrive}
          label="Disco"
          value={mainDisk && mainDisk.totalBytes > 0 ? `${Math.round(((mainDisk.totalBytes - mainDisk.freeBytes) / mainDisk.totalBytes) * 100)}%` : '—'}
          detail={mainDisk && mainDisk.totalBytes > 0 ? `${mainDisk.drive} · ${formatBytes(mainDisk.freeBytes, 0)} livres de ${formatBytes(mainDisk.totalBytes, 0)} (espaço usado)` : staticInfo.loading ? 'Detectando…' : 'Indisponível'}
          pct={mainDisk && mainDisk.totalBytes > 0 ? ((mainDisk.totalBytes - mainDisk.freeBytes) / mainDisk.totalBytes) * 100 : null}
          state={mainDisk && mainDisk.totalBytes > 0 ? 'live' : 'unavailable'}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Recomendações" icon={Lightbulb} accent="performance">
          <div data-recommendations>
            {collecting ? (
              <Spinner label="Analisando…" />
            ) : recommendations.length === 0 ? (
              <p className="text-[12.5px] text-muted">{index.evaluated ? 'Nenhuma recomendação: todos os critérios avaliados foram atendidos.' : 'Sem dados suficientes para recomendar.'}</p>
            ) : (
              <ul className="space-y-3.5">
                {recommendations.map((c) => (
                  <li key={c.id} data-recommendation={c.id} className="text-[12.5px]">
                    <p className="text-fg">{c.recommendation}</p>
                    <p className="text-[11.5px] text-subtle">Origem: critério "{c.label}" — {c.detail}</p>
                    <button type="button" className="mt-1 flex items-center gap-1 text-[12px] text-performance hover:underline" onClick={openSection()}>
                      Abrir <ArrowRight className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Resultados recentes" icon={History} accent="performance">
          <div data-recent>
            {changes.loading && !changes.data ? (
              <Spinner />
            ) : recent.length === 0 ? (
              <p className="text-[12.5px] text-muted">Nenhuma alteração feita pelo JK Optimize neste computador ainda.</p>
            ) : (
              <ul className="space-y-2.5">
                {recent.map((r) => (
                  <li key={r.id} className="text-[12.5px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-fg" title={r.title}>
                        {r.title}
                      </span>
                      <Badge tone={CHANGE_STATUS[r.status].tone}>{CHANGE_STATUS[r.status].label}</Badge>
                    </div>
                    <p className="truncate text-[11px] text-subtle" title={r.summaryAfter}>
                      {formatDateTime(r.createdAt)} · {r.summaryAfter}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <Card
        title="Critérios de otimização"
        icon={ListChecks}
        accent="performance"
        action={
          <Button variant="ghost" icon={RefreshCw} onClick={reevaluate} loading={overview.loading || staticInfo.loading} data-reevaluate>
            Reavaliar
          </Button>
        }
      >
        <div data-index-detail>
          <p className="text-[13px] text-fg">
            {index && index.evaluated ? (
              <>
                <strong data-index-count>
                  {index.passed} de {index.evaluated}
                </strong>{' '}
                critérios atendidos{index.total > index.evaluated ? ` (${index.total - index.evaluated} sem dados, fora do cálculo)` : ''}
                {index.percent !== null ? ` = ${index.percent}%` : ''}
              </>
            ) : (
              'Coletando dados…'
            )}
          </p>
          <p className="mb-3 text-[11px] text-subtle" data-evaluated-at>
            Fórmula: critérios atendidos ÷ critérios avaliados (mínimo de {3} avaliados para exibir o percentual). Critério sem dado não conta como atendido. Não mede FPS nem ganho de velocidade.
            {evaluation ? ` Última verificação: ${new Date(evaluation.at).toLocaleTimeString('pt-BR')}.` : ''}
          </p>
          {collecting && <Spinner label="Consultando o Windows…" />}
          <ul className="grid gap-x-8 gap-y-2 md:grid-cols-2">
            {(index?.criteria ?? []).map((c: Criterion) => {
              const Icon = STATE_ICON[c.state]
              return (
                <li key={c.id} data-criterion={c.id} data-state={c.state} className="flex items-start gap-2 text-[12.5px]">
                  <Icon className={cx('mt-0.5 size-4 shrink-0', STATE_COLOR[c.state])} />
                  <span className="min-w-0">
                    <span className="block text-fg">{c.label}</span>
                    <span className="block truncate text-[11px] text-subtle" title={c.detail}>
                      {c.state === 'unknown' ? 'Indisponível: ' : ''}
                      {c.detail}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      </Card>

      <SocialPanel />
    </div>
  )
}
