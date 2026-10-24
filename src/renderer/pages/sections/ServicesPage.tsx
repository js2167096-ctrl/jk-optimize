// Serviços: lista real (Get-CimInstance Win32_Service), com iniciar/parar/reiniciar e tipo de inicialização via ações com backup.
import { useMemo, useState } from 'react'
import { ServerCog } from 'lucide-react'
import { Badge, Button, PageHeader } from '../../components/ui'
import { DataTable, QueryView, RefreshButton } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'

interface Svc { name: string; displayName: string; state: string; startMode: string; delayed: boolean; description: string | null; dependents: string[]; category: 'essential' | 'windows' | 'third-party'; protectedReason: string | null; modifiable: boolean }

const MODES: [string, string][] = [['Automatic', 'Automático'], ['AutomaticDelayed', 'Automático (atrasado)'], ['Manual', 'Manual'], ['Disabled', 'Desativado']]
const modeOf = (s: Svc) => (s.startMode === 'Auto' ? (s.delayed ? 'AutomaticDelayed' : 'Automatic') : s.startMode === 'Disabled' ? 'Disabled' : 'Manual')

export function ServicesPage() {
  const list = useQuery<Svc[]>('services.list')
  const run = useAction()
  const [filter, setFilter] = useState<'all' | 'running' | 'stopped' | 'third-party' | 'modifiable'>('all')
  const rows = useMemo(
    () =>
      (list.data ?? []).filter((s) => (filter === 'running' ? s.state === 'Running' : filter === 'stopped' ? s.state === 'Stopped' : filter === 'third-party' ? s.category === 'third-party' : filter === 'modifiable' ? s.modifiable : true)),
    [list.data, filter]
  )
  const reload = () => list.reload()
  return (
    <>
      <PageHeader icon={ServerCog} accent="advanced" title="Serviços" description="Serviços reais do Windows. Serviços essenciais, de segurança e protegidos não podem ser alterados; cada mudança pede administrador, tem backup e é conferida depois." action={<RefreshButton onClick={reload} loading={list.loading} />} />
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filtros de serviços">
        {([['all', 'Todos'], ['running', 'Em execução'], ['stopped', 'Parados'], ['third-party', 'De terceiros'], ['modifiable', 'Modificáveis']] as const).map(([id, label]) => (
          <button key={id} type="button" data-svc-filter={id} aria-pressed={filter === id} onClick={() => setFilter(id)} className={`no-drag h-8 rounded-full border px-3 text-[12px] ${filter === id ? 'border-performance/50 bg-performance/15 text-fg' : 'border-line-strong text-muted hover:text-fg'}`}>
            {label}
          </button>
        ))}
      </div>
      <QueryView state={list} loadingLabel="Lendo os serviços do Windows…">
        {() => (
          <DataTable
            rows={rows}
            rowKey={(s) => s.name}
            search={(s) => `${s.name} ${s.displayName} ${s.description ?? ''}`}
            maxRows={250}
            columns={[
              { key: 'name', label: 'Serviço', render: (s) => <span title={s.description ?? ''}>{s.displayName}<span className="block text-[11px] text-subtle">{s.name}</span></span>, sort: (s) => s.displayName },
              { key: 'state', label: 'Estado', render: (s) => <Badge tone={s.state === 'Running' ? 'ok' : 'neutral'}>{s.state === 'Running' ? 'Em execução' : s.state === 'Stopped' ? 'Parado' : s.state}</Badge>, sort: (s) => s.state },
              {
                key: 'mode',
                label: 'Inicialização',
                render: (s) => (
                  <select aria-label={`Inicialização de ${s.displayName}`} disabled={!s.modifiable} title={s.protectedReason ?? undefined} value={modeOf(s)} onChange={(e) => void run('services.configure', { name: s.name, mode: e.target.value, stop: false, restorePoint: false }).then(reload)} className="no-drag h-8 rounded-control border border-line-strong bg-elevated px-1.5 text-[12px] text-fg disabled:opacity-40">
                    {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ),
                sort: (s) => s.startMode
              },
              {
                key: 'ctl',
                label: '',
                render: (s) => (
                  <div className="flex gap-1">
                    <Button variant="ghost" disabled={!s.modifiable || s.state === 'Running'} onClick={() => void run('services.control', { name: s.name, op: 'start' }).then(reload)}>Iniciar</Button>
                    <Button variant="ghost" disabled={!s.modifiable || s.state !== 'Running'} onClick={() => void run('services.control', { name: s.name, op: 'stop' }).then(reload)}>Parar</Button>
                    <Button variant="ghost" disabled={!s.modifiable || s.state !== 'Running'} onClick={() => void run('services.control', { name: s.name, op: 'restart' }).then(reload)}>Reiniciar</Button>
                  </div>
                )
              }
            ]}
          />
        )}
      </QueryView>
    </>
  )
}
