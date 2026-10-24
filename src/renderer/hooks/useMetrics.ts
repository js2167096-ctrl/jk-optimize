import { useEffect, useState } from 'react'
import type { LiveMetrics } from '@shared/types'
import { api, call } from '../services/api'

/** Consulta métricas reais em intervalo e guarda as últimas amostras para os gráficos. */
export function useMetrics(intervalSeconds: number, historySize = 60) {
  const [latest, setLatest] = useState<LiveMetrics | null>(null)
  const [history, setHistory] = useState<LiveMetrics[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const tick = () =>
      call(api.system.getMetrics())
        .then((m) => {
          if (!active) return
          setLatest(m)
          setError(null)
          setHistory((h) => [...h, m].slice(-historySize))
        })
        .catch((e: Error) => active && setError(e.message))
    void tick()
    const timer = setInterval(tick, intervalSeconds * 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [intervalSeconds, historySize])

  return { latest, history, error }
}
