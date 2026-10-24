// Processos: lista real do Windows com prioridade e encerramento confirmados pelo fluxo padrão de ações.
import { useState } from 'react'
import { Activity } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Button, PageHeader } from '../../components/ui'
import { DataTable, QueryView, RefreshButton } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'

interface Proc { pid: number; name: string; description: string | null; startTime: string | null; priority: string | null; workingSet: number; hasWindow: boolean; sameSession: boolean; critical: boolean; protectedReason: string | null }

const LEVELS: [string, string][] = [['Idle', 'Baixa'], ['BelowNormal', 'Abaixo do normal'], ['Normal', 'Normal'], ['AboveNormal', 'Acima do normal'], ['High', 'Alta']]

export function ProcessesPage() {
  const list = useQuery<Proc[]>('processes.list')
  const run = useAction()
  const [view, setView] = useState<'apps' | 'all'>('apps')
  const act = (id: string, p: Proc, extra: Record<string, string>) => {
    if (!p.startTime) return
    void run(id, { pid: p.pid, startTime: p.startTime, ...extra }).then(() => list.reload())
  }
  return (
    <>
      <PageHeader icon={Activity} accent="diagnostic" title="Processos" description="Processos reais do Windows. Prioridade vale só enquanto o processo estiver aberto; processos críticos são protegidos." action={<RefreshButton onClick={list.reload} loading={list.loading} />} />
      <div className="mb-3 flex gap-2">
        <Button variant={view === 'apps' ? 'primary' : 'secondary'} onClick={() => setView('apps')}>Aplicativos com janela</Button>
        <Button variant={view === 'all' ? 'primary' : 'secondary'} onClick={() => setView('all')}>Todos os processos</Button>
      </div>
      <QueryView state={list} loadingLabel="Lendo processos…">
        {(rows) => (
          <DataTable
            rows={rows.filter((p) => (view === 'all' ? true : p.hasWindow && p.sameSession))}
            rowKey={(p) => String(p.pid)}
            search={(p) => `${p.name} ${p.description ?? ''} ${p.pid}`}
            maxRows={400}
            initialSort={{ key: 'mem', desc: true }}
            columns={[
              { key: 'name', label: 'Nome', render: (p) => <span title={p.description ?? ''}>{p.name} {p.critical && <Badge tone="warn">Protegido</Badge>}</span>, sort: (p) => p.name },
              { key: 'pid', label: 'PID', render: (p) => p.pid, sort: (p) => p.pid },
              { key: 'mem', label: 'Memória', render: (p) => formatBytes(p.workingSet), sort: (p) => p.workingSet },
              {
                key: 'prio',
                label: 'Prioridade',
                render: (p) => (
                  <select aria-label={`Prioridade de ${p.name}`} disabled={!!p.protectedReason || p.priority === null} value={p.priority ?? ''} onChange={(e) => act('processes.priority', p, { level: e.target.value })} className="no-drag h-8 rounded-control border border-line-strong bg-elevated px-1.5 text-[12px] text-fg disabled:opacity-40">
                    {p.priority === null && <option value="">sem acesso</option>}
                    {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                )
              },
              {
                key: 'end',
                label: '',
                render: (p) => (
                  <Button variant="ghost" disabled={!!p.protectedReason || !p.sameSession} onClick={() => act('processes.end', p, { mode: 'close' })} title={p.protectedReason ?? 'Pede para o programa fechar (pode haver aviso de dados não salvos)'}>
                    Encerrar
                  </Button>
                )
              }
            ]}
          />
        )}
      </QueryView>
    </>
  )
}
