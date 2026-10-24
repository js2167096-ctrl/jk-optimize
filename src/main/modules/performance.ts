// Desempenho: monitores de CPU, GPU, memória, térmico e diagnóstico de CPU/energia.
import os from 'node:os'
import type { PerfSample } from '@shared/types/perf'
import { defineQuery } from '../ops/registry'
import { noParams } from '../ops/params'
import { asNumber, asString, runPowerShellJson } from '../services/powershell'
import { demandSample } from './sampler'
import { getPowerState } from './power'

const CPU_INFO = `
$p = @(Get-CimInstance Win32_Processor)
$cs = Get-CimInstance Win32_ComputerSystem
@($p | ForEach-Object { [pscustomobject]@{ name = $_.Name.Trim(); cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors; maxMHz = $_.MaxClockSpeed; currentMHz = $_.CurrentClockSpeed; l2KB = $_.L2CacheSize; l3KB = $_.L3CacheSize; socket = $_.SocketDesignation; sockets = $cs.NumberOfProcessors } }) | ConvertTo-Json -Compress`

async function cpuInfo() {
  const raw = await runPowerShellJson<unknown>(CPU_INFO)
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[]
  return list.map((p) => ({
    name: asString(p.name) ?? os.cpus()[0]?.model ?? 'Processador',
    cores: asNumber(p.cores),
    threads: asNumber(p.threads) ?? os.cpus().length,
    nominalMHz: asNumber(p.maxMHz),
    reportedMHz: asNumber(p.currentMHz),
    l2KB: asNumber(p.l2KB),
    l3KB: asNumber(p.l3KB),
    socket: asString(p.socket)
  }))
}

defineQuery({ id: 'perf.cpu.info', module: 'performance', parse: noParams, run: () => cpuInfo() })

defineQuery({
  id: 'perf.snapshot',
  module: 'performance',
  parse: noParams,
  async run() {
    return { sample: demandSample(), logicalProcessors: os.cpus().length }
  }
})

// ---------------------------------------------------------------------------
// 5.10 Diagnóstico de CPU e energia
// ---------------------------------------------------------------------------

export interface Finding {
  severity: 'ok' | 'info' | 'warn'
  title: string
  evidence: string
  recommendation: string | null
}

/** Regras baseadas somente em evidências coletadas. Exportada para testes. */
export function diagnoseCpu(
  sample: PerfSample | null,
  power: { activeName: string | null; activeUltimate: boolean; hasBattery: boolean },
  cpu: { nominalMHz: number | null; reportedMHz: number | null }
): Finding[] {
  const findings: Finding[] = []
  if (!sample) {
    findings.push({ severity: 'info', title: 'Sem amostras ainda', evidence: 'O monitor ainda não coletou dados.', recommendation: 'Aguarde alguns segundos e atualize.' })
    return findings
  }
  const limit = sample.cpu.performanceLimitPct
  if (limit !== null && limit < 100) {
    findings.push({
      severity: 'warn',
      title: 'Desempenho da CPU limitado',
      evidence: `O contador "% Performance Limit" está em ${limit}% (100% = sem limitação). Isso indica limite por política de energia, temperatura ou alimentação; a causa exata não é informada pelo Windows.`,
      recommendation: power.hasBattery ? 'Verifique se o notebook está na tomada e se o plano de energia não está em modo econômico.' : 'Verifique a refrigeração e o plano de energia.'
    })
  } else if (limit !== null) {
    findings.push({ severity: 'ok', title: 'Sem limitação reportada', evidence: '"% Performance Limit" em 100% nesta amostra.', recommendation: null })
  }
  const passive = sample.thermal.filter((t) => t.passiveLimitPct !== null && t.passiveLimitPct < 100)
  if (passive.length > 0) {
    findings.push({
      severity: 'warn',
      title: 'Resfriamento passivo ativo (throttling térmico)',
      evidence: passive.map((t) => `${t.name}: limite passivo ${t.passiveLimitPct}% a ${t.celsius} °C`).join('; '),
      recommendation: 'Limpe poeira, verifique ventoinhas e a pasta térmica. Não desative proteções térmicas.'
    })
  }
  if (sample.thermal.length === 0 && sample.nvidia.length === 0) {
    findings.push({
      severity: 'info',
      title: 'Temperatura não disponível',
      evidence: 'Este computador não expõe zonas térmicas ao Windows e não há ferramenta de telemetria de GPU compatível.',
      recommendation: null
    })
  }
  const total = sample.cpu.totalPct
  if (total !== null && total >= 90) {
    const top = sample.topCpu.slice(0, 3).map((p) => `${p.name} (${p.cpuPct.toFixed(0)}%)`).join(', ')
    findings.push({ severity: 'warn', title: 'CPU com carga alta', evidence: `${total.toFixed(0)}% de uso total. Maiores consumidores: ${top || '—'}.`, recommendation: 'Feche programas desnecessários na aba Processos.' })
  }
  const busyCores = sample.cpu.perCore.filter((c) => c.pct >= 95).length
  if (busyCores > 0 && total !== null && total < 60) {
    findings.push({
      severity: 'info',
      title: 'Carga concentrada em poucos núcleos',
      evidence: `${busyCores} núcleo(s) acima de 95% com uso total de ${total.toFixed(0)}%. Jogos com poucos threads costumam ser limitados assim.`,
      recommendation: null
    })
  }
  if (!power.activeUltimate && power.activeName && /econom|saver/i.test(power.activeName)) {
    findings.push({ severity: 'warn', title: 'Plano de economia ativo', evidence: `Plano ativo: ${power.activeName}.`, recommendation: 'Considere o plano Equilibrado ou Alto desempenho ao jogar.' })
  }
  if (sample.cpu.effectiveMHz !== null && cpu.nominalMHz !== null && sample.cpu.effectiveMHz < cpu.nominalMHz * 0.5 && (total ?? 0) > 50) {
    findings.push({
      severity: 'warn',
      title: 'Frequência efetiva baixa sob carga',
      evidence: `Frequência efetiva ${sample.cpu.effectiveMHz} MHz com nominal ${cpu.nominalMHz} MHz e ${total?.toFixed(0)}% de uso.`,
      recommendation: 'Pode indicar limite de energia ou temperatura. Compare com o plano Alto desempenho.'
    })
  }
  return findings
}

defineQuery({
  id: 'perf.cpu.diagnostic',
  module: 'performance',
  parse: noParams,
  async run() {
    const [power, cpus] = await Promise.all([getPowerState(), cpuInfo()])
    const sample = demandSample()
    const cpu = cpus[0] ?? { nominalMHz: null, reportedMHz: null }
    return {
      collectedAt: new Date().toISOString(),
      sampleAt: sample ? new Date(sample.ts).toISOString() : null,
      power: { active: power.active?.name ?? null, ultimate: power.active?.ultimate ?? false, hasBattery: power.hasBattery },
      cpu,
      sample,
      findings: diagnoseCpu(sample, { activeName: power.active?.name ?? null, activeUltimate: power.active?.ultimate ?? false, hasBattery: power.hasBattery }, cpu)
    }
  }
})

// ---------------------------------------------------------------------------
// 5.9 Monitor térmico: fontes e suporte
// ---------------------------------------------------------------------------

const THERMAL_SOURCES = `
$zones = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue).Count
$acpi = 'indisponível'
try { $r = @(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction Stop); $acpi = if ($r.Count) { 'disponível' } else { 'sem zonas' } } catch { $acpi = $_.Exception.Message.Trim() }
$nv = [bool](Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)
[pscustomobject]@{ zones = $zones; acpi = $acpi; nvidiaSmi = $nv } | ConvertTo-Json -Compress`

defineQuery({
  id: 'perf.thermal.sources',
  module: 'performance',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<{ zones: number; acpi: string; nvidiaSmi: boolean }>(THERMAL_SOURCES)
    return [
      {
        source: 'Contadores de zona térmica do Windows',
        status: (r?.zones ?? 0) > 0 ? `${r?.zones} zona(s)` : 'Sensor não disponível',
        available: (r?.zones ?? 0) > 0
      },
      { source: 'ACPI (MSAcpi_ThermalZoneTemperature)', status: r?.acpi ?? 'indisponível', available: r?.acpi === 'disponível' },
      {
        source: 'NVIDIA System Management Interface (nvidia-smi)',
        status: r?.nvidiaSmi ? 'instalado com o driver NVIDIA' : 'não encontrado',
        available: !!r?.nvidiaSmi
      }
    ]
  }
})
