// Game Boost: aplica um perfil escolhido pelo usuário quando o FiveM inicia e
// restaura os ajustes temporários quando o jogo fecha. Fluxo:
// detectar processo → identificar perfil → verificar elegibilidade → guardar estado
// anterior → aplicar → validar → monitorar a sessão → restaurar → registrar.
// O estado anterior fica em disco para ser restaurado mesmo se o app for fechado.
import { Notification } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { AppFailure } from '../security/validate'
import { CRITICAL_PROCESSES } from '../security/protection'
import { defineQuery } from '../ops/registry'
import { bool, noParams, obj, oneOf, strList } from '../ops/params'
import { log } from '../ops/log'
import { JsonStore } from '../services/store'
import { runPowerShellWith } from '../services/powershell'
import { getPowerState, setActive } from './power'
import { applyGtaSettings, buildGraphicsProfile, hardwareProfile, parseGtaSettings, readSettingsFile, type GraphicsProfile } from './fivem'
import { TelemetryCollector, summarizeTelemetry, type TelemetrySummary } from './telemetry'

export interface GameBoostSettings {
  enabled: boolean
  powerPlan: 'none' | 'ultimate' | 'high' | 'balanced'
  priority: 'none' | 'AboveNormal' | 'High'
  closeApps: string[]
  graphicsProfile: 'none' | GraphicsProfile
  notify: boolean
  recordSession: boolean
}

const DEFAULTS: GameBoostSettings = { enabled: false, powerPlan: 'none', priority: 'none', closeApps: [], graphicsProfile: 'none', notify: true, recordSession: true }
const EXE = /^[A-Za-z0-9 _.()-]{1,80}\.exe$/

export function parseBoostSettings(raw: unknown): GameBoostSettings {
  const p = obj(raw, ['enabled', 'powerPlan', 'priority', 'closeApps', 'graphicsProfile', 'notify', 'recordSession'])
  const closeApps = strList(p.closeApps ?? [], 'aplicativos', 20, 84, EXE)
  for (const app of closeApps) {
    const name = app.replace(/\.exe$/i, '').toLowerCase()
    if (CRITICAL_PROCESSES.has(name) || /^(fivem|gta5|fivem_.*)$/i.test(name)) throw new AppFailure('invalid-input', `${app} não pode ser encerrado pelo Game Boost.`)
  }
  return {
    enabled: bool(p.enabled, 'ativado', false),
    powerPlan: oneOf(p.powerPlan, 'plano', ['none', 'ultimate', 'high', 'balanced'] as const, 'none'),
    priority: oneOf(p.priority, 'prioridade', ['none', 'AboveNormal', 'High'] as const, 'none'),
    closeApps: [...new Set(closeApps.map((a) => a.toLowerCase()))],
    graphicsProfile: oneOf(p.graphicsProfile, 'perfil gráfico', ['none', 'performance', 'balanced', 'quality'] as const, 'none'),
    notify: bool(p.notify, 'notificações', true),
    recordSession: bool(p.recordSession, 'registrar sessão', true)
  }
}

const settings = new JsonStore<GameBoostSettings>('gameboost.json', (raw) => {
  try {
    return raw ? parseBoostSettings({ ...DEFAULTS, ...(raw as object) }) : DEFAULTS
  } catch {
    return DEFAULTS
  }
})

export interface BoostOperation {
  op: string
  status: 'ok' | 'failed' | 'skipped'
  detail: string
  reverted: boolean | null
}

export interface BoostSession {
  id: string
  startedAt: string
  endedAt: string | null
  settings: GameBoostSettings
  operations: BoostOperation[]
  telemetry: TelemetrySummary | null
  notReverted: string[]
}

const sessions = new JsonStore<BoostSession[]>('gameboost-sessions.json', (raw) => (Array.isArray(raw) ? (raw as BoostSession[]).slice(0, 50) : []))

/** Estado temporário a restaurar (persistido para sobreviver ao fechamento do app). */
interface PendingRestore {
  sessionId: string
  powerPlan: string | null
  graphics: { path: string; original: Record<string, string>; applied: Record<string, string> } | null
}
const pending = new JsonStore<PendingRestore | null>('gameboost-pending.json', (raw) => (raw && typeof raw === 'object' && 'sessionId' in (raw as object) ? (raw as PendingRestore) : null))

// ---------------------------------------------------------------------------
// Detecção de processos (tasklist: leve, sem PowerShell a cada ciclo)
// ---------------------------------------------------------------------------

function listProcessNames(): Promise<{ name: string; pid: number }[]> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      resolve(
        stdout
          .split(/\r?\n/)
          .map((l) => /^"([^"]+)","(\d+)"/.exec(l))
          .filter((m): m is RegExpExecArray => !!m)
          .map((m) => ({ name: m[1], pid: Number(m[2]) }))
      )
    })
  })
}

export const isLauncher = (n: string) => /^fivem\.exe$/i.test(n)
export const isGameProcess = (n: string) => /^(fivem_.*gtaprocess\.exe|gta5\.exe|gta5_enhanced\.exe)$/i.test(n)

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

let current: { session: BoostSession; collector: TelemetryCollector | null; prioritized: Set<number>; alerted: Set<string> } | null = null
let timer: NodeJS.Timeout | null = null
let missing = 0

function notify(enabled: boolean, title: string, body: string): void {
  if (enabled && Notification.isSupported()) new Notification({ title: `JK Optimize · Game Boost: ${title}`, body }).show()
}

async function planGuid(choice: GameBoostSettings['powerPlan']): Promise<string | null> {
  if (choice === 'none') return null
  const state = await getPowerState()
  const pick = choice === 'ultimate' ? state.schemes.find((s) => s.ultimate) : choice === 'high' ? state.schemes.find((s) => s.guid === '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c') : state.schemes.find((s) => s.guid === '381b4222-f694-41f0-9685-ff5bb260df2e')
  return pick?.guid ?? null
}

const CLOSE_BY_NAME = `
$out = foreach ($p in @(Get-Process -Name $in.name -ErrorAction SilentlyContinue)) {
  if ($p.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { continue }
  $closed = $false
  if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow(); $closed = $p.WaitForExit(6000) }
  [pscustomobject]@{ pid = $p.Id; closed = $closed; window = ($p.MainWindowHandle -ne 0) }
}
@($out) | ConvertTo-Json -Compress`

const SET_PRIORITY = `$p = Get-Process -Id $in.pid -ErrorAction Stop; $p.PriorityClass = [Diagnostics.ProcessPriorityClass]$in.level; $p.Refresh(); [pscustomobject]@{ now = [string]$p.PriorityClass } | ConvertTo-Json -Compress`

/** Aplica as operações autorizadas no início da sessão; cada uma é independente. */
async function beginSession(cfg: GameBoostSettings): Promise<void> {
  const session: BoostSession = { id: randomUUID(), startedAt: new Date().toISOString(), endedAt: null, settings: cfg, operations: [], telemetry: null, notReverted: [] }
  const restore: PendingRestore = { sessionId: session.id, powerPlan: null, graphics: null }
  const ops = session.operations

  if (cfg.powerPlan !== 'none') {
    try {
      const guid = await planGuid(cfg.powerPlan)
      const before = (await getPowerState()).active
      if (!guid) ops.push({ op: 'Plano de energia', status: 'skipped', detail: 'Plano escolhido não existe neste computador.', reverted: null })
      else if (before?.guid === guid) ops.push({ op: 'Plano de energia', status: 'skipped', detail: 'Já estava ativo.', reverted: null })
      else {
        await setActive(guid)
        restore.powerPlan = before?.guid ?? null
        ops.push({ op: 'Plano de energia', status: 'ok', detail: `${before?.name ?? '—'} → ${(await getPowerState()).active?.name} (conferido)`, reverted: false })
      }
    } catch (error) {
      ops.push({ op: 'Plano de energia', status: 'failed', detail: (error as Error).message, reverted: null })
    }
  }

  if (cfg.graphicsProfile !== 'none') {
    try {
      const data = readSettingsFile('fivem')
      if (!data) ops.push({ op: 'Configurações gráficas', status: 'skipped', detail: 'Arquivo gta5_settings.xml do FiveM não encontrado.', reverted: null })
      else {
        const changes = buildGraphicsProfile(data.values, await hardwareProfile(), cfg.graphicsProfile)
        if (changes.length === 0) ops.push({ op: 'Configurações gráficas', status: 'skipped', detail: 'O arquivo já está com os valores do perfil.', reverted: null })
        else {
          const applied = Object.fromEntries(changes.map((c) => [c.key, c.recommended]))
          writeFileSync(data.path, applyGtaSettings(data.xml, applied), 'utf8')
          const check = parseGtaSettings(readFileSync(data.path, 'utf8'))
          if (!changes.every((c) => check[c.key] === c.recommended)) throw new Error('valores gravados não conferem')
          restore.graphics = { path: data.path, original: Object.fromEntries(changes.map((c) => [c.key, c.current])), applied }
          ops.push({ op: 'Configurações gráficas', status: 'ok', detail: `${changes.length} ajuste(s) do perfil aplicados e conferidos`, reverted: false })
        }
      }
    } catch (error) {
      ops.push({ op: 'Configurações gráficas', status: 'failed', detail: (error as Error).message, reverted: null })
    }
  }

  for (const app of cfg.closeApps) {
    try {
      const r = (await runPowerShellWith<unknown>(CLOSE_BY_NAME, { name: app.replace(/\.exe$/i, '') }, { timeoutMs: 30_000 })) as { pid: number; closed: boolean; window: boolean }[] | { pid: number; closed: boolean; window: boolean } | null
      const list = Array.isArray(r) ? r : r ? [r] : []
      if (list.length === 0) ops.push({ op: `Fechar ${app}`, status: 'skipped', detail: 'Não estava aberto.', reverted: null })
      else {
        const closed = list.filter((x) => x.closed).length
        ops.push({ op: `Fechar ${app}`, status: closed === list.length ? 'ok' : 'failed', detail: `${closed} de ${list.length} instância(s) fechadas normalmente${closed < list.length ? ' (sem janela ou aguardando o usuário; não é forçado)' : ''}`, reverted: null })
      }
    } catch (error) {
      ops.push({ op: `Fechar ${app}`, status: 'failed', detail: (error as Error).message, reverted: null })
    }
  }

  pending.write(restore)
  const collector = cfg.recordSession ? new TelemetryCollector('gameboost') : null
  current = { session, collector, prioritized: new Set(), alerted: new Set() }
  collector?.start((p) => {
    if (!current) return
    if ((p.commit ?? 0) >= 90 && !current.alerted.has('mem')) {
      current.alerted.add('mem')
      notify(cfg.notify, 'pressão de memória', `Memória comprometida em ${p.commit}% durante o jogo.`)
    }
    if ((p.temp ?? 0) >= 90 && !current.alerted.has('temp')) {
      current.alerted.add('temp')
      notify(cfg.notify, 'temperatura alta', `${p.temp} °C durante o jogo.`)
    }
  })
  const failed = ops.filter((o) => o.status === 'failed').length
  log.info('fivem', `Game Boost: sessão iniciada — ${ops.filter((o) => o.status === 'ok').length} ajuste(s) aplicados, ${failed} falha(s).`)
  notify(cfg.notify, 'ativado', failed ? `Aplicado parcialmente (${failed} falha(s)). Veja o histórico no app.` : 'Perfil aplicado para esta sessão do FiveM.')
}

async function prioritize(procs: { name: string; pid: number }[]): Promise<void> {
  if (!current || current.session.settings.priority === 'none') return
  for (const p of procs.filter((x) => isGameProcess(x.name) && !current!.prioritized.has(x.pid))) {
    current.prioritized.add(p.pid)
    try {
      const r = await runPowerShellWith<{ now: string }>(SET_PRIORITY, { pid: p.pid, level: current.session.settings.priority })
      const ok = r?.now === current.session.settings.priority
      current.session.operations.push({ op: `Prioridade de ${p.name}`, status: ok ? 'ok' : 'failed', detail: ok ? `${r?.now} (conferido; vale até o processo fechar)` : `O Windows manteve ${r?.now}`, reverted: null })
    } catch (error) {
      current.session.operations.push({ op: `Prioridade de ${p.name}`, status: 'failed', detail: (error as Error).message.split('\n')[0], reverted: null })
    }
  }
}

/** Restaura o estado temporário (também usado na abertura do app após um encerramento inesperado). */
export async function restorePending(reason: string): Promise<string[]> {
  const state = pending.read()
  if (!state) return []
  const notReverted: string[] = []
  const done: string[] = []
  if (state.powerPlan) {
    try {
      await setActive(state.powerPlan)
      done.push('Plano de energia')
    } catch (error) {
      notReverted.push(`Plano de energia: ${(error as Error).message}`)
    }
  }
  if (state.graphics && existsSync(state.graphics.path)) {
    try {
      const xml = readFileSync(state.graphics.path, 'utf8')
      const values = parseGtaSettings(xml)
      // Só restaura as chaves que continuam com o valor aplicado pelo Game Boost
      // (se o usuário mudou algo dentro do jogo, a escolha dele é mantida).
      const restorable = Object.fromEntries(Object.entries(state.graphics.original).filter(([k]) => values[k] === state.graphics!.applied[k]))
      const kept = Object.keys(state.graphics.original).filter((k) => !(k in restorable))
      if (Object.keys(restorable).length) {
        writeFileSync(state.graphics.path, applyGtaSettings(xml, restorable), 'utf8')
        const check = parseGtaSettings(readFileSync(state.graphics.path, 'utf8'))
        if (!Object.entries(restorable).every(([k, v]) => check[k] === v)) throw new Error('valores restaurados não conferem')
      }
      done.push('Configurações gráficas')
      if (kept.length) notReverted.push(`Gráficos mantidos porque foram alterados no jogo: ${kept.join(', ')}`)
    } catch (error) {
      notReverted.push(`Configurações gráficas: ${(error as Error).message}`)
    }
  }
  pending.write(null)
  log[notReverted.length ? 'warn' : 'info']('fivem', `Game Boost: restauração (${reason}) — restaurado: ${done.join(', ') || 'nada'}${notReverted.length ? `; não revertido: ${notReverted.join('; ')}` : ''}.`)
  return notReverted
}

async function endSession(): Promise<void> {
  if (!current) return
  const { session, collector } = current
  current = null
  session.telemetry = collector ? collector.stop() : null
  session.notReverted = await restorePending('jogo fechado')
  for (const op of session.operations) if (op.reverted === false) op.reverted = !session.notReverted.some((n) => n.startsWith(op.op))
  session.endedAt = new Date().toISOString()
  sessions.write([session, ...sessions.read()].slice(0, 50))
  notify(session.settings.notify, 'sessão encerrada', session.notReverted.length ? `Algumas alterações não foram revertidas: ${session.notReverted.join('; ')}` : 'Ajustes temporários restaurados.')
}

async function tick(): Promise<void> {
  const cfg = settings.read()
  const procs = await listProcessNames()
  const running = procs.some((p) => isLauncher(p.name) || isGameProcess(p.name))
  if (running) {
    missing = 0
    if (!current && cfg.enabled) await beginSession(cfg)
    await prioritize(procs)
  } else if (current) {
    // Duas leituras seguidas sem o jogo evitam encerrar na troca launcher → jogo.
    if (++missing >= 2) await endSession()
  }
}

function schedule(): void {
  if (timer) clearInterval(timer)
  timer = setInterval(() => void tick().catch((e) => log.error('fivem', `Game Boost: ${(e as Error).message}`)), 4000)
}

export async function startGameBoost(): Promise<void> {
  // Restaura o que ficou pendente se o app foi fechado durante uma sessão.
  const state = pending.read()
  if (state) {
    const procs = await listProcessNames()
    if (!procs.some((p) => isLauncher(p.name) || isGameProcess(p.name))) await restorePending('abertura do app após encerramento inesperado')
  }
  schedule()
}

export function stopGameBoost(): void {
  if (timer) clearInterval(timer)
  timer = null
}

defineQuery({ id: 'gameboost.settings', module: 'fivem', parse: noParams, run: async () => settings.read() })

defineQuery({
  id: 'gameboost.settings.save',
  module: 'fivem',
  parse: (raw) => parseBoostSettings(raw),
  async run(cfg) {
    settings.write(cfg)
    log.info('fivem', `Game Boost ${cfg.enabled ? 'ativado' : 'desativado'} (plano: ${cfg.powerPlan}, prioridade: ${cfg.priority}, gráficos: ${cfg.graphicsProfile}, fechar: ${cfg.closeApps.join(', ') || 'nenhum'}).`)
    return cfg
  }
})

defineQuery({
  id: 'gameboost.status',
  module: 'fivem',
  parse: noParams,
  async run() {
    const cfg = settings.read()
    return {
      enabled: cfg.enabled,
      watching: timer !== null,
      active: current ? { id: current.session.id, startedAt: current.session.startedAt, operations: current.session.operations, samples: current.collector?.points.length ?? 0, telemetry: current.collector ? summarizeTelemetry(current.collector.points) : null } : null,
      pendingRestore: pending.read() !== null && !current
    }
  }
})

defineQuery({ id: 'gameboost.sessions', module: 'fivem', parse: noParams, run: async () => sessions.read() })
