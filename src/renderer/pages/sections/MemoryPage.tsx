// Memória: valores reais do contador do Windows, processos que mais consomem e fechamento seletivo com medição depois.
import { useState } from 'react'
import { MemoryStick } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Button, Card, Notice, PageHeader, ProgressBar } from '../../components/ui'
import { DataTable, Metric, QueryView, RefreshButton } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { usePerf } from '../../hooks/usePerf'
import { useQuery } from '../../hooks/useQuery'

interface RamApp { pid: number; name: string; description: string | null; startTime: string; hasWindow: boolean; workingSet: number; privateWorkingSet: number | null }
interface RamStatus { pressure: { level: string; recommendClosing: boolean; reason: string }; apps: RamApp[]; notes: string[] }

export function MemoryPage() {
  const perf = usePerf(2)
  const ram = useQuery<RamStatus>('ram.status')
  const run = useAction()
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [result, setResult] = useState<string | null>(null)
  const m = perf.sample?.memory
  const used = m?.totalBytes != null && m.availableBytes != null ? m.totalBytes - m.availableBytes : null
  const usedPct = used != null && m?.totalBytes ? (used / m.totalBytes) * 100 : null
  const cpuByPid = new Map((perf.sample?.topCpu ?? []).map((p) => [p.pid, p.cpuPct]))

  const close = async (force: boolean) => {
    const targets = (ram.data?.apps ?? []).filter((a) => picked.has(a.pid)).map((a) => ({ pid: a.pid, startTime: a.startTime }))
    const before = m?.availableBytes ?? null
    setResult(null)
    const outcome = await run('ram.closeApps', { targets, force })
    if (!outcome) return
    setPicked(new Set())
    await new Promise((r) => setTimeout(r, 2500))
    ram.reload()
    const after = perf.sample?.memory.availableBytes ?? null
    setResult(`${outcome.summary} Memória disponível: ${before != null ? formatBytes(before) : '—'} → ${after != null ? formatBytes(after) : '—'} (leituras reais do Windows; a diferença pode incluir outras atividades do sistema).`)
  }

  return (
    <>
      <PageHeader icon={MemoryStick} accent="diagnostic" title="Memória" description="Uso real de RAM, memória comprometida e processos que mais consomem. Nada é “liberado” sem medição, e caches úteis não são esvaziados." action={<RefreshButton onClick={ram.reload} loading={ram.loading} />} />
      <div className="space-y-4">
        <Card title="Estado atual" icon={MemoryStick} accent="diagnostic">
          <div className="grid gap-4 md:grid-cols-4" data-memory-metrics>
            <Metric label="RAM total" value={m?.totalBytes ? formatBytes(m.totalBytes) : '—'} />
            <Metric label="Em uso" value={used != null ? formatBytes(used) : '—'} hint={usedPct != null ? `${usedPct.toFixed(0)}% do total` : undefined} />
            <Metric label="Disponível" value={m?.availableBytes != null ? formatBytes(m.availableBytes) : '—'} hint="Livre + cache em espera" />
            <Metric label="Comprometida" value={m?.committedBytes != null ? formatBytes(m.committedBytes) : '—'} hint={m?.commitPct != null ? `${m.commitPct.toFixed(0)}% do limite` : undefined} />
          </div>
          {usedPct != null && <div className="mt-4"><ProgressBar value={usedPct} accent={usedPct > 85 ? 'alert' : 'diagnostic'} /></div>}
          <QueryView state={ram}>{(r) => <p className="mt-3 text-[12.5px] text-muted"><Badge tone={r.pressure.recommendClosing ? 'warn' : 'info'}>{r.pressure.level}</Badge> {r.pressure.reason}</p>}</QueryView>
        </Card>
        <Card
          title="Aplicativos que mais consomem"
          icon={MemoryStick}
          accent="optimize"
          action={
            <div className="flex gap-2">
              <Button disabled={picked.size === 0} onClick={() => void close(false)} data-ram-close>Fechar com aviso ({picked.size})</Button>
              <Button variant="ghost" disabled={picked.size === 0} onClick={() => void close(true)} data-ram-force>Forçar fechamento</Button>
            </div>
          }
        >
          <QueryView state={ram}>
            {(r) => (
              <>
                <DataTable
                  rows={r.apps}
                  rowKey={(a) => String(a.pid)}
                  search={(a) => `${a.name} ${a.description ?? ''}`}
                  initialSort={{ key: 'mem', desc: true }}
                  columns={[
                    { key: 'pick', label: '', render: (a) => <input type="checkbox" className="size-4" checked={picked.has(a.pid)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(a.pid); else n.delete(a.pid); return n })} aria-label={`Selecionar ${a.name}`} data-ram-pick={a.pid} /> },
                    { key: 'name', label: 'Aplicativo', render: (a) => <span title={a.description ?? ''}>{a.name}{a.hasWindow ? '' : ' (sem janela)'}</span>, sort: (a) => a.name },
                    { key: 'pid', label: 'PID', render: (a) => a.pid, sort: (a) => a.pid },
                    { key: 'mem', label: 'Memória privada', render: (a) => formatBytes(a.privateWorkingSet ?? a.workingSet), sort: (a) => a.privateWorkingSet ?? a.workingSet },
                    { key: 'cpu', label: 'CPU', render: (a) => (cpuByPid.has(a.pid) ? `${cpuByPid.get(a.pid)!.toFixed(1)}%` : '—'), sort: (a) => cpuByPid.get(a.pid) ?? -1 }
                  ]}
                />
                {r.notes.map((n) => <p key={n} className="mt-2 text-[12px] text-subtle">{n}</p>)}
              </>
            )}
          </QueryView>
          <p className="mt-3 text-[12px] text-subtle">Programas com trabalho em andamento (gravação, transmissão, download, documento aberto) podem perder dados ao fechar: confira antes. Processos críticos e de outras sessões nunca aparecem aqui.</p>
        </Card>
        {result && <Notice tone="info" title="Resultado medido">{result}</Notice>}
      </div>
    </>
  )
}
