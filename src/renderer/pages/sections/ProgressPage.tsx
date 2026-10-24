// Progresso: operação em andamento (eventos reais das ações) e histórico de execuções com horário, duração e resultado.
import { useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import type { JobProgress, LogEntry } from '@shared/types/ops'
import { Badge, Card, PageHeader, ProgressBar } from '../../components/ui'
import { DataTable, QueryView, RefreshButton } from '../../components/kit'
import { useAsync } from '../../hooks/useAsync'
import { api } from '../../services/api'
import { ops } from '../../services/ops'

interface Live { jobId: string; message: string; done: number; total: number | null; at: number }

export function ProgressPage() {
  const [live, setLive] = useState<Record<string, Live>>({})
  const logs = useAsync(() => ops.logs({ fromDays: 14, limit: 300 }), [])
  useEffect(() => {
    return api.ops.onProgress((p: JobProgress) => {
      setLive((s) => ({ ...s, [p.jobId]: { jobId: p.jobId, message: p.message, done: p.done, total: p.total, at: Date.now() } }))
    })
  }, [])
  // Uma tarefa sem novas mensagens há 20 s deixa de ser mostrada como "em andamento".
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [])
  const active = Object.values(live).filter((j) => now - j.at < 20_000 && !(j.total != null && j.done >= j.total))
  const rows = (logs.data ?? []).filter((l) => l.actionId)
  return (
    <>
      <PageHeader icon={ListChecks} accent="performance" title="Progresso" description="Operações do JK Optimize: o que está rodando agora (progresso informado pela própria operação) e o histórico de execuções com resultado e duração." action={<RefreshButton onClick={logs.reload} loading={logs.loading} />} />
      <div className="space-y-4">
        <Card title="Em andamento" icon={ListChecks} accent="performance">
          {active.length === 0 ? (
            <p className="text-[13px] text-muted" data-progress-idle>Nenhuma operação em andamento.</p>
          ) : (
            <div className="space-y-3" data-progress-active>
              {active.map((j) => (
                <div key={j.jobId}>
                  <p className="mb-1 text-[12.5px] text-fg">{j.message}</p>
                  <ProgressBar value={j.total ? (j.done / j.total) * 100 : null} />
                  <p className="mt-1 text-[11.5px] text-subtle">{j.total ? `${j.done} de ${j.total} etapas` : 'Progresso indeterminado (a operação não informa o total)'}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[12px] text-subtle">As operações rodam no processo principal, fora da interface. Ajustes em lote mostram a tela de progresso própria enquanto executam; reinício, quando necessário, é sempre pedido a você e nunca automático.</p>
        </Card>
        <Card title="Histórico de execuções (últimos 14 dias)" icon={ListChecks} accent="diagnostic">
          <QueryView state={logs} empty={() => rows.length === 0}>
            {() => (
              <DataTable
                rows={rows}
                rowKey={(l: LogEntry) => `${l.ts}|${l.actionId}|${l.message.slice(0, 20)}`}
                search={(l) => `${l.actionId} ${l.message} ${l.module}`}
                maxRows={150}
                initialSort={{ key: 'ts', desc: true }}
                columns={[
                  { key: 'ts', label: 'Horário', render: (l) => new Date(l.ts).toLocaleString('pt-BR'), sort: (l) => l.ts },
                  { key: 'act', label: 'Operação', render: (l) => l.actionId, sort: (l) => l.actionId ?? '' },
                  { key: 'lvl', label: 'Resultado', render: (l) => <Badge tone={l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'ok'}>{l.level === 'error' ? 'Falha' : l.level === 'warn' ? 'Aviso' : 'Registro'}</Badge> },
                  { key: 'dur', label: 'Duração', render: (l) => (l.durationMs != null ? `${(l.durationMs / 1000).toFixed(1)} s` : '—'), sort: (l) => l.durationMs ?? -1 },
                  { key: 'msg', label: 'Detalhe', render: (l) => <span className="text-[12px] text-muted">{l.message}</span> }
                ]}
              />
            )}
          </QueryView>
        </Card>
      </div>
    </>
  )
}
