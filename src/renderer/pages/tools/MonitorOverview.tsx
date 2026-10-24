// Monitoramento geral: reúne em uma tela a telemetria que o app já coleta (amostrador único) e o
// estado de rede, energia, FiveM, Executor e resultados recentes. Métrica sem fonte = "Indisponível".
import { useMemo } from 'react'
import { formatBytes, formatDateTime } from '@shared/format'
import type { ChangeRecord } from '@shared/types/ops'
import { useApp } from '../../hooks/useApp'
import { useAsync } from '../../hooks/useAsync'
import { useQuery } from '../../hooks/useQuery'
import { temperatures, usePerf } from '../../hooks/usePerf'
import { api, call } from '../../services/api'
import { ops } from '../../services/ops'
import { Badge, Card, InfoRow, ProgressBar, Spinner, type Tone } from '../../components/ui'
import { RefreshButton, Unavailable } from '../../components/kit'

interface Adapters {
  adapters: { name: string; description: string | null; status: string; linkSpeed: string | null; virtual: boolean; receivedBytes: number | null; sentBytes: number | null; receiveErrors: number | null; sendErrors: number | null }[]
}
interface FivemDetect {
  fivem: { found: boolean }
  gta: { edition: string | null } | null
  processes: { name: string; pid: number }[]
}
interface Overview {
  powerPlan: string | null
  ultimateActive: boolean
  fivemFound: boolean
  gtaFound: boolean
  presentMon: boolean
  lastResults: Record<string, { ts: string; level: string; message: string }>
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v))
const Row = ({ label, value }: { label: string; value: React.ReactNode }) => <InfoRow label={label} value={value} />
const NA = <Unavailable>Indisponível</Unavailable>
const STATUS: Record<ChangeRecord['status'], { label: string; tone: Tone }> = {
  applied: { label: 'Aplicada', tone: 'ok' },
  reverted: { label: 'Revertida', tone: 'neutral' },
  'revert-failed': { label: 'Reversão falhou', tone: 'error' }
}

function Bar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-14 shrink-0 truncate text-subtle" title={label}>
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <ProgressBar value={value} accent="performance" />
      </div>
      <span className="w-9 shrink-0 text-right text-muted tabular-nums">{value === null ? '—' : `${Math.round(value)}%`}</span>
    </div>
  )
}

export function MonitorOverview() {
  const { settings, executor } = useApp()
  const { sample, error } = usePerf(settings.metricsIntervalSeconds, 2)
  const overview = useQuery<Overview>('optimizer.overview', { light: true })
  const fivem = useQuery<FivemDetect>('fivem.detect')
  const net = useQuery<Adapters>('network.adapters')
  const statics = useAsync(() => call(api.system.getStatic(false)))
  const changes = useAsync(() => ops.changes())
  const recent = useMemo(() => [...(changes.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5), [changes.data])
  const temps = temperatures(sample)
  const mem = sample?.memory
  const used = mem?.totalBytes && mem.availableBytes !== null ? mem.totalBytes - mem.availableBytes : null
  const running = (fivem.data?.processes ?? []).filter((p) => /^(fivem|gta5)/i.test(p.name))
  const refreshAll = () => {
    overview.reload()
    fivem.reload()
    net.reload()
    statics.reload()
    changes.reload()
  }

  return (
    <div className="space-y-4" data-monitor-overview>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted">Telemetria atualizada a cada {settings.metricsIntervalSeconds} s. Rede, energia, FiveM e armazenamento são lidos sob demanda.</p>
        <RefreshButton onClick={refreshAll} loading={overview.loading || net.loading} />
      </div>
      {error && <p className="text-[12px] text-danger">Telemetria indisponível: {error}</p>}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="CPU e processadores lógicos" data-mon="cpu">
          <Row label="Uso total" value={pct(sample?.cpu.totalPct) === null ? NA : `${pct(sample?.cpu.totalPct)}%`} />
          <Row label="Frequência efetiva / nominal" value={sample?.cpu.effectiveMHz && sample.cpu.nominalMHz ? `${Math.round(sample.cpu.effectiveMHz)} / ${Math.round(sample.cpu.nominalMHz)} MHz` : NA} />
          <Row label="Limite de desempenho" value={sample?.cpu.performanceLimitPct == null ? NA : sample.cpu.performanceLimitPct >= 100 ? 'Sem limitação' : `Limitado a ${Math.round(sample.cpu.performanceLimitPct)}%`} />
          <div className="mt-3 grid gap-1.5 sm:grid-cols-2">{sample?.cpu.perCore.length ? sample.cpu.perCore.map((c) => <Bar key={c.name} label={c.name} value={c.pct} />) : <Unavailable>Uso por processador indisponível</Unavailable>}</div>
        </Card>

        <Card title="GPU e memória gráfica" data-mon="gpu">
          {sample?.gpus.length ? (
            sample.gpus.map((g) => (
              <div key={g.luid} className="mb-3 last:mb-0">
                <Bar label={g.name ?? 'GPU'} value={g.utilizationPct} />
                <p className="mt-1 text-[11px] text-subtle">
                  VRAM dedicada {g.dedicatedBytes === null ? 'indisponível' : formatBytes(g.dedicatedBytes)} · compartilhada {g.sharedBytes === null ? 'indisponível' : formatBytes(g.sharedBytes)}
                </p>
              </div>
            ))
          ) : (
            <Unavailable>Contadores de GPU indisponíveis nesta amostra</Unavailable>
          )}
          {sample?.nvidia.map((n) => (
            <Row key={n.index} label={n.name} value={`${n.temperatureC ?? '—'} °C · ${n.memoryUsedMB ?? '—'}/${n.memoryTotalMB ?? '—'} MB`} />
          ))}
        </Card>

        <Card title="Memória RAM" data-mon="ram">
          <Row label="Em uso" value={used === null || !mem?.totalBytes ? NA : `${formatBytes(used)} de ${formatBytes(mem.totalBytes)} (${Math.round((used / mem.totalBytes) * 100)}%)`} />
          <Row label="Disponível" value={mem?.availableBytes == null ? NA : formatBytes(mem.availableBytes)} />
          <Row label="Memória comprometida" value={mem?.commitPct == null ? NA : `${mem.commitPct}%`} />
          <Row label="Páginas por segundo" value={mem?.pagesPerSec == null ? NA : Math.round(mem.pagesPerSec)} />
        </Card>

        <Card title="Temperaturas e frequências" data-mon="temp">
          {temps.length ? temps.map((t) => <Row key={t.label} label={`${t.label} · ${t.source}`} value={`${t.celsius} °C`} />) : <Unavailable>Este computador não expõe sensores de temperatura ao Windows.</Unavailable>}
        </Card>

        <Card title="Processos que mais usam" data-mon="processes">
          <p className="mb-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">CPU</p>
          {sample?.topCpu.length ? sample.topCpu.slice(0, 5).map((p) => <Row key={p.pid} label={p.name} value={`${p.cpuPct.toFixed(1)}%`} />) : NA}
          <p className="mt-3 mb-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">Memória</p>
          {sample?.topMemory.length ? sample.topMemory.slice(0, 5).map((p) => <Row key={p.pid} label={p.name} value={formatBytes(p.workingSetPrivate)} />) : NA}
        </Card>

        <Card title="Armazenamento" data-mon="storage">
          {statics.loading && !statics.data ? (
            <Spinner />
          ) : statics.data?.disks.length ? (
            statics.data.disks.map((d) => (
              <div key={d.drive} className="mb-2 last:mb-0">
                <Bar label={d.drive} value={d.totalBytes ? Math.round(((d.totalBytes - d.freeBytes) / d.totalBytes) * 100) : null} />
                <p className="text-[11px] text-subtle">
                  {formatBytes(d.freeBytes, 0)} livres de {formatBytes(d.totalBytes, 0)}
                  {d.fileSystem ? ` · ${d.fileSystem}` : ''}
                </p>
              </div>
            ))
          ) : (
            NA
          )}
        </Card>

        <Card title="Rede" data-mon="network">
          {net.loading && !net.data ? (
            <Spinner label="Lendo adaptadores…" />
          ) : net.error ? (
            <Unavailable>{net.error}</Unavailable>
          ) : net.data?.adapters.length ? (
            net.data.adapters
              .filter((a) => !a.virtual)
              .slice(0, 4)
              .map((a) => (
                <div key={a.name} className="mb-2 last:mb-0">
                  <div className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="truncate text-fg" title={a.description ?? a.name}>
                      {a.name}
                    </span>
                    <Badge tone={/up/i.test(a.status) ? 'ok' : 'neutral'}>{/up/i.test(a.status) ? 'Conectado' : a.status}</Badge>
                  </div>
                  <p className="text-[11px] text-subtle">
                    {a.linkSpeed ?? 'velocidade indisponível'} · ↓ {a.receivedBytes === null ? '—' : formatBytes(a.receivedBytes)} ↑ {a.sentBytes === null ? '—' : formatBytes(a.sentBytes)} (desde que o adaptador subiu)
                  </p>
                </div>
              ))
          ) : (
            NA
          )}
        </Card>

        <Card title="Energia, FiveM e Executor" data-mon="state">
          <Row label="Plano de energia" value={overview.data?.powerPlan ?? NA} />
          <Row label="FiveM" value={fivem.data ? (fivem.data.fivem.found ? (running.length ? `Em execução (${running.map((p) => p.name).join(', ')})` : 'Instalado, fechado') : 'Não encontrado') : NA} />
          <Row label="GTA V" value={fivem.data ? (fivem.data.gta ? `Encontrado${fivem.data.gta.edition ? ` (${fivem.data.gta.edition})` : ''}` : 'Não encontrado') : NA} />
          <Row label="PresentMon" value={overview.data ? (overview.data.presentMon ? 'Configurado' : 'Não configurado (sem FPS)') : NA} />
          <Row label="Executor" value={executor.state === 'ready' ? `Ativo${executor.pid ? ` (PID ${executor.pid})` : ''}${executor.elevated ? ' · administrador' : ''}` : executor.state === 'starting' ? 'Iniciando' : 'Indisponível'} />
        </Card>

        <Card title="Resultados recentes da otimização" data-mon="recent" className="xl:col-span-2">
          {changes.loading && !changes.data ? (
            <Spinner />
          ) : recent.length === 0 ? (
            <p className="text-[12.5px] text-muted">Nenhuma alteração feita pelo JK Optimize neste computador ainda.</p>
          ) : (
            <ul className="space-y-2">
              {recent.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 truncate text-fg" title={r.summaryAfter}>
                    {r.title} <span className="text-subtle">· {formatDateTime(r.createdAt)}</span>
                  </span>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
