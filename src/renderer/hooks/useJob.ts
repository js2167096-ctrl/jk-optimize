import { useCallback, useEffect, useRef, useState } from 'react'
import type { JobProgress } from '@shared/types/ops'
import { api, errorMessage } from '../services/api'
import { newJobId, ops, query } from '../services/ops'

/** Executa uma consulta longa com progresso e cancelamento. */
export function useJob<T>() {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [partials, setPartials] = useState<unknown[]>([])
  const jobRef = useRef<string | null>(null)

  useEffect(
    () =>
      api.ops.onProgress((p) => {
        if (p.jobId !== jobRef.current) return
        setProgress(p)
        if (p.data !== undefined) setPartials((list) => [...list, p.data].slice(-2000))
      }),
    []
  )

  const run = useCallback(async (id: string, params?: unknown): Promise<T | null> => {
    const jobId = newJobId()
    jobRef.current = jobId
    setRunning(true)
    setError(null)
    setProgress(null)
    setPartials([])
    try {
      const data = await query<T>(id, params, jobId)
      setResult(data)
      return data
    } catch (e) {
      setError(errorMessage(e))
      return null
    } finally {
      jobRef.current = null
      setRunning(false)
    }
  }, [])

  const cancel = useCallback(() => {
    if (jobRef.current) void ops.cancel(jobRef.current)
  }, [])

  return { run, cancel, running, progress, result, error, partials, setResult }
}
