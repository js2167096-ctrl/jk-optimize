/// <reference types="electron" />
// Ponto de entrada do JK Optimize Executor, executado em um processo separado
// (Electron utilityProcess). Aceita somente tarefas do catálogo.
import { execFile } from 'node:child_process'
import { getTask, validateParams } from './catalog'
import { TASK_IMPLEMENTATIONS } from './tasks'
import type { RunRequest, TaskContext, WorkerMessage } from './protocol'

const port = process.parentPort

function send(message: WorkerMessage): void {
  port.postMessage(message)
}

/** `net session` só funciona com privilégios de administrador. */
function checkElevation(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('net', ['session'], { windowsHide: true, timeout: 5000 }, (error) => {
      if (!error) return resolve(true)
      resolve(typeof error.code === 'number' ? false : null)
    })
  })
}

const context: TaskContext = { elevated: null }

async function handleRun(request: RunRequest): Promise<void> {
  try {
    const task = getTask(request.taskId)
    const implementation = TASK_IMPLEMENTATIONS[request.taskId]
    if (!task || !implementation) throw new Error('Tarefa não registrada no executor.')
    if (task.requiresElevation && context.elevated !== true) throw new Error('Esta tarefa exige privilégios de administrador.')
    const params = validateParams(task, request.params)
    const output = await implementation(params, context)
    send({ type: 'result', runId: request.runId, ok: true, output })
  } catch (error) {
    send({
      type: 'result',
      runId: request.runId,
      ok: false,
      error: { code: 'task-failed', message: error instanceof Error ? error.message : 'Falha desconhecida.' }
    })
  }
}

port.on('message', (event) => {
  const data = event.data as Partial<RunRequest> | null
  if (data?.type === 'run' && typeof data.runId === 'string' && typeof data.taskId === 'string') {
    void handleRun(data as RunRequest)
  }
})

void checkElevation().then((elevated) => {
  context.elevated = elevated
  send({ type: 'ready', pid: process.pid, elevated })
})
