import { useEffect, useState } from 'react'
import { query } from '../services/ops'

interface OverlayData {
  settings: { scale: number; metrics: string[] }
  at: number | null
  cpuPct: number | null
  gpuPct: number | null
  ramPct: number | null
  tempC: number | null
  fps: number | null
  frametimeMs: number | null
  fpsSource: string | null
  fpsError: string | null
}

/** Janela do overlay: só exibe dados reais; o que não existe aparece como "—". */
export function Overlay() {
  const [data, setData] = useState<OverlayData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    let active = true
    const tick = () =>
      query<OverlayData>('monitoring.overlay.data')
        .then((d) => {
          if (!active) return
          setData(d)
          setError(null)
        })
        .catch((e: Error) => active && setError(e.message))
    void tick()
    const t = setInterval(tick, 1000)
    return () => {
      active = false
      clearInterval(t)
    }
  }, [])

  const fmt = (v: number | null, unit: string) => (v === null ? '—' : `${Math.round(v)}${unit}`)
  const rows: [string, string, string][] = data
    ? (
        [
          ['fps', 'FPS', data.fps === null ? '—' : String(data.fps)],
          ['frametime', 'Frametime', data.frametimeMs === null ? '—' : `${data.frametimeMs} ms`],
          ['cpu', 'CPU', fmt(data.cpuPct, '%')],
          ['gpu', 'GPU', fmt(data.gpuPct, '%')],
          ['ram', 'RAM', fmt(data.ramPct, '%')],
          ['temp', 'Temp', data.tempC === null ? 's/ sensor' : `${data.tempC} °C`]
        ] as [string, string, string][]
      ).filter(([id]) => data.settings.metrics.includes(id))
    : []

  return (
    <div className="h-screen w-screen select-none" style={{ fontSize: `${12 * (data?.settings.scale ?? 1)}px` }}>
      <div className="rounded-control border border-white/10 bg-black/70 px-3 py-2 font-mono text-white shadow-lg">
        <p className="mb-1 text-[0.8em] tracking-wider text-white/50 uppercase">JK Optimize</p>
        {error && <p className="text-[0.9em] text-red-300">{error}</p>}
        {rows.map(([id, label, value]) => (
          <div key={id} className="flex justify-between gap-4 leading-[1.6]">
            <span className="text-white/60">{label}</span>
            <span className="tabular-nums">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
