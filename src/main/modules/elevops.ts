// Operações administrativas em lote: UM aviso do Windows (UAC) executa todas as operações do lote.
// Só existem os tipos abaixo, cada um com lista fixa de alvos permitidos (validada aqui e de novo no script elevado);
// nenhum texto vindo da interface vira comando. O resultado de cada operação volta separado (ok/erro).
import { AppFailure } from '../security/validate'
import { runElevated } from '../services/elevated'

/** Prefixos do HKLM que o JK Optimize pode gravar (políticas e chaves documentadas dos ajustes do catálogo). */
export const HKLM_ALLOWED = [
  'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\',
  'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\',
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile',
  'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power',
  'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers'
] as const

/** Serviços cujo tipo de inicialização pode ser alterado (nunca serviços de segurança, rede básica ou atualização). */
export const SERVICES_ALLOWED = ['bthserv', 'DiagTrack', 'WSearch'] as const

/** Tarefas agendadas que podem ser ativadas ou desativadas. */
export const TASKS_ALLOWED = [{ path: '\\Microsoft\\Windows\\DiskCleanup\\', name: 'SilentCleanup' }] as const

export type ElevOp =
  | { k: 'reg'; key: string; name: string; type: 'DWord' | 'String'; data: number | string | null }
  | { k: 'svc'; name: string; start: 'auto' | 'delayed' | 'manual' | 'disabled'; run: boolean | null }
  | { k: 'hib'; on: boolean }
  | { k: 'lastaccess'; value: 0 | 1 | 2 | 3 }
  | { k: 'task'; path: string; name: string; enable: boolean }
  | { k: 'dns'; alias: string; servers: string[] | null }

export interface ElevOpResult {
  ok: boolean
  error?: string
}

/** Valida cada operação no lado do aplicativo (mesmas regras do script elevado). */
export function validateOps(ops: ElevOp[]): void {
  if (ops.length === 0 || ops.length > 60) throw new AppFailure('invalid-input', 'Lote de operações inválido.')
  for (const o of ops) {
    switch (o.k) {
      case 'reg':
        if (!HKLM_ALLOWED.some((p) => o.key.startsWith(p))) throw new AppFailure('invalid-input', `Chave do registro não permitida: ${o.key}`)
        if (!/^[A-Za-z0-9_]{1,64}$/.test(o.name)) throw new AppFailure('invalid-input', 'Nome de valor inválido.')
        if (o.data !== null && o.type === 'DWord' && !Number.isInteger(o.data)) throw new AppFailure('invalid-input', 'Valor DWORD inválido.')
        break
      case 'svc':
        if (!(SERVICES_ALLOWED as readonly string[]).includes(o.name)) throw new AppFailure('invalid-input', `Serviço não permitido: ${o.name}`)
        if (!['auto', 'delayed', 'manual', 'disabled'].includes(o.start)) throw new AppFailure('invalid-input', 'Tipo de inicialização inválido.')
        break
      case 'hib':
        break
      case 'lastaccess':
        if (![0, 1, 2, 3].includes(o.value)) throw new AppFailure('invalid-input', 'Valor inválido.')
        break
      case 'task':
        if (!TASKS_ALLOWED.some((t) => t.path === o.path && t.name === o.name)) throw new AppFailure('invalid-input', 'Tarefa não permitida.')
        break
      case 'dns':
        if (!/^[\p{L}\p{N} ._()-]{1,64}$/u.test(o.alias)) throw new AppFailure('invalid-input', 'Nome de adaptador inválido.')
        if (o.servers !== null && (o.servers.length < 1 || o.servers.length > 4 || !o.servers.every((x) => /^(\d{1,3}\.){3}\d{1,3}$/.test(x) && x.split('.').every((n) => Number(n) <= 255)))) throw new AppFailure('invalid-input', 'Endereço DNS inválido.')
        break
      default:
        throw new AppFailure('invalid-input', 'Operação desconhecida.')
    }
  }
}

const SCRIPT = (): string => `
$allowedKeys = ${JSON.stringify(HKLM_ALLOWED)}
$allowedSvc = ${JSON.stringify(SERVICES_ALLOWED)}
$allowedTasks = ${JSON.stringify(TASKS_ALLOWED.map((t) => t.path + t.name))}
$results = @()
foreach ($o in @($in.ops)) {
  $r = [ordered]@{ ok = $true; error = $null }
  try {
    switch ([string]$o.k) {
      'reg' {
        $key = [string]$o.key
        if (-not ($allowedKeys | Where-Object { $key.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) { throw 'chave não permitida' }
        if ($null -eq $o.data) { Remove-ItemProperty -LiteralPath $key -Name ([string]$o.name) -ErrorAction SilentlyContinue }
        else {
          if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
          if ([string]$o.type -eq 'DWord') { Set-ItemProperty -LiteralPath $key -Name ([string]$o.name) -Value ([int]$o.data) -Type DWord }
          else { Set-ItemProperty -LiteralPath $key -Name ([string]$o.name) -Value ([string]$o.data) -Type String }
        }
      }
      'svc' {
        $n = [string]$o.name
        if ($allowedSvc -notcontains $n) { throw 'serviço não permitido' }
        $svc = Get-Service -Name $n -ErrorAction Stop
        switch ([string]$o.start) {
          'auto' { Set-Service -Name $n -StartupType Automatic -ErrorAction Stop }
          'delayed' { Set-Service -Name $n -StartupType Automatic -ErrorAction Stop; & sc.exe config $n start= delayed-auto | Out-Null; if ($LASTEXITCODE -ne 0) { throw "sc.exe retornou $LASTEXITCODE" } }
          'manual' { Set-Service -Name $n -StartupType Manual -ErrorAction Stop }
          'disabled' { Set-Service -Name $n -StartupType Disabled -ErrorAction Stop }
          default { throw 'tipo inválido' }
        }
        if ($o.run -eq $false -and $svc.Status -ne 'Stopped') {
          Stop-Service -Name $n -Force -ErrorAction Stop
          $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
          $svc.Refresh()
          if ($svc.Status -ne 'Stopped') { throw "o serviço continua em execução ($($svc.Status))" }
        }
        if ($o.run -eq $true -and $svc.Status -ne 'Running') {
          Start-Service -Name $n -ErrorAction Stop
        }
      }
      'hib' {
        $arg = if ($o.on -eq $true) { 'on' } else { 'off' }
        $out = (& powercfg.exe /hibernate $arg) 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "powercfg retornou $LASTEXITCODE. $($out.Trim())" }
      }
      'lastaccess' {
        $v = [int]$o.value
        if ($v -lt 0 -or $v -gt 3) { throw 'valor inválido' }
        $out = (& fsutil.exe behavior set disablelastaccess $v) 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "fsutil retornou $LASTEXITCODE. $($out.Trim())" }
      }
      'task' {
        if ($allowedTasks -notcontains ([string]$o.path + [string]$o.name)) { throw 'tarefa não permitida' }
        if ($o.enable -eq $true) { Enable-ScheduledTask -TaskPath ([string]$o.path) -TaskName ([string]$o.name) -ErrorAction Stop | Out-Null }
        else { Disable-ScheduledTask -TaskPath ([string]$o.path) -TaskName ([string]$o.name) -ErrorAction Stop | Out-Null }
      }
      'dns' {
        $alias = [string]$o.alias
        if ($alias -notmatch '^[\\p{L}\\p{N} ._()-]{1,64}$') { throw 'adaptador inválido' }
        if ($null -eq $o.servers) { Set-DnsClientServerAddress -InterfaceAlias $alias -ResetServerAddresses -ErrorAction Stop }
        else {
          $list = @($o.servers | ForEach-Object { [string]$_ })
          foreach ($a in $list) { if ($a -notmatch '^(\\d{1,3}\\.){3}\\d{1,3}$') { throw 'endereço inválido' } }
          Set-DnsClientServerAddress -InterfaceAlias $alias -ServerAddresses $list -ErrorAction Stop
        }
      }
      default { throw 'operação desconhecida' }
    }
  } catch {
    $r.ok = $false
    $r.error = $_.Exception.Message
  }
  $results += [pscustomobject]$r
}
Out-Result ([pscustomobject]@{ results = @($results) })
exit 0`

/**
 * Executa o lote com UM pedido de administrador. Recusar o UAC lança AppFailure('elevation-cancelled') e nada é alterado.
 * Devolve um resultado por operação, na mesma ordem.
 */
export async function runElevatedOps(ops: ElevOp[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ElevOpResult[]> {
  validateOps(ops)
  const { output } = await runElevated<{ results: ElevOpResult[] | ElevOpResult }>(SCRIPT(), { ops }, { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal })
  const raw = output?.results
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  if (list.length !== ops.length) throw new AppFailure('elevated-failed', 'O script de administrador não devolveu o resultado de todas as operações.')
  return list.map((r) => ({ ok: r.ok === true, error: r.error ?? undefined }))
}
