// Mensagens trocadas entre o processo principal e o processo do executor.
import type { AppError, TaskOutput, TaskParamValue } from '@shared/types'

export interface RunRequest {
  type: 'run'
  runId: string
  taskId: string
  params: Record<string, TaskParamValue>
}

export type WorkerMessage =
  | { type: 'ready'; pid: number; elevated: boolean | null }
  | { type: 'result'; runId: string; ok: true; output: TaskOutput }
  | { type: 'result'; runId: string; ok: false; error: AppError }

export interface TaskContext {
  elevated: boolean | null
}

export type TaskImplementation = (params: Record<string, TaskParamValue>, ctx: TaskContext) => Promise<TaskOutput>
