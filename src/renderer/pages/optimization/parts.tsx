// Peças comuns das categorias da Central de Otimização: lista de ajustes reais, linhas de operação e estados.
import type { ReactNode } from 'react'
import { Badge, type Tone } from '../../components/ui'
import { RefreshButton } from '../../components/kit'
import { useQuery } from '../../hooks/useQuery'

export interface TweakState {
  id: string
  name: string
  description: string
  category: string
  options: { value: string; label: string }[]
  current: string | null
  currentLabel: string
  unavailable: string | null
  elevated: boolean
  needsRestart: boolean
  note: string | null
  profiles: { default: string | null; ideal: string | null; max: string | null }
}

export interface TweakCatalog {
  tweaks: TweakState[]
  baselineAt: string | null
  readAt: string
  hasBattery: boolean
  build: number
}

export function useCatalog() {
  return useQuery<TweakCatalog>('tweaks.catalog')
}

/** Cabeçalho de categoria: descrição objetiva e botão de atualizar (sem gráficos nem indicadores repetidos). */
export function CategoryHead({ description, onRefresh, loading, children }: { description: string; onRefresh?: () => void; loading?: boolean; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-3xl text-[13px] text-muted">{description}</p>
      <div className="flex items-center gap-2">
        {children}
        {onRefresh && <RefreshButton onClick={onRefresh} loading={loading} />}
      </div>
    </div>
  )
}

export function StateBadge({ state }: { state: string }) {
  const tone: Tone = /ativad|aplicad|em execu|ligad|^up$|ok/i.test(state) ? 'ok' : /indispon|erro|falha|ausente/i.test(state) ? 'error' : /parad|desativ|desligad/i.test(state) ? 'neutral' : 'info'
  return <Badge tone={tone}>{state}</Badge>
}

/** Linha padrão de uma função: nome, descrição, estado real e controles à direita. */
export function FunctionRow({ name, description, badges, children, note }: { name: ReactNode; description?: ReactNode; badges?: ReactNode; children?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-0" data-function-row>
      <div className="min-w-0 flex-1 basis-72">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-fg">
          {name}
          {badges}
        </p>
        {description && <p className="mt-0.5 text-[12px] text-muted">{description}</p>}
        {note && <p className="mt-0.5 text-[11.5px] text-subtle">{note}</p>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

