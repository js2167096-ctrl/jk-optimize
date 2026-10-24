// Aplicativos instalados, pacotes pré-instalados (Appx) e aplicativos em segundo plano.
import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, str } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson, runPowerShellWith } from '../services/powershell'
import { listProcesses } from './processes'
import { listStartup } from './startup'

// ---------------------------------------------------------------------------
// 6.5 Programas instalados
// ---------------------------------------------------------------------------

const INSTALLED = `
$keys = @(
  @{ hive = 'Máquina'; path = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ hive = 'Máquina (32 bits)'; path = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  @{ hive = 'Usuário'; path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' }
)
$out = foreach ($k in $keys) {
  Get-ChildItem -LiteralPath $k.path -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName -or $p.SystemComponent -eq 1 -or $p.ParentKeyName) { return }
    [pscustomobject]@{
      key = $_.PSPath; keyName = $_.PSChildName; hive = $k.hive; name = $p.DisplayName; version = $p.DisplayVersion; publisher = $p.Publisher
      installDate = $p.InstallDate; sizeKB = $p.EstimatedSize; location = $p.InstallLocation
      uninstall = $p.UninstallString; msi = ($p.WindowsInstaller -eq 1)
    }
  }
}
@($out) | ConvertTo-Json -Compress`

export interface InstalledApp {
  id: string
  name: string
  version: string | null
  publisher: string | null
  source: string
  installDate: string | null
  sizeBytes: number | null
  location: string | null
  uninstallMethod: 'msi' | 'executable' | 'settings'
  uninstallCommand: string | null
}

/** Divide a linha de desinstalação em executável + argumentos, sem shell. Exportada para testes. */
export function parseCommandLine(command: string): { exe: string; args: string[] } | null {
  const trimmed = command.trim()
  const quoted = /^"([^"]+)"\s*(.*)$/.exec(trimmed)
  const plain = /^(.+?\.exe)(?:\s+(.*))?$/i.exec(trimmed)
  const exe = quoted?.[1] ?? plain?.[1]
  if (!exe || !/\.exe$/i.test(exe)) return null
  const rest = (quoted ? quoted[2] : plain?.[2]) ?? ''
  const args = [...rest.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
  return { exe, args }
}

const MSI_GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i

export async function listInstalled(): Promise<InstalledApp[]> {
  const raw = await runPowerShellJson<unknown>(INSTALLED, { timeoutMs: 60_000 })
  const seen = new Set<string>()
  const apps: InstalledApp[] = []
  for (const r of asArray(raw)) {
    const a = r as Record<string, unknown>
    const name = String(a.name)
    const version = asString(a.version)
    const dedupe = `${name}|${version}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const keyName = String(a.keyName ?? '')
    const command = asString(a.uninstall)
    const method: InstalledApp['uninstallMethod'] =
      a.msi === true && MSI_GUID.test(keyName) ? 'msi' : command && parseCommandLine(command) ? 'executable' : 'settings'
    const date = asString(a.installDate)
    apps.push({
      id: createHash('sha1').update(String(a.key)).digest('hex').slice(0, 16),
      name,
      version,
      publisher: asString(a.publisher),
      source: String(a.hive),
      installDate: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
      sizeBytes: asNumber(a.sizeKB) !== null ? asNumber(a.sizeKB)! * 1024 : null,
      location: asString(a.location),
      uninstallMethod: method,
      uninstallCommand: method === 'msi' ? `msiexec.exe /x ${keyName}` : command
    })
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

defineQuery({ id: 'apps.installed', module: 'apps', parse: noParams, run: () => listInstalled() })

defineAction<{ id: string }, never>({
  id: 'apps.uninstall',
  module: 'apps',
  title: 'Iniciar desinstalação de programa',
  description: 'Abre o desinstalador original do programa (nunca remove silenciosamente).',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'A remoção é feita pelo desinstalador do próprio programa; para voltar, reinstale o programa.',
  requiresElevation: false,
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'programa', 16, /^[0-9a-f]{16}$/) }),
  async preview({ id }) {
    const app = (await listInstalled()).find((a) => a.id === id)
    if (!app) return { summary: 'Programa não encontrado.', changes: [], warnings: [], blocked: 'O programa não aparece mais na lista.' }
    return {
      summary: `${app.name} ${app.version ?? ''} — ${app.publisher ?? 'editor desconhecido'}`,
      changes: [{ target: app.name, current: 'Instalado', intended: 'Desinstalador aberto (você conclui na janela dele)' }],
      warnings: [
        app.uninstallMethod === 'settings'
          ? 'Não foi encontrado um desinstalador utilizável; a tela "Aplicativos" das Configurações do Windows será aberta.'
          : `Será executado: ${app.uninstallCommand}`,
        'A remoção depende do desinstalador original, que pode pedir permissão de administrador.'
      ],
      blocked: null
    }
  },
  async execute({ id }) {
    const app = (await listInstalled()).find((a) => a.id === id)
    if (!app) throw new AppFailure('not-found', 'Programa não encontrado.')
    if (app.uninstallMethod === 'msi') {
      const guid = app.uninstallCommand!.split(' ').pop()!
      spawn('msiexec.exe', ['/x', guid], { detached: true, stdio: 'ignore' }).unref()
    } else if (app.uninstallMethod === 'executable') {
      const parsed = parseCommandLine(app.uninstallCommand!)!
      const exe = parsed.exe.replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? `%${v}%`)
      if (!existsSync(exe)) throw new AppFailure('not-found', `O desinstalador não existe: ${exe}`)
      spawn(exe, parsed.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref()
    } else {
      await shell.openExternal('ms-settings:appsfeatures')
    }
    return {
      ok: true,
      verified: false,
      summary: `Desinstalador de ${app.name} aberto. Conclua na janela dele e depois atualize a lista para confirmar a remoção.`
    }
  }
})

// ---------------------------------------------------------------------------
// 6.6 Aplicativos pré-instalados (pacotes Appx do usuário)
// ---------------------------------------------------------------------------

/** Pacotes que sustentam o Windows e nunca são removidos pelo JK Optimize. */
export const ESSENTIAL_APPX = [
  'Microsoft.WindowsStore',
  'Microsoft.DesktopAppInstaller',
  'Microsoft.StorePurchaseApp',
  'Microsoft.SecHealthUI',
  'Microsoft.Windows.ShellExperienceHost',
  'Microsoft.Windows.StartMenuExperienceHost',
  'Microsoft.Windows.Search',
  'Microsoft.Windows.Cortana',
  'Microsoft.WindowsCalculator',
  'Microsoft.Windows.Photos',
  'Microsoft.ScreenSketch',
  'windows.immersivecontrolpanel',
  'Microsoft.AAD.BrokerPlugin',
  'Microsoft.AccountsControl',
  'Microsoft.LockApp',
  'Microsoft.Win32WebViewHost',
  'Microsoft.WindowsAppRuntime',
  'Microsoft.UI.Xaml',
  'Microsoft.VCLibs',
  'Microsoft.NET.Native',
  'Microsoft.Services.Store.Engagement',
  'Microsoft.XboxIdentityProvider',
  'Microsoft.XboxGameCallableUI',
  'Microsoft.Windows.CloudExperienceHost',
  'Microsoft.Windows.ContentDeliveryManager',
  'MicrosoftWindows.Client.CBS',
  'MicrosoftWindows.Client.Core',
  'Microsoft.WindowsNotepad',
  'Microsoft.WindowsTerminal'
].map((n) => n.toLowerCase())

const APPX = `
$user = @(Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; full = $_.PackageFullName; version = [string]$_.Version; publisher = $_.Publisher
    nonRemovable = [bool]$_.NonRemovable; framework = [bool]$_.IsFramework; signature = [string]$_.SignatureKind; location = $_.InstallLocation }
})
$prov = $null; $provError = $null
try { $prov = @(Get-AppxProvisionedPackage -Online -ErrorAction Stop | ForEach-Object { $_.DisplayName }) } catch { $provError = $_.Exception.Message }
[pscustomobject]@{ user = $user; provisioned = $prov; provisionedError = $provError } | ConvertTo-Json -Depth 3 -Compress`

export function appxBlockReason(name: string, nonRemovable: boolean, framework: boolean, signature: string): string | null {
  const lower = name.toLowerCase()
  if (nonRemovable) return 'Marcado pelo Windows como não removível.'
  if (framework) return 'Biblioteca usada por outros aplicativos.'
  if (signature === 'System') return 'Componente do sistema.'
  if (ESSENTIAL_APPX.some((e) => lower === e || lower.startsWith(e + '.'))) return 'Componente essencial do Windows.'
  return null
}

async function listAppx() {
  const raw = await runPowerShellJson<{ user: unknown; provisioned: unknown; provisionedError: string | null }>(APPX, { timeoutMs: 60_000 })
  const provisioned = raw?.provisioned ? new Set(asArray(raw.provisioned).map((n) => String(n).toLowerCase())) : null
  const packages = asArray(raw?.user).map((r) => {
    const p = r as Record<string, unknown>
    const name = String(p.name)
    const signature = String(p.signature ?? '')
    const reason = appxBlockReason(name, p.nonRemovable === true, p.framework === true, signature)
    return {
      name,
      fullName: String(p.full),
      version: asString(p.version),
      publisher: asString(p.publisher)?.replace(/^CN=([^,]+).*$/, '$1') ?? null,
      signature,
      kind: p.framework === true ? 'Biblioteca' : signature === 'Store' ? 'Loja' : signature === 'System' ? 'Sistema' : signature === 'Developer' ? 'Desenvolvedor' : 'Usuário',
      provisioned: provisioned ? provisioned.has(name.toLowerCase()) : null,
      removable: reason === null,
      blockReason: reason
    }
  })
  return {
    packages: packages.sort((a, b) => Number(b.removable) - Number(a.removable) || a.name.localeCompare(b.name)),
    provisionedNote: raw?.provisionedError ? 'Lista de pacotes provisionados indisponível sem administrador.' : null
  }
}

defineQuery({ id: 'apps.appx', module: 'apps', parse: noParams, run: () => listAppx() })

const REMOVE_APPX = `
Remove-AppxPackage -Package $in.full -ErrorAction Stop
$still = [bool](Get-AppxPackage | Where-Object { $_.PackageFullName -eq $in.full })
[pscustomobject]@{ still = $still } | ConvertTo-Json -Compress`

defineAction<{ fullName: string }, never>({
  id: 'apps.appx.remove',
  module: 'apps',
  title: 'Remover aplicativo pré-instalado',
  description: 'Remove um pacote Appx removível somente para o usuário atual.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'O JK Optimize não reinstala pacotes; para voltar, instale o aplicativo pela Microsoft Store.',
  requiresElevation: false,
  parse: (raw) => ({ fullName: str(obj(raw, ['fullName']).fullName, 'pacote', 300, /^[A-Za-z0-9._~-]+$/) }),
  async preview({ fullName }) {
    const pkg = (await listAppx()).packages.find((p) => p.fullName === fullName)
    return {
      summary: pkg ? `${pkg.name} ${pkg.version ?? ''} (${pkg.kind})` : 'Pacote não encontrado.',
      changes: pkg ? [{ target: pkg.name, current: 'Instalado para este usuário', intended: 'Removido para este usuário' }] : [],
      warnings: [
        'Outros usuários do computador não são afetados.',
        ...(pkg?.provisioned ? ['O pacote está provisionado: o Windows pode reinstalá-lo em novos usuários ou grandes atualizações.'] : [])
      ],
      blocked: !pkg ? 'O pacote não está mais instalado.' : pkg.blockReason
    }
  },
  async execute({ fullName }) {
    const pkg = (await listAppx()).packages.find((p) => p.fullName === fullName)
    if (!pkg || !pkg.removable) throw new AppFailure('blocked', 'Pacote não removível.')
    let r: { still: boolean } | null
    try {
      r = await runPowerShellWith<{ still: boolean }>(REMOVE_APPX, { full: fullName }, { timeoutMs: 120_000 })
    } catch (error) {
      throw new AppFailure('appx-failed', `O Windows recusou a remoção: ${(error as Error).message.split('\n')[0]}`)
    }
    const removed = r?.still === false
    return { ok: removed, verified: true, summary: removed ? `${pkg.name} removido (conferido).` : `${pkg.name} continua instalado.` }
  }
})

// ---------------------------------------------------------------------------
// 6.7 Aplicativos em segundo plano
// ---------------------------------------------------------------------------

defineQuery({
  id: 'apps.background',
  module: 'apps',
  parse: noParams,
  async run() {
    const [processes, startup] = await Promise.all([listProcesses(), listStartup()])
    const startupByExe = new Map<string, { source: string; name: string; enabled: boolean; sourceLabel: string }>()
    for (const e of startup.entries) if (e.exe) startupByExe.set(e.exe.toLowerCase(), e)
    return processes
      .filter((p) => p.sameSession && !p.hasWindow && !p.critical && p.path)
      .map((p) => {
        const entry = startupByExe.get(p.path!.toLowerCase())
        return {
          pid: p.pid,
          name: p.name,
          description: p.description,
          company: p.company,
          path: p.path,
          startTime: p.startTime,
          workingSet: p.workingSet,
          startsWithWindows: entry ? { source: entry.source, name: entry.name, enabled: entry.enabled, label: entry.sourceLabel } : null
        }
      })
      .sort((a, b) => b.workingSet - a.workingSet)
  }
})
