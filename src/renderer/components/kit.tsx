// Componentes reutilizáveis dos módulos: abas, tabela, estados de consulta, gráficos.
import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, RefreshCw, Search } from 'lucide-react'
import { Button, cx, Notice, Spinner } from './ui'
import { ACCENT_CLASSES, type Accent } from '../navigation'

// ---------------------------------------------------------------------------
// Abas
// ---------------------------------------------------------------------------

export interface TabDef<T extends string> {
  id: T
  label: string
}

export function Tabs<T extends string>({ tabs, value, onChange, accent = 'performance' }: { tabs: TabDef<T>[]; value: T; onChange: (id: T) => void; accent?: Accent }) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cx('-mb-px border-b-2 px-3.5 py-2 text-[13px] transition-colors', value === t.id ? 'font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
          style={value === t.id ? { borderBottomColor: accent === 'neutral' ? 'var(--jk-fg)' : `var(--jk-${accent})` } : undefined}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function useTab<T extends string>(initial: T) {
  return useState<T>(initial)
}

// ---------------------------------------------------------------------------
// Estado de consulta
// ---------------------------------------------------------------------------

export function QueryView<T>({
  state,
  children,
  loadingLabel = 'Consultando o Windows…',
  empty
}: {
  state: { data: T | null; error: string | null; loading: boolean }
  children: (data: T) => ReactNode
  loadingLabel?: string
  empty?: (data: T) => boolean
}) {
  if (state.error) return <Notice tone="error" title="Não foi possível consultar">{state.error}</Notice>
  if (state.data === null) return state.loading ? <Spinner label={loadingLabel} /> : null
  if (empty?.(state.data)) return <p className="text-[13px] text-subtle">Nada encontrado.</p>
  return <>{children(state.data)}</>
}

export function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return (
    <Button icon={RefreshCw} variant="ghost" onClick={onClick} loading={loading}>
      Atualizar
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Tabela com busca e ordenação
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string
  label: string
  render: (row: T) => ReactNode
  sort?: (row: T) => number | string
  className?: string
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  search,
  maxRows = 300,
  initialSort,
  empty = 'Nada encontrado.'
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  search?: (row: T) => string
  maxRows?: number
  initialSort?: { key: string; desc: boolean }
  empty?: string
}) {
  const [text, setText] = useState('')
  const [sort, setSort] = useState(initialSort ?? null)
  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase()
    let list = t && search ? rows.filter((r) => search(r).toLowerCase().includes(t)) : rows
    const col = sort ? columns.find((c) => c.key === sort.key) : null
    if (col?.sort) {
      const get = col.sort
      list = [...list].sort((a, b) => {
        const va = get(a)
        const vb = get(b)
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
        return sort!.desc ? -cmp : cmp
      })
    }
    return list
  }, [rows, text, sort, columns, search])

  return (
    <div className="space-y-3">
      {search && (
        <label className="flex h-9 max-w-sm items-center gap-2 rounded-control border border-line-strong bg-elevated px-3">
          <Search className="size-4 text-subtle" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filtrar…" className="w-full bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none" />
        </label>
      )}
      <div className="overflow-x-auto rounded-control border border-line">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-elevated text-subtle">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={cx('px-3 py-2 font-medium whitespace-nowrap', c.className)}>
                  {c.sort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-fg"
                      onClick={() => setSort((s) => ({ key: c.key, desc: s?.key === c.key ? !s.desc : true }))}
                    >
                      {c.label}
                      {sort?.key === c.key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, maxRows).map((row) => (
              <tr key={rowKey(row)} className="border-t border-line align-top hover:bg-surface-2/50">
                {columns.map((c) => (
                  <td key={c.key} className={cx('px-3 py-2 text-fg', c.className)}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-4 text-center text-subtle">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > maxRows && <p className="text-[11px] text-subtle">Mostrando {maxRows} de {filtered.length}. Use o filtro para refinar.</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Gráfico de linhas (vários valores; null = ausência de dado, desenhada como buraco)
// ---------------------------------------------------------------------------

export interface Series {
  label: string
  color: string
  values: (number | null)[]
}

export function LineChart({ series, height = 160, max, unit, xLabels }: { series: Series[]; height?: number; max?: number; unit: string; xLabels?: [string, string] }) {
  const n = Math.max(...series.map((s) => s.values.length), 0)
  const top = max ?? Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))) * 1.1
  if (n < 2) return <div className="grid place-items-center text-[12px] text-subtle" style={{ height }}>Dados insuficientes para o gráfico.</div>
  const w = n - 1
  const y = (v: number) => 100 - (v / top) * 100
  return (
    <div>
      <div className="relative" style={{ height }}>
        <svg viewBox={`0 0 ${w} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          {[25, 50, 75].map((g) => (
            <line key={g} x1="0" x2={w} y1={g} y2={g} stroke="var(--jk-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {series.map((s) => {
            const segments: string[] = []
            let current: string[] = []
            s.values.forEach((v, i) => {
              if (v === null) {
                if (current.length > 1) segments.push(current.join(' '))
                current = []
              } else current.push(`${i},${y(v)}`)
            })
            if (current.length > 1) segments.push(current.join(' '))
            return segments.map((pts, i) => (
              <polyline key={`${s.label}-${i}`} points={pts} fill="none" stroke={s.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            ))
          })}
        </svg>
        <span className="absolute top-0 left-1 text-[10px] text-subtle">
          {Math.round(top)} {unit}
        </span>
        <span className="absolute bottom-0 left-1 text-[10px] text-subtle">0 {unit}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-[11px] text-subtle">
        <div className="flex flex-wrap gap-3">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        {xLabels && (
          <span>
            {xLabels[0]} → {xLabels[1]}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pequenos blocos
// ---------------------------------------------------------------------------

export function Metric({ label, value, hint, accent = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; accent?: Accent }) {
  return (
    <div className="rounded-control border border-line bg-elevated p-3">
      <p className="text-[11px] tracking-wide text-subtle uppercase">{label}</p>
      <p className={cx('mt-1 text-lg font-semibold tabular-nums', accent === 'neutral' ? 'text-fg' : ACCENT_CLASSES[accent].text)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-subtle">{hint}</p>}
    </div>
  )
}

export function Unavailable({ children }: { children: ReactNode }) {
  return <span className="text-subtle italic">{children}</span>
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="selectable font-mono text-[11px] break-all text-muted">{children}</span>
}

export function JobProgressBar({ running, message, done, total, onCancel }: { running: boolean; message?: string; done?: number; total?: number | null; onCancel?: () => void }) {
  if (!running) return null
  return (
    <div className="space-y-2 rounded-control border border-line bg-elevated p-3">
      <div className="flex items-center justify-between gap-3">
        <Spinner label={message ?? 'Em andamento…'} />
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
      {total ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-performance transition-[width]" style={{ width: `${Math.min(100, ((done ?? 0) / total) * 100)}%` }} />
        </div>
      ) : null}
    </div>
  )
}
