// Analisador e desativação seletiva de serviços do Windows.
// Uma alteração por vez, sempre com elevação explícita, backup e reversão.
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { bool, noParams, obj, oneOf, str } from '../ops/params'
import { asArray, asString, runPowerShellJson } from '../services/powershell'
import { runElevated } from '../services/elevated'
import { log } from '../ops/log'
import { explainWinError, PROTECTED_SERVICE_NAMES, serviceProtection, winErrorFromText } from '../security/protection'

/** Mantido para compatibilidade: a lista central fica em security/protection.ts. */
export const PROTECTED_SERVICES = PROTECTED_SERVICE_NAMES

export interface ServiceRow {
  name: string
  displayName: string
  state: string
  startMode: string
  delayed: boolean
  account: string | null
  path: string | null
  description: string | null
  dependsOn: string[]
  dependents: string[]
  category: 'essential' | 'windows' | 'third-party'
  launchProtected: number | null
  protectionKind: 'protected' | 'essential' | 'security' | 'dependency' | null
  protectedReason: string | null
  /** true = pode aparecer nas listas de otimização modificáveis. */
  modifiable: boolean
}

const LIST = `
$deps = @{}
foreach ($s in Get-Service -ErrorAction SilentlyContinue) {
  $deps[$s.Name] = [pscustomobject]@{ on = [string[]]@($s.ServicesDependedOn | ForEach-Object { [string]$_.Name }); by = [string[]]@($s.DependentServices | ForEach-Object { [string]$_.Name }) }
}
$lp = @{}
foreach ($k in Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services' -ErrorAction SilentlyContinue) {
  $v = (Get-ItemProperty -LiteralPath $k.PSPath -Name LaunchProtected -ErrorAction SilentlyContinue).LaunchProtected
  if ($v) { $lp[$k.PSChildName.ToLower()] = [int]$v }
}
@(Get-CimInstance Win32_Service | ForEach-Object {
  $d = $deps[$_.Name]
  [pscustomobject]@{
    name = $_.Name; display = $_.DisplayName; state = $_.State; start = $_.StartMode; delayed = [bool]$_.DelayedAutoStart
    account = $_.StartName; path = $_.PathName; desc = $_.Description; lp = $lp[$_.Name.ToLower()]
    on = if ($d) { [string]($d.on -join '|') } else { '' }; by = if ($d) { [string]($d.by -join '|') } else { '' }
  }
}) | ConvertTo-Json -Depth 3 -Compress`

export function classifyService(name: string, path: string | null): ServiceRow['category'] {
  if (PROTECTED_SERVICE_NAMES.has(name.toLowerCase())) return 'essential'
  // Executáveis em \Windows\ (inclusive svchost) são componentes do Windows.
  if (!path || /\\windows\\/i.test(path)) return 'windows'
  return 'third-party'
}

export async function listServices(): Promise<ServiceRow[]> {
  const raw = await runPowerShellJson<unknown>(LIST, { timeoutMs: 60_000 })
  const base = asArray(raw).map((r) => {
    const s = r as Record<string, unknown>
    const name = String(s.name)
    const path = asString(s.path)
    return {
      name,
      displayName: asString(s.display) ?? name,
      state: String(s.state ?? ''),
      startMode: String(s.start ?? ''),
      delayed: s.delayed === true,
      account: asString(s.account),
      path,
      description: asString(s.desc),
      dependsOn: String(s.on ?? '').split('|').filter(Boolean),
      dependents: String(s.by ?? '').split('|').filter(Boolean),
      category: classifyService(name, path),
      launchProtected: typeof s.lp === 'number' ? s.lp : null
    }
  })
  const byName = new Map(base.map((r) => [r.name.toLowerCase(), r]))
  const rows: ServiceRow[] = base.map((row) => {
    const runningDependents = row.dependents.filter((d) => byName.get(d.toLowerCase())?.state === 'Running')
    let protection = serviceProtection({ name: row.name, path: row.path, launchProtected: row.launchProtected, runningDependents })
    if (!protection && /^(LocalSystem|NT AUTHORITY)/i.test(row.account ?? '') && /\\windows\\system32\\drivers\\/i.test(row.path ?? '')) {
      protection = { kind: 'essential', reason: 'Componente de driver do sistema.' }
    }
    return {
      ...row,
      category: protection && protection.kind !== 'dependency' ? 'essential' : row.category,
      protectionKind: protection?.kind ?? null,
      protectedReason: protection?.reason ?? null,
      modifiable: protection === null
    }
  })
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

defineQuery({ id: 'services.list', module: 'services', parse: noParams, run: () => listServices() })

const START_MODES = ['Automatic', 'AutomaticDelayed', 'Manual', 'Disabled'] as const
type StartModeParam = (typeof START_MODES)[number]

const MODE_LABEL: Record<string, string> = {
  Auto: 'Automático',
  Automatic: 'Automático',
  AutomaticDelayed: 'Automático (atraso)',
  Manual: 'Manual',
  Disabled: 'Desativado'
}

const currentModeParam = (row: ServiceRow): StartModeParam =>
  row.startMode === 'Auto' ? (row.delayed ? 'AutomaticDelayed' : 'Automatic') : row.startMode === 'Disabled' ? 'Disabled' : 'Manual'

// sc.exe é o mecanismo documentado para "delayed-auto". O script revalida a proteção
// do lado elevado e devolve os códigos Win32 reais para tratamento específico.
const APPLY = `
$name = [string]$in.name
$svc = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $svc) { Out-Result ([pscustomobject]@{ missing = $true }); exit 0 }
$lp = (Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $svc.Name) -Name LaunchProtected -ErrorAction SilentlyContinue).LaunchProtected
if ($lp -gt 0) { Out-Result ([pscustomobject]@{ protected = $true }); exit 0 }
$rp = $null
if ($in.restorePoint) {
  try { Checkpoint-Computer -Description ('JK Optimize - servico ' + $name) -RestorePointType MODIFY_SETTINGS -ErrorAction Stop; $rp = 'criado' } catch { $rp = $_.Exception.Message }
}
$scMode = @{ Automatic = 'auto'; AutomaticDelayed = 'delayed-auto'; Manual = 'demand'; Disabled = 'disabled' }[[string]$in.mode]
$scOut = (& sc.exe config $svc.Name start= $scMode) 2>&1 | Out-String
$scCode = $LASTEXITCODE
$stopErr = $null; $stopCode = $null
if ($in.stop -and $svc.Status -eq 'Running') {
  try { Stop-Service -Name $svc.Name -ErrorAction Stop } catch { $stopErr = $_.Exception.Message; $stopCode = $_.Exception.InnerException.NativeErrorCode; if (-not $stopCode) { $stopCode = $_.Exception.InnerException.InnerException.NativeErrorCode } }
}
if ($in.start -and (Get-Service -Name $svc.Name).Status -ne 'Running') {
  try { Start-Service -Name $svc.Name -ErrorAction Stop } catch { $stopErr = $_.Exception.Message; $stopCode = $_.Exception.InnerException.NativeErrorCode }
}
$w = Get-CimInstance Win32_Service -Filter ("Name='" + $svc.Name.Replace("'", "''") + "'")
Out-Result ([pscustomobject]@{ scCode = $scCode; scOut = $scOut; start = $w.StartMode; delayed = [bool]$w.DelayedAutoStart; state = $w.State; stopError = $stopErr; stopCode = $stopCode; restorePoint = $rp })
exit 0`

interface ApplyResult {
  missing?: boolean
  protected?: boolean
  scCode: number
  scOut: string
  start: string
  delayed: boolean
  state: string
  stopError: string | null
  stopCode: number | null
  restorePoint: string | null
}

/** Mensagem específica para o código do sc.exe (ou extraída do texto). Exportada para testes. */
export function describeServiceFailure(code: number, text: string): { kind: string; message: string } {
  const resolved = code !== 0 ? code : winErrorFromText(text)
  return explainWinError(resolved)
}

async function applyService(name: string, mode: StartModeParam, opts: { stop?: boolean; start?: boolean; restorePoint?: boolean }) {
  const { output } = await runElevated<ApplyResult>(APPLY, { name, mode, ...opts }, { timeoutMs: 180_000 })
  if (!output) throw new AppFailure('service-failed', 'O script de administrador não devolveu resultado.')
  if (output.missing) throw new AppFailure('service-not-found', explainWinError(1060).message)
  if (output.protected) throw new AppFailure('service-protected', 'Protegido pelo próprio Windows (processo protegido): nem o administrador pode alterá-lo.')
  return output
}

const modeMatches = (r: ApplyResult, mode: StartModeParam) =>
  mode === 'Disabled' ? r.start === 'Disabled' : mode === 'Manual' ? r.start === 'Manual' : r.start === 'Auto' && r.delayed === (mode === 'AutomaticDelayed')

interface ServiceBackup {
  name: string
  mode: StartModeParam
  wasRunning: boolean
}

defineAction<{ name: string; mode: StartModeParam; stop: boolean; restorePoint: boolean }, ServiceBackup>({
  id: 'services.configure',
  module: 'services',
  title: 'Alterar tipo de inicialização de serviço',
  description: 'Altera um único serviço (tipo de inicialização e, opcionalmente, para o serviço), com backup e reversão.',
  risk: 'high',
  reversible: true,
  requiresElevation: true,
  exclusive: 'services',
  parse(raw) {
    const p = obj(raw, ['name', 'mode', 'stop', 'restorePoint'])
    return {
      name: str(p.name, 'serviço', 256, /^[A-Za-z0-9_.\-$ ]+$/),
      mode: oneOf(p.mode, 'inicialização', START_MODES),
      stop: bool(p.stop, 'parar agora', false),
      restorePoint: bool(p.restorePoint, 'ponto de restauração', false)
    }
  },
  async preview(params) {
    const services = await listServices()
    const row = services.find((s) => s.name.toLowerCase() === params.name.toLowerCase())
    if (!row) return { summary: 'Serviço não encontrado.', changes: [], warnings: [], blocked: 'Este serviço não existe.' }
    const dependents = row.dependents.length ? row.dependents.join(', ') : 'nenhum'
    const current = currentModeParam(row)
    return {
      summary: `${row.displayName} (${row.name}) — ${row.description ?? 'sem descrição'}`,
      changes: [
        { target: 'Tipo de inicialização', current: MODE_LABEL[current], intended: MODE_LABEL[params.mode] },
        ...(params.stop && row.state === 'Running' ? [{ target: 'Estado', current: 'Em execução', intended: 'Parado' }] : [])
      ],
      warnings: [
        `Impacto esperado: ${params.mode === 'Disabled' ? 'o serviço não poderá iniciar, nem sob demanda' : params.mode === 'Manual' ? 'o serviço só inicia quando algum programa precisar' : 'o serviço inicia com o Windows'}.`,
        `Serviços que dependem dele: ${dependents}.`,
        `Categoria: ${row.category === 'third-party' ? 'serviço de terceiros' : 'componente do Windows'}. Executável: ${row.path ?? '—'}.`,
        'Requer permissão de administrador (o Windows vai pedir confirmação).',
        ...(params.restorePoint ? ['Um ponto de restauração será solicitado antes (não substitui o backup do JK Optimize).'] : [])
      ],
      blocked: row.protectedReason ?? (current === params.mode && !(params.stop && row.state === 'Running') ? 'O serviço já está nessa configuração.' : null)
    }
  },
  async precheck(params) {
    const row = (await listServices()).find((s) => s.name.toLowerCase() === params.name.toLowerCase())
    return !row ? 'O serviço não existe mais.' : row.protectedReason
  },
  async execute(params, ctx) {
    const row = (await listServices()).find((s) => s.name.toLowerCase() === params.name.toLowerCase())!
    ctx.progress('Aguardando permissão de administrador…')
    const r = await applyService(row.name, params.mode, { stop: params.stop, restorePoint: params.restorePoint })
    const modeOk = r.scCode === 0 && modeMatches(r, params.mode)
    const stopFailed = params.stop && !!r.stopError
    const ok = modeOk && !stopFailed
    const failure = !modeOk ? describeServiceFailure(r.scCode, r.scOut) : stopFailed ? explainWinError(r.stopCode ?? winErrorFromText(r.stopError ?? '')) : null
    log.info('services', `${row.name}: sc.exe código ${r.scCode}; parar: ${r.stopError ? `falhou (${r.stopCode ?? '?'})` : 'ok/não solicitado'}`)
    const sections = [
      {
        title: 'Resultado conferido',
        rows: [
          { label: 'Tipo de inicialização', value: `${MODE_LABEL[r.start] ?? r.start}${r.delayed ? ' (atraso)' : ''}`, tone: ok ? ('ok' as const) : ('error' as const) },
          { label: 'Estado', value: r.state },
          ...(r.stopError ? [{ label: 'Parar serviço', value: `${explainWinError(r.stopCode ?? winErrorFromText(r.stopError)).message} — ${r.stopError.trim()}`, tone: 'warn' as const }] : []),
          ...(!modeOk ? [{ label: 'Detalhe técnico (sc.exe)', value: `código ${r.scCode}: ${r.scOut.trim()}`, tone: 'error' as const }] : []),
          ...(params.restorePoint ? [{ label: 'Ponto de restauração', value: r.restorePoint ?? '—' }] : [])
        ]
      }
    ]
    return {
      ok,
      verified: true,
      summary: ok
        ? `${row.displayName}: ${MODE_LABEL[params.mode]} (conferido).`
        : modeOk
          ? `Inicialização alterada para ${MODE_LABEL[params.mode]}, mas o serviço não pôde ser parado: ${failure!.message}`
          : `Não foi alterado: ${failure!.message}`,
      sections,
      change: modeOk
        ? {
            before: { name: row.name, mode: currentModeParam(row), wasRunning: row.state === 'Running' },
            after: { mode: params.mode, state: r.state },
            summaryBefore: `${row.displayName}: ${MODE_LABEL[currentModeParam(row)]}, ${row.state}`,
            summaryAfter: `${row.displayName}: ${MODE_LABEL[params.mode]}, ${r.state}`
          }
        : undefined
    }
  },
  async revert(before, after, ctx) {
    const row = (await listServices()).find((s) => s.name.toLowerCase() === before.name.toLowerCase())
    if (!row) throw new AppFailure('not-found', 'O serviço não existe mais.')
    const expected = (after as { mode: StartModeParam }).mode
    if (currentModeParam(row) !== expected && !ctx.force) {
      throw new AppFailure('state-changed', `A inicialização mudou depois da alteração (agora: ${MODE_LABEL[currentModeParam(row)]}).`)
    }
    const r = await applyService(before.name, before.mode, { start: before.wasRunning })
    if (r.scCode !== 0 || !modeMatches(r, before.mode)) throw new AppFailure('revert-failed', `O Windows não restaurou: ${describeServiceFailure(r.scCode, r.scOut).message}`)
    return `${row.displayName}: ${MODE_LABEL[before.mode]}${before.wasRunning ? `, ${r.state === 'Running' ? 'reiniciado' : 'não foi possível reiniciar'}` : ''}.`
  }
})
