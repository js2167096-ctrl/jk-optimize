// Amostrador de telemetria: um único processo PowerShell persistente que emite
// uma linha JSON por intervalo. Usa classes CIM de contadores de desempenho
// (independentes do idioma do Windows). Fica ativo somente enquanto houver demanda.
import os from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { GpuAdapterSample, PerfSample } from '@shared/types/perf'
import { encodeScript } from '../services/powershell'
import { getStaticInfo } from '../services/system'
import { log } from '../ops/log'

const IDLE_STOP_MS = 45_000

const SAMPLER_SCRIPT = (intervalMs: number) => `
$ErrorActionPreference = 'SilentlyContinue'
$n = [Environment]::ProcessorCount
$nv = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source
if (-not $nv) { $c = Join-Path $env:ProgramFiles 'NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'; if (Test-Path $c) { $nv = $c } }
# Cada classe de desempenho do WMI leva ~300 ms para responder. Em vez de consultá-las em fila (~1,3 s por ciclo),
# as consultas rodam em paralelo num pool de runspaces criado uma única vez. CPU e memória são lidas a cada ciclo;
# GPU e temperatura a cada dois ciclos (idade em 'slow') e a lista de processos (a consulta mais cara) a cada cinco.
$pool = [RunspaceFactory]::CreateRunspacePool(1, 6)
$pool.Open()
function Start-Query([string]$cls) {
  $p = [PowerShell]::Create()
  $p.RunspacePool = $pool
  [void]$p.AddScript('param($c) $ErrorActionPreference = "SilentlyContinue"; @(Get-CimInstance -ClassName $c)').AddArgument($cls)
  [pscustomobject]@{ p = $p; h = $p.BeginInvoke() }
}
function Wait-Query($q) {
  try { $r = @($q.p.EndInvoke($q.h)) } catch { $r = @() }
  $q.p.Dispose()
  $r
}
$tick = 0
$eng = @(); $gmem = @(); $th = @(); $procs = @(); $nvo = @(); $slowTs = 0
while ($true) {
  $t0 = [DateTime]::UtcNow
  $errs = @()
  $slow = ($tick % 2 -eq 0)
  $slowProc = ($tick % 5 -eq 0)
  $qPi = Start-Query 'Win32_PerfFormattedData_Counters_ProcessorInformation'
  $qMem = Start-Query 'Win32_PerfFormattedData_PerfOS_Memory'
  if ($slow) {
    $qEng = Start-Query 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine'
    $qGm = Start-Query 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory'
    $qTh = Start-Query 'Win32_PerfFormattedData_Counters_ThermalZoneInformation'
  }
  if ($slowProc) { $qPr = Start-Query 'Win32_PerfFormattedData_PerfProc_Process' }
  $pi = @(Wait-Query $qPi)
  if ($pi.Count -eq 0) { $errs += 'cpu' }
  $tot = $pi | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
  $cores = @($pi | Where-Object { $_.Name -notlike '*_Total' } | ForEach-Object { [pscustomobject]@{ name = $_.Name; pct = [double]$_.PercentProcessorTime } })
  $mem = @(Wait-Query $qMem) | Select-Object -First 1
  if (-not $mem) { $errs += 'memory' }
  if ($slow) {
    $eng = @(Wait-Query $qEng | ForEach-Object { [pscustomobject]@{ n = $_.Name; u = [double]$_.UtilizationPercentage } } | Where-Object { $_.u -gt 0 })
    $gmem = @(Wait-Query $qGm | ForEach-Object { [pscustomobject]@{ n = $_.Name; d = [double]$_.DedicatedUsage; s = [double]$_.SharedUsage } })
    $th = @(Wait-Query $qTh | ForEach-Object { [pscustomobject]@{ n = $_.Name; hp = [double]$_.HighPrecisionTemperature; k = [double]$_.Temperature; pl = $_.PercentPassiveLimit; tr = $_.ThrottleReasons } })
    $nvo = @()
    if ($nv) {
      $lines = & $nv --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null
      foreach ($l in @($lines)) { $f = $l -split ',\\s*'; if ($f.Count -ge 6) { $nvo += [pscustomobject]@{ index = $f[0]; name = $f[1]; temp = $f[2]; util = $f[3]; mu = $f[4]; mt = $f[5] } } }
    }
    $slowTs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  if ($slowProc) {
    $procs = @(Wait-Query $qPr | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.IDProcess; name = $_.Name; cpu = [double]$_.PercentProcessorTime / $n; ws = [double]$_.WorkingSetPrivate; pb = [double]$_.PrivateBytes } })
    if ($procs.Count -eq 0) { $errs += 'processes' }
  }
  $collect = ([DateTime]::UtcNow - $t0).TotalMilliseconds
  [pscustomobject]@{
    ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    collect = [math]::Round($collect)
    slow = $slowTs
    cpu = if ($tot) { [pscustomobject]@{ total = [double]$tot.PercentProcessorTime; perf = [double]$tot.PercentProcessorPerformance; freq = [double]$tot.ProcessorFrequency; limit = [double]$tot.PercentPerformanceLimit } } else { $null }
    cores = $cores
    mem = if ($mem) { [pscustomobject]@{ avail = [double]$mem.AvailableBytes; com = [double]$mem.CommittedBytes; lim = [double]$mem.CommitLimit; pct = [double]$mem.PercentCommittedBytesInUse; pages = [double]$mem.PagesPersec; sb = [double]$mem.StandbyCacheNormalPriorityBytes + [double]$mem.StandbyCacheReserveBytes + [double]$mem.StandbyCacheCoreBytes; mod = [double]$mem.ModifiedPageListBytes; free = [double]$mem.FreeAndZeroPageListBytes; cache = [double]$mem.CacheBytes } } else { $null }
    eng = $eng
    gmem = $gmem
    th = $th
    procs = @($procs | Sort-Object cpu -Descending | Select-Object -First 15) + @($procs | Sort-Object ws -Descending | Select-Object -First 15)
    nv = $nvo
    errs = $errs
  } | ConvertTo-Json -Depth 4 -Compress
  $tick++
  $elapsed = ([DateTime]::UtcNow - $t0).TotalMilliseconds
  $wait = [Math]::Max(100, ${intervalMs} - $elapsed)
  Start-Sleep -Milliseconds $wait
}`

let child: ChildProcessWithoutNullStreams | null = null
let latest: PerfSample | null = null
let lastDemand = 0
let intervalMs = 2000
const persistent = new Set<string>()
const listeners = new Set<(sample: PerfSample) => void>()
let gpuNames: string[] = []
let idleTimer: NodeJS.Timeout | null = null

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : v ? [v] : []) as Record<string, unknown>[]

/** Converte a linha JSON do script no formato tipado. Exportada para testes. */
export function parseSample(raw: Record<string, unknown>, physicalGpuNames: string[]): PerfSample {
  const cpu = raw.cpu as Record<string, unknown> | null
  const mem = raw.mem as Record<string, unknown> | null
  const nominal = num(cpu?.freq)
  const perf = num(cpu?.perf)

  // Motores de GPU: "pid_1360_luid_0x00000000_0x0000E31F_phys_0_eng_0_engtype_3D"
  const byAdapter = new Map<string, Map<string, number>>()
  const byPid = new Map<number, number>()
  for (const e of arr(raw.eng)) {
    const m = /pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_\d+_engtype_(.+)$/i.exec(String(e.n))
    if (!m) continue
    const u = num(e.u) ?? 0
    const engines = byAdapter.get(m[2]) ?? new Map<string, number>()
    engines.set(m[3], (engines.get(m[3]) ?? 0) + u)
    byAdapter.set(m[2], engines)
    byPid.set(Number(m[1]), (byPid.get(Number(m[1])) ?? 0) + u)
  }
  const memByLuid = new Map<string, { d: number | null; s: number | null }>()
  for (const g of arr(raw.gmem)) {
    const m = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(String(g.n))
    if (m) memByLuid.set(m[1], { d: num(g.d), s: num(g.s) })
  }
  const luids = new Set([...byAdapter.keys(), ...memByLuid.keys()])
  // Associação de nome só quando há uma única GPU física e um único adaptador com memória dedicada em uso.
  const withDedicated = [...memByLuid.entries()].filter(([, v]) => (v.d ?? 0) > 0).map(([k]) => k)
  const gpus: GpuAdapterSample[] = [...luids].map((luid) => {
    const engines = [...(byAdapter.get(luid) ?? new Map()).entries()].map(([type, pct]) => ({ type, pct: Math.min(100, pct) }))
    return {
      luid,
      name: physicalGpuNames.length === 1 && withDedicated.length === 1 && withDedicated[0] === luid ? physicalGpuNames[0] : null,
      utilizationPct: engines.reduce((max, e) => Math.max(max, e.pct), 0),
      engines: engines.sort((a, b) => b.pct - a.pct),
      dedicatedBytes: memByLuid.get(luid)?.d ?? null,
      sharedBytes: memByLuid.get(luid)?.s ?? null
    }
  })

  const procs = arr(raw.procs).map((p) => ({
    pid: num(p.pid) ?? 0,
    name: String(p.name ?? '').replace(/#\d+$/, ''),
    cpuPct: Math.min(100, num(p.cpu) ?? 0),
    workingSetPrivate: num(p.ws) ?? 0,
    privateBytes: num(p.pb) ?? 0
  }))
  const unique = (list: typeof procs) => [...new Map(list.map((p) => [p.pid, p])).values()]

  return {
    ts: num(raw.ts) ?? Date.now(),
    collectMs: num(raw.collect),
    slowTs: num(raw.slow),
    cpu: {
      totalPct: num(cpu?.total),
      perCore: arr(raw.cores)
        .map((c) => ({ name: String(c.name), pct: num(c.pct) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      performancePct: perf,
      nominalMHz: nominal,
      effectiveMHz: nominal !== null && perf !== null ? Math.round((nominal * perf) / 100) : null,
      performanceLimitPct: num(cpu?.limit)
    },
    memory: {
      totalBytes: os.totalmem(),
      availableBytes: num(mem?.avail),
      committedBytes: num(mem?.com),
      commitLimitBytes: num(mem?.lim),
      commitPct: num(mem?.pct),
      pagesPerSec: num(mem?.pages),
      standbyBytes: num(mem?.sb),
      modifiedBytes: num(mem?.mod),
      freeBytes: num(mem?.free),
      systemCacheBytes: num(mem?.cache)
    },
    gpus: gpus.sort((a, b) => (b.dedicatedBytes ?? 0) - (a.dedicatedBytes ?? 0)),
    gpuProcesses: [...byPid.entries()].map(([pid, pct]) => ({ pid, pct: Math.min(100, pct) })).sort((a, b) => b.pct - a.pct).slice(0, 10),
    thermal: arr(raw.th)
      .map((t) => {
        const hp = num(t.hp)
        const k = num(t.k)
        const kelvin = hp && hp > 0 ? hp / 10 : k
        return kelvin && kelvin > 0
          ? { name: String(t.n), celsius: Math.round((kelvin - 273.15) * 10) / 10, passiveLimitPct: num(t.pl), throttleReasons: num(t.tr) }
          : null
      })
      .filter((t): t is NonNullable<typeof t> => t !== null),
    nvidia: arr(raw.nv).map((g) => ({
      index: num(g.index) ?? 0,
      name: String(g.name ?? ''),
      temperatureC: num(g.temp),
      utilizationPct: num(g.util),
      memoryUsedMB: num(g.mu),
      memoryTotalMB: num(g.mt)
    })),
    topCpu: unique(procs).sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 15),
    topMemory: unique(procs).sort((a, b) => b.workingSetPrivate - a.workingSetPrivate).slice(0, 15),
    errors: arr(raw.errs).map(String)
  }
}

function start(): void {
  if (child) return
  // Somente para testes: simula coletor indisponível (sem sensores) para verificar que o painel abre e mostra "indisponível".
  if (process.env.JKO_E2E_NO_SAMPLER) return
  void getStaticInfo(false)
    .then((info) => (gpuNames = info.gpus.map((g) => g.name).filter((n) => !/basic (display|render)/i.test(n))))
    .catch(() => undefined)
  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(SAMPLER_SCRIPT(intervalMs))], {
    windowsHide: true
  })
  child = proc
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line.startsWith('{')) continue
      try {
        latest = parseSample(JSON.parse(line), gpuNames)
        for (const l of listeners) l(latest)
      } catch (error) {
        log.warn('performance', `Amostra inválida do amostrador: ${(error as Error).message}`)
      }
    }
  })
  proc.on('exit', () => {
    if (child === proc) child = null
  })
  idleTimer ??= setInterval(() => {
    if (child && persistent.size === 0 && Date.now() - lastDemand > IDLE_STOP_MS) stop()
  }, 10_000)
}

export function stop(): void {
  child?.kill()
  child = null
}

/** Marca demanda (telas abertas) e devolve a amostra mais recente, se houver. */
export function demandSample(): PerfSample | null {
  lastDemand = Date.now()
  start()
  return latest && Date.now() - latest.ts < 15_000 ? latest : null
}

/** Consumidores contínuos (overlay, alertas, histórico) mantêm o amostrador ligado. */
export function setPersistentConsumer(id: string, active: boolean): void {
  if (active) {
    persistent.add(id)
    start()
  } else persistent.delete(id)
}

export function onSample(listener: (sample: PerfSample) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setSamplerInterval(ms: number): void {
  const next = Math.min(Math.max(ms, 1000), 10_000)
  if (next === intervalMs) return
  intervalMs = next
  if (child) {
    stop()
    start()
  }
}

export const logicalProcessors = () => os.cpus().length
