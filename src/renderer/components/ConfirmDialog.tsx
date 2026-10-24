import { useEffect, type ReactNode } from 'react'
import { Button } from './ui'

/**
 * Confirmação padrão do aplicativo: "Confirmar operação" / "Deseja realmente executar esta ação?"
 * com uma linha identificando a ação e os botões Cancelar | Confirmar.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  busy,
  onConfirm,
  onCancel
}: {
  open: boolean
  /** Identificação curta da ação, exibida abaixo da pergunta. */
  title: string
  children?: ReactNode
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" role="dialog" aria-modal="true">
      <div className="animate-enter w-full max-w-md rounded-card border border-line-strong bg-surface p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-fg">Confirmar operação</h2>
        <p className="mt-2 text-[13px] text-muted">Deseja realmente executar esta ação?</p>
        <p className="mt-1 text-[13px] text-fg">{title}</p>
        {children && <div className="mt-2 text-[12px] text-subtle">{children}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={busy}>
            Confirmar
          </Button>
        </div>
      </div>
    </div>
  )
}
