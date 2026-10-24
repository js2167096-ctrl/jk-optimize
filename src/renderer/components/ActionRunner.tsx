// Fluxo único para todas as ações que alteram o sistema:
// confirmação simples → execução com progresso → notificação curta com o resultado real.
// Falhas mostram uma mensagem resumida e "Detalhes" com a causa técnica.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, CircleX, LoaderCircle, X } from 'lucide-react'
import type { ActionOutcome, ActionPreview, JobProgress } from '@shared/types/ops'
import type { TaskDetailSection } from '@shared/types'
import { api, ApiError, errorMessage } from '../services/api'
import { newJobId, ops } from '../services/ops'
import { Button, cx } from './ui'
import { TaskOutputView } from './TaskOutputView'

interface RunOptions {
  /** Pergunta própria da confirmação (substitui a mensagem padrão e o resumo). */
  message?: string
  /** Mostra, junto da pergunta própria, o resumo, a tabela de alterações e os avisos da pré-visualização. */
  details?: boolean
  /** Quem chama exibe o andamento e o resultado (ex.: tela animada): sem as notificações de execução e de sucesso. */
  quiet?: boolean
  /** Chamado ao confirmar, com o identificador do trabalho (permite cancelar). */
  onStart?: (jobId: string) => void
  /** Progresso real enviado pela operação (mensagem, concluídos e total, quando conhecido). */
  onProgress?: (progress: JobProgress) => void
  /** Falha antes ou durante a execução (a operação não devolveu resultado). */
  onError?: (message: string) => void
}

interface RunAction {
  (actionId: string, params?: unknown, options?: RunOptions): Promise<ActionOutcome | null>
}

const ActionContext = createContext<RunAction | null>(null)

export function useAction(): RunAction {
  const ctx = useContext(ActionContext)
  if (!ctx) throw new Error('useAction fora do ActionProvider')
  return ctx
}

interface Toast {
  id: number
  tone: 'ok' | 'error' | 'running'
  message: string
  details: { title: string; text?: string; sections?: TaskDetailSection[]; preview?: ActionPreview } | null
  jobId?: string
}

let toastSeq = 0

export function ActionProvider({ children }: { children: ReactNode }) {
  const [confirm, setConfirm] = useState<{ preview: ActionPreview; message?: string; details?: boolean; resolve: (ok: boolean) => void } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [details, setDetails] = useState<Toast['details']>(null)
  const progressRef = useRef(new Map<string, number>())
  const listenersRef = useRef(new Map<string, (p: JobProgress) => void>())

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq
    setToasts((list) => [...list.slice(-4), { ...t, id }])
    if (t.tone === 'ok') setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 6000)
    return id
  }, [])
  const update = useCallback((id: number, patch: Partial<Toast>) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    if (patch.tone === 'ok') setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 6000)
  }, [])
  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id))

  useEffect(
    () =>
      api.ops.onProgress((p: JobProgress) => {
        const id = progressRef.current.get(p.jobId)
        if (id !== undefined) update(id, { message: p.message })
        listenersRef.current.get(p.jobId)?.(p)
      }),
    [update]
  )

  const run = useCallback<RunAction>(
    async (actionId, params, options) => {
      let preview: ActionPreview
      try {
        preview = await ops.preview(actionId, params ?? {})
      } catch (e) {
        push({ tone: 'error', message: errorMessage(e), details: { title: 'Não foi possível preparar a operação', text: technical(e) } })
        options?.onError?.(errorMessage(e))
        return null
      }
      if (preview.blocked) {
        push({ tone: 'error', message: preview.blocked, details: { title: preview.title, preview } })
        options?.onError?.(preview.blocked)
        return null
      }
      if (preview.risk !== 'none') {
        const accepted = await new Promise<boolean>((resolve) => setConfirm({ preview, message: options?.message, details: options?.details, resolve }))
        setConfirm(null)
        if (!accepted) return null
      }
      const jobId = newJobId()
      const quiet = options?.quiet === true
      const toastId = quiet ? null : push({ tone: 'running', message: `${preview.title}…`, details: null, jobId })
      if (toastId !== null) progressRef.current.set(jobId, toastId)
      if (options?.onProgress) listenersRef.current.set(jobId, options.onProgress)
      options?.onStart?.(jobId)
      try {
        const outcome = await ops.execute(preview.previewId, true, jobId)
        if (toastId !== null) {
          update(toastId, {
            tone: outcome.ok ? 'ok' : 'error',
            message: outcome.summary,
            details: { title: preview.title, sections: outcome.sections, text: outcome.verified ? undefined : 'O resultado final depende de outro programa e não pôde ser conferido automaticamente.', preview }
          })
        }
        return outcome
      } catch (e) {
        if (toastId !== null) update(toastId, { tone: 'error', message: errorMessage(e), details: { title: preview.title, text: technical(e), preview } })
        else push({ tone: 'error', message: errorMessage(e), details: { title: preview.title, text: technical(e), preview } })
        options?.onError?.(errorMessage(e))
        return null
      } finally {
        progressRef.current.delete(jobId)
        listenersRef.current.delete(jobId)
      }
    },
    [push, update]
  )

  return (
    <ActionContext.Provider value={run}>
      {children}

      {confirm && <ConfirmDialog preview={confirm.preview} message={confirm.message} details={confirm.details} onAnswer={confirm.resolve} />}

      <div className="no-drag fixed right-5 bottom-5 z-40 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'animate-enter flex items-start gap-3 rounded-card border bg-surface px-4 py-3 text-[13px] shadow-xl',
              t.tone === 'ok' ? 'border-optimize/40' : t.tone === 'error' ? 'border-danger/40' : 'border-line-strong'
            )}
          >
            {t.tone === 'running' ? (
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-performance" />
            ) : t.tone === 'ok' ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-optimize" />
            ) : (
              <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-fg">{t.message}</p>
              <div className="mt-1 flex gap-3 text-[12px]">
                {t.details && (
                  <button type="button" className="text-muted hover:text-fg hover:underline" onClick={() => setDetails(t.details)}>
                    Detalhes
                  </button>
                )}
                {t.tone === 'running' && t.jobId && (
                  <button type="button" className="text-muted hover:text-fg hover:underline" onClick={() => void ops.cancel(t.jobId!)}>
                    Cancelar
                  </button>
                )}
              </div>
            </div>
            {t.tone !== 'running' && (
              <button type="button" className="text-subtle hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Fechar">
                <X className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {details && <DetailsDialog details={details} onClose={() => setDetails(null)} />}
    </ActionContext.Provider>
  )
}

function technical(e: unknown): string {
  return e instanceof ApiError ? `${e.message} (código: ${e.code})` : errorMessage(e)
}

function ConfirmDialog({ preview, message, details, onAnswer }: { preview: ActionPreview; message?: string; details?: boolean; onAnswer: (ok: boolean) => void }) {
  const [showChanges, setShowChanges] = useState(!!details)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onAnswer(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="animate-enter w-full max-w-md rounded-card border border-line-strong bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-fg">Confirmar operação</h2>
        {message ? (
          <>
            <p className="mt-2 text-[13px] text-fg">{message}</p>
            {details && preview.summary && <p className="mt-1 text-[12.5px] text-muted">{preview.summary}</p>}
          </>
        ) : (
          <>
            <p className="mt-2 text-[13px] text-muted">Deseja realmente executar esta ação?</p>
            <p className="mt-1 text-[13px] text-fg">
              {preview.title}
              {preview.summary ? ` — ${preview.summary}` : ''}
            </p>
            {!preview.reversible && <p className="mt-2 text-[12px] text-alert">Esta operação não pode ser desfeita.</p>}
          </>
        )}
        {(!message || details) && preview.changes.length > 0 && (
          <button type="button" className="mt-3 text-[12px] text-subtle hover:text-muted hover:underline" onClick={() => setShowChanges((v) => !v)}>
            {showChanges ? 'Ocultar alterações' : 'Ver alterações'}
          </button>
        )}
        {showChanges && <ChangesTable preview={preview} />}
        {(!message || details) && preview.warnings.length > 0 && (
          <ul data-confirm-warnings className="mt-3 max-h-40 space-y-1 overflow-y-auto text-[12px] text-subtle">
            {preview.warnings.map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onAnswer(false)}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => onAnswer(true)}>
            Confirmar
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChangesTable({ preview }: { preview: ActionPreview }) {
  return (
    <div className="mt-2 max-h-48 overflow-y-auto rounded-control border border-line">
      <table className="w-full text-left text-[12px]">
        <tbody>
          {preview.changes.map((c, i) => (
            <tr key={i} className="border-t border-line first:border-0">
              <td className="selectable px-2 py-1.5 break-all text-muted">{c.target}</td>
              <td className="px-2 py-1.5 text-subtle">{c.current}</td>
              <td className="px-2 py-1.5 text-fg">→ {c.intended}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DetailsDialog({ details, onClose }: { details: NonNullable<Toast['details']>; onClose: () => void }) {
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="animate-enter max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-card border border-line-strong bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-fg">{details.title}</h2>
          <button type="button" className="text-subtle hover:text-fg" onClick={onClose} aria-label="Fechar">
            <X className="size-5" />
          </button>
        </div>
        {details.text && <p className="selectable mb-3 text-[13px] whitespace-pre-wrap text-muted">{details.text}</p>}
        {details.preview?.blocked && <p className="mb-3 text-[13px] text-alert">{details.preview.blocked}</p>}
        {details.sections && details.sections.length > 0 && (
          <TaskOutputView
            compact
            record={{ runId: '', taskId: '', taskName: '', params: {}, ok: true, startedAt: '', finishedAt: '', durationMs: 0, output: { summary: '', sections: details.sections }, error: null }}
          />
        )}
        {details.preview && details.preview.changes.length > 0 && (
          <>
            <h4 className="mt-4 mb-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">Alterações previstas</h4>
            <ChangesTable preview={details.preview} />
          </>
        )}
        {details.preview && details.preview.warnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-[12px] text-subtle">
            {details.preview.warnings.map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
