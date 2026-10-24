import { query } from '../services/ops'
import { useAsync } from './useAsync'

/** Consulta registrada no processo principal, recarregada quando `params` muda. */
export function useQuery<T>(id: string, params?: unknown) {
  const key = JSON.stringify(params ?? {})
  return useAsync(() => query<T>(id, params), [id, key])
}
