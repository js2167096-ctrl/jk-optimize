import { useId } from 'react'

/** Gráfico de linha simples em SVG para séries de 0 a 100. */
export function Sparkline({ values, color, height = 72 }: { values: (number | null)[]; color: string; height?: number }) {
  const gradientId = useId()
  const points = values.map((v, i) => ({ x: i, y: v })).filter((p): p is { x: number; y: number } => p.y !== null)
  const width = Math.max(values.length - 1, 1)

  if (points.length < 2) {
    return (
      <div className="grid place-items-center text-[12px] text-subtle" style={{ height }}>
        Coletando amostras…
      </div>
    )
  }

  const line = points.map((p) => `${p.x},${100 - p.y}`).join(' ')
  const area = `${points[0].x},100 ${line} ${points[points.length - 1].x},100`
  return (
    <svg viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((y) => (
        <line key={y} x1="0" x2={width} y1={y} y2={y} stroke="var(--jk-line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      <polygon points={area} fill={`url(#${gradientId})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}
