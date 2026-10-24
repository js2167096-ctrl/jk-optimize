// Tela de progresso de operações em lote: logo oficial, operação atual, lista de funções com o estado de cada uma,
// progresso baseado em etapas reais (concluídas ÷ total), erros, itens ignorados, resultado final e reinício necessário.
import { useCallback, useState, type ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from 'lucide-react'
import type { ActionOutcome, JobProgress } from '@shared/types/ops'
import { useAction } from './ActionRunner'
import { Button, cx, Emblem, ProgressBar } from './ui'
import { ops } from '../services/ops'

export type ItemState = 'pending' | 'running' | 'ok' | 'error' | 'skipped'

export interface BatchItem {
  id: string
  name: string
  state: ItemState
  message?: string
}

export interface BatchState {
  title: string
  jobId: string | null
  items: BatchItem[]
  /** Etapas concluídas e total, informados pela própria operação. */
  done: number
  total: number | null
  current: string
  finished: boolean
  outcome: ActionOutcome | null
  error: string | null
}

const ICON: Record<ItemState, ReactNode> = {
  pending: <CircleDashed className="size-4 text-subtle" />,
  running: <LoaderCircle className="size-4 animate-spin text-performance" />,
  ok: <CircleCheck className="size-4 text-optimize" />,
  error: <CircleX className="size-4 text-danger" />,
  skipped: <CircleMinus className="size-4 text-alert" />
}

const STATE_LABEL: Record<ItemState, string> = { pending: 'Aguardando', running: 'Em andamento', ok: 'Concluído', error: 'Falhou', skipped: 'Ignorado' }

/** Controla a execução de uma ação em lote e a tela de progresso (a confirmação é a do ActionRunner). */
export function useBatch(onFinished?: () => void) {
  const run = useAction()
  const [state, setState] = useState<BatchState | null>(null)

  const start = useCallback(
    async (opts: { title: string; actionId: string; params: unknown; items: { id: string; name: string }[]; message?: string; details?: boolean }) => {
      const outcome = await run(opts.actionId, opts.params, {
        quiet: true,
        message: opts.message,
        details: opts.details,
        onStart: (jobId) =>
          setState({ title: opts.title, jobId, items: opts.items.map((i) => ({ ...i, state: 'pending' })), done: 0, total: opts.items.length, current: 'Preparando…', finished: false, outcome: null, error: null }),
        onProgress: (p: JobProgress) =>
          setState((s) => {
            if (!s) return s
            const d = p.data as { stage?: string; id?: string; name?: string; state?: ItemState; message?: string } | undefined
            let items = s.items
            if (d?.stage === 'item' && d.id && d.state) {
              const known = items.some((i) => i.id === d.id)
              items = known ? items.map((i) => (i.id === d.id ? { ...i, state: d.state!, message: d.message } : i)) : [...items, { id: d.id, name: d.name ?? d.id, state: d.state, message: d.message }]
            }
            return { ...s, items, done: p.total !== null ? p.done : s.done, total: p.total ?? s.total, current: p.message }
          }),
        onError: (message) => setState((s) => (s ? { ...s, finished: true, error: message } : s))
      })
      if (outcome) setState((s) => (s ? { ...s, finished: true, outcome } : s))
      onFinished?.()
      return outcome
    },
    [run, onFinished]
  )
  return { state, start, close: () => setState(null) }
}

export function OperationProgress({ state, onClose }: { state: BatchState; onClose: () => void }) {
  const { items, finished, outcome } = state
  const pct = finished ? 100 : state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : null
  const failed = items.filter((i) => i.state === 'error')
  const skipped = items.filter((i) => i.state === 'skipped')
  const restart = outcome?.sections.flatMap((s) => s.rows).find((r) => r.label === 'Reinicialização necessária')
  const ok = finished && !state.error && !!outcome?.ok && failed.length === 0
  return (
    <div data-operation-progress className="no-drag fixed inset-0 z-50 grid place-items-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-label={state.title}>
      <div className="animate-enter flex max-h-[88vh] w-full max-w-xl flex-col rounded-card border border-line-strong bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <Emblem small brand="mark" className="size-14" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wider text-subtle uppercase">JK Optimize</p>
            <h2 className="truncate text-base font-semibold text-fg">{state.title}</h2>
            <p data-operation-current className="truncate text-[12.5px] text-muted">
              {finished ? (state.error ? 'Interrompida' : ok ? 'Concluída' : 'Concluída com problemas') : state.current}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <ProgressBar value={pct} accent={finished && !ok ? 'alert' : 'performance'} />
          <p data-operation-percent className="mt-1 text-right text-[11.5px] text-subtle tabular-nums">
            {pct === null ? 'Aguardando…' : `${pct}% · ${items.filter((i) => ['ok', 'error', 'skipped'].includes(i.state)).length} de ${items.length} função(ões)`}
          </p>
        </div>
        <ul className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-control border border-line">
          {items.map((i) => (
            <li key={i.id} data-op-item={i.id} data-op-state={i.state} className="flex items-start gap-2.5 border-b border-line px-3 py-2 text-[12.5px] last:border-0">
              <span className="mt-0.5">{ICON[i.state]}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-fg">{i.name}</span>
                {i.message && <span className={cx('selectable block break-words text-[11.5px]', i.state === 'error' ? 'text-danger' : 'text-subtle')}>{i.message}</span>}
              </span>
              <span className="shrink-0 text-[11.5px] text-subtle">{STATE_LABEL[i.state]}</span>
            </li>
          ))}
        </ul>
        {finished && (
          <div data-operation-result className="mt-4 space-y-1.5 text-[12.5px]">
            <p className={cx('font-medium', ok ? 'text-optimize' : 'text-alert')}>{state.error ?? outcome?.summary}</p>
            {failed.length > 0 && <p className="text-danger">{failed.length} função(ões) com erro: o lote não é considerado totalmente concluído.</p>}
            {skipped.length > 0 && <p className="text-alert">{skipped.length} função(ões) ignorada(s).</p>}
            {restart && (
              <p className="text-alert">
                Reinicialização necessária: {restart.value} Salve seu trabalho e reinicie quando quiser.
              </p>
            )}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {!finished && state.jobId && (
            <Button variant="ghost" onClick={() => void ops.cancel(state.jobId!)}>
              Cancelar
            </Button>
          )}
          {finished && (
            <Button variant="primary" onClick={onClose} data-operation-close>
              Fechar
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
