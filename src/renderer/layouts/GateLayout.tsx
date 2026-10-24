import type { ReactNode } from 'react'

/** Layout das telas antes do acesso (carregamento, ativação, desbloqueio). */
export function GateLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="drag h-10 shrink-0" />
      <div className="grid flex-1 place-items-center overflow-y-auto px-6 pb-10">
        <div className="animate-enter w-full max-w-md">{children}</div>
      </div>
    </div>
  )
}
