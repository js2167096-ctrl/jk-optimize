import type { AppError, Result } from '@shared/types'

export const api = window.jk

export class ApiError extends Error {
  readonly code: string
  constructor(error: AppError) {
    super(error.message)
    this.code = error.code
  }
}

/** Converte o Result do IPC em valor ou exceção. */
export async function call<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new ApiError(result.error)
  return result.data
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Erro inesperado.'
}
