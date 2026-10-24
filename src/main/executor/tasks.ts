// Implementações das tarefas. Executadas somente dentro do processo do executor.
import os from 'node:os'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskDetailRow, TaskDetailSection } from '@shared/types'
import { formatBytes, formatDuration } from '@shared/format'
import { asArray, asNumber, asString, runPowerShellJson } from '../services/powershell'
import type { TaskImplementation } from './protocol'
import { runBenchmark } from './benchmark'

const selfCheck: TaskImplementation = async (_params, ctx) => {
  const mem = process.memoryUsage()
  return {
    summary: 'Executor operacional.',
    sections: [
      {
        title: 'Processo',
        rows: [
          { label: 'PID', value: String(process.pid) },
          { label: 'Ativo há', value: formatDuration(process.uptime()) },
          { label: 'Memória (RSS)', value: formatBytes(mem.rss) },
          { label: 'Node.js', value: process.versions.node },
          { label: 'Electron', value: process.versions.electron ?? '—' },
          { label: 'Isolamento', value: 'Processo separado da interface (utilityProcess)', tone: 'ok' }
        ]
      },
      {
        title: 'Privilégios',
        rows: [
          {
            label: 'Administrador',
            value: ctx.elevated === null ? 'Não foi possível verificar' : ctx.elevated ? 'Sim' : 'Não (modo padrão e seguro)',
            tone: ctx.elevated === null ? 'warn' : 'ok'
          }
        ]
      }
    ]
  }
}

const HEALTH_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
[pscustomobject]@{
  disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{[pscustomobject]@{id=$_.DeviceID;size=$_.Size;free=$_.FreeSpace}})
  startup=@(Get-CimInstance Win32_StartupCommand|%{[pscustomobject]@{name=$_.Name;location=$_.Location}})
}|ConvertTo-Json -Depth 3 -Compress
`

const TEMP_SCAN_LIMITS = { entries: 100_000, ms: 15_000 }

async function measureDirectory(root: string): Promise<{ bytes: number; files: number; partial: boolean }> {
  const started = Date.now()
  const stack = [root]
  let bytes = 0
  let files = 0
  let visited = 0
  while (stack.length > 0) {
    if (visited >= TEMP_SCAN_LIMITS.entries || Date.now() - started > TEMP_SCAN_LIMITS.ms) {
      return { bytes, files, partial: true }
    }
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited++
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          bytes += (await lstat(full)).size
          files++
        } catch {
          // Arquivo em uso ou removido durante a leitura.
        }
      }
    }
  }
  return { bytes, files, partial: false }
}

const systemHealth: TaskImplementation = async (params) => {
  const warnPercent = params.freeSpaceWarnPercent as number
  const sections: TaskDetailSection[] = []
  let alerts = 0

  let raw: Record<string, unknown> = {}
  let cimError: string | null = null
  try {
    raw = ((await runPowerShellJson(HEALTH_SCRIPT)) as Record<string, unknown>) ?? {}
  } catch (error) {
    cimError = (error as Error).message
  }

  const diskRows: TaskDetailRow[] = asArray(raw.disks).flatMap((d) => {
    const disk = d as Record<string, unknown>
    const size = asNumber(disk.size)
    const free = asNumber(disk.free)
    if (!size || free === null) return []
    const pct = (free / size) * 100
    const low = pct < warnPercent
    if (low) alerts++
    return [
      {
        label: asString(disk.id) ?? '?',
        value: `${formatBytes(free)} livres de ${formatBytes(size)} (${pct.toFixed(0)}%)${low ? ' · pouco espaço' : ''}`,
        tone: low ? 'warn' : 'ok'
      } satisfies TaskDetailRow
    ]
  })
  sections.push({
    title: 'Armazenamento',
    rows: diskRows.length > 0 ? diskRows : [{ label: 'Discos', value: cimError ?? 'Nenhum disco local informado.', tone: 'warn' }]
  })

  const total = os.totalmem()
  const used = total - os.freemem()
  const memPct = (used / total) * 100
  const memHigh = memPct > 85
  if (memHigh) alerts++
  const uptimeDays = os.uptime() / 86400
  const longUptime = uptimeDays > 7
  if (longUptime) alerts++
  sections.push({
    title: 'Memória e sessão',
    rows: [
      {
        label: 'Memória em uso',
        value: `${formatBytes(used)} de ${formatBytes(total)} (${memPct.toFixed(0)}%)`,
        tone: memHigh ? 'warn' : 'ok'
      },
      {
        label: 'Ligado há',
        value: `${formatDuration(os.uptime())}${longUptime ? ' · considere reiniciar o computador' : ''}`,
        tone: longUptime ? 'warn' : 'ok'
      }
    ]
  })

  const startup = asArray(raw.startup).map((s) => s as Record<string, unknown>)
  sections.push({
    title: `Programas de inicialização (${startup.length})`,
    rows:
      startup.length > 0
        ? startup.slice(0, 20).map((s) => ({ label: asString(s.name) ?? '—', value: asString(s.location) ?? '—' }))
        : [{ label: 'Itens', value: cimError ? 'Não foi possível consultar.' : 'Nenhum item informado pelo Windows.' }]
  })

  if (params.scanTemp) {
    const tmp = os.tmpdir()
    const result = await measureDirectory(tmp)
    sections.push({
      title: 'Pasta temporária do usuário',
      rows: [
        { label: 'Local', value: tmp },
        {
          label: 'Tamanho',
          value: `${formatBytes(result.bytes)} em ${result.files.toLocaleString('pt-BR')} arquivos${result.partial ? ' (medição parcial: limite atingido)' : ''}`
        },
        { label: 'Observação', value: 'Somente medição. Nenhum arquivo foi apagado.' }
      ]
    })
  }

  return {
    summary: alerts === 0 ? 'Nenhum alerta encontrado.' : `${alerts} alerta(s) encontrado(s).`,
    sections
  }
}

const benchmark: TaskImplementation = async (params) => {
  const m = await runBenchmark(params.includeDisk === true)
  const v = (n: number | null, unit: string) => (n === null ? 'Não medido' : `${n.toLocaleString('pt-BR')} ${unit}`)
  return {
    summary: `Benchmark concluído em ${(m.durationMs / 1000).toFixed(1)} s.`,
    sections: [
      {
        title: 'Resultados medidos',
        rows: [
          { label: 'CPU 1 thread (SHA-256)', value: v(m.cpuSingleMBps, 'MB/s') },
          { label: `CPU ${m.threads} threads (SHA-256)`, value: v(m.cpuMultiMBps, 'MB/s') },
          { label: 'Cópia de memória', value: v(m.memoryCopyGBps, 'GB/s') },
          { label: 'Disco: gravação sequencial', value: v(m.diskWriteMBps, 'MB/s') },
          { label: 'Disco: leitura sequencial', value: v(m.diskReadMBps, 'MB/s') }
        ]
      },
      ...(m.notes.length ? [{ title: 'Observações', rows: m.notes.map((n) => ({ label: 'Nota', value: n })) }] : [])
    ],
    metrics: {
      cpuSingleMBps: m.cpuSingleMBps,
      cpuMultiMBps: m.cpuMultiMBps,
      memoryCopyGBps: m.memoryCopyGBps,
      diskWriteMBps: m.diskWriteMBps,
      diskReadMBps: m.diskReadMBps,
      threads: m.threads,
      durationMs: m.durationMs
    }
  }
}

export const TASK_IMPLEMENTATIONS: Record<string, TaskImplementation> = {
  'executor.self-check': selfCheck,
  'diagnostic.system-health': systemHealth,
  'benchmark.standard': benchmark
}
