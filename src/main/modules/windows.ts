// Diagnóstico e manutenção do Windows: diagnóstico geral, saúde dos discos,
// SFC/DISM, drivers, eventos, ponto de restauração, benchmark e backups.
import { app } from 'electron'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery, journal, listChanges } from '../ops/registry'
import { bool, int, noParams, obj, oneOf, str } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson, withInput } from '../services/powershell'
import { runElevated } from '../services/elevated'
import { getStaticInfo } from '../services/system'
import { JsonStore } from '../services/store'
import { runTask } from '../executor/host'
import { demandSample } from './sampler'
import { getPowerState } from './power'
import { listStartup } from './startup'

// ---------------------------------------------------------------------------
// 9.2 Saúde dos discos
// ---------------------------------------------------------------------------

const DISKS = `
$errs = @()
$pd = @(); try { $pd = @(Get-PhysicalDisk -ErrorAction Stop) } catch { $errs += 'Get-PhysicalDisk: ' + $_.Exception.Message }
$disks = foreach ($d in $pd) {
  $rel = $null; $relErr = $null
  try { $r = $d | Get-StorageReliabilityCounter -ErrorAction Stop; $rel = [pscustomobject]@{ temp = $r.Temperature; tempMax = $r.TemperatureMax; wear = $r.Wear; readErr = $r.ReadErrorsTotal; writeErr = $r.WriteErrorsTotal; hours = $r.PowerOnHours } } catch { $relErr = $_.Exception.Message }
  [pscustomobject]@{ id = [string]$d.DeviceId; name = $d.FriendlyName; media = [string]$d.MediaType; bus = [string]$d.BusType; health = [string]$d.HealthStatus; op = (@($d.OperationalStatus) -join ', '); size = $d.Size; rel = $rel; relErr = $relErr }
}
$smart = $null; $smartErr = $null
try { $smart = @(Get-CimInstance -Namespace root/wmi MSStorageDriver_FailurePredictStatus -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ inst = $_.InstanceName; predict = [bool]$_.PredictFailure; reason = $_.Reason } }) } catch { $smartErr = $_.Exception.Message }
$vol = @(Get-Volume -ErrorAction SilentlyContinue | Where-Object DriveLetter | ForEach-Object { [pscustomobject]@{ letter = [string]$_.DriveLetter; label = $_.FileSystemLabel; fs = $_.FileSystem; health = [string]$_.HealthStatus; size = $_.Size; free = $_.SizeRemaining } })
Out-Result-Or-Json ([pscustomobject]@{ disks = @($disks); smart = $smart; smartErr = $smartErr; volumes = $vol; errors = $errs })`

const asJson = 'function Out-Result-Or-Json($o) { $o | ConvertTo-Json -Depth 5 -Compress }\n'
const asElevated = 'function Out-Result-Or-Json($o) { Out-Result $o }\n'

function mapDisks(r: Record<string, unknown> | null, elevated: boolean) {
  return {
    elevated,
    collectedAt: new Date().toISOString(),
    disks: asArray(r?.disks).map((d) => {
      const x = d as Record<string, unknown>
      const rel = x.rel as Record<string, unknown> | null
      return {
        id: String(x.id),
        name: asString(x.name) ?? 'Disco',
        media: asString(x.media),
        bus: asString(x.bus),
        health: asString(x.health),
        operational: asString(x.op),
        sizeBytes: asNumber(x.size),
        reliability: rel
          ? {
              temperatureC: asNumber(rel.temp) || null,
              temperatureMaxC: asNumber(rel.tempMax) || null,
              wearPct: asNumber(rel.wear),
              readErrors: asNumber(rel.readErr),
              writeErrors: asNumber(rel.writeErr),
              powerOnHours: asNumber(rel.hours)
            }
          : null,
        reliabilityError: asString(x.relErr)
      }
    }),
    smart: r?.smart ? asArray(r.smart).map((s) => s as { inst: string; predict: boolean; reason: number }) : null,
    smartError: asString(r?.smartErr),
    volumes: asArray(r?.volumes).map((v) => v as { letter: string; label: string; fs: string; health: string; size: number; free: number }),
    errors: asArray(r?.errors).map(String)
  }
}

defineQuery({
  id: 'windows.disks',
  module: 'windows',
  parse: noParams,
  async run() {
    return mapDisks(await runPowerShellJson<Record<string, unknown>>(asJson + DISKS, { timeoutMs: 60_000 }), false)
  }
})

defineQuery({
  id: 'windows.disks.elevated',
  module: 'windows',
  parse: noParams,
  async run() {
    const { output } = await runElevated<Record<string, unknown>>(asElevated + DISKS + '\nexit 0', {}, { timeoutMs: 90_000 })
    return mapDisks(output, true)
  }
})

// ---------------------------------------------------------------------------
// 9.3 SFC e DISM (elevados, longos, com progresso lido do log)
// ---------------------------------------------------------------------------

const MAINTENANCE = {
  sfc: { label: 'Verificador de Arquivos do Sistema (sfc /scannow)', exe: 'sfc.exe', args: ['/scannow'], repairs: true },
  dismScan: { label: 'DISM ScanHealth (somente verificação)', exe: 'DISM.exe', args: ['/Online', '/Cleanup-Image', '/ScanHealth'], repairs: false },
  dismRestore: { label: 'DISM RestoreHealth (reparo da imagem)', exe: 'DISM.exe', args: ['/Online', '/Cleanup-Image', '/RestoreHealth'], repairs: true }
} as const
type MaintenanceId = keyof typeof MAINTENANCE

const RUN_TOOL = `
$exe = Join-Path $env:SystemRoot ('System32\\' + [string]$in.exe)
$p = Start-Process -FilePath $exe -ArgumentList @($in.args) -RedirectStandardOutput $LOG -NoNewWindow -Wait -PassThru
Out-Result ([pscustomobject]@{ code = $p.ExitCode })
exit 0`

/** Último percentual encontrado no log (SFC: "45%"; DISM: "[==   25.0%   ]"). Exportada para testes. */
export function lastPercent(text: string): number | null {
  const all = [...text.matchAll(/(\d{1,3}(?:[.,]\d)?)\s?%/g)]
  const last = all.at(-1)
  if (!last) return null
  const n = Number(last[1].replace(',', '.'))
  return n >= 0 && n <= 100 ? n : null
}

defineAction<{ tool: MaintenanceId }, never>({
  id: 'windows.maintenance.run',
  module: 'windows',
  title: 'Verificação de arquivos do Windows',
  description: 'Executa SFC ou DISM com privilégios de administrador e registra a saída e o código de retorno.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Reparos feitos pelo SFC/DISM substituem arquivos do sistema por cópias íntegras e não são desfeitos.',
  requiresElevation: true,
  exclusive: 'windows-maintenance',
  parse: (raw) => ({ tool: oneOf(obj(raw, ['tool']).tool, 'ferramenta', ['sfc', 'dismScan', 'dismRestore'] as const) }),
  async preview({ tool }) {
    const t = MAINTENANCE[tool]
    return {
      summary: t.label,
      changes: [{ target: 'Arquivos do sistema', current: 'Não verificados', intended: t.repairs ? 'Verificados e reparados se necessário' : 'Verificados (sem reparo)' }],
      warnings: [
        'Pode levar de 5 a 30 minutos. Não desligue o computador durante a execução.',
        'A operação não é interrompida pelo JK Optimize depois de iniciada.',
        ...(tool === 'dismRestore' ? ['O RestoreHealth pode baixar arquivos pelo Windows Update.'] : []),
        'Requer permissão de administrador.'
      ]
    }
  },
  async execute({ tool }, ctx) {
    const t = MAINTENANCE[tool]
    ctx.progress('Aguardando permissão de administrador…')
    const started = Date.now()
    const { output, log } = await runElevated<{ code: number }>(
      RUN_TOOL,
      { exe: t.exe, args: t.args },
      {
        timeoutMs: 3 * 60 * 60_000,
        onLog: (text) => {
          const pct = lastPercent(text)
          ctx.progress(`${t.label}${pct !== null ? ` — ${pct}%` : ''}`, pct ?? 0, 100)
        }
      }
    )
    const code = output?.code ?? -1
    const tail = log.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-12)
    return {
      ok: code === 0,
      verified: true,
      summary: `${t.label} terminou com código ${code} em ${Math.round((Date.now() - started) / 60000)} min.`,
      sections: [
        {
          title: 'Saída (últimas linhas)',
          rows: tail.map((l, i) => ({ label: String(i + 1), value: l }))
        },
        {
          title: 'Registro detalhado do Windows',
          rows: [{ label: tool === 'sfc' ? 'CBS.log' : 'dism.log', value: tool === 'sfc' ? '%windir%\\Logs\\CBS\\CBS.log' : '%windir%\\Logs\\DISM\\dism.log' }]
        }
      ]
    }
  }
})

// ---------------------------------------------------------------------------
// 9.4 Drivers
// ---------------------------------------------------------------------------

const DRIVERS = `
$drv = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object DeviceName | ForEach-Object {
  [pscustomobject]@{ device = $_.DeviceName; maker = $_.Manufacturer; version = $_.DriverVersion; date = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }; class = $_.DeviceClass; inf = $_.InfName; signed = $_.IsSigned; id = $_.DeviceID }
})
$problems = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.ConfigManagerErrorCode -ne 0 } | ForEach-Object { [pscustomobject]@{ name = $_.Name; code = $_.ConfigManagerErrorCode; id = $_.DeviceID; status = $_.Status } })
[pscustomobject]@{ drivers = $drv; problems = $problems } | ConvertTo-Json -Depth 3 -Compress`

/** Códigos de erro do Gerenciador de Dispositivos (documentação da Microsoft). */
export const CM_ERRORS: Record<number, string> = {
  1: 'Dispositivo não configurado corretamente',
  3: 'Driver corrompido ou falta de memória',
  10: 'O dispositivo não pode ser iniciado',
  12: 'Recursos insuficientes',
  14: 'Requer reinicialização',
  18: 'Reinstale os drivers',
  19: 'Configuração do registro danificada',
  21: 'O Windows está removendo o dispositivo',
  22: 'Dispositivo desativado',
  24: 'Dispositivo ausente ou não funcional',
  28: 'Drivers não instalados',
  29: 'Desativado pelo firmware',
  31: 'Driver não pôde ser carregado',
  32: 'Serviço do driver desativado',
  37: 'Falha na inicialização do driver',
  39: 'Driver corrompido ou ausente',
  43: 'O dispositivo relatou problemas',
  45: 'Dispositivo desconectado',
  48: 'Driver bloqueado por problemas conhecidos',
  52: 'Assinatura digital do driver não verificada'
}

defineQuery({
  id: 'windows.drivers',
  module: 'windows',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<{ drivers: unknown; problems: unknown }>(DRIVERS, { timeoutMs: 90_000 })
    return {
      drivers: asArray(r?.drivers)
        .map((d) => d as { device: string; maker: string | null; version: string | null; date: string | null; class: string | null; inf: string | null; signed: boolean | null })
        .sort((a, b) => (a.class ?? '').localeCompare(b.class ?? '') || a.device.localeCompare(b.device)),
      problems: asArray(r?.problems).map((p) => {
        const x = p as { name: string; code: number; id: string; status: string }
        return { ...x, description: CM_ERRORS[x.code] ?? `Código ${x.code}` }
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 9.5 Analisador de erros (Visualizador de Eventos)
// ---------------------------------------------------------------------------

/** Eventos conhecidos que costumam acompanhar travamentos (apenas correlação temporal). */
export const CRASH_MARKERS: { provider: RegExp; id: number; meaning: string }[] = [
  { provider: /Kernel-Power/i, id: 41, meaning: 'Desligamento inesperado (sem desligamento limpo)' },
  { provider: /BugCheck|WER-SystemErrorReporting/i, id: 1001, meaning: 'Tela azul (BugCheck)' },
  { provider: /Application Error/i, id: 1000, meaning: 'Programa fechou com erro' },
  { provider: /Application Hang/i, id: 1002, meaning: 'Programa parou de responder' },
  { provider: /^Display$/i, id: 4101, meaning: 'Driver de vídeo parou de responder e foi recuperado (TDR)' },
  { provider: /EventLog/i, id: 6008, meaning: 'Desligamento anterior inesperado' }
]

const EVENTS = withInput(`
$filter = @{ LogName = @($in.logs); Level = @($in.levels); StartTime = (Get-Date).AddDays(-[int]$in.days) }
$items = @(); $err = $null
try {
  $items = @(Get-WinEvent -FilterHashtable $filter -MaxEvents ([int]$in.max) -ErrorAction Stop | ForEach-Object {
    $msg = $_.Message; if ($msg -and $msg.Length -gt 1500) { $msg = $msg.Substring(0, 1500) + '…' }
    [pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; level = $_.Level; levelName = $_.LevelDisplayName; provider = $_.ProviderName; log = $_.LogName; message = $msg }
  })
} catch { if ($_.Exception.Message -notmatch 'No events|Nenhum evento') { $err = $_.Exception.Message } }
[pscustomobject]@{ items = $items; error = $err } | ConvertTo-Json -Depth 3 -Compress`)

defineQuery({
  id: 'windows.events',
  module: 'windows',
  parse(raw) {
    const p = obj(raw, ['days', 'levels', 'logs', 'max'])
    const levels = Array.isArray(p.levels) ? p.levels.map((l) => int(l, 'gravidade', 1, 4)) : [1, 2, 3]
    const logs = Array.isArray(p.logs) ? p.logs.map((l) => oneOf(l, 'log', ['System', 'Application'] as const)) : ['System', 'Application']
    if (levels.length === 0 || logs.length === 0) throw new AppFailure('invalid-input', 'Escolha ao menos um log e uma gravidade.')
    return { days: int(p.days, 'período (dias)', 1, 30, 7), levels: [...new Set(levels)], logs: [...new Set(logs)], max: int(p.max, 'máximo', 10, 1000, 300) }
  },
  async run(params) {
    const r = await runPowerShellJson<{ items: unknown; error: string | null }>(EVENTS, { input: JSON.stringify(params), timeoutMs: 90_000 })
    return {
      error: asString(r?.error),
      items: asArray(r?.items).map((e) => {
        const x = e as { time: string; id: number; level: number; levelName: string; provider: string; log: string; message: string | null }
        const marker = CRASH_MARKERS.find((m) => m.id === x.id && m.provider.test(x.provider))
        return { ...x, crashMarker: marker?.meaning ?? null }
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 9.6 Ponto de restauração
// ---------------------------------------------------------------------------

const RP_STATUS = `
$cfg = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore' -ErrorAction SilentlyContinue
$pol = Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\SystemRestore' -ErrorAction SilentlyContinue
$points = $null; $err = $null
try { $points = @(Get-ComputerRestorePoint -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ seq = $_.SequenceNumber; desc = $_.Description; time = $_.ConvertToDateTime($_.CreationTime).ToUniversalTime().ToString('o') } }) } catch { $err = $_.Exception.Message }
[pscustomobject]@{ freq = $cfg.SystemRestorePointCreationFrequency; disabledByPolicy = $pol.DisableSR; points = $points; error = $err } | ConvertTo-Json -Depth 3 -Compress`

defineQuery({
  id: 'windows.restorepoint.status',
  module: 'windows',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<Record<string, unknown>>(RP_STATUS)
    return {
      frequencyMinutes: asNumber(r?.freq) ?? 1440,
      frequencyIsDefault: asNumber(r?.freq) === null,
      disabledByPolicy: asNumber(r?.disabledByPolicy) === 1,
      points: r?.points ? asArray(r.points).map((p) => p as { seq: number; desc: string; time: string }) : null,
      pointsError: r?.points ? null : 'A lista de pontos exige permissão de administrador.'
    }
  }
})

const RP_CREATE = `
$before = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue)
$start = Get-Date
$warn = $null
try { Checkpoint-Computer -Description $in.description -RestorePointType MODIFY_SETTINGS -ErrorAction Stop -WarningVariable w; $warn = ($w | Out-String).Trim() } catch { Out-Result ([pscustomobject]@{ error = $_.Exception.Message }); exit 0 }
$after = @(Get-ComputerRestorePoint -ErrorAction SilentlyContinue)
$newest = $after | Sort-Object SequenceNumber -Descending | Select-Object -First 1
$created = $after.Count -gt $before.Count
Out-Result ([pscustomobject]@{ created = $created; warning = $warn; newest = if ($newest) { $newest.Description } else { $null }; count = $after.Count })
exit 0`

defineAction<{ description: string }, never>({
  id: 'windows.restorepoint.create',
  module: 'windows',
  title: 'Criar ponto de restauração',
  description: 'Solicita ao Windows um ponto de restauração do sistema (Proteção do Sistema).',
  risk: 'low',
  reversible: false,
  irreversibleReason: 'Pontos de restauração são gerenciados e expirados pelo próprio Windows.',
  requiresElevation: true,
  exclusive: 'restore-point',
  parse: (raw) => ({ description: str(obj(raw, ['description']).description, 'descrição', 64, /^[\p{L}\p{N} .,_()-]+$/u, 'JK Optimize') }),
  async preview({ description }) {
    const r = await runPowerShellJson<Record<string, unknown>>(RP_STATUS)
    const freq = asNumber(r?.freq) ?? 1440
    return {
      summary: `Ponto de restauração "${description}".`,
      changes: [{ target: 'Proteção do Sistema', current: '—', intended: 'Novo ponto de restauração' }],
      warnings: [
        'Um ponto de restauração NÃO é um backup completo: não protege seus arquivos pessoais.',
        freq === 0
          ? 'Este computador não tem limite de frequência configurado para pontos de restauração.'
          : `O Windows cria no máximo 1 ponto a cada ${freq >= 60 ? `${Math.round(freq / 60)} h` : `${freq} min`}; se já houver um recente, o pedido é ignorado e o resultado mostrará isso.`,
        'Se a Proteção do Sistema estiver desativada na unidade C:, o Windows recusará.',
        'Requer permissão de administrador.'
      ],
      blocked: asNumber(r?.disabledByPolicy) === 1 ? 'A Restauração do Sistema está desativada por política.' : null
    }
  },
  async execute({ description }, ctx) {
    ctx.progress('Aguardando permissão de administrador…')
    const { output } = await runElevated<{ created?: boolean; warning?: string | null; newest?: string | null; count?: number; error?: string }>(
      RP_CREATE,
      { description },
      { timeoutMs: 15 * 60_000 }
    )
    if (!output) throw new AppFailure('restore-point-failed', 'Sem resposta do Windows.')
    return {
      ok: output.created === true,
      verified: true,
      summary: output.created
        ? `Ponto de restauração criado (conferido na lista do Windows: "${output.newest}").`
        : `O Windows não criou um novo ponto. ${output.warning || 'Provavelmente já existe um ponto recente (limite de frequência).'}`
    }
  }
})

// ---------------------------------------------------------------------------
// 9.7 Backups de configuração (diário): verificação de integridade
// ---------------------------------------------------------------------------

defineQuery({
  id: 'windows.backups.verify',
  module: 'executor',
  parse: noParams,
  async run() {
    return listChanges().map((c) => {
      try {
        journal.readBackup(c.id)
        return { id: c.id, title: c.title, createdAt: c.createdAt, ok: true, error: null }
      } catch (error) {
        return { id: c.id, title: c.title, createdAt: c.createdAt, ok: false, error: (error as Error).message }
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 9.8 Benchmark com registro de condições
// ---------------------------------------------------------------------------

export interface BenchmarkRun {
  id: string
  at: string
  appVersion: string
  label: string
  metrics: Record<string, number | null>
  conditions: { powerPlan: string | null; onBattery: boolean; cpuLoadBeforePct: number | null; threads: number }
}

const benchStore = new JsonStore<BenchmarkRun[]>('benchmarks.json', (raw) => (Array.isArray(raw) ? (raw as BenchmarkRun[]).slice(0, 100) : []))

defineQuery({
  id: 'windows.benchmark.run',
  module: 'windows',
  parse(raw) {
    const p = obj(raw, ['includeDisk', 'label'])
    return { includeDisk: bool(p.includeDisk, 'disco', true), label: str(p.label, 'rótulo', 60, /^[\p{L}\p{N} .,_()+-]+$/u, 'Execução') }
  },
  async run(params, ctx) {
    const sample = demandSample()
    const power = await getPowerState()
    ctx.progress('Executando benchmark no executor…')
    const record = await runTask({ taskId: 'benchmark.standard', params: { includeDisk: params.includeDisk }, confirmed: false })
    if (!record.ok || !record.output?.metrics) throw new AppFailure('benchmark-failed', record.error?.message ?? 'O benchmark não retornou métricas.')
    const run: BenchmarkRun = {
      id: record.runId,
      at: record.startedAt,
      appVersion: app.getVersion(),
      label: params.label,
      metrics: record.output.metrics,
      conditions: {
        powerPlan: power.active?.name ?? null,
        onBattery: power.hasBattery,
        cpuLoadBeforePct: sample?.cpu.totalPct ?? null,
        threads: Number(record.output.metrics.threads ?? 0)
      }
    }
    benchStore.write([run, ...benchStore.read()].slice(0, 100))
    return run
  }
})

defineQuery({ id: 'windows.benchmark.list', module: 'windows', parse: noParams, run: async () => benchStore.read() })

export interface MetricComparison {
  metric: string
  before: number | null
  after: number | null
  changePct: number | null
}

/** Compara somente métricas presentes nas duas execuções e aponta condições diferentes. */
export function compareRuns(a: BenchmarkRun, b: BenchmarkRun): { metrics: MetricComparison[]; warnings: string[] } {
  const keys = ['cpuSingleMBps', 'cpuMultiMBps', 'memoryCopyGBps', 'diskWriteMBps', 'diskReadMBps']
  const metrics = keys.map((metric) => {
    const before = a.metrics[metric] ?? null
    const after = b.metrics[metric] ?? null
    return { metric, before, after, changePct: before && after ? Math.round(((after - before) / before) * 1000) / 10 : null }
  })
  const warnings: string[] = []
  if (a.conditions.powerPlan !== b.conditions.powerPlan) warnings.push(`Planos de energia diferentes: "${a.conditions.powerPlan}" × "${b.conditions.powerPlan}".`)
  if (a.conditions.threads !== b.conditions.threads) warnings.push('Número de threads diferente entre as execuções.')
  for (const [run, name] of [[a, 'primeira'], [b, 'segunda']] as const) {
    if ((run.conditions.cpuLoadBeforePct ?? 0) > 20) warnings.push(`A ${name} execução começou com a CPU em ${run.conditions.cpuLoadBeforePct?.toFixed(0)}% de uso.`)
  }
  warnings.push('Variações de até ~5% são comuns entre execuções idênticas; diferenças menores não indicam efeito de um ajuste.')
  return { metrics, warnings }
}

defineQuery({
  id: 'windows.benchmark.compare',
  module: 'windows',
  parse(raw) {
    const p = obj(raw, ['a', 'b'])
    return { a: str(p.a, 'execução A', 40), b: str(p.b, 'execução B', 40) }
  },
  async run({ a, b }) {
    const runs = benchStore.read()
    const ra = runs.find((r) => r.id === a)
    const rb = runs.find((r) => r.id === b)
    if (!ra || !rb) throw new AppFailure('not-found', 'Execução não encontrada.')
    return { a: ra, b: rb, ...compareRuns(ra, rb) }
  }
})

// ---------------------------------------------------------------------------
// 9.1 Diagnóstico geral
// ---------------------------------------------------------------------------

defineQuery({
  id: 'windows.diagnostic',
  module: 'windows',
  parse: noParams,
  async run() {
    const at = () => new Date().toISOString()
    const [info, power, startup, events, disks] = await Promise.all([
      getStaticInfo(true),
      getPowerState().catch(() => null),
      listStartup().catch(() => null),
      runPowerShellJson<{ items: unknown }>(EVENTS, {
        input: JSON.stringify({ days: 7, levels: [1, 2], logs: ['System', 'Application'], max: 500 }),
        timeoutMs: 90_000
      }).catch(() => null),
      runPowerShellJson<Record<string, unknown>>(asJson + DISKS, { timeoutMs: 60_000 }).then((r) => mapDisks(r, false)).catch(() => null)
    ])
    const sample = demandSample()
    const items: { area: string; value: string; source: string; at: string; tone: 'ok' | 'warn' | 'neutral' }[] = []
    const recs: string[] = []

    items.push({ area: 'Windows', value: `${info.os?.caption ?? '—'} (build ${info.os?.build ?? '?'})`, source: 'CIM Win32_OperatingSystem', at: info.collectedAt, tone: 'neutral' })
    items.push({ area: 'Processador', value: info.cpus[0]?.name ?? '—', source: 'CIM Win32_Processor', at: info.collectedAt, tone: 'neutral' })
    items.push({ area: 'GPU', value: info.gpus.map((g) => g.name).join(', ') || 'Não informada', source: 'CIM Win32_VideoController', at: info.collectedAt, tone: 'neutral' })
    if (sample) {
      items.push({ area: 'Uso de CPU', value: `${sample.cpu.totalPct?.toFixed(0) ?? '—'}%`, source: 'Contador de desempenho', at: new Date(sample.ts).toISOString(), tone: (sample.cpu.totalPct ?? 0) > 85 ? 'warn' : 'ok' })
      items.push({ area: 'Memória comprometida', value: `${sample.memory.commitPct?.toFixed(0) ?? '—'}%`, source: 'Contador de desempenho', at: new Date(sample.ts).toISOString(), tone: (sample.memory.commitPct ?? 0) > 85 ? 'warn' : 'ok' })
      if ((sample.memory.commitPct ?? 0) > 85) recs.push('A memória comprometida está acima de 85%: feche programas pesados ou verifique o arquivo de paginação.')
      items.push({
        area: 'Temperatura',
        value: sample.thermal.length ? sample.thermal.map((t) => `${t.celsius} °C`).join(', ') : sample.nvidia.length ? sample.nvidia.map((g) => `${g.temperatureC ?? '—'} °C (GPU)`).join(', ') : 'Sensor não disponível',
        source: sample.thermal.length ? 'Zonas térmicas do Windows' : sample.nvidia.length ? 'nvidia-smi' : '—',
        at: new Date(sample.ts).toISOString(),
        tone: 'neutral'
      })
    } else {
      items.push({ area: 'Uso de CPU e memória', value: 'Monitor iniciando — atualize em alguns segundos', source: '—', at: at(), tone: 'neutral' })
    }
    for (const d of info.disks) {
      const pct = d.totalBytes ? (d.freeBytes / d.totalBytes) * 100 : 0
      items.push({ area: `Espaço em ${d.drive}`, value: `${pct.toFixed(0)}% livre`, source: 'CIM Win32_LogicalDisk', at: info.collectedAt, tone: pct < 10 ? 'warn' : 'ok' })
      if (pct < 10) recs.push(`A unidade ${d.drive} tem menos de 10% livre: use a Limpeza e o Analisador de armazenamento.`)
    }
    if (disks) {
      for (const d of disks.disks) {
        const bad = d.health && d.health !== 'Healthy'
        items.push({ area: `Saúde: ${d.name}`, value: `${d.health ?? 'não informada'} (reportada pelo Windows)`, source: 'Get-PhysicalDisk', at: disks.collectedAt, tone: bad ? 'warn' : 'ok' })
        if (bad) recs.push(`O Windows reporta "${d.health}" para ${d.name}: faça backup dos seus dados.`)
      }
    }
    if (power?.active) {
      items.push({ area: 'Plano de energia', value: power.active.name, source: 'powercfg', at: at(), tone: 'neutral' })
    }
    if (startup) {
      const enabled = startup.entries.filter((e) => e.enabled).length
      items.push({ area: 'Itens de inicialização ativos', value: String(enabled), source: 'Registro e pastas Inicializar', at: at(), tone: enabled > 12 ? 'warn' : 'ok' })
      if (enabled > 12) recs.push(`${enabled} programas abrem com o Windows: revise-os no Gerenciador de inicialização.`)
    }
    if (events) {
      const list = asArray(events.items) as { id: number; provider: string; level: number }[]
      const crashes = list.filter((e) => CRASH_MARKERS.some((m) => m.id === e.id && m.provider.test(e.provider)))
      items.push({ area: 'Erros nos últimos 7 dias', value: `${list.length} eventos críticos/erros; ${crashes.length} ligados a travamentos`, source: 'Visualizador de Eventos', at: at(), tone: crashes.length ? 'warn' : 'ok' })
      if (crashes.length) recs.push('Há eventos de travamento ou desligamento inesperado: veja os detalhes no Analisador de erros (correlação temporal, não prova de causa).')
    }
    if (recs.length === 0) recs.push('Nenhum problema identificado nos dados coletados. Isso não garante ausência de problemas não medidos.')
    return { collectedAt: at(), items, recommendations: recs }
  }
})
