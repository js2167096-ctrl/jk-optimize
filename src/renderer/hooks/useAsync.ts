import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../services/api'

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
  setData: (value: T) => void
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const requestId = useRef(0)

  // `load` é recriado a cada render; as dependências explícitas controlam quando recarregar.
  const run = useCallback(load, deps)

  const reload = useCallback(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    run()
      .then((value) => id === requestId.current && setData(value))
      .catch((e) => id === requestId.current && setError(errorMessage(e)))
      .finally(() => id === requestId.current && setLoading(false))
  }, [run])

  useEffect(reload, [reload])

  return { data, error, loading, reload, setData }
}
