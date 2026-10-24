// Lado do processo principal: inicia o executor, valida pedidos, aplica as
// regras de confirmação/privilégio e registra o histórico.
import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AppError, ExecutorStatus, TaskOutput, TaskRunRecord } from '@shared/types'
import { EXECUTOR_NAME, MAX_HISTORY_ENTRIES } from '@shared/constants/app'
import { AppFailure, expectBoolean, expectRecord, expectString } from '../security/validate'
import { JsonStore } from '../services/store'
import { getTask, ParamError, TASK_CATALOG, validateParams } from './catalog'
import type { WorkerMessage } from './protocol'

const START_TIMEOUT_MS = 10_000
const RUN_TIMEOUT_MS = 120_000

type Outcome = { ok: true; output: TaskOutput } | { ok: false; error: AppError }

let child: UtilityProcess | null = null
let status: ExecutorStatus = { state: 'stopped', pid: null, startedAt: null, elevated: null, message: null }
let starting: Promise<ExecutorStatus> | null = null
const pending = new Map<string, (outcome: Outcome) => void>()

const history = new JsonStore<TaskRunRecord[]>('executor-history.json', (raw) =>
  Array.isArray(raw) ? (raw as TaskRunRecord[]).filter((r) => typeof r?.runId === 'string').slice(0, MAX_HISTORY_ENTRIES) : []
)

export function getExecutorStatus(): ExecutorStatus {
  return status
}

export function startExecutor(): Promise<ExecutorStatus> {
  if (child && status.state === 'ready') return Promise.resolve(status)
  if (starting) return starting

  status = { state: 'starting', pid: null, startedAt: null, elevated: null, message: null }
  starting = new Promise<ExecutorStatus>((resolve) => {
    const proc = utilityProcess.fork(join(__dirname, 'executor-worker.js'), [], {
      serviceName: EXECUTOR_NAME,
      stdio: 'ignore'
    })
    child = proc
    let settled = false
    const finish = (next: ExecutorStatus): void => {
      status = next
      if (!settled) {
        settled = true
        clearTimeout(timer)
        starting = null
        resolve(status)
      }
    }
    const timer = setTimeout(() => {
      finish({ state: 'unavailable', pid: null, startedAt: null, elevated: null, message: 'O executor não respondeu a tempo.' })
      proc.kill()
    }, START_TIMEOUT_MS)

    proc.on('message', (message: WorkerMessage) => {
      if (message?.type === 'ready') {
        finish({ state: 'ready', pid: message.pid, startedAt: new Date().toISOString(), elevated: message.elevated, message: null })
      } else if (message?.type === 'result') {
        pending.get(message.runId)?.(message.ok ? { ok: true, output: message.output } : { ok: false, error: message.error })
      }
    })

    proc.on('exit', (code) => {
      if (child === proc) child = null
      for (const reject of pending.values()) reject({ ok: false, error: { code: 'executor-exited', message: 'O executor foi encerrado durante a tarefa.' } })
      pending.clear()
      const wasReady = status.state === 'ready'
      finish({
        state: wasReady ? 'stopped' : 'unavailable',
        pid: null,
        startedAt: null,
        elevated: null,
        message: status.message ?? `Processo encerrado (código ${code}).`
      })
    })
  })
  return starting
}

export async function restartExecutor(): Promise<ExecutorStatus> {
  if (child) {
    const proc = child
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
      proc.kill()
    })
  }
  return startExecutor()
}

export function stopExecutor(): void {
  child?.kill()
}

export async function runTask(rawInput: unknown): Promise<TaskRunRecord> {
  const input = expectRecord(rawInput, 'tarefa', ['taskId', 'params', 'confirmed'])
  const taskId = expectString(input.taskId, 'taskId', 64, 1)
  const confirmed = expectBoolean(input.confirmed, 'confirmed')
  const task = getTask(taskId)
  if (!task) throw new AppFailure('unknown-task', 'Tarefa não encontrada no catálogo do executor.')

  let params
  try {
    params = validateParams(task, input.params ?? {})
  } catch (error) {
    if (error instanceof ParamError) throw new AppFailure('invalid-params', error.message)
    throw error
  }
  if (task.changesSystem && !confirmed) {
    throw new AppFailure('confirmation-required', 'Esta tarefa altera o sistema e precisa de confirmação.')
  }
  if (task.requiresElevation && status.elevated !== true) {
    throw new AppFailure('elevation-required', 'Esta tarefa exige privilégios de administrador. A elevação sob demanda ainda não foi implementada.')
  }
  if (!child || status.state !== 'ready') {
    throw new AppFailure('executor-unavailable', 'O executor não está disponível. Reinicie-o na tela do Executor.')
  }

  const runId = randomUUID()
  const started = Date.now()
  const proc = child
  const outcome = await new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(runId)
      resolve({ ok: false, error: { code: 'timeout', message: 'A tarefa excedeu o tempo limite.' } })
    }, RUN_TIMEOUT_MS)
    pending.set(runId, (result) => {
      clearTimeout(timer)
      pending.delete(runId)
      resolve(result)
    })
    proc.postMessage({ type: 'run', runId, taskId, params })
  })
  const finished = Date.now()

  const record: TaskRunRecord = {
    runId,
    taskId,
    taskName: task.name,
    params,
    ok: outcome.ok,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    output: outcome.ok ? outcome.output : null,
    error: outcome.ok ? null : outcome.error
  }
  history.write([record, ...history.read()].slice(0, MAX_HISTORY_ENTRIES))
  return record
}

export function listTasks() {
  return TASK_CATALOG
}

export function getHistory(): TaskRunRecord[] {
  return history.read()
}

export function clearHistory(): TaskRunRecord[] {
  return history.write([])
}
