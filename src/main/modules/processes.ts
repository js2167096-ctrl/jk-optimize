// Processos: lista, prioridade (com restauração) e encerramento seletivo.
import { AppFailure } from '../security/validate'
import { processProtection } from '../security/protection'
import { defineAction, defineQuery } from '../ops/registry'
import { int, noParams, obj, oneOf, str } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson, runPowerShellWith } from '../services/powershell'

/** Lista central em security/protection.ts (reexportada para compatibilidade). */
export { CRITICAL_PROCESSES } from '../security/protection'

export const PRIORITY_LEVELS = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'] as const
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]

export const PRIORITY_LABEL: Record<string, string> = {
  Idle: 'Baixa',
  BelowNormal: 'Abaixo do normal',
  Normal: 'Normal',
  AboveNormal: 'Acima do normal',
  High: 'Alta',
  RealTime: 'Tempo real'
}

export interface ProcessRow {
  pid: number
  name: string
  path: string | null
  company: string | null
  description: string | null
  sessionId: number
  priority: string | null
  startTime: string | null
  workingSet: number
  privateBytes: number
  cpuSeconds: number | null
  hasWindow: boolean
  windowTitle: string | null
  sameSession: boolean
  critical: boolean
  protectedReason: string | null
}

const LIST = `
$me = [Diagnostics.Process]::GetCurrentProcess()
$session = $me.SessionId
@(Get-Process | ForEach-Object {
  $p = $_
  $prio = $null; $start = $null; $path = $null; $cpu = $null
  try { $prio = [string]$p.PriorityClass } catch {}
  try { $start = $p.StartTime.ToUniversalTime().ToString('o') } catch {}
  try { $path = $p.Path } catch {}
  try { $cpu = $p.TotalProcessorTime.TotalSeconds } catch {}
  [pscustomobject]@{
    pid = $p.Id; name = $p.ProcessName; path = $path; company = $p.Company; description = $p.Description
    session = $p.SessionId; mySession = $session; priority = $prio; start = $start
    ws = $p.WorkingSet64; pb = $p.PrivateMemorySize64; cpu = $cpu
    hasWindow = ($p.MainWindowHandle -ne 0); title = $p.MainWindowTitle
  }
}) | ConvertTo-Json -Compress`

export const protectionReason = processProtection

export async function listProcesses(): Promise<ProcessRow[]> {
  const raw = await runPowerShellJson<unknown>(LIST, { timeoutMs: 30_000 })
  return asArray(raw).map((r) => {
    const p = r as Record<string, unknown>
    const pid = asNumber(p.pid) ?? 0
    const name = asString(p.name) ?? '?'
    const path = asString(p.path)
    const sessionId = asNumber(p.session) ?? 0
    const mySession = asNumber(p.mySession) ?? -1
    const reason = protectionReason(name, path, sessionId, mySession, process.pid, pid)
    return {
      pid,
      name,
      path,
      company: asString(p.company),
      description: asString(p.description),
      sessionId,
      priority: asString(p.priority),
      startTime: asString(p.start),
      workingSet: asNumber(p.ws) ?? 0,
      privateBytes: asNumber(p.pb) ?? 0,
      cpuSeconds: asNumber(p.cpu),
      hasWindow: p.hasWindow === true,
      windowTitle: asString(p.title),
      sameSession: sessionId === mySession,
      critical: reason !== null,
      protectedReason: reason
    }
  })
}

defineQuery({ id: 'processes.list', module: 'processes', parse: noParams, run: () => listProcesses() })

interface Target {
  pid: number
  startTime: string
}

function parseTarget(p: Record<string, unknown>): Target {
  return { pid: int(p.pid, 'processo', 1, 2 ** 31 - 1), startTime: str(p.startTime, 'início do processo', 40) }
}

async function findTarget(t: Target): Promise<ProcessRow> {
  const proc = (await listProcesses()).find((p) => p.pid === t.pid)
  if (!proc) throw new AppFailure('process-gone', 'O processo não está mais em execução.')
  if (proc.startTime !== t.startTime) throw new AppFailure('process-changed', 'O identificador agora pertence a outro processo.')
  return proc
}

const SET_PRIORITY = `
$p = Get-Process -Id $in.pid -ErrorAction Stop
$p.PriorityClass = [Diagnostics.ProcessPriorityClass]$in.level
$p.Refresh()
[pscustomobject]@{ now = [string]$p.PriorityClass } | ConvertTo-Json -Compress`

async function setPriority(pid: number, level: string): Promise<string> {
  try {
    const r = await runPowerShellWith<{ now: string }>(SET_PRIORITY, { pid, level })
    return r?.now ?? ''
  } catch (error) {
    throw new AppFailure('priority-denied', `O Windows recusou a alteração: ${(error as Error).message.split('\n')[0]}`)
  }
}

defineAction<Target & { level: PriorityLevel }, Target & { priority: string; name: string }>({
  id: 'processes.priority',
  module: 'processes',
  title: 'Alterar prioridade de processo',
  description: 'Muda a prioridade de CPU de um processo do usuário. Tempo real não é oferecido.',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  parse(raw) {
    const p = obj(raw, ['pid', 'startTime', 'level'])
    return { ...parseTarget(p), level: oneOf(p.level, 'prioridade', PRIORITY_LEVELS) }
  },
  async preview(params) {
    const proc = await findTarget(params)
    const warnings = [
      'A prioridade vale somente enquanto o processo estiver aberto.',
      ...(params.level === 'High' ? ['Prioridade Alta pode deixar outros programas e o próprio Windows menos responsivos.'] : []),
      ...(params.level === 'Idle' ? ['Prioridade Baixa faz o processo rodar só quando a CPU estiver ociosa.'] : [])
    ]
    return {
      summary: `${proc.name} (PID ${proc.pid})`,
      changes: [{ target: `Prioridade de ${proc.name}`, current: PRIORITY_LABEL[proc.priority ?? ''] ?? 'desconhecida', intended: PRIORITY_LABEL[params.level] }],
      warnings,
      blocked: proc.protectedReason ?? (proc.priority === null ? 'Sem permissão para ler a prioridade deste processo.' : proc.priority === params.level ? 'O processo já está nessa prioridade.' : null)
    }
  },
  async execute(params) {
    const proc = await findTarget(params)
    const now = await setPriority(proc.pid, params.level)
    const ok = now === params.level
    return {
      ok,
      verified: ok,
      summary: ok ? `${proc.name}: prioridade ${PRIORITY_LABEL[now]} (conferida).` : `O Windows manteve a prioridade ${PRIORITY_LABEL[now] ?? now}.`,
      change: ok
        ? {
            before: { pid: proc.pid, startTime: proc.startTime!, priority: proc.priority!, name: proc.name },
            after: { priority: now },
            summaryBefore: `${proc.name}: ${PRIORITY_LABEL[proc.priority!] ?? proc.priority}`,
            summaryAfter: `${proc.name}: ${PRIORITY_LABEL[now]}`
          }
        : undefined
    }
  },
  async revert(before, after, ctx) {
    const proc = await findTarget(before)
    const expected = (after as { priority: string }).priority
    if (proc.priority !== expected && !ctx.force) throw new AppFailure('state-changed', `A prioridade mudou depois (agora: ${PRIORITY_LABEL[proc.priority ?? ''] ?? proc.priority}).`)
    const now = await setPriority(proc.pid, before.priority)
    if (now !== before.priority) throw new AppFailure('revert-failed', 'O Windows não restaurou a prioridade.')
    return `${before.name}: prioridade ${PRIORITY_LABEL[now]} restaurada.`
  }
})

const END_PROCESS = `
$p = Get-Process -Id $in.pid -ErrorAction Stop
$closed = $false
if ($in.mode -eq 'close') {
  if ($p.MainWindowHandle -eq 0) { [pscustomobject]@{ result = 'no-window' } | ConvertTo-Json -Compress; return }
  [void]$p.CloseMainWindow()
  $closed = $p.WaitForExit(8000)
} else {
  Stop-Process -Id $in.pid -Force -ErrorAction Stop
  $closed = $p.WaitForExit(8000)
}
[pscustomobject]@{ result = if ($closed) { 'exited' } else { 'still-running' } } | ConvertTo-Json -Compress`

defineAction<Target & { mode: 'close' | 'force' }, never>({
  id: 'processes.end',
  module: 'processes',
  title: 'Encerrar processo',
  description: 'Fecha um processo do usuário: normalmente (pede para a janela fechar) ou de forma forçada.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Um processo encerrado não pode ser restaurado; dados não salvos no programa podem ser perdidos.',
  requiresElevation: false,
  parse(raw) {
    const p = obj(raw, ['pid', 'startTime', 'mode'])
    return { ...parseTarget(p), mode: oneOf(p.mode, 'modo', ['close', 'force'] as const) }
  },
  async preview(params) {
    const proc = await findTarget(params)
    return {
      summary: `${proc.name} (PID ${proc.pid})${proc.windowTitle ? ` — "${proc.windowTitle}"` : ''}`,
      changes: [{ target: proc.path ?? proc.name, current: 'Em execução', intended: params.mode === 'close' ? 'Fechamento normal solicitado' : 'Encerrado à força' }],
      warnings:
        params.mode === 'force'
          ? ['Encerramento forçado não permite que o programa salve dados.']
          : ['O programa pode pedir para salvar alterações antes de fechar.'],
      blocked: proc.protectedReason ?? (params.mode === 'close' && !proc.hasWindow ? 'Este processo não tem janela: só é possível o encerramento forçado.' : null)
    }
  },
  async execute(params) {
    const proc = await findTarget(params)
    let r: { result: string } | null
    try {
      r = await runPowerShellWith<{ result: string }>(END_PROCESS, { pid: proc.pid, mode: params.mode }, { timeoutMs: 20_000 })
    } catch (error) {
      throw new AppFailure('end-denied', `O Windows recusou: ${(error as Error).message.split('\n')[0]}`)
    }
    const exited = r?.result === 'exited'
    return {
      ok: exited,
      verified: true,
      summary: exited
        ? `${proc.name} foi encerrado (conferido).`
        : r?.result === 'no-window'
          ? 'O processo não tem janela para fechar.'
          : `${proc.name} continua em execução (o programa pode estar aguardando confirmação).`
    }
  }
})
