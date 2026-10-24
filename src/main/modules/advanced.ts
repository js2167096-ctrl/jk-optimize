// Otimização 2: consulta do estado de segurança do Windows (somente leitura), otimização de volumes
// (desfragmentação/TRIM pela mídia real) e execução das tarefas ociosas do Windows.
import os from 'node:os'
import { formatBytes } from '@shared/format'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, strList } from '../ops/params'
import { AppFailure } from '../security/validate'
import { runElevated } from '../services/elevated'
import { asArray, runPowerShellJson } from '../services/powershell'

// ---------------------------------------------------------------------------
// Estado de segurança (Defender, firewall, SmartScreen, UAC): somente consulta
// ---------------------------------------------------------------------------

const SECURITY_SCRIPT = `
$d = $null
try { $d = Get-MpComputerStatus -ErrorAction Stop } catch {}
$fw = @()
try { $fw = @(Get-NetFirewallProfile -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; enabled = [string]$_.Enabled } }) } catch {}
$av = @(); $avd = @()
try { $p = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop); $av = @($p | ForEach-Object { [string]$_.displayName }); $avd = @($p | ForEach-Object { [string]$_.displayName + ' (productState 0x' + ([int]$_.productState).ToString('X6') + ')' }) } catch {}
function RegVal($key, $name) { try { (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction Stop).$name } catch { $null } }
$sys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'
[pscustomobject]@{
  defender = if ($d) { [pscustomobject]@{ service = [bool]$d.AMServiceEnabled; antivirus = [bool]$d.AntivirusEnabled; realtime = [bool]$d.RealTimeProtectionEnabled; tamper = [bool]$d.IsTamperProtected; mode = [string]$d.AMRunningMode; signatureAge = [int]$d.AntivirusSignatureAge } } else { $null }
  antivirus = $av
  antivirusDetail = $avd
  defenderRegistry = [pscustomobject]@{ tamper = RegVal 'HKLM:\\SOFTWARE\\Microsoft\\Windows Defender\\Features' 'TamperProtection'; disableRealtime = RegVal 'HKLM:\\SOFTWARE\\Microsoft\\Windows Defender\\Real-Time Protection' 'DisableRealtimeMonitoring'; policyDisable = RegVal 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows Defender' 'DisableAntiSpyware' }
  firewall = $fw
  smartscreen = [pscustomobject]@{ explorer = RegVal 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer' 'SmartScreenEnabled'; policy = RegVal 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\System' 'EnableSmartScreen' }
  uac = [pscustomobject]@{ lua = RegVal $sys 'EnableLUA'; admin = RegVal $sys 'ConsentPromptBehaviorAdmin'; secure = RegVal $sys 'PromptOnSecureDesktop' }
} | ConvertTo-Json -Depth 5 -Compress`

export interface SecurityRaw {
  defender: { service: boolean; antivirus: boolean; realtime: boolean; tamper: boolean; mode: string; signatureAge: number } | null
  antivirus: string[] | string
  antivirusDetail?: string[] | string
  defenderRegistry?: { tamper: number | null; disableRealtime: number | null; policyDisable: number | null }
  firewall: { name: string; enabled: string }[] | { name: string; enabled: string }
  smartscreen: { explorer: string | null; policy: number | null }
  uac: { lua: number | null; admin: number | null; secure: number | null }
}

export interface SecurityRow {
  id: string
  name: string
  /** Estado lido do Windows. */
  state: 'ativo' | 'parcial' | 'desativado' | 'desconhecido'
  summary: string
  details: string[]
}

const FW_NAME: Record<string, string> = { Domain: 'Domínio', Private: 'Privado', Public: 'Público' }

/** Converte a leitura bruta em linhas de estado (função pura, testável). */
export function buildSecurityRows(raw: SecurityRaw): SecurityRow[] {
  const rows: SecurityRow[] = []
  const av = asArray(raw.antivirus).map(String)
  const d = raw.defender
  if (!d) {
    const reg = raw.defenderRegistry
    const detail = asArray(raw.antivirusDetail).map(String)
    rows.push({
      id: 'defender',
      name: 'Microsoft Defender',
      state: 'desconhecido',
      summary: 'O Windows não respondeu à consulta detalhada do Defender; o estado em tempo real não pôde ser confirmado.',
      details: [
        ...(detail.length ? [`Antivírus no Centro de Segurança: ${detail.join('; ')}`] : av.length ? [`Antivírus no Centro de Segurança: ${av.join(', ')}`] : []),
        ...(reg ? [`Proteção contra adulteração (registro): ${reg.tamper === 5 ? 'ativa' : reg.tamper === 4 ? 'desativada' : reg.tamper === null ? 'não informada' : `valor ${reg.tamper}`}`, `Configuração DisableRealtimeMonitoring: ${reg.disableRealtime ?? 'não definida'}`, `Política DisableAntiSpyware: ${reg.policyDisable ?? 'não definida'}`] : []),
        'Estes são valores de configuração, não o estado em execução.'
      ]
    })
  } else {
    const passive = /passive|sxs/i.test(d.mode)
    const state = d.antivirus && d.realtime ? 'ativo' : d.antivirus || d.realtime ? 'parcial' : 'desativado'
    rows.push({
      id: 'defender',
      name: 'Microsoft Defender',
      state,
      summary: passive ? 'Modo passivo (outro antivírus está ativo)' : d.realtime ? 'Proteção em tempo real ativa' : 'Proteção em tempo real desativada',
      details: [
        `Antivírus: ${d.antivirus ? 'ativo' : 'desativado'}`,
        `Proteção contra adulteração: ${d.tamper ? 'ativa (impede alterações não autorizadas nas proteções)' : 'desativada'}`,
        `Modo de execução: ${d.mode || 'desconhecido'}`,
        `Idade das assinaturas: ${d.signatureAge} dia(s)`,
        ...(av.length ? [`Antivírus registrados no Windows: ${av.join(', ')}`] : [])
      ]
    })
  }
  const fw = asArray(raw.firewall) as { name: string; enabled: string }[]
  if (fw.length === 0) rows.push({ id: 'firewall', name: 'Firewall do Windows', state: 'desconhecido', summary: 'Não foi possível ler os perfis do firewall.', details: [] })
  else {
    const on = fw.filter((p) => /^true$/i.test(p.enabled)).length
    rows.push({
      id: 'firewall',
      name: 'Firewall do Windows',
      state: on === fw.length ? 'ativo' : on === 0 ? 'desativado' : 'parcial',
      summary: `${on} de ${fw.length} perfis ativos`,
      details: fw.map((p) => `Perfil ${FW_NAME[p.name] ?? p.name}: ${/^true$/i.test(p.enabled) ? 'ativo' : 'desativado'}`)
    })
  }
  const ss = raw.smartscreen
  const ssText = ss.explorer ?? null
  const ssOff = (ssText && /^off$/i.test(ssText)) || ss.policy === 0
  rows.push({
    id: 'smartscreen',
    name: 'SmartScreen (aplicativos e arquivos)',
    state: ssOff ? 'desativado' : ssText || ss.policy === 1 ? 'ativo' : 'desconhecido',
    summary: ssOff ? 'Desativado' : ssText ? `Modo: ${ssText}` : ss.policy === 1 ? 'Ativado por política' : 'Sem configuração explícita (padrão do Windows)',
    details: [`Configuração do Explorador: ${ssText ?? 'não definida'}`, `Política do sistema (EnableSmartScreen): ${ss.policy ?? 'não definida'}`]
  })
  const u = raw.uac
  const level = u.lua === 0 ? 'UAC desativado' : u.admin === 2 ? 'Sempre notificar' : u.admin === 5 && u.secure === 1 ? 'Notificar apenas quando aplicativos tentam fazer alterações (padrão)' : u.admin === 5 ? 'Notificar sem escurecer a área de trabalho' : u.admin === 0 ? 'Nunca notificar' : `Personalizado (admin=${u.admin ?? '?'}, área segura=${u.secure ?? '?'})`
  rows.push({
    id: 'uac',
    name: 'Controle de Conta de Usuário (UAC)',
    state: u.lua === null ? 'desconhecido' : u.lua === 0 ? 'desativado' : u.admin === 0 ? 'parcial' : 'ativo',
    summary: level,
    details: [`EnableLUA: ${u.lua ?? 'não lido'}`, `ConsentPromptBehaviorAdmin: ${u.admin ?? 'não lido'}`, `PromptOnSecureDesktop: ${u.secure ?? 'não lido'}`]
  })
  return rows
}

defineQuery({
  id: 'security.status',
  module: 'windows',
  parse: noParams,
  async run() {
    const raw = await runPowerShellJson<SecurityRaw>(SECURITY_SCRIPT, { timeoutMs: 30_000 })
    if (!raw) throw new AppFailure('security-read-failed', 'Não foi possível consultar o estado de segurança do Windows.')
    return { rows: buildSecurityRows(raw), readAt: new Date().toISOString() }
  }
})

// ---------------------------------------------------------------------------
// Volumes: desfragmentar (HDD) ou TRIM (SSD)
// ---------------------------------------------------------------------------

const VOLUMES_SCRIPT = `
$vols = @(Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveType -eq 'Fixed' -and $_.DriveLetter } | ForEach-Object {
  $l = [string]$_.DriveLetter; $media = 'Unknown'
  try { $media = [string]@(Get-Partition -DriveLetter $l -ErrorAction Stop | Get-Disk -ErrorAction Stop | Get-PhysicalDisk -ErrorAction Stop)[0].MediaType } catch {}
  [pscustomobject]@{ letter = $l; label = [string]$_.FileSystemLabel; fs = [string]$_.FileSystem; size = [double]$_.Size; free = [double]$_.SizeRemaining; media = $media }
})
@($vols) | ConvertTo-Json -Depth 3 -Compress`

export interface VolumeInfo {
  letter: string
  label: string
  fs: string
  size: number
  free: number
  media: string
  /** Operação escolhida pela mídia real; null = não suportada. */
  op: 'retrim' | 'defrag' | 'auto' | null
  opLabel: string
}

export function planVolumeOp(fs: string, media: string): Pick<VolumeInfo, 'op' | 'opLabel'> {
  if (!/^(NTFS|ReFS)$/i.test(fs)) return { op: null, opLabel: `Sistema de arquivos ${fs || 'desconhecido'} não suportado` }
  if (/^SSD$/i.test(media)) return { op: 'retrim', opLabel: 'TRIM (SSD não é desfragmentado)' }
  if (/^HDD$/i.test(media)) return { op: 'defrag', opLabel: 'Desfragmentação (HDD)' }
  return { op: 'auto', opLabel: 'Otimização automática (o Windows escolhe pelo tipo de mídia)' }
}

async function listVolumes(): Promise<VolumeInfo[]> {
  const raw = await runPowerShellJson<unknown>(VOLUMES_SCRIPT, { timeoutMs: 40_000 })
  return asArray(raw).map((v) => {
    const r = v as { letter: string; label: string; fs: string; size: number; free: number; media: string }
    return { letter: String(r.letter).toUpperCase(), label: String(r.label ?? ''), fs: String(r.fs ?? ''), size: Number(r.size) || 0, free: Number(r.free) || 0, media: String(r.media ?? 'Unknown'), ...planVolumeOp(String(r.fs ?? ''), String(r.media ?? '')) }
  })
}

defineQuery({
  id: 'disk.volumes',
  module: 'performance',
  parse: noParams,
  run: async () => listVolumes()
})

const OPTIMIZE_SCRIPT = `
$results = @()
foreach ($v in @($in.volumes)) {
  $l = [string]$v.letter
  if ($l -notmatch '^[A-Z]$') { continue }
  Add-Content -LiteralPath $LOG -Value "START $l"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ok = $true; $err = $null
  try {
    switch ([string]$v.op) {
      'retrim' { Optimize-Volume -DriveLetter $l -ReTrim -ErrorAction Stop }
      'defrag' { Optimize-Volume -DriveLetter $l -Defrag -ErrorAction Stop }
      'auto' { Optimize-Volume -DriveLetter $l -ErrorAction Stop }
      default { throw 'operação inválida' }
    }
  } catch { $ok = $false; $err = $_.Exception.Message }
  Add-Content -LiteralPath $LOG -Value ("END $l " + $(if ($ok) { 'ok' } else { 'erro' }))
  $results += [pscustomobject]@{ letter = $l; ok = $ok; error = $err; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}
Out-Result ([pscustomobject]@{ results = @($results) })
exit 0`

defineAction<{ drives: string[] }, never>({
  id: 'disk.optimize',
  module: 'performance',
  title: 'Otimizar unidades (desfragmentar / TRIM)',
  description: 'Executa a otimização oficial do Windows em cada unidade: TRIM em SSD e desfragmentação em HDD.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'É uma reorganização física dos dados feita pelo próprio Windows; não há estado anterior a restaurar.',
  requiresElevation: true,
  exclusive: 'disk-optimize',
  parse: (raw) => ({ drives: [...new Set(strList(obj(raw, ['drives']).drives, 'unidades', 26, 1, /^[A-Za-z]$/).map((d) => d.toUpperCase()))] }),
  async preview({ drives }) {
    const vols = (await listVolumes()).filter((v) => drives.includes(v.letter))
    const ok = vols.filter((v) => v.op)
    return {
      summary: `${ok.length} unidade(s) a otimizar.`,
      changes: vols.map((v) => ({ target: `${v.letter}: ${v.label ? `(${v.label}) ` : ''}· ${formatBytes(v.size)} · ${v.fs || '?'} · ${v.media}`, current: `${formatBytes(v.free)} livres`, intended: v.opLabel })),
      warnings: [
        'Exige administrador (o Windows pede permissão).',
        'Em HDD a desfragmentação pode levar de minutos a horas e deixa o disco ocupado; em SSD só o TRIM é feito.',
        'O JK Optimize não promete ganho de desempenho; o resultado de cada unidade é informado ao final.'
      ],
      blocked: ok.length === 0 ? 'Nenhuma unidade selecionada pode ser otimizada neste computador.' : null
    }
  },
  async execute({ drives }, ctx) {
    const vols = (await listVolumes()).filter((v) => drives.includes(v.letter) && v.op)
    if (vols.length === 0) throw new AppFailure('no-volumes', 'Nenhuma unidade elegível.')
    const seen = new Set<string>()
    const emit = (v: VolumeInfo, state: 'running' | 'ok' | 'error', message?: string, done = 0) => ctx.progress(`${v.letter}:…`, done, vols.length, { stage: 'item', id: v.letter, name: `Unidade ${v.letter}:`, state, message })
    for (const v of vols) emit(v, 'running', undefined, 0)
    let finished = 0
    const { output } = await runElevated<{ results: { letter: string; ok: boolean; error: string | null; seconds: number }[] | { letter: string; ok: boolean; error: string | null; seconds: number } }>(
      OPTIMIZE_SCRIPT,
      { volumes: vols.map((v) => ({ letter: v.letter, op: v.op })) },
      {
        timeoutMs: 4 * 3_600_000,
        signal: ctx.signal,
        onLog: (text) => {
          for (const m of text.matchAll(/^END ([A-Z]) (ok|erro)/gm)) {
            if (seen.has(m[1])) continue
            seen.add(m[1])
            finished++
            const v = vols.find((x) => x.letter === m[1])
            if (v) emit(v, m[2] === 'ok' ? 'ok' : 'error', undefined, finished)
          }
        }
      }
    )
    const results = asArray(output?.results) as { letter: string; ok: boolean; error: string | null; seconds: number }[]
    const failed = results.filter((r) => !r.ok)
    return {
      ok: failed.length === 0 && results.length === vols.length,
      verified: true,
      summary: failed.length === 0 ? `${results.length} unidade(s) otimizada(s) pelo Windows.` : `${results.length - failed.length} de ${vols.length} unidade(s) otimizada(s); ${failed.length} falharam.`,
      sections: [
        {
          title: 'Unidades',
          rows: vols.map((v) => {
            const r = results.find((x) => x.letter === v.letter)
            return { label: `${v.letter}: · ${v.opLabel}`, value: !r ? 'Sem resultado' : r.ok ? `Concluída em ${r.seconds} s` : `Falhou: ${r.error}`, tone: !r ? ('warn' as const) : r.ok ? ('ok' as const) : ('error' as const) }
          })
        }
      ]
    }
  }
})

// ---------------------------------------------------------------------------
// Tarefas ociosas do Windows (ProcessIdleTasks)
// ---------------------------------------------------------------------------

const IDLE_SCRIPT = `
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\rundll32.exe') -ArgumentList 'advapi32.dll,ProcessIdleTasks' -Wait -PassThru -WindowStyle Hidden
Out-Result ([pscustomobject]@{ exitCode = $p.ExitCode; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1) })
exit 0`

defineAction<Record<string, never>, never>({
  id: 'memory.idleTasks',
  module: 'performance',
  title: 'Forçar tarefas ociosas do Windows',
  description: 'Pede ao Windows que execute agora as tarefas de manutenção que ele deixaria para quando o computador está ocioso.',
  risk: 'low',
  reversible: false,
  irreversibleReason: 'É uma execução de manutenção interna do Windows; não há estado anterior a restaurar.',
  requiresElevation: true,
  exclusive: 'idle-tasks',
  parse: noParams,
  async preview() {
    return {
      summary: 'Executa advapi32.dll,ProcessIdleTasks com administrador.',
      changes: [{ target: 'Tarefas ociosas do Windows', current: 'Aguardando ociosidade', intended: 'Executadas agora' }],
      warnings: [
        'Este ponto de entrada é interno do Windows (usado há muitas versões, mas sem documentação pública oficial).',
        'Pode haver uso intenso de disco durante a execução. Ele NÃO libera memória RAM por si só; a memória livre antes e depois é medida e informada.',
        'O JK Optimize não promete ganho de desempenho.'
      ],
      blocked: null
    }
  },
  async execute(_p, ctx) {
    const before = os.freemem()
    ctx.progress('Executando tarefas ociosas do Windows…', 0, 1, { stage: 'item', id: 'idle', name: 'Tarefas ociosas', state: 'running' })
    const { output } = await runElevated<{ exitCode: number; seconds: number }>(IDLE_SCRIPT, {}, { timeoutMs: 30 * 60_000, signal: ctx.signal })
    const after = os.freemem()
    const ok = output?.exitCode === 0
    ctx.progress('Concluído', 1, 1, { stage: 'item', id: 'idle', name: 'Tarefas ociosas', state: ok ? 'ok' : 'error' })
    return {
      ok,
      verified: true,
      summary: ok ? `Tarefas ociosas executadas em ${output!.seconds} s. Memória livre ${formatBytes(before)} → ${formatBytes(after)}.` : `O Windows retornou o código ${output?.exitCode ?? '?'}.`,
      sections: [{ title: 'Medição', rows: [{ label: 'Tempo', value: `${output?.seconds ?? '?'} s` }, { label: 'Memória livre antes', value: formatBytes(before) }, { label: 'Memória livre depois', value: formatBytes(after) }] }]
    }
  }
})
