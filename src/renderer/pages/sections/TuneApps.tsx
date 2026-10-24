// Apps: otimização de programas já instalados (consumo, segundo plano, inicialização). O catálogo de downloads fica em Aplicativos.
import { useState } from 'react'
import { Boxes } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Button, Notice, PageHeader } from '../../components/ui'
import { DataTable, QueryView, RefreshButton, Tabs } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { usePerf } from '../../hooks/usePerf'
import { useQuery } from '../../hooks/useQuery'

type Tab = 'running' | 'background' | 'startup' | 'installed'

interface Proc { pid: number; name: string; description: string | null; startTime: string | null; workingSet: number; hasWindow: boolean; sameSession: boolean; critical: boolean; protectedReason: string | null }
interface Bg { pid: number; name: string; description: string | null; company: string | null; startTime: string | null; workingSet: number; startsWithWindows: { source: string; name: string; enabled: boolean; label: string } | null }
interface Startup { entries: { source: string; sourceLabel: string; name: string; publisher: string | null; enabled: boolean; needsAdmin: boolean }[] }
interface Installed { id: string; name: string; version: string | null; publisher: string | null; sizeBytes: number | null; installDate: string | null }

export function TuneAppsPage() {
  const [tab, setTab] = useState<Tab>('running')
  return (
    <>
      <PageHeader icon={Boxes} accent="optimize" title="Apps" description="Otimização dos programas instalados: consumo real, programas em segundo plano e inicialização com o Windows. Para baixar programas, use Extras → Aplicativos." />
      <Tabs value={tab} onChange={setTab} accent="optimize" tabs={[{ id: 'running', label: 'Em uso' }, { id: 'background', label: 'Segundo plano' }, { id: 'startup', label: 'Inicialização' }, { id: 'installed', label: 'Instalados' }]} />
      <div data-tune-tab={tab}>
        {tab === 'running' && <Running />}
        {tab === 'background' && <Background />}
        {tab === 'startup' && <StartupTab />}
        {tab === 'installed' && <InstalledTab />}
      </div>
    </>
  )
}

function Running() {
  const list = useQuery<Proc[]>('processes.list')
  const perf = usePerf(2)
  const run = useAction()
  const cpu = new Map((perf.sample?.topCpu ?? []).map((p) => [p.pid, p.cpuPct]))
  return (
    <QueryView state={list}>
      {(rows) => (
        <>
          <div className="mb-2 flex justify-end"><RefreshButton onClick={list.reload} loading={list.loading} /></div>
          <DataTable
            rows={rows.filter((p) => p.hasWindow && p.sameSession && !p.critical)}
            rowKey={(p) => String(p.pid)}
            search={(p) => `${p.name} ${p.description ?? ''}`}
            initialSort={{ key: 'mem', desc: true }}
            columns={[
              { key: 'name', label: 'Programa', render: (p) => p.description || p.name, sort: (p) => p.description || p.name },
              { key: 'mem', label: 'Memória', render: (p) => formatBytes(p.workingSet), sort: (p) => p.workingSet },
              { key: 'cpu', label: 'CPU', render: (p) => (cpu.has(p.pid) ? `${cpu.get(p.pid)!.toFixed(1)}%` : '—'), sort: (p) => cpu.get(p.pid) ?? -1 },
              { key: 'x', label: '', render: (p) => <Button variant="ghost" disabled={!p.startTime} onClick={() => void run('processes.end', { pid: p.pid, startTime: p.startTime, mode: 'close' }).then(list.reload)}>Fechar</Button> }
            ]}
          />
          <p className="mt-3 text-[12px] text-subtle">O fechamento pede ao programa para encerrar e avisa antes. Nada é encerrado sem a sua confirmação; confira gravações, transmissões e downloads antes.</p>
        </>
      )}
    </QueryView>
  )
}

function Background() {
  const list = useQuery<Bg[]>('apps.background')
  const run = useAction()
  return (
    <QueryView state={list} loadingLabel="Procurando programas sem janela…">
      {(rows) => (
        <>
          <div className="mb-2 flex justify-end"><RefreshButton onClick={list.reload} loading={list.loading} /></div>
          <DataTable
            rows={rows}
            rowKey={(p) => String(p.pid)}
            search={(p) => `${p.name} ${p.description ?? ''} ${p.company ?? ''}`}
            columns={[
              { key: 'name', label: 'Programa', render: (p) => <span title={p.description ?? ''}>{p.name}<span className="block text-[11px] text-subtle">{p.company ?? ''}</span></span>, sort: (p) => p.name },
              { key: 'mem', label: 'Memória', render: (p) => formatBytes(p.workingSet), sort: (p) => p.workingSet },
              { key: 'start', label: 'Inicia com o Windows', render: (p) => (p.startsWithWindows ? <Badge tone={p.startsWithWindows.enabled ? 'warn' : 'neutral'}>{p.startsWithWindows.enabled ? 'Sim' : 'Desativado'}</Badge> : <span className="text-subtle">não</span>) },
              { key: 'x', label: '', render: (p) => <Button variant="ghost" disabled={!p.startTime} onClick={() => void run('processes.end', { pid: p.pid, startTime: p.startTime, mode: 'close' }).then(list.reload)}>Encerrar</Button> }
            ]}
          />
        </>
      )}
    </QueryView>
  )
}

function StartupTab() {
  const list = useQuery<Startup>('startup.list')
  const run = useAction()
  return (
    <QueryView state={list}>
      {(d) => (
        <>
          <Notice tone="info">Desativar aqui altera só o estado “aprovado” da entrada (como o Gerenciador de Tarefas); o programa não é desinstalado e a mudança pode ser revertida no histórico.</Notice>
          <div className="mt-3" />
          <DataTable
            rows={d.entries}
            rowKey={(e) => `${e.source}:${e.name}`}
            search={(e) => `${e.name} ${e.publisher ?? ''}`}
            columns={[
              { key: 'name', label: 'Entrada', render: (e) => e.name, sort: (e) => e.name },
              { key: 'pub', label: 'Fabricante', render: (e) => e.publisher ?? '—' },
              { key: 'src', label: 'Origem', render: (e) => e.sourceLabel },
              { key: 'st', label: 'Estado', render: (e) => <Badge tone={e.enabled ? 'ok' : 'neutral'}>{e.enabled ? 'Ativada' : 'Desativada'}</Badge> },
              { key: 'x', label: '', render: (e) => <Button variant="ghost" onClick={() => void run('startup.toggle', { source: e.source, name: e.name, enabled: !e.enabled }).then(list.reload)}>{e.enabled ? 'Desativar' : 'Ativar'}{e.needsAdmin ? ' (admin)' : ''}</Button> }
            ]}
          />
        </>
      )}
    </QueryView>
  )
}

function InstalledTab() {
  const list = useQuery<Installed[]>('apps.installed')
  return (
    <QueryView state={list} loadingLabel="Lendo os programas instalados…">
      {(rows) => (
        <DataTable
          rows={rows}
          rowKey={(a) => a.id}
          search={(a) => `${a.name} ${a.publisher ?? ''}`}
          columns={[
            { key: 'name', label: 'Programa', render: (a) => a.name, sort: (a) => a.name },
            { key: 'ver', label: 'Versão', render: (a) => a.version ?? '—' },
            { key: 'pub', label: 'Fabricante', render: (a) => a.publisher ?? '—', sort: (a) => a.publisher ?? '' },
            { key: 'size', label: 'Tamanho', render: (a) => (a.sizeBytes ? formatBytes(a.sizeBytes) : '—'), sort: (a) => a.sizeBytes ?? 0 }
          ]}
        />
      )}
    </QueryView>
  )
}
