// Informações reais do Windows e do hardware. Nada é inventado: o que não puder
// ser coletado entra em `unavailable` com o motivo.
import os from 'node:os'
import type { LiveMetrics, StaticSystemInfo } from '@shared/types'
import { asArray, asNumber, asString, runPowerShellJson } from './powershell'

const STATIC_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$os=Get-CimInstance Win32_OperatingSystem
$cs=Get-CimInstance Win32_ComputerSystem
[pscustomobject]@{
  os=if($os){[pscustomobject]@{caption=$os.Caption;version=$os.Version;build=$os.BuildNumber;arch=$os.OSArchitecture;lastBoot=if($os.LastBootUpTime){$os.LastBootUpTime.ToString('o')}else{$null}}}else{$null}
  maker=$cs.Manufacturer
  model=$cs.Model
  cpu=@(Get-CimInstance Win32_Processor|%{[pscustomobject]@{name=$_.Name;cores=$_.NumberOfCores;threads=$_.NumberOfLogicalProcessors;mhz=$_.MaxClockSpeed}})
  gpu=@(Get-CimInstance Win32_VideoController|%{[pscustomobject]@{name=$_.Name;driver=$_.DriverVersion;w=$_.CurrentHorizontalResolution;h=$_.CurrentVerticalResolution;hz=$_.CurrentRefreshRate}})
  disk=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{[pscustomobject]@{id=$_.DeviceID;label=$_.VolumeName;fs=$_.FileSystem;size=$_.Size;free=$_.FreeSpace}})
  ram=@(Get-CimInstance Win32_PhysicalMemory|%{[pscustomobject]@{cap=$_.Capacity;speed=$_.Speed}})
}|ConvertTo-Json -Depth 4 -Compress
`

let staticCache: Promise<StaticSystemInfo> | null = null

export function getStaticInfo(refresh: boolean): Promise<StaticSystemInfo> {
  if (refresh || !staticCache) {
    staticCache = collectStatic().catch((error) => {
      staticCache = null
      throw error
    })
  }
  return staticCache
}

async function collectStatic(): Promise<StaticSystemInfo> {
  const unavailable: string[] = []
  let raw: Record<string, unknown> = {}
  try {
    raw = ((await runPowerShellJson(STATIC_SCRIPT)) as Record<string, unknown>) ?? {}
  } catch (error) {
    unavailable.push(`Consulta CIM/WMI do Windows falhou: ${(error as Error).message}`)
  }

  const rawOs = raw.os as Record<string, unknown> | null | undefined
  const info: StaticSystemInfo = {
    os: rawOs
      ? {
          caption: asString(rawOs.caption) ?? 'Windows',
          version: asString(rawOs.version) ?? os.release(),
          build: asString(rawOs.build) ?? '',
          architecture: asString(rawOs.arch) ?? os.arch(),
          hostname: os.hostname(),
          lastBoot: asString(rawOs.lastBoot)
        }
      : {
          // Fallback com dados do próprio Node.js, também reais.
          caption: os.version(),
          version: os.release(),
          build: os.release().split('.').pop() ?? '',
          architecture: os.arch(),
          hostname: os.hostname(),
          lastBoot: new Date(Date.now() - os.uptime() * 1000).toISOString()
        },
    manufacturer: asString(raw.maker),
    model: asString(raw.model),
    cpus: asArray(raw.cpu).map((c) => {
      const cpu = c as Record<string, unknown>
      return {
        name: asString(cpu.name) ?? 'Processador desconhecido',
        cores: asNumber(cpu.cores),
        threads: asNumber(cpu.threads),
        maxClockMHz: asNumber(cpu.mhz)
      }
    }),
    gpus: asArray(raw.gpu).map((g) => {
      const gpu = g as Record<string, unknown>
      const w = asNumber(gpu.w)
      const h = asNumber(gpu.h)
      const hz = asNumber(gpu.hz)
      return {
        name: asString(gpu.name) ?? 'Adaptador de vídeo',
        driverVersion: asString(gpu.driver),
        resolution: w && h ? `${w} × ${h}${hz ? ` @ ${hz} Hz` : ''}` : null
      }
    }),
    disks: asArray(raw.disk).flatMap((d) => {
      const disk = d as Record<string, unknown>
      const total = asNumber(disk.size)
      const free = asNumber(disk.free)
      if (total === null || free === null) return []
      return [
        {
          drive: asString(disk.id) ?? '?',
          label: asString(disk.label),
          fileSystem: asString(disk.fs),
          totalBytes: total,
          freeBytes: free
        }
      ]
    }),
    memoryModules: asArray(raw.ram).flatMap((m) => {
      const mod = m as Record<string, unknown>
      const cap = asNumber(mod.cap)
      return cap === null ? [] : [{ capacityBytes: cap, speedMHz: asNumber(mod.speed) }]
    }),
    totalMemoryBytes: os.totalmem(),
    collectedAt: new Date().toISOString(),
    unavailable
  }

  if (info.cpus.length === 0) {
    const cpus = os.cpus()
    if (cpus.length > 0) {
      info.cpus.push({ name: cpus[0].model.trim(), cores: null, threads: cpus.length, maxClockMHz: cpus[0].speed || null })
    } else {
      unavailable.push('Processador não identificado.')
    }
  }
  if (info.gpus.length === 0) unavailable.push('Nenhum adaptador de vídeo informado pelo Windows.')
  if (info.disks.length === 0) unavailable.push('Nenhum disco local informado pelo Windows.')
  if (info.memoryModules.length === 0) unavailable.push('Detalhes dos módulos de memória indisponíveis.')
  return info
}

// ---------------------------------------------------------------------------
// Métricas ao vivo
// ---------------------------------------------------------------------------

interface CpuSample {
  idle: number
  total: number
}

function sampleCpu(): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

let previous: CpuSample = sampleCpu()

export function getMetrics(): LiveMetrics {
  const current = sampleCpu()
  const totalDelta = current.total - previous.total
  const cpuPercent =
    totalDelta > 0 ? Math.min(100, Math.max(0, 100 * (1 - (current.idle - previous.idle) / totalDelta))) : null
  previous = current
  const total = os.totalmem()
  return {
    cpuPercent,
    memoryTotalBytes: total,
    memoryUsedBytes: total - os.freemem(),
    uptimeSeconds: os.uptime(),
    timestamp: Date.now()
  }
}
