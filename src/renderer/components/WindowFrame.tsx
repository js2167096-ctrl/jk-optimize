// Moldura da janela sem borda nativa: cantos externos arredondados, botões de minimizar,
// maximizar/restaurar e fechar, faixa de arraste e bordas próprias de redimensionamento
// (no Windows, janelas transparentes não redimensionam pela borda do sistema).
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { api } from '../services/api'
import { cx } from './ui'

const MIN_W = 1024
const MIN_H = 680

export function WindowControls() {
  const maximized = useMaximized()
  const btn = 'no-drag grid h-9 w-11 place-items-center rounded-[8px] text-muted transition-colors hover:bg-surface-3 hover:text-fg'
  return (
    <div className="flex items-center gap-0.5" data-window-controls>
      <button type="button" aria-label="Minimizar" className={btn} onClick={() => void api.window.minimize()}>
        <Minus className="size-4" />
      </button>
      <button type="button" aria-label={maximized ? 'Restaurar' : 'Maximizar'} className={btn} onClick={() => void api.window.toggleMaximize()}>
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </button>
      <button type="button" aria-label="Fechar" className={cx(btn, 'hover:bg-[#e81123] hover:text-white')} onClick={() => void api.window.close()}>
        <X className="size-4" />
      </button>
    </div>
  )
}

let maximizedState = false
const listeners = new Set<(v: boolean) => void>()
let subscribed = false

function useMaximized(): boolean {
  const [value, setValue] = useState(maximizedState)
  useEffect(() => {
    listeners.add(setValue)
    if (!subscribed) {
      subscribed = true
      void api.window.isMaximized().then((r) => r.ok && broadcast(r.data))
      api.window.onState((s) => broadcast(s.maximized))
    }
    return () => {
      listeners.delete(setValue)
    }
  }, [])
  return value
}

function broadcast(v: boolean) {
  maximizedState = v
  for (const l of listeners) l(v)
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EDGES: { edge: Edge; className: string; cursor: string }[] = [
  { edge: 'n', className: 'top-0 left-3 right-3 h-1', cursor: 'ns-resize' },
  { edge: 's', className: 'bottom-0 left-3 right-3 h-1', cursor: 'ns-resize' },
  { edge: 'e', className: 'right-0 top-3 bottom-3 w-1', cursor: 'ew-resize' },
  { edge: 'w', className: 'left-0 top-3 bottom-3 w-1', cursor: 'ew-resize' },
  { edge: 'ne', className: 'top-0 right-0 size-3', cursor: 'nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 size-3', cursor: 'nesw-resize' },
  { edge: 'nw', className: 'top-0 left-0 size-3', cursor: 'nwse-resize' },
  { edge: 'se', className: 'bottom-0 right-0 size-3', cursor: 'nwse-resize' }
]

function ResizeEdges() {
  const drag = useRef<{ edge: Edge; sx: number; sy: number; x: number; y: number; w: number; h: number } | null>(null)
  const frame = useRef<number | null>(null)

  const down = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { edge, sx: e.screenX, sy: e.screenY, x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight }
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.screenX - d.sx
    const dy = e.screenY - d.sy
    let { x, y, w, h } = d
    if (d.edge.includes('e')) w = Math.max(MIN_W, d.w + dx)
    if (d.edge.includes('s')) h = Math.max(MIN_H, d.h + dy)
    if (d.edge.includes('w')) {
      w = Math.max(MIN_W, d.w - dx)
      x = d.x + (d.w - w)
    }
    if (d.edge.includes('n')) {
      h = Math.max(MIN_H, d.h - dy)
      y = d.y + (d.h - h)
    }
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      void api.window.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) })
    })
  }
  const up = () => {
    drag.current = null
  }

  return (
    <>
      {EDGES.map(({ edge, className, cursor }) => (
        <div
          key={edge}
          data-resize={edge}
          className={cx('no-drag absolute z-[60]', className)}
          style={{ cursor }}
          onPointerDown={down(edge)}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      ))}
    </>
  )
}

/** Envolve todo o aplicativo: contorno arredondado (exceto maximizado), arraste e controles. */
export function WindowFrame({ children }: { children: ReactNode }) {
  const maximized = useMaximized()
  return (
    <div
      data-window-frame
      data-maximized={maximized}
      // translateZ(0): diálogos e telas cheias (position: fixed) ficam contidos na janela e respeitam os cantos arredondados.
      className={cx('relative flex h-full flex-col overflow-hidden bg-bg [transform:translateZ(0)]', !maximized && 'rounded-[var(--jk-window-radius)] border border-line-strong')}
    >
      {/* Faixa de arraste no topo; elementos interativos dentro dela usam no-drag. */}
      <div className="drag absolute inset-x-0 top-0 z-0 h-11" />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</div>
      {/* Depois do conteúdo no DOM: o Chromium resolve as regiões de arraste pela ordem, e os botões (no-drag) precisam vencer o cabeçalho (drag). */}
      <div className="no-drag absolute top-1 right-1.5 z-50">
        <WindowControls />
      </div>
      {!maximized && <ResizeEdges />}
    </div>
  )
}
