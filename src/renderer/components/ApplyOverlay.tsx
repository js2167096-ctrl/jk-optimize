// Tela animada de aplicação de ajustes. Mostra o andamento REAL da operação (etapas e itens
// enviados pelo processo principal): nada de percentual fictício. Sem total conhecido, o
// indicador é indeterminado. Leve de propósito: só CSS (sem canvas nem bibliotecas).
import { CircleCheck, CircleX, LoaderCircle, Minus, RotateCcw } from 'lucide-react'
import type { ActionOutcome } from '@shared/types/ops'
import { classifyResult, type ApplyTask, type TaskState } from '@shared/apply-tasks'
import { Button, cx, Wordmark } from './ui'

export type { ApplyTask, TaskState }
export type ApplyPhase = 'preparing' | 'verifying' | 'applying' | 'checking' | 'finishing' | 'done'

export interface ApplyView {
  phase: ApplyPhase
  tasks: ApplyTask[]
  done: number
  total: number | null
  jobId: string | null
  cancelling: boolean
  outcome: ActionOutcome | null
  error: string | null
  /** Nomes dos ajustes aplicados que só valem depois de reiniciar. */
  restartNames: string[]
  restartScheduled: boolean
  restartError: string | null
}

const STAGES: { phase: ApplyPhase; label: string }[] = [
  { phase: 'preparing', label: 'Preparando ajustes' },
  { phase: 'verifying', label: 'Verificando configurações' },
  { phase: 'applying', label: 'Aplicando alterações' },
  { phase: 'checking', label: 'Conferindo resultados' },
  { phase: 'finishing', label: 'Finalizando' }
]

const TASK_ICON: Record<TaskState, { icon: typeof CircleCheck; color: string }> = {
  wait: { icon: Minus, color: 'text-subtle' },
  run: { icon: LoaderCircle, color: 'text-performance' },
  ok: { icon: CircleCheck, color: 'text-optimize' },
  fail: { icon: CircleX, color: 'text-danger' },
  skip: { icon: Minus, color: 'text-alert' }
}

export function resultKind(view: ApplyView) {
  return classifyResult(view.tasks, view.cancelling)
}

const RESULT_TEXT = {
  success: { title: 'Ajustes aplicados e conferidos', tone: 'text-optimize' },
  partial: { title: 'Concluído com pendências', tone: 'text-alert' },
  failure: { title: 'Nenhum ajuste foi aplicado', tone: 'text-danger' },
  cancelled: { title: 'Aplicação cancelada', tone: 'text-alert' }
}

export function ApplyOverlay({
  view,
  onCancel,
  onClose,
  onRestartNow,
  onRestartLater,
  onAbortRestart
}: {
  view: ApplyView
  onCancel: () => void
  onClose: () => void
  onRestartNow: () => void
  onRestartLater: () => void
  onAbortRestart: () => void
}) {
  const finished = view.phase === 'done'
  const stageIndex = STAGES.findIndex((s) => s.phase === view.phase)
  const stage = STAGES[Math.max(0, stageIndex)]
  const kind = finished ? resultKind(view) : null
  const determinate = view.phase === 'applying' && view.total !== null && view.total > 0
  const width = determinate ? Math.min(100, (view.done / (view.total ?? 1)) * 100) : finished ? 100 : 0

  return (
    <div
      className="no-drag fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-bg p-6"
      style={{ backgroundImage: 'radial-gradient(60% 50% at 50% 30%, rgb(var(--jk-accent-rgb) / 0.12), transparent 70%)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Aplicando ajustes"
      data-apply-overlay
      data-phase={view.phase}
    >
      <div className="animate-enter w-full max-w-lg">
        <div className="mb-7 flex justify-center">
          <Wordmark size="lg" />
        </div>

        <div className="rounded-card border border-line bg-surface/90 p-6 shadow-2xl">
          <div className="text-center" aria-live="polite">
            {finished && kind ? (
              <h2 className={cx('text-[18px] font-semibold', RESULT_TEXT[kind].tone)} data-apply-result={kind}>
                {RESULT_TEXT[kind].title}
              </h2>
            ) : (
              <h2 className="flex items-center justify-center gap-2.5 text-[18px] font-semibold text-fg" data-apply-stage={stage.phase}>
                <LoaderCircle className="size-5 animate-spin text-performance" />
                {stage.label}
              </h2>
            )}
            <p className="mt-1 text-[12px] text-muted">
              {finished
                ? (view.error ?? view.outcome?.summary ?? '')
                : view.phase === 'applying'
                  ? `${Math.min(view.done + 1, view.total ?? view.done + 1)} de ${view.total ?? '?'}`
                  : 'Aguarde: o Windows está sendo consultado.'}
            </p>
          </div>

          {/* Etapas reais da operação */}
          {!finished && (
            <ol className="mt-4 flex justify-between gap-1 text-[10.5px]" aria-label="Etapas">
              {STAGES.map((s, i) => (
                <li key={s.phase} className={cx('flex flex-1 flex-col items-center gap-1 text-center', i < stageIndex ? 'text-optimize' : i === stageIndex ? 'text-fg' : 'text-subtle')}>
                  <span className={cx('h-1 w-full rounded-full transition-colors duration-300', i <= stageIndex ? 'bg-performance' : 'bg-surface-3')} />
                  <span className="hidden sm:block">{s.label}</span>
                </li>
              ))}
            </ol>
          )}

          {/* Progresso: real quando há total; indeterminado caso contrário */}
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate || finished ? Math.round(width) : undefined}>
            {determinate || finished ? (
              <div className={cx('h-full rounded-full transition-[width] duration-300', finished && kind !== 'success' ? 'bg-alert' : 'bg-performance')} style={{ width: `${width}%` }} />
            ) : (
              <div className="animate-loader h-full w-2/5 rounded-full bg-performance" />
            )}
          </div>

          {/* Lista compacta de tarefas */}
          <ul className="mt-5 max-h-60 space-y-1.5 overflow-y-auto pr-1">
            {view.tasks.map((t) => {
              const { icon: Icon, color } = TASK_ICON[t.state]
              return (
                <li key={t.id} data-task={t.id} data-state={t.state} className="flex items-start gap-2.5 rounded-control bg-bg/40 px-3 py-2 text-[12.5px]">
                  <Icon className={cx('mt-0.5 size-4 shrink-0', color, t.state === 'run' && 'animate-spin')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-fg">{t.name}</span>
                    <span className="block truncate text-[11px] text-subtle" title={t.detail ?? `${t.from} → ${t.to}`}>
                      {t.detail ?? `${t.from} → ${t.to}`}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>

          {finished && view.restartNames.length > 0 && (
            <div className="mt-4 rounded-control border border-performance/30 bg-performance/[0.07] p-3 text-[12.5px] text-fg" data-restart-needed>
              Para valer, este ajuste exige reiniciar o Windows: <strong>{view.restartNames.join(', ')}</strong>.
              {view.restartScheduled && <span className="mt-1 block text-alert">Reinício agendado: o Windows reiniciará em instantes.</span>}
              {view.restartError && <span className="mt-1 block text-danger">{view.restartError}</span>}
            </div>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {!finished && (
              <Button variant="ghost" data-apply-cancel disabled={view.cancelling || view.phase === 'checking' || view.phase === 'finishing' || !view.jobId} onClick={onCancel}>
                {view.cancelling ? 'Cancelando…' : 'Cancelar'}
              </Button>
            )}
            {finished && view.restartNames.length > 0 && !view.restartScheduled && (
              <>
                <Button variant="ghost" data-apply-restart-later onClick={onRestartLater}>
                  Reiniciar depois
                </Button>
                <Button variant="primary" icon={RotateCcw} data-apply-restart-now onClick={onRestartNow}>
                  Reiniciar agora
                </Button>
              </>
            )}
            {finished && view.restartScheduled && (
              <Button variant="danger" data-apply-abort-restart onClick={onAbortRestart}>
                Cancelar reinício
              </Button>
            )}
            {finished && (view.restartNames.length === 0 || view.restartScheduled) && (
              <Button variant={view.restartScheduled ? 'ghost' : 'primary'} data-apply-close onClick={onClose}>
                Fechar
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
