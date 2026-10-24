// Atualizações: pacotes com atualização pelo winget (um por vez, com confirmação) e informação de drivers com links oficiais.
import { useState } from 'react'
import { RefreshCcw } from 'lucide-react'
import { Badge, Button, Card, Notice, PageHeader, Spinner } from '../../components/ui'
import { DataTable, QueryView, Tabs } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'
import { query } from '../../services/ops'
import { errorMessage } from '../../services/api'

type Tab = 'software' | 'drivers'

interface Row { name: string; id: string; version: string; available: string; source: string }
interface Gpu { name: string; vendor: string; driverVersion: string | null; driverDate: string | null }
interface Driver { device: string; maker: string | null; version: string | null; date: string | null; class: string | null; signed: boolean | null }

const OFFICIAL: Record<string, { label: string; url: string }> = {
  nvidia: { label: 'Drivers NVIDIA', url: 'https://www.nvidia.com/Download/index.aspx' },
  amd: { label: 'Drivers AMD', url: 'https://www.amd.com/en/support' },
  intel: { label: 'Drivers Intel', url: 'https://www.intel.com/content/www/us/en/download-center/home.html' }
}

export function UpdatesPage() {
  const [tab, setTab] = useState<Tab>('software')
  return (
    <>
      <PageHeader icon={RefreshCcw} accent="diagnostic" title="Atualizações" description="Software pelo winget e informações de drivers. Nada é instalado sem confirmação, e drivers só são atualizados pelas páginas oficiais dos fabricantes." />
      <Tabs value={tab} onChange={setTab} accent="diagnostic" tabs={[{ id: 'software', label: 'Software (winget)' }, { id: 'drivers', label: 'Drivers' }]} />
      <div data-updates-tab={tab}>{tab === 'software' ? <Software /> : <Drivers />}</div>
    </>
  )
}

function Software() {
  const [data, setData] = useState<{ rows: Row[]; note: string | null; at: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = useAction()
  const check = () => {
    setBusy(true)
    setErr(null)
    query<{ rows: Row[]; note: string | null; at: string }>('updates.winget.list').then(setData).catch((e) => setErr(errorMessage(e))).finally(() => setBusy(false))
  }
  return (
    <Card title="Atualizações disponíveis" icon={RefreshCcw} accent="diagnostic" action={<Button variant="primary" onClick={check} loading={busy} data-winget-check>Verificar com o winget</Button>}>
      {busy && <Spinner label="Consultando o winget (pode levar alguns segundos)…" />}
      {err && <Notice tone="error" title="Não foi possível consultar o winget">{err}</Notice>}
      {!data && !busy && !err && <p className="text-[13px] text-subtle">A verificação só acontece quando você clica; nada é consultado em segundo plano.</p>}
      {data && (
        <div data-winget-result>
          {data.note && <Notice tone="info">{data.note}</Notice>}
          {data.rows.length > 0 && (
            <DataTable
              rows={data.rows}
              rowKey={(r) => r.id}
              search={(r) => `${r.name} ${r.id}`}
              columns={[
                { key: 'name', label: 'Programa', render: (r) => <span>{r.name}<span className="block text-[11px] text-subtle">{r.id}</span></span>, sort: (r) => r.name },
                { key: 'cur', label: 'Instalada', render: (r) => r.version },
                { key: 'new', label: 'Disponível', render: (r) => <Badge tone="info">{r.available}</Badge> },
                { key: 'x', label: '', render: (r) => <Button variant="ghost" onClick={() => void run('updates.winget.upgrade', { id: r.id }).then(check)}>Atualizar</Button> }
              ]}
            />
          )}
          <p className="mt-2 text-[12px] text-subtle">Origem: winget. Verificado em {new Date(data.at).toLocaleString('pt-BR')}. Ter uma versão nova não significa que a atualização é necessária.</p>
        </div>
      )}
    </Card>
  )
}

function Drivers() {
  const gpus = useQuery<{ gpus: Gpu[] }>('gpu.detect')
  const [drv, setDrv] = useState<Driver[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = () => {
    setBusy(true)
    setErr(null)
    query<{ drivers: Driver[] }>('windows.drivers').then((d) => setDrv(d.drivers)).catch((e) => setErr(errorMessage(e))).finally(() => setBusy(false))
  }
  return (
    <div className="space-y-4">
      <Card title="Placa de vídeo" icon={RefreshCcw} accent="diagnostic">
        <QueryView state={gpus}>
          {(d) => (
            <div className="space-y-2">
              {d.gpus.map((g) => {
                const o = OFFICIAL[g.vendor.toLowerCase()]
                return (
                  <div key={g.name} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line p-3 text-[13px]">
                    <span className="text-fg">{g.name}<span className="block text-[12px] text-muted">Driver {g.driverVersion ?? '—'}{g.driverDate ? ` · ${g.driverDate.slice(0, 10)}` : ''}</span></span>
                    {o ? <a className="no-drag text-performance hover:underline" href={o.url} target="_blank" rel="noreferrer">{o.label} (site oficial)</a> : <span className="text-subtle">Fabricante não identificado: procure no site do fabricante do computador.</span>}
                  </div>
                )
              })}
            </div>
          )}
        </QueryView>
        <p className="mt-3 text-[12px] text-subtle">O JK Optimize não baixa nem instala drivers: compare a versão acima com a do site oficial e instale por lá.</p>
      </Card>
      <Card title="Drivers instalados" icon={RefreshCcw} accent="diagnostic" action={<Button onClick={load} loading={busy} data-drivers-load>Ler drivers</Button>}>
        {busy && <Spinner label="Lendo os drivers assinados…" />}
        {err && <Notice tone="error" title="Não foi possível ler os drivers">{err}</Notice>}
        {drv && (
          <DataTable
            rows={drv}
            rowKey={(d) => `${d.device}|${d.version}`}
            search={(d) => `${d.device} ${d.maker ?? ''} ${d.class ?? ''}`}
            columns={[
              { key: 'dev', label: 'Dispositivo', render: (d) => d.device, sort: (d) => d.device },
              { key: 'cls', label: 'Classe', render: (d) => d.class ?? '—', sort: (d) => d.class ?? '' },
              { key: 'maker', label: 'Fabricante', render: (d) => d.maker ?? '—' },
              { key: 'ver', label: 'Versão', render: (d) => d.version ?? '—' },
              { key: 'date', label: 'Data', render: (d) => d.date?.slice(0, 10) ?? '—', sort: (d) => d.date ?? '' }
            ]}
          />
        )}
      </Card>
    </div>
  )
}
