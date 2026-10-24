// Operações da Central de Otimização que ainda não existiam: GPU, tarefas agendadas,
// recursos opcionais do Windows, controle e lote de serviços, perfis de serviços,
// Lixeira e abertura de páginas oficiais. Tudo passa pelo registro de operações
// (prévia, confirmação, UAC quando preciso, backup e reversão).
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { formatBytes } from '@shared/format'
import { catalogApp } from '@shared/constants/apps-catalog'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, oneOf, str } from '../ops/params'
import { AppFailure } from '../security/validate'
import { explainWinError, winErrorFromText } from '../security/protection'
import { JsonStore } from '../services/store'
import { asArray, asNumber, asString, runPowerShellJson, runPowerShellWith } from '../services/powershell'
import { runElevated } from '../services/elevated'
import { log } from '../ops/log'
import { listServices, type ServiceRow } from './services'
import { compareProfile, featureProtection, gpuKind, gpuVendor, taskProtection, validAffinityMask, type GpuVendor, type Mode } from './central-rules'
export { compareProfile, featureProtection, gpuKind, gpuVendor, taskProtection, validAffinityMask }
import { listProcesses } from './processes'

// ---------------------------------------------------------------------------
// Aplicativos: abre a página oficial (nada é baixado ou executado)
// ---------------------------------------------------------------------------

defineQuery({
  id: 'apps.catalog.open',
  module: 'apps',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'aplicativo', 40, /^[a-z0-9-]+$/) }),
  async run({ id }) {
    const app = catalogApp(id)
    if (!app) throw new AppFailure('not-found', 'Aplicativo não está no catálogo.')
    const url = new URL(app.url)
    if (url.protocol !== 'https:') throw new AppFailure('not-allowed', 'Só páginas https são abertas.')
    await shell.openExternal(url.toString())
    return { opened: url.toString() }
  }
})

// ---------------------------------------------------------------------------
// GPU Control Center: detecção dinâmica
// ---------------------------------------------------------------------------

const GPU_SCRIPT = `
$cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
$mem = @{}
foreach ($k in Get-ChildItem $cls -ErrorAction SilentlyContinue) {
  $p = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
  if ($p -and $p.DriverDesc) { $q = $p.'HardwareInformation.qwMemorySize'; if ($q) { $mem[[string]$p.DriverDesc] = [int64]$q } }
}
$gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; maker = $_.AdapterCompatibility; driver = $_.DriverVersion; date = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }
    pnp = $_.PNPDeviceID; ram = $_.AdapterRAM; mem = $mem[[string]$_.Name]; status = $_.Status; w = $_.CurrentHorizontalResolution; h = $_.CurrentVerticalResolution; hz = $_.CurrentRefreshRate }
})
$panels = @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA Control Panel|AMD Software|Radeon Software|Intel.*(Graphics|Arc)' } | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.AppID } })
[pscustomobject]@{ gpus = $gpus; panels = $panels } | ConvertTo-Json -Depth 4 -Compress`

export interface GpuInfo {
  index: number
  name: string
  vendor: GpuVendor
  kind: 'integrated' | 'dedicated' | 'unknown'
  kindBasis: string
  driverVersion: string | null
  driverDate: string | null
  /** Memória dedicada em bytes (registro do driver; o valor do WMI é limitado a 4 GB). */
  memoryBytes: number | null
  status: string | null
  resolution: string | null
  panel: { name: string; id: string } | null
}

let lastPanels = new Set<string>()

export async function detectGpus(): Promise<{ gpus: GpuInfo[]; detectedAt: string; error: string | null }> {
  try {
    const raw = await runPowerShellJson<{ gpus: unknown; panels: unknown }>(GPU_SCRIPT, { timeoutMs: 45_000 })
    const panels = asArray(raw?.panels).map((p) => p as { name: string; id: string })
    lastPanels = new Set(panels.map((p) => p.id))
    const gpus: GpuInfo[] = asArray(raw?.gpus).map((g, index) => {
      const r = g as Record<string, unknown>
      const name = String(r.name ?? 'GPU desconhecida')
      const vendor = gpuVendor(asString(r.pnp), name, asString(r.maker))
      const { kind, basis } = gpuKind(vendor, name)
      const w = asNumber(r.w)
      const h = asNumber(r.h)
      const hz = asNumber(r.hz)
      const panelRe = vendor === 'nvidia' ? /nvidia/i : vendor === 'amd' ? /amd|radeon/i : vendor === 'intel' ? /intel/i : null
      return {
        index,
        name,
        vendor,
        kind,
        kindBasis: basis,
        driverVersion: asString(r.driver),
        driverDate: asString(r.date),
        memoryBytes: asNumber(r.mem) ?? asNumber(r.ram),
        status: asString(r.status),
        resolution: w && h ? `${w}×${h}${hz ? ` @ ${hz} Hz` : ''}` : null,
        panel: panelRe ? (panels.find((p) => panelRe.test(p.name)) ?? null) : null
      }
    })
    return { gpus, detectedAt: new Date().toISOString(), error: null }
  } catch (error) {
    return { gpus: [], detectedAt: new Date().toISOString(), error: `Não foi possível consultar a placa de vídeo: ${(error as Error).message.split('\n')[0]}` }
  }
}

defineQuery({ id: 'gpu.detect', module: 'performance', parse: noParams, run: () => detectGpus() })

defineQuery({
  id: 'gpu.panel.open',
  module: 'performance',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'painel', 400) }),
  async run({ id }) {
    if (!lastPanels.has(id)) throw new AppFailure('not-allowed', 'Painel não detectado. Use "Atualizar hardware" primeiro.')
    // explorer.exe shell:AppsFolder abre aplicativos da Loja e atalhos do Menu Iniciar sem passar por shell de comandos.
    spawn('explorer.exe', [`shell:AppsFolder\\${id}`], { detached: true, stdio: 'ignore' }).unref()
    return true
  }
})

// ---------------------------------------------------------------------------
// Serviços: controle (iniciar / parar / reiniciar) e lote
// ---------------------------------------------------------------------------

const MODE_LABEL: Record<string, string> = { Automatic: 'Automático', AutomaticDelayed: 'Automático (atraso)', Manual: 'Manual', Disabled: 'Desativado' }
const MODES = ['Automatic', 'AutomaticDelayed', 'Manual', 'Disabled'] as const
const SERVICE_NAME = /^[A-Za-z0-9_.\-$ ]+$/

const modeOf = (row: ServiceRow): Mode => (row.startMode === 'Auto' ? (row.delayed ? 'AutomaticDelayed' : 'Automatic') : row.startMode === 'Disabled' ? 'Disabled' : 'Manual')
const STATE_LABEL: Record<string, string> = { Running: 'Em execução', Stopped: 'Parado', 'Start Pending': 'Inicializando', 'Stop Pending': 'Parando', Paused: 'Pausado', 'Pause Pending': 'Pausando', 'Continue Pending': 'Retomando' }
const stateLabel = (s: string) => STATE_LABEL[s] ?? s

const findRow = async (name: string) => (await listServices()).find((s) => s.name.toLowerCase() === name.toLowerCase())

const CONTROL = `
$name = [string]$in.name
$svc = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $svc) { Out-Result ([pscustomobject]@{ missing = $true }); exit 0 }
$lp = (Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $svc.Name) -Name LaunchProtected -ErrorAction SilentlyContinue).LaunchProtected
if ($lp -gt 0) { Out-Result ([pscustomobject]@{ protected = $true }); exit 0 }
$err = $null; $code = $null
try {
  switch ([string]$in.op) {
    'start' { Start-Service -Name $svc.Name -ErrorAction Stop }
    'stop' { Stop-Service -Name $svc.Name -ErrorAction Stop }
    'restart' { Restart-Service -Name $svc.Name -ErrorAction Stop }
  }
} catch { $err = $_.Exception.Message; $code = $_.Exception.InnerException.NativeErrorCode; if (-not $code) { $code = $_.Exception.InnerException.InnerException.NativeErrorCode } }
Start-Sleep -Milliseconds 600
$w = Get-CimInstance Win32_Service -Filter ("Name='" + $svc.Name.Replace("'", "''") + "'")
Out-Result ([pscustomobject]@{ state = $w.State; error = $err; code = $code })
exit 0`

type ControlOp = 'start' | 'stop' | 'restart'
const OP_LABEL: Record<ControlOp, string> = { start: 'Iniciar', stop: 'Parar', restart: 'Reiniciar' }

defineAction<{ name: string; op: ControlOp }, { name: string; wasRunning: boolean }>({
  id: 'services.control',
  module: 'services',
  title: 'Iniciar, parar ou reiniciar serviço',
  description: 'Controla o estado de execução de um serviço do Windows e confere o estado real depois.',
  risk: 'high',
  reversible: true,
  requiresElevation: true,
  exclusive: 'services',
  parse(raw) {
    const p = obj(raw, ['name', 'op'])
    return { name: str(p.name, 'serviço', 256, SERVICE_NAME), op: oneOf(p.op, 'operação', ['start', 'stop', 'restart'] as const) }
  },
  async preview({ name, op }) {
    const row = await findRow(name)
    if (!row) return { summary: 'Serviço não encontrado.', changes: [], warnings: [], blocked: 'Este serviço não existe neste computador.' }
    const running = row.state === 'Running'
    return {
      summary: `${OP_LABEL[op]} "${row.displayName}" (${row.name}).`,
      changes: [{ target: 'Estado', current: stateLabel(row.state), intended: op === 'start' ? 'Em execução' : op === 'stop' ? 'Parado' : 'Reiniciado' }],
      warnings: [
        `Serviços que dependem dele: ${row.dependents.length ? row.dependents.join(', ') : 'nenhum'}.`,
        'Requer permissão de administrador (o Windows vai pedir confirmação).',
        ...(op !== 'start' ? ['Parar ou reiniciar um serviço pode interromper programas que o usam.'] : [])
      ],
      blocked: row.protectedReason ?? (op === 'start' && running ? 'O serviço já está em execução.' : op === 'stop' && row.state === 'Stopped' ? 'O serviço já está parado.' : null)
    }
  },
  async precheck({ name }) {
    const row = await findRow(name)
    return !row ? 'O serviço não existe mais.' : row.protectedReason
  },
  async execute({ name, op }, ctx) {
    const row = (await findRow(name))!
    ctx.progress('Aguardando permissão de administrador…')
    const { output } = await runElevated<{ missing?: boolean; protected?: boolean; state: string; error: string | null; code: number | null }>(CONTROL, { name: row.name, op }, { timeoutMs: 120_000, signal: ctx.signal })
    if (!output) throw new AppFailure('service-failed', 'O script de administrador não devolveu resultado.')
    if (output.missing) throw new AppFailure('service-not-found', explainWinError(1060).message)
    if (output.protected) throw new AppFailure('service-protected', 'Protegido pelo próprio Windows: nem o administrador pode alterá-lo.')
    const expected = op === 'stop' ? 'Stopped' : 'Running'
    const ok = !output.error && output.state === expected
    const why = output.error ? explainWinError(output.code ?? winErrorFromText(output.error)).message : null
    log.info('services', `${row.name}: ${op} → ${output.state}${output.error ? ` (erro ${output.code ?? '?'})` : ''}`)
    return {
      ok,
      verified: true,
      summary: ok ? `${row.displayName}: ${stateLabel(output.state)} (conferido).` : `${row.displayName}: ${why ?? `estado atual ${stateLabel(output.state)}`}`,
      sections: [{ title: 'Resultado conferido', rows: [{ label: 'Estado atual', value: stateLabel(output.state), tone: ok ? 'ok' : 'error' }, ...(output.error ? [{ label: 'Erro do Windows', value: output.error.trim(), tone: 'error' as const }] : [])] }],
      change: ok || output.state !== row.state ? { before: { name: row.name, wasRunning: row.state === 'Running' }, after: { state: output.state }, summaryBefore: `${row.displayName}: ${stateLabel(row.state)}`, summaryAfter: `${row.displayName}: ${stateLabel(output.state)}` } : undefined
    }
  },
  async revert(before, _after, _ctx) {
    const row = await findRow(before.name)
    if (!row) throw new AppFailure('not-found', 'O serviço não existe mais.')
    const op: ControlOp = before.wasRunning ? 'start' : 'stop'
    const { output } = await runElevated<{ state: string; error: string | null }>(CONTROL, { name: row.name, op }, { timeoutMs: 120_000 })
    if (!output || output.error) throw new AppFailure('revert-failed', `O Windows não restaurou o estado: ${output?.error?.trim() ?? 'sem resposta'}`)
    return `${row.displayName}: ${stateLabel(output.state)}.`
  }
})

const BATCH = `
$results = @()
foreach ($it in @($in.items)) {
  $name = [string]$it.name
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $svc) { $results += [pscustomobject]@{ name = $name; missing = $true }; continue }
  $lp = (Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $svc.Name) -Name LaunchProtected -ErrorAction SilentlyContinue).LaunchProtected
  if ($lp -gt 0) { $results += [pscustomobject]@{ name = $name; protected = $true }; continue }
  $scMode = @{ Automatic = 'auto'; AutomaticDelayed = 'delayed-auto'; Manual = 'demand'; Disabled = 'disabled' }[[string]$it.mode]
  $out = (& sc.exe config $svc.Name start= $scMode) 2>&1 | Out-String
  $code = $LASTEXITCODE
  $stopErr = $null
  if ($it.stop -and (Get-Service -Name $svc.Name).Status -eq 'Running') { try { Stop-Service -Name $svc.Name -ErrorAction Stop } catch { $stopErr = $_.Exception.Message } }
  if ($it.start -and (Get-Service -Name $svc.Name).Status -ne 'Running') { try { Start-Service -Name $svc.Name -ErrorAction Stop } catch { $stopErr = $_.Exception.Message } }
  $w = Get-CimInstance Win32_Service -Filter ("Name='" + $svc.Name.Replace("'", "''") + "'")
  $results += [pscustomobject]@{ name = $name; code = $code; out = $out; start = $w.StartMode; delayed = [bool]$w.DelayedAutoStart; state = $w.State; stopError = $stopErr }
}
Out-Result ([pscustomobject]@{ results = $results })
exit 0`

interface BatchItem {
  name: string
  mode: Mode
  stop: boolean
}
interface BatchResult {
  name: string
  missing?: boolean
  protected?: boolean
  code?: number
  out?: string
  start?: string
  delayed?: boolean
  state?: string
  stopError?: string | null
}
const matches = (r: BatchResult, mode: Mode) =>
  mode === 'Disabled' ? r.start === 'Disabled' : mode === 'Manual' ? r.start === 'Manual' : r.start === 'Auto' && !!r.delayed === (mode === 'AutomaticDelayed')

function parseItems(raw: unknown): BatchItem[] {
  const p = obj(raw, ['items'])
  if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > 60) throw new AppFailure('invalid-input', 'Escolha de 1 a 60 serviços.')
  const seen = new Set<string>()
  return p.items.map((i) => {
    const o = obj(i, ['name', 'mode', 'stop'])
    const name = str(o.name, 'serviço', 256, SERVICE_NAME)
    if (seen.has(name.toLowerCase())) throw new AppFailure('invalid-input', `Serviço repetido: ${name}.`)
    seen.add(name.toLowerCase())
    return { name, mode: oneOf(o.mode, 'inicialização', MODES), stop: o.stop === true }
  })
}

defineAction<{ items: BatchItem[] }, { items: { name: string; mode: Mode; wasRunning: boolean }[] }>({
  id: 'services.batch',
  module: 'services',
  title: 'Alterar vários serviços',
  description: 'Altera o tipo de inicialização de serviços selecionados em uma única confirmação de administrador, conferindo cada um.',
  risk: 'high',
  reversible: true,
  requiresElevation: true,
  exclusive: 'services',
  parse: (raw) => ({ items: parseItems(raw) }),
  async preview({ items }) {
    const rows = await listServices()
    const by = new Map(rows.map((r) => [r.name.toLowerCase(), r]))
    const changes = []
    const warnings: string[] = []
    let applicable = 0
    for (const it of items) {
      const row = by.get(it.name.toLowerCase())
      if (!row) {
        warnings.push(`${it.name}: não existe neste computador (ignorado).`)
        continue
      }
      if (row.protectedReason) {
        warnings.push(`${row.displayName}: ${row.protectedReason} (ignorado).`)
        continue
      }
      if (modeOf(row) === it.mode && !(it.stop && row.state === 'Running')) {
        warnings.push(`${row.displayName}: já está em ${MODE_LABEL[it.mode]} (ignorado).`)
        continue
      }
      applicable++
      changes.push({ target: `${row.displayName} (${row.name})`, current: `${MODE_LABEL[modeOf(row)]} · ${stateLabel(row.state)}`, intended: `${MODE_LABEL[it.mode]}${it.stop && row.state === 'Running' ? ' · parar agora' : ''}` })
      if (row.dependents.length) warnings.push(`${row.displayName}: usado por ${row.dependents.join(', ')}.`)
    }
    return { summary: `${applicable} de ${items.length} serviço(s) serão alterados.`, changes, warnings: ['Requer permissão de administrador (uma única confirmação do Windows).', ...warnings], blocked: applicable === 0 ? 'Nenhum dos serviços escolhidos pode ser alterado agora.' : null }
  },
  async execute({ items }, ctx) {
    const rows = await listServices()
    const by = new Map(rows.map((r) => [r.name.toLowerCase(), r]))
    const todo = items.filter((it) => {
      const row = by.get(it.name.toLowerCase())
      return row && !row.protectedReason && !(modeOf(row) === it.mode && !(it.stop && row.state === 'Running'))
    })
    ctx.progress('Aguardando permissão de administrador…')
    const { output } = await runElevated<{ results: unknown }>(BATCH, { items: todo.map((t) => ({ ...t, name: by.get(t.name.toLowerCase())!.name })) }, { timeoutMs: 300_000, signal: ctx.signal })
    const results = asArray(output?.results) as BatchResult[]
    const done: { name: string; mode: Mode; wasRunning: boolean }[] = []
    const sectionRows = []
    let failed = 0
    for (const it of todo) {
      const row = by.get(it.name.toLowerCase())!
      const r = results.find((x) => x.name.toLowerCase() === row.name.toLowerCase())
      const ok = !!r && !r.missing && !r.protected && r.code === 0 && matches(r, it.mode)
      if (!ok) failed++
      else done.push({ name: row.name, mode: modeOf(row), wasRunning: row.state === 'Running' })
      sectionRows.push({
        label: row.displayName,
        value: ok ? `${MODE_LABEL[it.mode]} (conferido)${r?.stopError ? ` · não parou: ${r.stopError.trim()}` : ''}` : r?.protected ? 'Protegido pelo Windows' : r?.missing ? 'Não existe' : `Não alterado: ${explainWinError(r?.code ?? winErrorFromText(r?.out ?? '')).message}`,
        tone: ok ? ('ok' as const) : ('error' as const)
      })
    }
    return {
      ok: failed === 0 && todo.length > 0,
      verified: true,
      summary: failed === 0 ? `${done.length} serviço(s) alterado(s) e conferido(s).` : `${done.length} alterado(s), ${failed} não alterado(s).`,
      sections: [{ title: 'Resultado por serviço', rows: sectionRows }],
      change: done.length ? { before: { items: done }, after: { count: done.length }, summaryBefore: `${done.length} serviço(s) com a inicialização anterior`, summaryAfter: `${done.length} serviço(s) alterado(s)` } : undefined
    }
  },
  async revert(before) {
    const { output } = await runElevated<{ results: unknown }>(BATCH, { items: before.items.map((i) => ({ name: i.name, mode: i.mode, start: i.wasRunning })) }, { timeoutMs: 300_000 })
    const results = asArray(output?.results) as BatchResult[]
    const bad = before.items.filter((i) => {
      const r = results.find((x) => x.name.toLowerCase() === i.name.toLowerCase())
      return !r || r.code !== 0 || !matches(r, i.mode)
    })
    if (bad.length) throw new AppFailure('revert-failed', `O Windows não restaurou: ${bad.map((b) => b.name).join(', ')}.`)
    return `${before.items.length} serviço(s) restaurado(s).`
  }
})

// Perfis de serviços: só preferências (nome + inicialização). A lista de cada computador é sempre lida localmente.
interface ServiceProfile {
  id: string
  name: string
  items: { name: string; mode: Mode }[]
  createdAt: string
}
const profileStore = new JsonStore<ServiceProfile[]>('services-profiles.json', (raw) => {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p): p is ServiceProfile => !!p && typeof p === 'object' && typeof (p as ServiceProfile).id === 'string' && typeof (p as ServiceProfile).name === 'string' && Array.isArray((p as ServiceProfile).items))
    .map((p) => ({ ...p, items: p.items.filter((i) => typeof i?.name === 'string' && (MODES as readonly string[]).includes(i.mode)) }))
    .slice(0, 30)
})

defineQuery({
  id: 'services.profiles',
  module: 'services',
  parse: noParams,
  async run() {
    const local = await listServices()
    return profileStore.read().map((p) => ({ ...p, comparison: compareProfile(p.items, local) }))
  }
})

defineQuery({
  id: 'services.profiles.save',
  module: 'services',
  parse(raw) {
    const p = obj(raw, ['name', 'items'])
    return { name: str(p.name, 'nome', 40, /^[\p{L}\p{N} ._-]+$/u), items: parseItems({ items: p.items }).map((i) => ({ name: i.name, mode: i.mode })) }
  },
  async run({ name, items }) {
    const profile: ServiceProfile = { id: crypto.randomUUID(), name, items, createdAt: new Date().toISOString() }
    profileStore.write([profile, ...profileStore.read()].slice(0, 30))
    return profile
  }
})

defineQuery({
  id: 'services.profiles.delete',
  module: 'services',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'perfil', 60, /^[0-9a-f-]+$/i) }),
  async run({ id }) {
    profileStore.write(profileStore.read().filter((p) => p.id !== id))
    return true
  }
})

// ---------------------------------------------------------------------------
// Tarefas agendadas
// ---------------------------------------------------------------------------

const TASKS = `
@(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.TaskName; path = $_.TaskPath; state = [string]$_.State; desc = $_.Description; author = $_.Author; exe = [string](($_.Actions | Select-Object -First 1).Execute) }
}) | ConvertTo-Json -Depth 3 -Compress`

export interface TaskRow {
  name: string
  path: string
  state: string
  enabled: boolean
  description: string | null
  author: string | null
  executable: string | null
  protectedReason: string | null
}

async function listTasks(): Promise<TaskRow[]> {
  const raw = await runPowerShellJson<unknown>(TASKS, { timeoutMs: 60_000 })
  return asArray(raw)
    .map((t) => {
      const r = t as Record<string, unknown>
      const path = String(r.path ?? '\\')
      const name = String(r.name)
      const state = String(r.state ?? '')
      return { name, path, state, enabled: state !== 'Disabled', description: asString(r.desc), author: asString(r.author), executable: asString(r.exe), protectedReason: taskProtection(path, name) }
    })
    .sort((a, b) => Number(!!a.protectedReason) - Number(!!b.protectedReason) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
}

defineQuery({ id: 'tasks.list', module: 'startup', parse: noParams, run: () => listTasks() })

const TASK_TOGGLE = `
$t = Get-ScheduledTask -TaskPath ([string]$in.path) -TaskName ([string]$in.name) -ErrorAction SilentlyContinue
if (-not $t) { Out-Result ([pscustomobject]@{ missing = $true }); exit 0 }
$err = $null
try { if ($in.enable) { Enable-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null } else { Disable-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null } } catch { $err = $_.Exception.Message }
$n = Get-ScheduledTask -TaskPath ([string]$in.path) -TaskName ([string]$in.name)
Out-Result ([pscustomobject]@{ state = [string]$n.State; error = $err })
exit 0`

defineAction<{ path: string; name: string; enable: boolean }, { path: string; name: string; wasEnabled: boolean }>({
  id: 'tasks.toggle',
  module: 'startup',
  title: 'Ativar ou desativar tarefa agendada',
  description: 'Habilita ou desabilita uma tarefa agendada que não seja do próprio Windows, sem apagá-la.',
  risk: 'medium',
  reversible: true,
  requiresElevation: true,
  exclusive: 'tasks',
  parse(raw) {
    const p = obj(raw, ['path', 'name', 'enable'])
    return { path: str(p.path, 'pasta da tarefa', 260, /^\\[^"<>|*?]*$/), name: str(p.name, 'tarefa', 260, /^[^\\/"<>|*?]+$/), enable: p.enable === true }
  },
  async preview({ path, name, enable }) {
    const row = (await listTasks()).find((t) => t.path === path && t.name === name)
    if (!row) return { summary: 'Tarefa não encontrada.', changes: [], warnings: [], blocked: 'Esta tarefa não existe neste computador.' }
    return {
      summary: `${enable ? 'Ativar' : 'Desativar'} a tarefa "${row.name}".`,
      changes: [{ target: `${row.path}${row.name}`, current: row.enabled ? 'Ativada' : 'Desativada', intended: enable ? 'Ativada' : 'Desativada' }],
      warnings: [`Executa: ${row.executable ?? '—'}.`, 'Requer permissão de administrador.', 'A tarefa não é apagada; dá para reativá-la ou restaurar pelo Histórico.'],
      blocked: row.protectedReason ?? (row.enabled === enable ? 'A tarefa já está nesse estado.' : null)
    }
  },
  async precheck({ path, name }) {
    return (await listTasks()).find((t) => t.path === path && t.name === name)?.protectedReason ?? null
  },
  async execute({ path, name, enable }, ctx) {
    const row = (await listTasks()).find((t) => t.path === path && t.name === name)!
    ctx.progress('Aguardando permissão de administrador…')
    const { output } = await runElevated<{ missing?: boolean; state: string; error: string | null }>(TASK_TOGGLE, { path, name, enable }, { timeoutMs: 60_000, signal: ctx.signal })
    if (!output || output.missing) throw new AppFailure('task-not-found', 'A tarefa não existe mais.')
    const nowEnabled = output.state !== 'Disabled'
    const ok = !output.error && nowEnabled === enable
    return {
      ok,
      verified: true,
      summary: ok ? `Tarefa "${name}" ${enable ? 'ativada' : 'desativada'} (conferido).` : `Não foi possível alterar: ${output.error?.trim() ?? `estado atual ${output.state}`}`,
      sections: [{ title: 'Resultado conferido', rows: [{ label: 'Estado', value: output.state, tone: ok ? 'ok' : 'error' }] }],
      change: nowEnabled !== row.enabled ? { before: { path, name, wasEnabled: row.enabled }, after: { enabled: nowEnabled }, summaryBefore: `${name}: ${row.enabled ? 'ativada' : 'desativada'}`, summaryAfter: `${name}: ${nowEnabled ? 'ativada' : 'desativada'}` } : undefined
    }
  },
  async revert(before) {
    const { output } = await runElevated<{ state: string; error: string | null }>(TASK_TOGGLE, { path: before.path, name: before.name, enable: before.wasEnabled }, { timeoutMs: 60_000 })
    if (!output || output.error) throw new AppFailure('revert-failed', `O Windows não restaurou a tarefa: ${output?.error?.trim() ?? 'sem resposta'}`)
    return `Tarefa "${before.name}" ${before.wasEnabled ? 'reativada' : 'desativada'}.`
  }
})

// ---------------------------------------------------------------------------
// Recursos opcionais do Windows
// ---------------------------------------------------------------------------

const FEATURES = `
@(Get-CimInstance Win32_OptionalFeature -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = $_.Name; caption = $_.Caption; state = [int]$_.InstallState } }) | ConvertTo-Json -Compress`

export interface FeatureRow {
  name: string
  caption: string
  enabled: boolean
  protectedReason: string | null
}

async function listFeatures(): Promise<FeatureRow[]> {
  const raw = await runPowerShellJson<unknown>(FEATURES, { timeoutMs: 60_000 })
  return asArray(raw)
    .map((f) => {
      const r = f as { name: string; caption: string; state: number }
      return { name: String(r.name), caption: String(r.caption || r.name), enabled: r.state === 1, protectedReason: featureProtection(String(r.name)) }
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

defineQuery({ id: 'features.list', module: 'windows', parse: noParams, run: () => listFeatures() })

const FEATURE_TOGGLE = `
$name = [string]$in.name
$err = $null; $restart = $false
try {
  if ($in.enable) { $r = Enable-WindowsOptionalFeature -Online -FeatureName $name -All -NoRestart -ErrorAction Stop } else { $r = Disable-WindowsOptionalFeature -Online -FeatureName $name -NoRestart -ErrorAction Stop }
  $restart = [bool]$r.RestartNeeded
} catch { $err = $_.Exception.Message }
$st = (Get-CimInstance Win32_OptionalFeature -Filter ("Name='" + $name.Replace("'", "''") + "'")).InstallState
Out-Result ([pscustomobject]@{ state = [int]$st; error = $err; restart = $restart })
exit 0`

defineAction<{ name: string; enable: boolean }, { name: string; wasEnabled: boolean }>({
  id: 'features.toggle',
  module: 'windows',
  title: 'Ativar ou desativar recurso do Windows',
  description: 'Habilita ou desabilita um recurso opcional do Windows e informa se é preciso reiniciar.',
  risk: 'high',
  reversible: true,
  requiresElevation: true,
  exclusive: 'features',
  parse(raw) {
    const p = obj(raw, ['name', 'enable'])
    return { name: str(p.name, 'recurso', 120, /^[A-Za-z0-9_.\-]+$/), enable: p.enable === true }
  },
  async preview({ name, enable }) {
    const row = (await listFeatures()).find((f) => f.name.toLowerCase() === name.toLowerCase())
    if (!row) return { summary: 'Recurso não encontrado.', changes: [], warnings: [], blocked: 'Este recurso não existe neste Windows.' }
    return {
      summary: `${enable ? 'Ativar' : 'Desativar'} "${row.caption}".`,
      changes: [{ target: row.name, current: row.enabled ? 'Ativado' : 'Desativado', intended: enable ? 'Ativado' : 'Desativado' }],
      warnings: ['Requer permissão de administrador e pode levar alguns minutos.', 'Alguns recursos só passam a valer depois de reiniciar o Windows; o JK Optimize não reinicia sozinho.'],
      blocked: row.protectedReason ?? (row.enabled === enable ? 'O recurso já está nesse estado.' : null)
    }
  },
  async precheck({ name }) {
    return (await listFeatures()).find((f) => f.name.toLowerCase() === name.toLowerCase())?.protectedReason ?? null
  },
  async execute({ name, enable }, ctx) {
    const row = (await listFeatures()).find((f) => f.name.toLowerCase() === name.toLowerCase())!
    ctx.progress('Aguardando permissão de administrador…')
    const { output } = await runElevated<{ state: number; error: string | null; restart: boolean }>(FEATURE_TOGGLE, { name: row.name, enable }, { timeoutMs: 600_000, signal: ctx.signal })
    if (!output) throw new AppFailure('feature-failed', 'O script de administrador não devolveu resultado.')
    const now = output.state === 1
    const ok = !output.error && now === enable
    return {
      ok,
      verified: true,
      summary: ok ? `${row.caption}: ${now ? 'ativado' : 'desativado'} (conferido).${output.restart ? ' É preciso reiniciar o Windows para concluir.' : ''}` : `Não foi possível alterar: ${output.error?.trim().split('\n')[0] ?? 'estado não mudou'}`,
      sections: [{ title: 'Resultado conferido', rows: [{ label: 'Estado', value: now ? 'Ativado' : 'Desativado', tone: ok ? 'ok' : 'error' }, { label: 'Reinício necessário', value: output.restart ? 'Sim (não feito automaticamente)' : 'Não', tone: output.restart ? 'warn' : 'neutral' }] }],
      change: now !== row.enabled ? { before: { name: row.name, wasEnabled: row.enabled }, after: { enabled: now }, summaryBefore: `${row.caption}: ${row.enabled ? 'ativado' : 'desativado'}`, summaryAfter: `${row.caption}: ${now ? 'ativado' : 'desativado'}` } : undefined
    }
  },
  async revert(before) {
    const { output } = await runElevated<{ state: number; error: string | null; restart: boolean }>(FEATURE_TOGGLE, { name: before.name, enable: before.wasEnabled }, { timeoutMs: 600_000 })
    if (!output || output.error) throw new AppFailure('revert-failed', `O Windows não restaurou o recurso: ${output?.error?.trim().split('\n')[0] ?? 'sem resposta'}`)
    return `${before.name}: ${before.wasEnabled ? 'reativado' : 'desativado'}${output.restart ? ' (reinício necessário)' : ''}.`
  }
})

// ---------------------------------------------------------------------------
// Lixeira (operação separada, sempre com confirmação)
// ---------------------------------------------------------------------------

const RECYCLE_SCAN = `
$sh = New-Object -ComObject Shell.Application
$items = @($sh.NameSpace(10).Items())
$bytes = 0; foreach ($i in $items) { $bytes += [int64]$i.Size }
[pscustomobject]@{ items = $items.Count; bytes = $bytes } | ConvertTo-Json -Compress`

async function recycleState(): Promise<{ items: number; bytes: number }> {
  const r = await runPowerShellWith<{ items: number; bytes: number }>(RECYCLE_SCAN, {}, { timeoutMs: 60_000 })
  return { items: r?.items ?? 0, bytes: r?.bytes ?? 0 }
}

defineQuery({ id: 'cleanup.recycle.scan', module: 'cleanup', parse: noParams, run: () => recycleState() })

defineAction<Record<string, never>, never>({
  id: 'cleanup.recycle.empty',
  module: 'cleanup',
  title: 'Esvaziar a Lixeira',
  description: 'Apaga em definitivo os itens da Lixeira de todas as unidades.',
  risk: 'high',
  reversible: false,
  irreversibleReason: 'Os arquivos da Lixeira são apagados em definitivo e não podem ser recuperados pelo JK Optimize.',
  requiresElevation: false,
  exclusive: 'cleanup',
  parse: noParams,
  async preview() {
    const s = await recycleState()
    return {
      summary: `${s.items.toLocaleString('pt-BR')} item(ns), ${formatBytes(s.bytes)} na Lixeira.`,
      changes: [{ target: 'Lixeira', current: `${s.items} item(ns) · ${formatBytes(s.bytes)}`, intended: 'Vazia' }],
      warnings: ['Esta ação é definitiva: confira a Lixeira antes de continuar.'],
      blocked: s.items === 0 ? 'A Lixeira já está vazia.' : null
    }
  },
  async execute() {
    const before = await recycleState()
    let error: string | null = null
    try {
      await runPowerShellWith('Clear-RecycleBin -Force -ErrorAction Stop', {}, { timeoutMs: 180_000 })
    } catch (e) {
      error = (e as Error).message.split('\n')[0]
    }
    const after = await recycleState()
    const freed = Math.max(0, before.bytes - after.bytes)
    const ok = after.items === 0 || after.items < before.items
    return {
      ok,
      verified: true,
      summary: ok ? `Lixeira: ${(before.items - after.items).toLocaleString('pt-BR')} item(ns) removido(s), ${formatBytes(freed)} liberados${after.items ? `; ${after.items} item(ns) restantes` : ''}.` : `A Lixeira não foi esvaziada${error ? `: ${error}` : ''}.`,
      sections: [{ title: 'Conferência', rows: [{ label: 'Antes', value: `${before.items} item(ns) · ${formatBytes(before.bytes)}` }, { label: 'Depois', value: `${after.items} item(ns) · ${formatBytes(after.bytes)}`, tone: ok ? 'ok' : 'error' }] }]
    }
  }
})

// ---------------------------------------------------------------------------
// Afinidade de CPU de um processo do usuário (reversível, vale só enquanto o processo existir)
// ---------------------------------------------------------------------------

const AFFINITY = `
$p = Get-Process -Id $in.pid -ErrorAction Stop
$before = [int64]$p.ProcessorAffinity
if ($in.mask -gt 0) { $p.ProcessorAffinity = [IntPtr][int64]$in.mask; $p.Refresh() }
[pscustomobject]@{ before = $before; now = [int64]$p.ProcessorAffinity } | ConvertTo-Json -Compress`

defineAction<{ pid: number; startTime: string; mask: number }, { pid: number; startTime: string; mask: number }>({
  id: 'processes.affinity',
  module: 'processes',
  title: 'Alterar afinidade de CPU de processo',
  description: 'Define em quais núcleos lógicos um processo do usuário pode rodar. Vale somente enquanto o processo estiver aberto.',
  risk: 'medium',
  reversible: true,
  requiresElevation: false,
  parse(raw) {
    const p = obj(raw, ['pid', 'startTime', 'mask'])
    const pid = Number(p.pid)
    const mask = Number(p.mask)
    if (!Number.isInteger(pid) || pid < 1) throw new AppFailure('invalid-input', 'Processo inválido.')
    if (!validAffinityMask(mask, os.cpus().length)) throw new AppFailure('invalid-input', 'Escolha ao menos um núcleo existente.')
    return { pid, startTime: str(p.startTime, 'início do processo', 40), mask }
  },
  async preview({ pid, startTime, mask }) {
    const proc = (await listProcesses()).find((p) => p.pid === pid)
    if (!proc) return { summary: 'Processo não encontrado.', changes: [], warnings: [], blocked: 'O processo não está mais em execução.' }
    const cur = await runPowerShellWith<{ before: number }>(AFFINITY, { pid, mask: 0 }, { timeoutMs: 15_000 })
    const label = (m: number) => `${m.toString(2).split('').filter((c) => c === '1').length} núcleo(s) · máscara 0x${m.toString(16).toUpperCase()}`
    return {
      summary: `Afinidade de ${proc.name} (PID ${pid}).`,
      changes: [{ target: 'Núcleos permitidos', current: cur ? label(cur.before) : '—', intended: label(mask) }],
      warnings: ['Restringir núcleos pode reduzir o desempenho do programa. O ganho depende do jogo e do processador: meça antes e depois.', 'Vale somente enquanto o processo estiver aberto.'],
      blocked: proc.protectedReason ?? (proc.startTime !== startTime ? 'O identificador agora pertence a outro processo.' : null)
    }
  },
  async precheck({ pid, startTime }) {
    const proc = (await listProcesses()).find((p) => p.pid === pid)
    return !proc ? 'O processo não está mais em execução.' : proc.startTime !== startTime ? 'O identificador agora pertence a outro processo.' : proc.protectedReason
  },
  async execute({ pid, startTime, mask }) {
    const r = await runPowerShellWith<{ before: number; now: number }>(AFFINITY, { pid, mask }, { timeoutMs: 15_000 })
    const ok = !!r && r.now === mask
    return {
      ok,
      verified: true,
      summary: ok ? `Afinidade aplicada e conferida (máscara 0x${mask.toString(16).toUpperCase()}).` : 'O Windows não aplicou a afinidade pedida.',
      sections: [{ title: 'Conferência', rows: [{ label: 'Antes', value: `0x${(r?.before ?? 0).toString(16).toUpperCase()}` }, { label: 'Agora', value: `0x${(r?.now ?? 0).toString(16).toUpperCase()}`, tone: ok ? 'ok' : 'error' }] }],
      change: r && r.before !== r.now ? { before: { pid, startTime, mask: r.before }, after: { mask: r.now }, summaryBefore: `PID ${pid}: máscara 0x${r.before.toString(16).toUpperCase()}`, summaryAfter: `PID ${pid}: máscara 0x${r.now.toString(16).toUpperCase()}` } : undefined
    }
  },
  async revert(before) {
    const proc = (await listProcesses()).find((p) => p.pid === before.pid && p.startTime === before.startTime)
    if (!proc) throw new AppFailure('process-gone', 'O processo não está mais aberto; a afinidade já voltou ao normal.')
    const r = await runPowerShellWith<{ now: number }>(AFFINITY, { pid: before.pid, mask: before.mask }, { timeoutMs: 15_000 })
    if (!r || r.now !== before.mask) throw new AppFailure('revert-failed', 'O Windows não restaurou a afinidade.')
    return `Afinidade restaurada (0x${before.mask.toString(16).toUpperCase()}).`
  }
})
