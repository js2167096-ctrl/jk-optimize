// Redes: adaptadores, DNS atual, comparação real de provedores (várias amostras), troca com backup e latência separada do DNS.
import { useState } from 'react'
import { Wifi } from 'lucide-react'
import { Badge, Button, Card, InfoRow, Notice, PageHeader, Spinner } from '../../components/ui'
import { QueryView, RefreshButton, Tabs } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'
import { query } from '../../services/ops'
import { errorMessage } from '../../services/api'

type Tab = 'overview' | 'dns' | 'latency'

interface Adapter { name: string; description: string | null; status: string; linkSpeed: string | null; virtual: boolean; ipv4: string[]; gateway: string[]; dns: string[] }
interface Conn { gateway: string | null; gatewayMs: number | null; gatewayLoss: number | null; internetMs: number | null; internetLoss: number | null; dnsOk: boolean; dnsMs: number | null }
interface DnsRes { id: string; label: string; server: string; ok: number; fail: number; median: number | null; min: number | null; max: number | null; avg: number | null }
interface DnsCmp { results: DnsRes[]; samplesPerServer: number; note: string; at: string }
interface LatencyReport { host: string; stats: { avgMs: number | null; minMs: number | null; maxMs: number | null; jitterMs: number | null; timeoutPct: number; sent: number } }

const PROVIDERS: [string, string][] = [['cloudflare', 'Cloudflare'], ['google', 'Google Public DNS'], ['quad9', 'Quad9'], ['opendns', 'OpenDNS']]
const ms = (v: number | null) => (v == null ? '—' : `${v} ms`)

export function NetworkPage() {
  const [tab, setTab] = useState<Tab>('overview')
  return (
    <>
      <PageHeader icon={Wifi} accent="diagnostic" title="Redes" description="Adaptadores, DNS e conectividade com medições reais. Latência de DNS (resolução de nomes) é diferente do ping até o servidor do jogo, e nenhuma redução de ping é prometida." />
      <Tabs value={tab} onChange={setTab} accent="diagnostic" tabs={[{ id: 'overview', label: 'Adaptadores e diagnóstico' }, { id: 'dns', label: 'DNS' }, { id: 'latency', label: 'Latência até um servidor' }]} />
      <div data-net-tab={tab}>
        {tab === 'overview' && <Overview />}
        {tab === 'dns' && <Dns />}
        {tab === 'latency' && <Latency />}
      </div>
    </>
  )
}

function Overview() {
  const ad = useQuery<{ adapters: Adapter[]; errors: string[] }>('network.adapters')
  const [conn, setConn] = useState<Conn | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const test = () => {
    setBusy(true)
    setErr(null)
    query<Conn>('network.connectivity').then(setConn).catch((e) => setErr(errorMessage(e))).finally(() => setBusy(false))
  }
  return (
    <div className="space-y-4">
      <Card title="Adaptadores" icon={Wifi} accent="diagnostic" action={<RefreshButton onClick={ad.reload} loading={ad.loading} />}>
        <QueryView state={ad}>
          {(d) => (
            <div className="space-y-2">
              {d.adapters.map((a) => (
                <div key={a.name} className="rounded-control border border-line p-3 text-[12.5px]" data-adapter={a.name}>
                  <p className="flex items-center gap-2 font-medium text-fg">{a.name} <Badge tone={a.status === 'Up' ? 'ok' : 'neutral'}>{a.status === 'Up' ? 'Conectado' : a.status}</Badge>{a.virtual && <Badge>Virtual</Badge>}</p>
                  <p className="text-muted">{a.description} · {a.linkSpeed ?? 'velocidade ?'}</p>
                  <p className="text-muted">IPv4 {a.ipv4.join(', ') || '—'} · Gateway {a.gateway.join(', ') || '—'} · DNS {a.dns.join(', ') || '—'}</p>
                </div>
              ))}
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="Diagnóstico básico de conectividade" icon={Wifi} accent="optimize" action={<Button variant="primary" onClick={test} loading={busy} data-net-test>Executar diagnóstico</Button>}>
        {busy && <Spinner label="Medindo gateway, internet e DNS…" />}
        {err && <Notice tone="error" title="O diagnóstico falhou">{err}</Notice>}
        {conn && (
          <div data-net-result>
            <InfoRow label={`Gateway${conn.gateway ? ` (${conn.gateway})`: ''}`} value={conn.gateway ? `${ms(conn.gatewayMs)} · perda ${conn.gatewayLoss ?? '—'}%` : 'não encontrado'} />
            <InfoRow label="Internet (1.1.1.1, 4 pacotes)" value={`${ms(conn.internetMs)} · perda ${conn.internetLoss ?? '—'}%`} />
            <InfoRow label="Resolução de nomes (DNS)" value={conn.dnsOk ? `Funcionando · ${ms(conn.dnsMs)}` : <Badge tone="error">Falhou</Badge>} />
            <p className="mt-2 text-[12px] text-subtle">{conn.internetLoss === 100 ? 'Sem resposta ao ping: pode ser bloqueio de ICMP ou ausência de internet.' : conn.dnsOk ? 'A conexão responde; para diferenciar causas de lentidão, compare gateway × internet.' : 'Há resposta de rede, mas o DNS falhou: tente outro servidor na aba DNS.'}</p>
          </div>
        )}
      </Card>
    </div>
  )
}

function Dns() {
  const ad = useQuery<{ adapters: Adapter[] }>('network.adapters')
  const run = useAction()
  const [cmp, setCmp] = useState<DnsCmp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [alias, setAlias] = useState('')
  const usable = (ad.data?.adapters ?? []).filter((a) => a.status === 'Up' && !a.virtual)
  const chosen = alias || usable[0]?.name || ''
  const measure = () => {
    setBusy(true)
    setErr(null)
    query<DnsCmp>('network.dns.compare', { rounds: 3 }).then(setCmp).catch((e) => setErr(errorMessage(e))).finally(() => setBusy(false))
  }
  const best = cmp ? [...cmp.results].filter((r) => r.median != null).sort((a, b) => (a.median as number) - (b.median as number))[0] : null
  return (
    <div className="space-y-4">
      <Card title="Comparar servidores DNS" icon={Wifi} accent="optimize" action={<Button variant="primary" onClick={measure} loading={busy} data-dns-compare>Medir agora</Button>}>
        {busy && <Spinner label="Resolvendo nomes em cada servidor (pode levar até 1 minuto)…" />}
        {err && <Notice tone="error" title="A medição falhou">{err}</Notice>}
        {cmp && (
          <div data-dns-result>
            <table className="w-full text-[12.5px]">
              <thead><tr className="text-left text-subtle"><th className="py-1">Servidor</th><th>Mediana</th><th>Média</th><th>Mín–Máx</th><th>Falhas</th></tr></thead>
              <tbody>
                {cmp.results.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="py-1.5 text-fg">{r.label}{r.server && <span className="text-subtle"> ({r.server})</span>}{best?.id === r.id && <Badge tone="ok">menor mediana</Badge>}</td>
                    <td>{ms(r.median)}</td><td>{ms(r.avg)}</td><td>{r.min ?? '—'}–{r.max ?? '—'} ms</td><td>{r.fail}/{r.ok + r.fail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[12px] text-subtle">{cmp.samplesPerServer} consultas por servidor. {cmp.note} Resultados variam com a hora e o cache.</p>
          </div>
        )}
      </Card>
      <Card title="Aplicar DNS a um adaptador" icon={Wifi} accent="advanced">
        <QueryView state={ad}>
          {() => (
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Adaptador" value={chosen} onChange={(e) => setAlias(e.target.value)} className="no-drag h-9 rounded-control border border-line-strong bg-elevated px-2 text-[13px] text-fg">
                {usable.map((a) => <option key={a.name} value={a.name}>{a.name} — DNS {a.dns.join(', ') || 'automático'}</option>)}
              </select>
              {PROVIDERS.map(([id, label]) => <Button key={id} disabled={!chosen} onClick={() => void run('network.dns.set', { alias: chosen, provider: id }).then(ad.reload)} data-dns-set={id}>{label}</Button>)}
              <Button variant="ghost" disabled={!chosen} onClick={() => void run('network.dns.set', { alias: chosen, provider: 'auto' }).then(ad.reload)} data-dns-set="auto">Voltar ao automático</Button>
            </div>
          )}
        </QueryView>
        <p className="mt-3 text-[12px] text-subtle">Pede administrador, guarda o DNS anterior, confere o resultado e pode ser desfeito em Histórico e Restauração. Só o IPv4 do adaptador escolhido é alterado.</p>
      </Card>
    </div>
  )
}

function Latency() {
  const [host, setHost] = useState('1.1.1.1')
  const [rep, setRep] = useState<LatencyReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = () => {
    setBusy(true)
    setErr(null)
    query<LatencyReport>('network.latency.run', { host, durationSec: 10, intervalMs: 500 }).then(setRep).catch((e) => setErr(errorMessage(e))).finally(() => setBusy(false))
  }
  return (
    <Card title="Ping até um servidor" icon={Wifi} accent="diagnostic" action={<Button variant="primary" onClick={go} loading={busy} data-latency-run>Testar 10 s</Button>}>
      <label className="mb-3 flex items-center gap-2 text-[13px] text-muted">Servidor (IP ou nome)
        <input value={host} onChange={(e) => setHost(e.target.value.trim())} className="no-drag h-9 w-64 rounded-control border border-line-strong bg-elevated px-2 text-fg" aria-label="Servidor de teste" />
      </label>
      {busy && <Spinner label="Enviando pacotes ICMP…" />}
      {err && <Notice tone="error" title="O teste falhou">{err}</Notice>}
      {rep && (
        <div data-latency-result>
          <InfoRow label="Média" value={ms(rep.stats.avgMs)} />
          <InfoRow label="Mín / Máx" value={`${rep.stats.minMs ?? '—'} / ${rep.stats.maxMs ?? '—'} ms`} />
          <InfoRow label="Jitter" value={ms(rep.stats.jitterMs)} />
          <InfoRow label="Perda de pacotes" value={`${rep.stats.timeoutPct}% de ${rep.stats.sent} pacotes`} />
        </div>
      )}
      <p className="mt-2 text-[12px] text-subtle">Use o endereço do servidor do seu jogo, quando o conhecer, para uma medição relevante. Servidores podem ignorar ICMP.</p>
    </Card>
  )
}
