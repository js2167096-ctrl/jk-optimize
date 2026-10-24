import { useEffect, useState } from 'react'
import { BellRing, Layers, Save, TrendingUp } from 'lucide-react'
import { formatDateTime } from '@shared/format'
import { useQuery } from '../hooks/useQuery'
import { query } from '../services/ops'
import { errorMessage } from '../services/api'
import { Button, Card, Notice, PageHeader, TextField, Toggle } from '../components/ui'
import { LineChart, QueryView, RefreshButton, Tabs } from '../components/kit'
import { MonitorOverview } from './tools/MonitorOverview'

type Tab = 'overview' | 'overlay' | 'alerts' | 'history'

export interface MonitoringSettings {
  overlay: { enabled: boolean; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; scale: number; opacity: number; metrics: string[]; fpsProcess: string | null }
  alerts: { enabled: boolean; muted: boolean; tempC: number; memoryPct: number; diskFreePct: number; cooldownMin: number }
  history: { enabled: boolean; retentionDays: number; intervalSec: number }
}

const METRICS = [
  { id: 'fps', label: 'FPS (PresentMon)' },
  { id: 'frametime', label: 'Frametime (PresentMon)' },
  { id: 'cpu', label: 'CPU' },
  { id: 'gpu', label: 'GPU' },
  { id: 'ram', label: 'Memória' },
  { id: 'temp', label: 'Temperatura' }
]

/** Overlay, alertas e histórico (a antiga visão geral foi distribuída nas categorias; `embedded` o coloca dentro de Configurações). */
export function MonitoringPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [tab, setTab] = useState<Tab>(embedded ? 'overlay' : 'overview')
  const state = useQuery<MonitoringSettings>('monitoring.settings')
  const [draft, setDraft] = useState<MonitoringSettings | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  useEffect(() => {
    if (state.data) setDraft(state.data)
  }, [state.data])

  const save = (next: MonitoringSettings) =>
    query<MonitoringSettings>('monitoring.settings.save', next)
      .then((s) => {
        setDraft(s)
        setMsg({ tone: 'ok', text: 'Configurações salvas e aplicadas.' })
      })
      .catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))

  return (
    <>
      {!embedded && <PageHeader icon={TrendingUp} accent="diagnostic" title="Monitoramento" description="Visão geral da telemetria, overlay de desempenho, alertas e histórico, usando apenas sensores disponíveis." />}
      <Tabs
        accent="diagnostic"
        value={tab}
        onChange={setTab}
        tabs={[
          ...(embedded ? [] : [{ id: 'overview' as const, label: 'Visão geral' }]),
          { id: 'overlay', label: 'Overlay' },
          { id: 'alerts', label: 'Alertas' },
          { id: 'history', label: 'Histórico' }
        ]}
      />
      {msg && (
        <div className="mb-4">
          <Notice tone={msg.tone === 'ok' ? 'ok' : 'error'}>{msg.text}</Notice>
        </div>
      )}
      {tab === 'overview' && <MonitorOverview />}
      {tab !== 'overview' && (
      <QueryView state={{ data: draft, error: state.error, loading: state.loading }}>
        {(d) => (
          <>
            {tab === 'overlay' && <OverlayTab s={d} setDraft={setDraft} save={save} />}
            {tab === 'alerts' && <AlertsTab s={d} setDraft={setDraft} save={save} />}
            {tab === 'history' && <HistoryTab s={d} setDraft={setDraft} save={save} />}
          </>
        )}
      </QueryView>
      )}
    </>
  )
}

interface TabProps {
  s: MonitoringSettings
  setDraft: (s: MonitoringSettings) => void
  save: (s: MonitoringSettings) => Promise<void>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-0">
      <div>
        <p className="text-[13px] text-fg">{label}</p>
        {hint && <p className="mt-0.5 text-[12px] text-subtle">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

const num = (v: string) => Number(v.replace(',', '.'))

function OverlayTab({ s, setDraft, save }: TabProps) {
  const o = s.overlay
  const set = (patch: Partial<MonitoringSettings['overlay']>) => setDraft({ ...s, overlay: { ...o, ...patch } })
  return (
    <Card title="Overlay de desempenho" icon={Layers} accent="diagnostic">
      <Notice tone="info">
        Janela própria, transparente e sempre por cima, que não recebe cliques e não toca no processo do jogo (sem injeção, sem hooks). Funciona sobre jogos em modo janela ou tela cheia sem bordas;
        em tela cheia exclusiva o Windows pode escondê-la. FPS e frametime só aparecem com o PresentMon configurado (FiveM → Instalação).
      </Notice>
      <div className="mt-2">
        <Row label="Mostrar overlay">
          <Toggle label="Mostrar overlay" checked={o.enabled} onChange={(v) => void save({ ...s, overlay: { ...o, enabled: v } })} />
        </Row>
        <Row label="Posição">
          <select value={o.position} onChange={(e) => set({ position: e.target.value as typeof o.position })} className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-[13px] text-fg">
            <option value="top-left">Superior esquerda</option>
            <option value="top-right">Superior direita</option>
            <option value="bottom-left">Inferior esquerda</option>
            <option value="bottom-right">Inferior direita</option>
          </select>
        </Row>
        <Row label="Tamanho" hint={`${Math.round(o.scale * 100)}%`}>
          <input type="range" min={0.75} max={1.75} step={0.05} value={o.scale} onChange={(e) => set({ scale: num(e.target.value) })} />
        </Row>
        <Row label="Opacidade" hint={`${Math.round(o.opacity * 100)}%`}>
          <input type="range" min={0.3} max={1} step={0.05} value={o.opacity} onChange={(e) => set({ opacity: num(e.target.value) })} />
        </Row>
        <Row label="Métricas exibidas">
          <div className="flex flex-wrap justify-end gap-3 text-[12px] text-muted">
            {METRICS.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5">
                <input type="checkbox" checked={o.metrics.includes(m.id)} onChange={(e) => set({ metrics: e.target.checked ? [...o.metrics, m.id] : o.metrics.filter((x) => x !== m.id) })} />
                {m.label}
              </label>
            ))}
          </div>
        </Row>
        <Row label="Processo do jogo para FPS" hint="Ex.: FiveM_GTAProcess.exe. Deixe vazio para não medir FPS.">
          <div className="w-64">
            <TextField label="" value={o.fpsProcess ?? ''} onChange={(e) => set({ fpsProcess: e.target.value.trim() || null })} />
          </div>
        </Row>
      </div>
      <Button variant="primary" icon={Save} className="mt-4" onClick={() => void save(s)}>
        Salvar e aplicar
      </Button>
    </Card>
  )
}

function AlertsTab({ s, setDraft, save }: TabProps) {
  const a = s.alerts
  const set = (patch: Partial<MonitoringSettings['alerts']>) => setDraft({ ...s, alerts: { ...a, ...patch } })
  const [test, setTest] = useState<string | null>(null)
  const field = (key: 'tempC' | 'memoryPct' | 'diskFreePct' | 'cooldownMin', min: number, max: number) => (
    <input type="number" min={min} max={max} value={a[key]} onChange={(e) => set({ [key]: Number(e.target.value) })} className="h-8 w-20 rounded-control border border-line-strong bg-elevated px-2 text-right text-[13px] text-fg" />
  )
  return (
    <Card title="Alertas inteligentes" icon={BellRing} accent="alert">
      <Row label="Ativar alertas" hint="Verifica a cada amostra do monitor; usa somente sensores disponíveis.">
        <Toggle label="Ativar alertas" checked={a.enabled} onChange={(v) => set({ enabled: v })} />
      </Row>
      <Row label="Silenciar notificações" hint="Continua registrando os alertas no log, sem mostrar notificações.">
        <Toggle label="Silenciar" checked={a.muted} onChange={(v) => set({ muted: v })} />
      </Row>
      <Row label="Temperatura (°C)" hint="Ignorado quando não há sensor disponível.">
        {field('tempC', 50, 110)}
      </Row>
      <Row label="Memória comprometida (%)">{field('memoryPct', 50, 99)}</Row>
      <Row label="Espaço livre mínimo em disco (%)">{field('diskFreePct', 1, 50)}</Row>
      <Row label="Intervalo mínimo entre alertas iguais (min)" hint="Evita notificações repetidas.">
        {field('cooldownMin', 5, 240)}
      </Row>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" icon={Save} onClick={() => void save(s)}>
          Salvar e aplicar
        </Button>
        <Button
          onClick={() =>
            query<{ shown: boolean; reason: string | null }>('monitoring.alerts.test')
              .then((r) => setTest(r.shown ? 'Notificação enviada.' : r.reason))
              .catch((e) => setTest(errorMessage(e)))
          }
        >
          Testar notificação
        </Button>
      </div>
      {test && <p className="mt-2 text-[12px] text-muted">{test}</p>}
    </Card>
  )
}

interface HistoryData {
  from: number
  to: number
  intervalSec: number
  enabled: boolean
  points: ({ t: number; cpu: number | null; maxCore: number | null; gpu: number | null; commit: number | null; availGB: number | null; tempC: number | null } | { t: number; gap: true })[]
  sources: Record<string, string>
}

function HistoryTab({ s, setDraft, save }: TabProps) {
  const h = s.history
  const [hours, setHours] = useState(24)
  const data = useQuery<HistoryData>('monitoring.history', { hours })
  const set = (patch: Partial<MonitoringSettings['history']>) => setDraft({ ...s, history: { ...h, ...patch } })
  const series = (k: 'cpu' | 'gpu' | 'commit' | 'tempC') => (data.data?.points ?? []).map((p) => ('gap' in p ? null : p[k]))
  const hasTemp = (data.data?.points ?? []).some((p) => !('gap' in p) && p.tempC !== null)
  return (
    <div className="space-y-4">
      <Card title="Histórico de desempenho">
        <Row label="Gravar histórico" hint="Mantém o monitor ativo em segundo plano enquanto o app estiver aberto.">
          <Toggle label="Gravar histórico" checked={h.enabled} onChange={(v) => set({ enabled: v })} />
        </Row>
        <Row label="Intervalo entre amostras (s)">
          <input type="number" min={5} max={300} value={h.intervalSec} onChange={(e) => set({ intervalSec: Number(e.target.value) })} className="h-8 w-20 rounded-control border border-line-strong bg-elevated px-2 text-right text-[13px] text-fg" />
        </Row>
        <Row label="Retenção (dias)" hint="Dados mais antigos são apagados automaticamente.">
          <input type="number" min={1} max={90} value={h.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) })} className="h-8 w-20 rounded-control border border-line-strong bg-elevated px-2 text-right text-[13px] text-fg" />
        </Row>
        <Button variant="primary" icon={Save} className="mt-4" onClick={() => void save(s)}>
          Salvar e aplicar
        </Button>
      </Card>
      <Card
        title="Gráficos"
        action={
          <div className="flex items-center gap-2">
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-[12px] text-fg">
              {[1, 6, 24, 72, 168].map((x) => (
                <option key={x} value={x}>
                  Últimas {x} h
                </option>
              ))}
            </select>
            <RefreshButton onClick={data.reload} loading={data.loading} />
          </div>
        }
      >
        <QueryView state={data}>
          {(d) =>
            d.points.length === 0 ? (
              <p className="text-[13px] text-subtle">{d.enabled ? 'Ainda não há amostras neste período.' : 'O histórico está desativado; ative e salve para começar a gravar.'}</p>
            ) : (
              <div className="space-y-6">
                <LineChart
                  unit="%"
                  max={100}
                  xLabels={[formatDateTime(new Date(d.from).toISOString()), formatDateTime(new Date(d.to).toISOString())]}
                  series={[
                    { label: 'CPU', color: 'var(--jk-performance)', values: series('cpu') },
                    { label: 'GPU', color: 'var(--jk-advanced)', values: series('gpu') },
                    { label: 'Memória comprometida', color: 'var(--jk-optimize)', values: series('commit') }
                  ]}
                />
                {hasTemp ? (
                  <LineChart unit="°C" series={[{ label: 'Temperatura máxima', color: 'var(--jk-alert)', values: series('tempC') }]} />
                ) : (
                  <p className="text-[12px] text-subtle">Temperatura: sem sensor disponível neste computador (nenhum valor registrado).</p>
                )}
                <div className="text-[11px] text-subtle">
                  <p>Intervalo médio por ponto: {d.intervalSec} s. Buracos nas linhas indicam ausência de dados (app fechado), não valor zero.</p>
                  {Object.entries(d.sources).map(([k, v]) => (
                    <p key={k}>
                      {k}: {v}
                    </p>
                  ))}
                </div>
              </div>
            )
          }
        </QueryView>
      </Card>
    </div>
  )
}
