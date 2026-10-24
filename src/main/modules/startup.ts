// Gerenciador de inicialização. Usa o mesmo mecanismo do Gerenciador de Tarefas:
// os valores em ...\Explorer\StartupApproved. Desativar NÃO apaga a entrada,
// e a reversão restaura exatamente os bytes anteriores.
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, oneOf, str } from '../ops/params'
import { asArray, asString, runPowerShellJson, runPowerShellWith } from '../services/powershell'
import { runElevated } from '../services/elevated'

const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved'

export const STARTUP_SOURCES = {
  hkcuRun: { label: 'Registro do usuário (Run)', hive: 'HKCU', approval: `HKCU:\\${APPROVED}\\Run`, admin: false },
  hklmRun: { label: 'Registro da máquina (Run)', hive: 'HKLM', approval: `HKLM:\\${APPROVED}\\Run`, admin: true },
  hklmRun32: { label: 'Registro da máquina 32 bits (Run)', hive: 'HKLM', approval: `HKLM:\\${APPROVED}\\Run32`, admin: true },
  userFolder: { label: 'Pasta Inicializar do usuário', hive: 'HKCU', approval: `HKCU:\\${APPROVED}\\StartupFolder`, admin: false },
  commonFolder: { label: 'Pasta Inicializar de todos os usuários', hive: 'HKLM', approval: `HKLM:\\${APPROVED}\\StartupFolder`, admin: true }
} as const

export type StartupSource = keyof typeof STARTUP_SOURCES

const LIST = `
$approved = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved'
function Get-Approval($key, $name) {
  try { $v = (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction Stop).$name; return ,([byte[]]$v) } catch { return $null }
}
function Get-Publisher($cmd) {
  $exe = $null
  if ($cmd -match '^"([^"]+)"') { $exe = $Matches[1] } elseif ($cmd -match '^(.+?\\.exe)\\b') { $exe = $Matches[1] }
  if ($exe) { $exe = [Environment]::ExpandEnvironmentVariables($exe) }
  if ($exe -and (Test-Path -LiteralPath $exe)) { return [pscustomobject]@{ exe = $exe; company = (Get-Item -LiteralPath $exe).VersionInfo.CompanyName } }
  return [pscustomobject]@{ exe = $exe; company = $null }
}
$out = @()
$runs = @(
  @{ src = 'hkcuRun'; key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; ap = "HKCU:\\$approved\\Run" },
  @{ src = 'hklmRun'; key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; ap = "HKLM:\\$approved\\Run" },
  @{ src = 'hklmRun32'; key = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; ap = "HKLM:\\$approved\\Run32" }
)
foreach ($r in $runs) {
  $props = Get-ItemProperty -LiteralPath $r.key -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    $pub = Get-Publisher ([string]$p.Value)
    $out += [pscustomobject]@{ source = $r.src; name = $p.Name; command = [string]$p.Value; exe = $pub.exe; company = $pub.company; approval = (Get-Approval $r.ap $p.Name) }
  }
}
$shell = New-Object -ComObject WScript.Shell
$folders = @(
  @{ src = 'userFolder'; dir = [Environment]::GetFolderPath('Startup'); ap = "HKCU:\\$approved\\StartupFolder" },
  @{ src = 'commonFolder'; dir = [Environment]::GetFolderPath('CommonStartup'); ap = "HKLM:\\$approved\\StartupFolder" }
)
foreach ($f in $folders) {
  if (-not $f.dir -or -not (Test-Path -LiteralPath $f.dir)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $f.dir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' }) {
    $target = $file.FullName
    if ($file.Extension -eq '.lnk') { try { $target = $shell.CreateShortcut($file.FullName).TargetPath } catch {} }
    $company = $null
    if ($target -and (Test-Path -LiteralPath $target)) { $company = (Get-Item -LiteralPath $target).VersionInfo.CompanyName }
    $out += [pscustomobject]@{ source = $f.src; name = $file.Name; command = $file.FullName; exe = $target; company = $company; approval = (Get-Approval $f.ap $file.Name) }
  }
}
$tasks = @()
try {
  $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' } } | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object {
    [pscustomobject]@{ name = $_.TaskName; path = $_.TaskPath; state = [string]$_.State; action = (@($_.Actions | ForEach-Object { $_.Execute }) -join '; '); author = $_.Author }
  })
} catch {}
[pscustomobject]@{ entries = $out; tasks = $tasks } | ConvertTo-Json -Depth 4 -Compress`

export interface StartupEntry {
  source: StartupSource
  sourceLabel: string
  name: string
  command: string
  exe: string | null
  publisher: string | null
  enabled: boolean
  /** true quando o estado vem de um valor StartupApproved existente. */
  stateConfirmed: boolean
  approvalBytes: number[] | null
  needsAdmin: boolean
}

/** Byte 0 do StartupApproved: par (02/06) = ativado; ímpar (03/07) = desativado. Ausente = ativado. */
export function approvalEnabled(bytes: number[] | null): boolean {
  if (!bytes || bytes.length === 0) return true
  return (bytes[0] & 1) === 0
}

export async function listStartup() {
  const raw = await runPowerShellJson<{ entries: unknown; tasks: unknown }>(LIST, { timeoutMs: 60_000 })
  const entries: StartupEntry[] = asArray(raw?.entries).map((e) => {
    const r = e as Record<string, unknown>
    const source = r.source as StartupSource
    const bytes = Array.isArray(r.approval) ? (r.approval as unknown[]).map((b) => Number(b)) : null
    return {
      source,
      sourceLabel: STARTUP_SOURCES[source]?.label ?? String(source),
      name: String(r.name),
      command: String(r.command ?? ''),
      exe: asString(r.exe),
      publisher: asString(r.company),
      enabled: approvalEnabled(bytes),
      stateConfirmed: bytes !== null,
      approvalBytes: bytes,
      needsAdmin: STARTUP_SOURCES[source]?.admin ?? true
    }
  })
  const tasks = asArray(raw?.tasks).map((t) => {
    const r = t as Record<string, unknown>
    return { name: String(r.name), path: String(r.path), state: String(r.state), action: asString(r.action), author: asString(r.author) }
  })
  return { entries, tasks }
}

defineQuery({ id: 'startup.list', module: 'startup', parse: noParams, run: () => listStartup() })

const WRITE_APPROVAL = `
if ($null -eq $in.bytes) { Remove-ItemProperty -LiteralPath $in.key -Name $in.name -ErrorAction SilentlyContinue }
else {
  if (-not (Test-Path -LiteralPath $in.key)) { New-Item -Path $in.key -Force | Out-Null }
  Set-ItemProperty -LiteralPath $in.key -Name $in.name -Value ([byte[]]@($in.bytes)) -Type Binary
}
$now = $null; try { $now = [byte[]](Get-ItemProperty -LiteralPath $in.key -Name $in.name -ErrorAction Stop).($in.name) } catch {}
`

async function writeApproval(source: StartupSource, name: string, bytes: number[] | null): Promise<number[] | null> {
  const def = STARTUP_SOURCES[source]
  const params = { key: def.approval, name, bytes }
  if (def.admin) {
    const { output } = await runElevated<{ now: number[] | null }>(`${WRITE_APPROVAL}\nOut-Result ([pscustomobject]@{ now = $now })\nexit 0`, params)
    return output?.now ? asArray(output.now).map(Number) : null
  }
  const r = await runPowerShellWith<{ now: unknown }>(`${WRITE_APPROVAL}\n[pscustomobject]@{ now = $now } | ConvertTo-Json -Compress`, params)
  return r?.now ? asArray(r.now).map(Number) : null
}

/** Valor gravado pelo Gerenciador de Tarefas: 4 bytes de estado + FILETIME. */
export function approvalBytesFor(enabled: boolean, now = new Date()): number[] {
  const bytes = new Array<number>(12).fill(0)
  bytes[0] = enabled ? 0x02 : 0x03
  if (!enabled) {
    const filetime = BigInt(now.getTime()) * 10_000n + 116_444_736_000_000_000n
    for (let i = 0; i < 8; i++) bytes[4 + i] = Number((filetime >> BigInt(8 * i)) & 0xffn)
  }
  return bytes
}

interface StartupBackup {
  source: StartupSource
  name: string
  bytes: number[] | null
}

defineAction<{ source: StartupSource; name: string; enabled: boolean }, StartupBackup>({
  id: 'startup.toggle',
  module: 'startup',
  title: 'Ativar/desativar item de inicialização',
  description: 'Impede ou permite que um programa abra junto com o Windows, sem apagar a entrada.',
  risk: 'low',
  reversible: true,
  requiresElevation: (p) => STARTUP_SOURCES[p.source].admin,
  exclusive: 'startup',
  parse(raw) {
    const p = obj(raw, ['source', 'name', 'enabled'])
    return {
      source: oneOf(p.source, 'origem', Object.keys(STARTUP_SOURCES) as StartupSource[]),
      name: str(p.name, 'nome', 260),
      enabled: p.enabled === true
    }
  },
  async preview(params) {
    const entry = (await listStartup()).entries.find((e) => e.source === params.source && e.name === params.name)
    return {
      summary: entry ? `${entry.name} — ${entry.publisher ?? 'editor desconhecido'}` : 'Entrada não encontrada.',
      changes: entry
        ? [{ target: `${entry.sourceLabel}: ${entry.name}`, current: entry.enabled ? 'Ativado' : 'Desativado', intended: params.enabled ? 'Ativado' : 'Desativado' }]
        : [],
      warnings: [
        'A mudança vale a partir do próximo login. O programa aberto agora continua aberto.',
        ...(entry && !entry.exe ? ['Não foi possível identificar o executável desta entrada.'] : [])
      ],
      blocked: !entry ? 'Esta entrada não existe mais.' : entry.enabled === params.enabled ? 'A entrada já está nesse estado.' : null
    }
  },
  async execute(params) {
    const entry = (await listStartup()).entries.find((e) => e.source === params.source && e.name === params.name)
    if (!entry) throw new AppFailure('not-found', 'Entrada não encontrada.')
    const now = await writeApproval(params.source, params.name, approvalBytesFor(params.enabled))
    const ok = approvalEnabled(now) === params.enabled && now !== null
    return {
      ok,
      verified: ok,
      summary: ok ? `${entry.name}: ${params.enabled ? 'ativado' : 'desativado'} na inicialização (conferido).` : 'O valor lido depois da gravação não confere.',
      change: ok
        ? {
            before: { source: params.source, name: params.name, bytes: entry.approvalBytes },
            after: { bytes: now },
            summaryBefore: `${entry.name}: ${entry.enabled ? 'ativado' : 'desativado'}`,
            summaryAfter: `${entry.name}: ${params.enabled ? 'ativado' : 'desativado'}`
          }
        : undefined
    }
  },
  async revert(before, after, ctx) {
    const entry = (await listStartup()).entries.find((e) => e.source === before.source && e.name === before.name)
    if (!entry) throw new AppFailure('not-found', 'A entrada de inicialização não existe mais.')
    const expected = (after as { bytes: number[] | null }).bytes
    if (JSON.stringify(entry.approvalBytes) !== JSON.stringify(expected) && !ctx.force) {
      throw new AppFailure('state-changed', 'O estado desta entrada mudou depois da alteração.')
    }
    const now = await writeApproval(before.source, before.name, before.bytes)
    if (JSON.stringify(now) !== JSON.stringify(before.bytes)) throw new AppFailure('revert-failed', 'O valor restaurado não confere.')
    return `${before.name}: estado anterior restaurado.`
  }
})
