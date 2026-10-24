import { useEffect, useState } from 'react'
import { ChevronDown, History, Play, RefreshCw, ShieldAlert, SquareTerminal, Trash2 } from 'lucide-react'
import type { TaskDescriptor, TaskParamValue, TaskRunRecord } from '@shared/types'
import { formatDateTime } from '@shared/format'
import { useApp } from '../hooks/useApp'
import { useAsync } from '../hooks/useAsync'
import { api, call, errorMessage } from '../services/api'
import { Badge, Button, Card, cx, InfoRow, Notice, Spinner, Toggle } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { TaskOutputView } from '../components/TaskOutputView'

function defaultParams(task: TaskDescriptor): Record<string, TaskParamValue> {
  return Object.fromEntries(task.params.map((p) => [p.key, p.default]))
}

function TaskCard({ task, disabled, onRun }: { task: TaskDescriptor; disabled: boolean; onRun: (task: TaskDescriptor, params: Record<string, TaskParamValue>) => Promise<void> }) {
  const [params, setParams] = useState(() => defaultParams(task))
  const [running, setRunning] = useState(false)
  const set = (key: string, value: TaskParamValue) => setParams((p) => ({ ...p, [key]: value }))

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-fg">{task.name}</h3>
            <Badge tone={task.changesSystem ? 'warn' : 'ok'}>{task.changesSystem ? 'Altera o sistema' : 'Somente leitura'}</Badge>
            {task.requiresElevation && <Badge tone="error">Requer administrador</Badge>}
          </div>
          <p className="mt-1 text-[12px] text-muted">{task.description}</p>
          <p className="mt-1 font-mono text-[11px] text-subtle">{task.id}</p>
        </div>
        <Button
          variant="primary"
          icon={Play}
          loading={running}
          disabled={disabled}
          onClick={() => {
            setRunning(true)
            void onRun(task, params).finally(() => setRunning(false))
          }}
        >
          Executar
        </Button>
      </div>

      {task.params.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          {task.params.map((spec) => (
            <div key={spec.key} className="flex items-center justify-between gap-4 text-[13px]">
              <span className="text-muted">{spec.label}</span>
              {spec.type === 'boolean' && <Toggle label={spec.label} checked={params[spec.key] as boolean} onChange={(v) => set(spec.key, v)} />}
              {spec.type === 'integer' && (
                <input
                  type="number"
                  min={spec.min}
                  max={spec.max}
                  value={params[spec.key] as number}
                  onChange={(e) => set(spec.key, Number.parseInt(e.target.value || '0', 10))}
                  className="h-8 w-20 rounded-control border border-line-strong bg-elevated px-2 text-right text-[13px] text-fg focus:outline-none"
                />
              )}
              {spec.type === 'enum' && (
                <select
                  value={params[spec.key] as string}
                  onChange={(e) => set(spec.key, e.target.value)}
                  className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-[13px] text-fg"
                >
                  {spec.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function HistoryItem({ record }: { record: TaskRunRecord }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-line last:border-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 py-3 text-left text-[13px]">
        <Badge tone={record.ok ? 'ok' : 'error'}>{record.ok ? 'Sucesso' : 'Falha'}</Badge>
        <span className="min-w-0 flex-1 truncate text-fg">{record.taskName}</span>
        <span className="text-[12px] text-subtle">{formatDateTime(record.startedAt)}</span>
        <ChevronDown className={cx('size-4 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="pb-4">
          <TaskOutputView record={record} />
        </div>
      )}
    </div>
  )
}

export function ExecutorTasksTab() {
  const { executor, setExecutor } = useApp()
  const tasks = useAsync(() => call(api.executor.listTasks()))
  const history = useAsync(() => call(api.executor.history()))
  const [lastRun, setLastRun] = useState<TaskRunRecord | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ task: TaskDescriptor; params: Record<string, TaskParamValue>; resolve: () => void } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // O processo do executor pode ter sido encerrado desde a última consulta.
  useEffect(() => {
    call(api.executor.status()).then(setExecutor).catch(() => undefined)
  }, [setExecutor])

  async function execute(task: TaskDescriptor, params: Record<string, TaskParamValue>, confirmed: boolean) {
    setRunError(null)
    try {
      const record = await call(api.executor.run({ taskId: task.id, params, confirmed }))
      setLastRun(record)
      history.reload()
    } catch (e) {
      setRunError(errorMessage(e))
    }
  }

  function requestRun(task: TaskDescriptor, params: Record<string, TaskParamValue>): Promise<void> {
    if (!task.changesSystem) return execute(task, params, false)
    return new Promise((resolve) => setPending({ task, params, resolve }))
  }

  const ready = executor.state === 'ready'

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          icon={RefreshCw}
          loading={restarting}
          onClick={() => {
            setRestarting(true)
            call(api.executor.restart())
              .then(setExecutor)
              .catch((e) => setRunError(errorMessage(e)))
              .finally(() => setRestarting(false))
          }}
        >
          Reiniciar executor
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Estado do módulo" icon={SquareTerminal} accent="advanced">
          <InfoRow
            label="Estado"
            value={<Badge tone={ready ? 'ok' : executor.state === 'starting' ? 'info' : 'error'}>{ready ? 'Pronto' : executor.state === 'starting' ? 'Iniciando' : executor.state === 'stopped' ? 'Parado' : 'Indisponível'}</Badge>}
          />
          <InfoRow label="PID" value={executor.pid ?? '—'} mono />
          <InfoRow label="Iniciado em" value={formatDateTime(executor.startedAt)} />
          <InfoRow label="Administrador" value={executor.elevated === null ? 'Não verificado' : executor.elevated ? 'Sim' : 'Não'} />
          {executor.message && <p className="mt-3 text-[12px] text-alert">{executor.message}</p>}
          <div className="mt-4 flex gap-2 rounded-control border border-line bg-elevated p-3 text-[12px] text-muted">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-subtle" />
            Não há entrada de comandos livres. Tarefas que alterarem o sistema pedirão confirmação, e as que exigirem administrador
            solicitarão elevação de forma explícita.
          </div>
        </Card>

        <div className="space-y-4 xl:col-span-2">
          <h2 className="text-[12px] font-semibold tracking-wider text-subtle uppercase">Catálogo de tarefas</h2>
          {tasks.loading && <Spinner label="Carregando catálogo…" />}
          {tasks.error && <Notice tone="error">{tasks.error}</Notice>}
          {!ready && <Notice tone="warn">O executor não está pronto. Use "Reiniciar executor".</Notice>}
          {tasks.data?.map((task) => <TaskCard key={task.id} task={task} disabled={!ready} onRun={requestRun} />)}
          {runError && <Notice tone="error" title="Não foi possível executar">{runError}</Notice>}
          {lastRun && (
            <Card title={`Resultado: ${lastRun.taskName}`}>
              <TaskOutputView record={lastRun} />
            </Card>
          )}
        </div>
      </div>

      <Card
        className="mt-4"
        title="Histórico de execuções"
        icon={History}
        accent="advanced"
        action={
          <Button variant="ghost" icon={Trash2} disabled={!history.data?.length} onClick={() => setConfirmClear(true)}>
            Limpar
          </Button>
        }
      >
        {history.data?.length === 0 && <p className="text-[13px] text-subtle">Nenhuma execução registrada.</p>}
        {history.data?.map((record) => <HistoryItem key={record.runId} record={record} />)}
      </Card>

      <ConfirmDialog
        open={pending !== null}
        title={`Executar "${pending?.task.name}"?`}
        confirmLabel="Executar"
        onCancel={() => {
          pending?.resolve()
          setPending(null)
        }}
        onConfirm={() => {
          const p = pending
          setPending(null)
          if (p) void execute(p.task, p.params, true).finally(p.resolve)
        }}
      >
        Esta tarefa altera configurações do sistema. {pending?.task.description}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmClear}
        title="Limpar histórico?"
        confirmLabel="Limpar histórico"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false)
          void call(api.executor.clearHistory()).then(history.setData)
        }}
      >
        Todos os registros de execução serão removidos deste computador.
      </ConfirmDialog>
    </>
  )
}
