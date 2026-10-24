import { useMemo, useState } from 'react'
import { Pin, RotateCcw, SquareTerminal, Trash2, Zap } from 'lucide-react'
import type { ActionDescriptor, ChangeRecord, LogEntry, OpModule, QuickAction } from '@shared/types/ops'
import { OP_MODULE_LABEL } from '@shared/types/ops'
import { formatDateTime } from '@shared/format'
import { useAsync } from '../hooks/useAsync'
import { useQuery } from '../hooks/useQuery'
import { ops, query } from '../services/ops'
import { ApiError, errorMessage } from '../services/api'
import { useAction } from '../components/ActionRunner'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Badge, Button, Card, Notice, PageHeader } from '../components/ui'
import { DataTable, Mono, QueryView, RefreshButton, Tabs } from '../components/kit'
import { ExecutorTasksTab } from './Executor'

type Tab = 'tasks' | 'catalog' | 'quick' | 'restore' | 'logs' | 'backups'

export function ExecutorPage() {
  const [tab, setTab] = useState<Tab>('tasks')
  return (
    <>
      <PageHeader
        icon={SquareTerminal}
        accent="advanced"
        title="Executor"
        description="Catálogo de tarefas e ações com permissões, risco, prévia, histórico, reversão e logs. Nenhum comando livre é aceito."
      />
      <Tabs
        accent="advanced"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'tasks', label: 'Tarefas do executor' },
          { id: 'catalog', label: 'Catálogo de ações' },
          { id: 'quick', label: 'Ações rápidas' },
          { id: 'restore', label: 'Central de restauração' },
          { id: 'logs', label: 'Logs' },
          { id: 'backups', label: 'Backups' }
        ]}
      />
      {tab === 'tasks' && <ExecutorTasksTab />}
      {tab === 'catalog' && <CatalogTab />}
      {tab === 'quick' && <QuickActionsCard />}
      {tab === 'restore' && <RestoreTab />}
      {tab === 'logs' && <LogsTab />}
      {tab === 'backups' && <BackupsTab />}
    </>
  )
}

const RISK_TONE = { none: 'ok', low: 'info', medium: 'warn', high: 'error' } as const
const RISK_LABEL = { none: 'Sem risco', low: 'Baixo', medium: 'Médio', high: 'Alto' }

/** Ações sem parâmetros podem ser executadas direto do catálogo e fixadas como ações rápidas. */
const NO_PARAM_ACTIONS = new Set(['network.dns.flush', 'power.ultimate.enable', 'updater.install'])

function CatalogTab() {
  const actions = useAsync(() => ops.actions())
  const runAction = useAction()
  const [msg, setMsg] = useState<string | null>(null)
  const groups = useMemo(() => {
    const map = new Map<OpModule, ActionDescriptor[]>()
    for (const a of actions.data ?? []) map.set(a.module, [...(map.get(a.module) ?? []), a])
    return [...map.entries()]
  }, [actions.data])
  return (
    <div className="space-y-4">
      <Notice tone="info">
        Todas as ações passam pelo mesmo fluxo: pré-visualização dos recursos afetados e dos valores atuais e pretendidos, confirmação, validação de permissões no processo principal, execução
        com verificação e registro. As ações com parâmetros são iniciadas nas telas de cada módulo.
      </Notice>
      {msg && <p className="text-[12px] text-optimize">{msg}</p>}
      <QueryView state={actions}>
        {() =>
          groups.map(([module, list]) => (
            <Card key={module} title={OP_MODULE_LABEL[module]}>
              <div className="space-y-2">
                {list.map((a) => (
                  <div key={a.id} className="flex items-start justify-between gap-4 rounded-control border border-line bg-elevated p-3">
                    <div className="min-w-0 text-[13px]">
                      <p className="flex flex-wrap items-center gap-2 text-fg">
                        {a.title}
                        <Badge tone={RISK_TONE[a.risk]}>Risco {RISK_LABEL[a.risk].toLowerCase()}</Badge>
                        <Badge tone={a.reversible ? 'ok' : 'warn'}>{a.reversible ? 'Reversível' : 'Irreversível'}</Badge>
                        {a.requiresElevation && <Badge tone="warn">Administrador</Badge>}
                      </p>
                      <p className="mt-1 text-[12px] text-muted">{a.description}</p>
                      {!a.reversible && a.irreversibleReason && <p className="mt-1 text-[11px] text-subtle">{a.irreversibleReason}</p>}
                      <Mono>{a.id}</Mono>
                    </div>
                    {NO_PARAM_ACTIONS.has(a.id) && (
                      <div className="flex shrink-0 gap-1.5">
                        <Button
                          variant="ghost"
                          icon={Pin}
                          className="h-8 px-2"
                          onClick={() =>
                            query('monitoring.quick.add', { actionId: a.id, label: a.title, params: {} })
                              .then(() => setMsg(`"${a.title}" adicionada às ações rápidas.`))
                              .catch((e) => setMsg(errorMessage(e)))
                          }
                        />
                        <Button onClick={() => void runAction(a.id, {})}>Pré-visualizar</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          ))
        }
      </QueryView>
    </div>
  )
}

export function QuickActionsCard({ compact }: { compact?: boolean }) {
  const list = useQuery<QuickAction[]>('monitoring.quick.list')
  const runAction = useAction()
  return (
    <Card title="Ações rápidas" icon={Zap} accent="advanced" action={!compact && <RefreshButton onClick={list.reload} loading={list.loading} />}>
      <QueryView state={list}>
        {(items) =>
          items.length === 0 ? (
            <p className="text-[13px] text-subtle">
              Nenhuma ação fixada. Use o ícone de alfinete nas telas de Energia, Limpeza ou no Catálogo de ações. Cada uso passa pela mesma prévia e confirmação da tela original.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {items.map((q) => (
                <div key={q.id} className="flex items-center gap-1 rounded-control border border-line bg-elevated pl-1">
                  <Button variant="ghost" icon={Zap} className="h-8" onClick={() => void runAction(q.actionId, q.params)}>
                    {q.label}
                  </Button>
                  {!compact && (
                    <Button variant="ghost" icon={Trash2} className="h-8 px-2" onClick={() => void query('monitoring.quick.remove', { id: q.id }).then(list.reload)} />
                  )}
                </div>
              ))}
            </div>
          )
        }
      </QueryView>
    </Card>
  )
}

const STATUS = {
  applied: { label: 'Aplicada', tone: 'info' },
  reverted: { label: 'Revertida', tone: 'ok' },
  'revert-failed': { label: 'Reversão falhou', tone: 'error' }
} as const

export function RestoreTab() {
  const changes = useAsync(() => ops.changes())
  const [target, setTarget] = useState<{ change: ChangeRecord; force: boolean; stateMessage?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const revert = async () => {
    if (!target) return
    setBusy(true)
    try {
      await ops.revert(target.change.id, target.force)
      setResult({ tone: 'ok', text: `"${target.change.title}" revertida e conferida.` })
      setTarget(null)
      changes.reload()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'state-changed' && !target.force) {
        setTarget({ ...target, force: true, stateMessage: e.message })
      } else {
        setResult({ tone: 'error', text: errorMessage(e) })
        setTarget(null)
        changes.reload()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Central de restauração" action={<RefreshButton onClick={changes.reload} loading={changes.loading} />}>
      <p className="mb-3 text-[12px] text-subtle">
        Alterações feitas pelo JK Optimize, com o estado anterior guardado. Antes de reverter, o backup tem a integridade conferida (SHA-256) e o estado atual é validado.
      </p>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      <QueryView state={changes} empty={(l) => l.length === 0}>
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(c) => c.id}
            search={(c) => `${c.title} ${c.summaryBefore} ${c.summaryAfter} ${OP_MODULE_LABEL[c.module]}`}
            columns={[
              { key: 'at', label: 'Data', sort: (c) => c.createdAt, render: (c) => formatDateTime(c.createdAt) },
              { key: 'mod', label: 'Módulo', render: (c) => OP_MODULE_LABEL[c.module] },
              { key: 'title', label: 'Alteração', render: (c) => c.title },
              { key: 'before', label: 'Configuração anterior', render: (c) => <span className="text-muted">{c.summaryBefore}</span> },
              { key: 'after', label: 'Configuração aplicada', render: (c) => c.summaryAfter },
              {
                key: 'status',
                label: 'Estado',
                render: (c) => (
                  <div>
                    <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                    {c.revertError && <p className="mt-1 text-[11px] text-danger">{c.revertError}</p>}
                    {c.revertedAt && <p className="mt-1 text-[11px] text-subtle">{formatDateTime(c.revertedAt)}</p>}
                  </div>
                )
              },
              {
                key: 'act',
                label: '',
                render: (c) =>
                  c.reversible && c.status !== 'reverted' ? (
                    <Button icon={RotateCcw} className="h-7 px-2" onClick={() => setTarget({ change: c, force: false })}>
                      Reverter
                    </Button>
                  ) : !c.reversible ? (
                    <span className="text-[11px] text-subtle">Sem reversão</span>
                  ) : null
              }
            ]}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={target !== null}
        title={target?.force ? 'O estado mudou desde a alteração' : 'Reverter alteração?'}
        confirmLabel={target?.force ? 'Restaurar mesmo assim' : 'Reverter'}
        danger={target?.force}
        busy={busy}
        onCancel={() => setTarget(null)}
        onConfirm={() => void revert()}
      >
        {target?.force ? (
          <>
            {target.stateMessage} Restaurar vai sobrescrever o estado atual com o valor guardado antes da alteração.
          </>
        ) : (
          <>
            "{target?.change.title}" voltará para: {target?.change.summaryBefore}.
          </>
        )}
      </ConfirmDialog>
    </Card>
  )
}

const MODULES: OpModule[] = ['cleanup', 'power', 'performance', 'processes', 'startup', 'services', 'apps', 'fivem', 'network', 'windows', 'monitoring', 'updater']

export function LogsTab() {
  const [module, setModule] = useState('')
  const [level, setLevel] = useState('')
  const [text, setText] = useState('')
  const [days, setDays] = useState(7)
  const filter = { module: module || undefined, level: (level || undefined) as LogEntry['level'] | undefined, text: text || undefined, fromDays: days, limit: 500 }
  const key = JSON.stringify(filter)
  const logs = useAsync(() => ops.logs(filter), [key])
  return (
    <Card title="Logs de operações" action={<RefreshButton onClick={logs.reload} loading={logs.loading} />}>
      <div className="mb-4 flex flex-wrap gap-2 text-[12px]">
        <select value={module} onChange={(e) => setModule(e.target.value)} className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-fg">
          <option value="">Todos os módulos</option>
          {MODULES.map((m) => (
            <option key={m} value={m}>
              {OP_MODULE_LABEL[m]}
            </option>
          ))}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-fg">
          <option value="">Todas as gravidades</option>
          <option value="info">Informação</option>
          <option value="warn">Aviso</option>
          <option value="error">Erro</option>
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-fg">
          {[1, 3, 7, 14].map((d) => (
            <option key={d} value={d}>
              Últimos {d} dia(s)
            </option>
          ))}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pesquisar…" className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-fg" />
      </div>
      <p className="mb-3 text-[11px] text-subtle">Senhas, chaves de ativação e outros segredos são removidos antes da gravação. Retenção de 14 dias.</p>
      <QueryView state={logs} empty={(l) => l.length === 0}>
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(l) => `${l.ts}-${l.message.slice(0, 40)}`}
            columns={[
              { key: 'ts', label: 'Horário', render: (l) => <span className="whitespace-nowrap">{formatDateTime(l.ts)}</span> },
              { key: 'lvl', label: 'Gravidade', render: (l) => <Badge tone={l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'neutral'}>{{ info: 'Info', warn: 'Aviso', error: 'Erro' }[l.level]}</Badge> },
              { key: 'mod', label: 'Módulo', render: (l) => OP_MODULE_LABEL[l.module as OpModule] ?? l.module },
              { key: 'msg', label: 'Mensagem', render: (l) => <span className="selectable">{l.message}</span> },
              { key: 'dur', label: 'Duração', render: (l) => (l.durationMs === undefined ? '' : `${(l.durationMs / 1000).toFixed(1)} s`) }
            ]}
          />
        )}
      </QueryView>
    </Card>
  )
}

function BackupsTab() {
  const state = useQuery<{ id: string; title: string; createdAt: string; ok: boolean; error: string | null }[]>('windows.backups.verify')
  return (
    <Card title="Backups de configuração" action={<RefreshButton onClick={state.reload} loading={state.loading} />}>
      <p className="mb-3 text-[12px] text-subtle">
        Cada alteração guarda os valores anteriores num arquivo gravado uma única vez (sem sobrescrita), com data, versão do formato e identificação da operação. A verificação abaixo confere o SHA-256 de
        cada backup.
      </p>
      <QueryView state={state} empty={(l) => l.length === 0}>
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(b) => b.id}
            columns={[
              { key: 'at', label: 'Data', render: (b) => formatDateTime(b.createdAt) },
              { key: 'title', label: 'Alteração', render: (b) => b.title },
              { key: 'ok', label: 'Integridade', render: (b) => <Badge tone={b.ok ? 'ok' : 'error'}>{b.ok ? 'Íntegro' : 'Problema'}</Badge> },
              { key: 'err', label: '', render: (b) => <span className="text-[12px] text-danger">{b.error}</span> },
              { key: 'id', label: 'Identificação', render: (b) => <Mono>{b.id}</Mono> }
            ]}
          />
        )}
      </QueryView>
    </Card>
  )
}
