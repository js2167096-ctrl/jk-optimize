// Deploy: componentes do Windows e debloat. Sempre item a item, com confirmação e informação de como reinstalar.
import { useState } from 'react'
import { PackageMinus } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Button, Notice, PageHeader } from '../../components/ui'
import { DataTable, QueryView, RefreshButton, Tabs } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'

type Tab = 'appx' | 'features' | 'programs'

interface Appx { name: string; fullName: string; version: string | null; publisher: string | null; kind: string; provisioned: boolean | null; removable: boolean; blockReason: string | null }
interface Feature { name: string; caption: string; enabled: boolean; protectedReason: string | null }
interface Program { id: string; name: string; version: string | null; publisher: string | null; sizeBytes: number | null; uninstallMethod: string }

export function DeployPage() {
  const [tab, setTab] = useState<Tab>('appx')
  return (
    <>
      <PageHeader icon={PackageMinus} accent="advanced" title="Deploy" description="Componentes e debloat: aplicativos pré-instalados, recursos opcionais do Windows e programas instalados. Cada remoção é individual, confirmada e registrada; componentes críticos são bloqueados." />
      <Tabs value={tab} onChange={setTab} accent="advanced" tabs={[{ id: 'appx', label: 'Aplicativos do Windows' }, { id: 'features', label: 'Recursos opcionais' }, { id: 'programs', label: 'Programas instalados' }]} />
      <div data-deploy-tab={tab}>
        {tab === 'appx' && <AppxTab />}
        {tab === 'features' && <FeaturesTab />}
        {tab === 'programs' && <ProgramsTab />}
      </div>
    </>
  )
}

function AppxTab() {
  const list = useQuery<{ packages: Appx[]; provisionedNote: string | null }>('apps.appx')
  const run = useAction()
  return (
    <QueryView state={list} loadingLabel="Lendo os pacotes do Windows…">
      {(d) => (
        <>
          <Notice tone="info">A remoção vale para o usuário atual. Para reinstalar, use a Microsoft Store (o JK Optimize não reinstala pacotes). {d.provisionedNote ?? ''}</Notice>
          <div className="mt-3 mb-2 flex justify-end"><RefreshButton onClick={list.reload} loading={list.loading} /></div>
          <DataTable
            rows={d.packages}
            rowKey={(p) => p.fullName}
            search={(p) => `${p.name} ${p.publisher ?? ''}`}
            columns={[
              { key: 'name', label: 'Pacote', render: (p) => <span title={p.fullName}>{p.name}<span className="block text-[11px] text-subtle">{p.publisher ?? ''} · {p.kind}</span></span>, sort: (p) => p.name },
              { key: 'ver', label: 'Versão', render: (p) => p.version ?? '—' },
              { key: 'state', label: 'Situação', render: (p) => (p.removable ? <Badge tone="ok">Removível</Badge> : <span title={p.blockReason ?? ''}><Badge tone="neutral">Protegido</Badge></span>) },
              { key: 'x', label: '', render: (p) => <Button variant="ghost" disabled={!p.removable} onClick={() => void run('apps.appx.remove', { fullName: p.fullName }).then(list.reload)}>Remover</Button> }
            ]}
          />
        </>
      )}
    </QueryView>
  )
}

function FeaturesTab() {
  const list = useQuery<Feature[]>('features.list')
  const run = useAction()
  return (
    <QueryView state={list} loadingLabel="Lendo os recursos opcionais…">
      {(rows) => (
        <>
          <Notice tone="info">Ativar ou desativar um recurso pede administrador e pode exigir reinício. É reversível: basta alternar de novo.</Notice>
          <div className="mt-3" />
          <DataTable
            rows={rows}
            rowKey={(f) => f.name}
            search={(f) => `${f.caption} ${f.name}`}
            columns={[
              { key: 'name', label: 'Recurso', render: (f) => <span>{f.caption}<span className="block text-[11px] text-subtle">{f.name}</span></span>, sort: (f) => f.caption },
              { key: 'st', label: 'Estado', render: (f) => <Badge tone={f.enabled ? 'ok' : 'neutral'}>{f.enabled ? 'Ativado' : 'Desativado'}</Badge>, sort: (f) => Number(f.enabled) },
              { key: 'x', label: '', render: (f) => <Button variant="ghost" disabled={!!f.protectedReason} title={f.protectedReason ?? undefined} onClick={() => void run('features.toggle', { name: f.name, enable: !f.enabled }).then(list.reload)}>{f.enabled ? 'Desativar' : 'Ativar'}</Button> }
            ]}
          />
        </>
      )}
    </QueryView>
  )
}

function ProgramsTab() {
  const list = useQuery<Program[]>('apps.installed')
  const run = useAction()
  return (
    <QueryView state={list} loadingLabel="Lendo os programas instalados…">
      {(rows) => (
        <>
          <Notice tone="info">A desinstalação abre o desinstalador oficial do próprio programa. Para reinstalar, use o instalador original ou a página Aplicativos.</Notice>
          <div className="mt-3" />
          <DataTable
            rows={rows}
            rowKey={(p) => p.id}
            search={(p) => `${p.name} ${p.publisher ?? ''}`}
            columns={[
              { key: 'name', label: 'Programa', render: (p) => p.name, sort: (p) => p.name },
              { key: 'ver', label: 'Versão', render: (p) => p.version ?? '—' },
              { key: 'pub', label: 'Fabricante', render: (p) => p.publisher ?? '—', sort: (p) => p.publisher ?? '' },
              { key: 'size', label: 'Tamanho', render: (p) => (p.sizeBytes ? formatBytes(p.sizeBytes) : '—'), sort: (p) => p.sizeBytes ?? 0 },
              { key: 'x', label: '', render: (p) => <Button variant="ghost" onClick={() => void run('apps.uninstall', { id: p.id })}>Desinstalar</Button> }
            ]}
          />
        </>
      )}
    </QueryView>
  )
}
