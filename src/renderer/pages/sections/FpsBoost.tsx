// FPS Boost: CPU, GPU, energia e armazenamento com dados reais; os ajustes reutilizam o catálogo e as ações existentes.
import { useState } from 'react'
import { Cpu, HardDrive, MonitorPlay, Zap } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Button, Card, InfoRow, Notice, PageHeader, ProgressBar } from '../../components/ui'
import { DataTable, Metric, QueryView, Tabs } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { usePerf } from '../../hooks/usePerf'
import { useQuery } from '../../hooks/useQuery'
import { query } from '../../services/ops'
import { Windows2, PowerPlans, TweakPanel } from '../optimization/Windows2'

type Tab = 'cpu' | 'gpu' | 'storage' | 'power' | 'advanced'

interface CpuInfo { name: string; cores: number | null; threads: number; nominalMHz: number | null; reportedMHz: number | null }
interface Finding { severity: 'ok' | 'info' | 'warn'; title: string; evidence: string; recommendation: string | null }
interface Gpu { index: number; name: string; vendor: string; kind: string; driverVersion: string | null; driverDate: string | null; memoryBytes: number | null; status: string | null; resolution: string | null; panel: { name: string; id: string } | null }
interface Volume { letter: string; label: string; fs: string; size: number; free: number; media: string; op: string | null; opLabel: string }

const tone = (s: Finding['severity']) => (s === 'warn' ? 'warn' : s === 'ok' ? 'ok' : 'info')

export function FpsBoostPage() {
  const [tab, setTab] = useState<Tab>('cpu')
  return (
    <>
      <PageHeader icon={Zap} accent="performance" title="FPS Boost" description="CPU, GPU, energia e armazenamento: estado real, ajustes compatíveis e verificação depois de aplicar. Sem promessa de ganho fixo." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'cpu', label: 'CPU' }, { id: 'gpu', label: 'GPU' }, { id: 'storage', label: 'Armazenamento' }, { id: 'power', label: 'Energia' }, { id: 'advanced', label: 'Ajustes avançados' }]} />
      <div data-fps-tab={tab}>
        {tab === 'cpu' && <CpuTab />}
        {tab === 'gpu' && <GpuTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'power' && (
          <div className="space-y-4">
            <PowerPlans />
            <Card title="Parâmetros de energia e jogos" icon={Zap} accent="performance">
              <TweakPanel ids={['procMin', 'pcieAspm', 'usbSuspend', 'gameMode', 'hags']} />
            </Card>
          </div>
        )}
        {tab === 'advanced' && <Windows2 />}
      </div>
    </>
  )
}

function CpuTab() {
  const perf = usePerf(2)
  const info = useQuery<CpuInfo[]>('perf.cpu.info')
  const diag = useQuery<{ findings: Finding[]; power: { active: string | null } }>('perf.cpu.diagnostic')
  const s = perf.sample
  const cpu = info.data?.[0]
  const top = s?.topCpu ?? []
  return (
    <div className="space-y-4">
      <Card title="Processador" icon={Cpu} accent="performance">
        <QueryView state={info}>
          {() => (
            <div className="grid gap-4 md:grid-cols-4">
              <Metric label="Modelo" value={cpu?.name ?? '—'} hint={cpu ? `${cpu.cores ?? '?'} núcleos · ${cpu.threads} threads` : undefined} />
              <Metric label="Uso total" value={s?.cpu.totalPct != null ? `${Math.round(s.cpu.totalPct)}%` : '—'} hint="Contador do Windows" />
              <Metric label="Frequência efetiva" value={s?.cpu.effectiveMHz ? `${Math.round(s.cpu.effectiveMHz)} MHz` : cpu?.reportedMHz ? `${cpu.reportedMHz} MHz (reportada)` : '—'} hint={s?.cpu.nominalMHz ? `Nominal ${Math.round(s.cpu.nominalMHz)} MHz` : undefined} />
              <Metric label="Limitação de desempenho" value={s?.cpu.performanceLimitPct != null ? (s.cpu.performanceLimitPct < 100 ? `${Math.round(s.cpu.performanceLimitPct)}%` : 'Nenhuma') : '—'} hint="< 100% indica limite por energia ou temperatura" />
            </div>
          )}
        </QueryView>
        {s && s.cpu.perCore.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4" data-cpu-cores>
            {s.cpu.perCore.map((c) => (
              <div key={c.name}>
                <p className="mb-1 flex justify-between text-[11.5px] text-subtle"><span>Processador lógico {c.name}</span><span className="tabular-nums">{Math.round(c.pct)}%</span></p>
                <ProgressBar value={c.pct} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="Diagnóstico de energia e CPU" icon={Zap} accent="performance">
        <QueryView state={diag}>
          {(d) => (
            <div className="space-y-2.5">
              <InfoRow label="Plano de energia ativo" value={d.power.active ?? '—'} />
              {d.findings.map((f, i) => (
                <div key={i} className="rounded-control border border-line p-3 text-[12.5px]">
                  <p className="flex items-center gap-2 font-medium text-fg"><Badge tone={tone(f.severity)}>{f.severity === 'warn' ? 'Atenção' : f.severity === 'ok' ? 'Ok' : 'Info'}</Badge>{f.title}</p>
                  <p className="mt-1 text-muted">{f.evidence}</p>
                  {f.recommendation && <p className="mt-1 text-subtle">{f.recommendation}</p>}
                </div>
              ))}
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="Maiores consumidores de CPU" icon={Cpu} accent="diagnostic">
        {top.length === 0 ? (
          <p className="text-[13px] text-subtle">Aguardando a leitura de processos da telemetria.</p>
        ) : (
          <DataTable
            rows={top}
            rowKey={(p) => String(p.pid)}
            columns={[
              { key: 'name', label: 'Processo', render: (p) => p.name, sort: (p) => p.name },
              { key: 'pid', label: 'PID', render: (p) => p.pid, sort: (p) => p.pid },
              { key: 'cpu', label: 'CPU', render: (p) => `${p.cpuPct.toFixed(1)}%`, sort: (p) => p.cpuPct },
              { key: 'mem', label: 'Memória', render: (p) => formatBytes(p.workingSetPrivate), sort: (p) => p.workingSetPrivate }
            ]}
            initialSort={{ key: 'cpu', desc: true }}
          />
        )}
        <p className="mt-3 text-[12px] text-subtle">A prioridade de um processo é alterada na página Processos, com confirmação e verificação depois. Nenhuma voltagem, frequência ou overclock é alterado.</p>
      </Card>
    </div>
  )
}

function GpuTab() {
  const gpus = useQuery<{ gpus: Gpu[]; error: string | null }>('gpu.detect')
  const perf = usePerf(2)
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <QueryView state={gpus} loadingLabel="Detectando adaptadores gráficos…">
        {(d) => (
          <>
            {d.error && <Notice tone="warn" title="Detecção parcial">{d.error}</Notice>}
            {d.gpus.length === 0 && <Notice tone="warn" title="Nenhum adaptador detectado">O Windows não informou adaptadores gráficos.</Notice>}
            {d.gpus.map((g) => {
              const live = perf.sample?.gpus.length === 1 ? perf.sample.gpus[0] : perf.sample?.gpus.find((x) => x.name && g.name.toLowerCase().includes(x.name.toLowerCase().slice(0, 8)))
              return (
                <Card
                  key={g.index}
                  title={g.name}
                  icon={MonitorPlay}
                  accent="advanced"
                  action={g.panel ? <Button onClick={() => void query('gpu.panel.open', { id: g.panel!.id }).catch((e) => setMsg(String(e.message ?? e)))} data-gpu-panel>Abrir {g.panel.name}</Button> : undefined}
                >
                  <div className="grid gap-x-8 md:grid-cols-2">
                    <InfoRow label="Fabricante" value={g.vendor} />
                    <InfoRow label="Tipo" value={g.kind === 'integrated' ? 'Integrada' : g.kind === 'dedicated' ? 'Dedicada' : 'Não identificado'} />
                    <InfoRow label="Driver" value={g.driverVersion ? `${g.driverVersion}${g.driverDate ? ` (${g.driverDate.slice(0, 10)})` : ''}` : '—'} />
                    <InfoRow label="Memória de vídeo" value={g.memoryBytes ? formatBytes(g.memoryBytes) : '—'} />
                    <InfoRow label="Resolução atual" value={g.resolution ?? '—'} />
                    <InfoRow label="Estado" value={g.status ?? '—'} />
                    <InfoRow label="Uso atual (telemetria)" value={live ? `${Math.round(live.utilizationPct)}%` : 'indisponível'} />
                  </div>
                  {!g.panel && <p className="mt-2 text-[12px] text-subtle">Painel oficial do fabricante não encontrado neste computador.</p>}
                </Card>
              )
            })}
          </>
        )}
      </QueryView>
      {msg && <Notice tone="error" title="Não foi possível abrir o painel">{msg}</Notice>}
      <Card title="Ajustes gráficos do Windows" icon={MonitorPlay} accent="advanced">
        <TweakPanel ids={['hags', 'gameMode', 'gameDvr', 'appCapture']} />
        <p className="mt-3 text-[12px] text-subtle">Somente ajustes do Windows. Ajustes específicos de fabricante ficam no painel oficial dele, mostrado apenas quando detectado.</p>
      </Card>
    </div>
  )
}

function StorageTab() {
  const vols = useQuery<Volume[]>('disk.volumes')
  const disks = useQuery<{ disks: { id: string; name: string; media: string | null; bus: string | null; health: string | null; sizeBytes: number | null; reliability: { temperatureC: number | null; wearPct: number | null; powerOnHours: number | null } | null }[]; smartError: string | null }>('windows.disks')
  const run = useAction()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  return (
    <div className="space-y-4">
      <Card
        title="Volumes"
        icon={HardDrive}
        accent="optimize"
        action={<Button variant="primary" disabled={picked.size === 0} onClick={() => void run('disk.optimize', { drives: [...picked] }).then(() => vols.reload())} data-disk-optimize>Otimizar selecionados ({picked.size})</Button>}
      >
        <QueryView state={vols}>
          {(list) => (
            <div className="space-y-3">
              {list.map((v) => {
                const usedPct = v.size ? ((v.size - v.free) / v.size) * 100 : 0
                return (
                  <div key={v.letter} className="rounded-control border border-line p-3" data-volume={v.letter}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-[13px] text-fg">
                        <input type="checkbox" className="size-4" disabled={!v.op} checked={picked.has(v.letter)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(v.letter); else n.delete(v.letter); return n })} aria-label={`Selecionar ${v.letter}:`} />
                        {v.letter}: {v.label && `(${v.label})`} · {v.fs} · {v.media || 'tipo desconhecido'}
                      </label>
                      <Badge tone={v.op ? 'info' : 'neutral'}>{v.op ? v.opLabel : 'Sem otimização suportada'}</Badge>
                    </div>
                    <p className="mt-1.5 text-[12px] text-muted">{formatBytes(v.free)} livres de {formatBytes(v.size)} ({usedPct.toFixed(0)}% usado)</p>
                    <ProgressBar value={usedPct} accent={usedPct > 90 ? 'alert' : 'optimize'} />
                    {v.size > 0 && v.free / v.size < 0.1 && <p className="mt-1.5 text-[12px] text-alert">Espaço livre abaixo de 10%: libere espaço na página Limpeza antes de otimizar.</p>}
                  </div>
                )
              })}
              <p className="text-[12px] text-subtle">SSD recebe TRIM (ReTrim); HDD recebe desfragmentação; mídia desconhecida não é otimizada. A operação pede administrador e não tem reversão.</p>
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="Unidades físicas e saúde" icon={HardDrive} accent="diagnostic">
        <QueryView state={disks}>
          {(d) => (
            <div className="space-y-2">
              {d.disks.map((x) => (
                <div key={x.id} className="rounded-control border border-line p-3 text-[12.5px]">
                  <p className="font-medium text-fg">{x.name} · {x.media ?? 'tipo ?'} · {x.bus ?? 'barramento ?'} · {x.sizeBytes ? formatBytes(x.sizeBytes) : '—'}</p>
                  <p className="text-muted">Saúde: {x.health ?? 'indisponível'}{x.reliability?.temperatureC ? ` · ${x.reliability.temperatureC} °C` : ''}{x.reliability?.wearPct != null ? ` · desgaste ${x.reliability.wearPct}%` : ''}{x.reliability?.powerOnHours != null ? ` · ${x.reliability.powerOnHours} h ligado` : ''}</p>
                </div>
              ))}
              {d.smartError && <p className="text-[12px] text-subtle">SMART: {d.smartError}</p>}
            </div>
          )}
        </QueryView>
      </Card>
    </div>
  )
}
