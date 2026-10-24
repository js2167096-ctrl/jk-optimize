// Controladores: pressão de memória (RAM), térmico e energia, e gargalo de CPU.
// Recomendam ações só quando há evidência nas medições; nada é aplicado sem confirmação.
import type { PerfSample } from '@shared/types/perf'
import { formatBytes } from '@shared/format'
import type { TaskDetailSection } from '@shared/types'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { bool, int, noParams, obj, str } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson, runPowerShellWith } from '../services/powershell'
import { demandSample, onSample, setPersistentConsumer } from './sampler'
import { listProcesses } from './processes'
import { getPowerState } from './power'
import { getPresentMonPath } from './fivem'
import { liveStats, PROCESS_NAME, startLive, stopLive } from './presentmon'
import { pointFromSample, summarizeTelemetry, type TelemetryPoint, type TelemetrySummary } from './telemetry'

// ---------------------------------------------------------------------------
// 11. RAM Pressure Controller
// ---------------------------------------------------------------------------

const WS_PRIVATE = `
@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.IDProcess; ws = [double]$_.WorkingSetPrivate } }) | ConvertTo-Json -Compress`

async function privateWorkingSets(): Promise<Map<number, number>> {
  const raw = await runPowerShellJson<unknown>(WS_PRIVATE, { timeoutMs: 30_000 })
  return new Map(asArray(raw).map((r) => [Number((r as { pid: number }).pid), Number((r as { ws: number }).ws)]))
}

export interface MemoryPressure {
  level: 'low' | 'moderate' | 'high' | 'unknown'
  recommendClosing: boolean
  reason: string
}

/** Pressão de memória a partir dos contadores. Exportada para testes. */
export function memoryPressure(m: PerfSample['memory']): MemoryPressure {
  if (m.commitPct === null || m.availableBytes === null || !m.totalBytes) return { level: 'unknown', recommendClosing: false, reason: 'Contadores de memória indisponíveis.' }
  const availPct = (m.availableBytes / m.totalBytes) * 100
  if (m.commitPct >= 90 || availPct < 10) {
    return { level: 'high', recommendClosing: true, reason: `Memória comprometida em ${m.commitPct}% e ${availPct.toFixed(0)}% disponível: fechar aplicativos pesados tende a reduzir paginação e travadas.` }
  }
  if (m.commitPct >= 80 || availPct < 20) {
    return { level: 'moderate', recommendClosing: true, reason: `Pressão moderada (${m.commitPct}% comprometida, ${availPct.toFixed(0)}% disponível): fechar aplicativos grandes pode ajudar durante o jogo.` }
  }
  return {
    level: 'low',
    recommendClosing: false,
    reason: `Há memória disponível suficiente (${availPct.toFixed(0)}%). Encerrar aplicativos não deve trazer ganho de FPS; memória "livre" por si só não acelera o jogo.`
  }
}

defineQuery({
  id: 'ram.status',
  module: 'performance',
  parse: noParams,
  async run() {
    const sample = demandSample()
    const [procs, ws] = await Promise.all([listProcesses(), privateWorkingSets()])
    const apps = procs
      .filter((p) => p.sameSession && !p.critical && p.path && p.startTime)
      .map((p) => ({
        pid: p.pid,
        name: p.name,
        description: p.description,
        path: p.path,
        startTime: p.startTime,
        hasWindow: p.hasWindow,
        workingSet: p.workingSet,
        privateWorkingSet: ws.get(p.pid) ?? null
      }))
      .sort((a, b) => (b.privateWorkingSet ?? b.workingSet) - (a.privateWorkingSet ?? a.workingSet))
      .slice(0, 40)
    return {
      sample: sample?.memory ?? null,
      sampleAt: sample?.ts ?? null,
      pressure: sample ? memoryPressure(sample.memory) : { level: 'unknown', recommendClosing: false, reason: 'Aguardando a primeira amostra do monitor.' },
      apps,
      notes: [
        'Disponível = livre + cache em espera: o Windows usa memória ociosa como cache e a devolve na hora que um programa precisa.',
        'A estimativa por aplicativo é o conjunto de trabalho privado (memória que só ele usa); o ganho real é medido depois do fechamento.'
      ]
    }
  }
})

const CLOSE_APP = `
$p = Get-Process -Id $in.pid -ErrorAction SilentlyContinue
if (-not $p) { [pscustomobject]@{ result = 'gone' } | ConvertTo-Json -Compress; return }
$closed = $false
if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow(); $closed = $p.WaitForExit(8000) }
if (-not $closed -and $in.force) { try { Stop-Process -Id $in.pid -Force -ErrorAction Stop; $closed = $p.WaitForExit(5000) } catch {} }
[pscustomobject]@{ result = if ($closed) { 'exited' } elseif ($p.MainWindowHandle -eq 0 -and -not $in.force) { 'no-window' } else { 'still-running' } } | ConvertTo-Json -Compress`

const AVAILABLE = `[pscustomobject]@{ a = [double](Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableBytes } | ConvertTo-Json -Compress`

interface CloseTarget {
  pid: number
  startTime: string
}

defineAction<{ targets: CloseTarget[]; force: boolean }, never>({
  id: 'ram.closeApps',
  module: 'performance',
  title: 'Fechar aplicativos para liberar memória',
  description: 'Fecha os aplicativos escolhidos e mede a memória disponível antes e depois.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Aplicativos fechados não são reabertos automaticamente; dados não salvos podem ser perdidos.',
  requiresElevation: false,
  exclusive: 'ram',
  parse(raw) {
    const p = obj(raw, ['targets', 'force'])
    if (!Array.isArray(p.targets) || p.targets.length === 0 || p.targets.length > 20) throw new AppFailure('invalid-input', 'Escolha de 1 a 20 aplicativos.')
    return {
      targets: p.targets.map((t) => {
        const x = obj(t, ['pid', 'startTime'])
        return { pid: int(x.pid, 'processo', 1, 2 ** 31 - 1), startTime: str(x.startTime, 'início', 40) }
      }),
      force: bool(p.force, 'forçar', false)
    }
  },
  async preview({ targets, force }) {
    const [procs, ws] = await Promise.all([listProcesses(), privateWorkingSets()])
    const found = targets.map((t) => procs.find((p) => p.pid === t.pid && p.startTime === t.startTime))
    const missing = found.filter((p) => !p).length
    const blocked = found.find((p) => p?.protectedReason)
    const total = found.reduce((a, p) => a + (p ? ws.get(p.pid) ?? 0 : 0), 0)
    return {
      summary: `${found.filter(Boolean).length} aplicativo(s), estimativa de até ${formatBytes(total)} liberados.`,
      changes: found.filter(Boolean).map((p) => ({ target: `${p!.name} (PID ${p!.pid})`, current: `${formatBytes(ws.get(p!.pid) ?? p!.workingSet)} privados`, intended: force ? 'Fechado (forçado se não responder)' : 'Fechado normalmente' })),
      warnings: ['Programas podem pedir para salvar antes de fechar.', ...(missing ? [`${missing} aplicativo(s) já não estão em execução.`] : [])],
      blocked: blocked ? `${blocked.name}: ${blocked.protectedReason}` : found.every((p) => !p) ? 'Nenhum dos aplicativos está em execução.' : null
    }
  },
  async execute({ targets, force }) {
    const before = (await runPowerShellJson<{ a: number }>(AVAILABLE))?.a ?? null
    const procs = await listProcesses()
    const rows: TaskDetailSection['rows'] = []
    let closed = 0
    for (const t of targets) {
      const p = procs.find((x) => x.pid === t.pid && x.startTime === t.startTime)
      if (!p || p.protectedReason) continue
      const r = await runPowerShellWith<{ result: string }>(CLOSE_APP, { pid: p.pid, force }, { timeoutMs: 30_000 }).catch((e: Error) => ({ result: `erro: ${e.message.split('\n')[0]}` }))
      if (r?.result === 'exited' || r?.result === 'gone') closed++
      rows.push({
        label: p.name,
        value: r?.result === 'exited' ? 'Fechado' : r?.result === 'gone' ? 'Já estava fechado' : r?.result === 'no-window' ? 'Sem janela (use "forçar")' : r?.result === 'still-running' ? 'Continua aberto' : r?.result ?? '—',
        tone: r?.result === 'exited' || r?.result === 'gone' ? 'ok' : 'warn'
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const after = (await runPowerShellJson<{ a: number }>(AVAILABLE))?.a ?? null
    const delta = before !== null && after !== null ? after - before : null
    return {
      ok: closed > 0,
      verified: true,
      summary: `${closed} de ${targets.length} aplicativo(s) fechados. Memória disponível: ${before === null ? '—' : formatBytes(before)} → ${after === null ? '—' : formatBytes(after)}${delta !== null ? ` (${delta >= 0 ? '+' : ''}${formatBytes(Math.abs(delta))}${delta < 0 ? ' a menos' : ''})` : ''}.`,
      sections: [{ title: 'Aplicativos', rows }, { title: 'Medição', rows: [{ label: 'Variação medida da memória disponível', value: delta === null ? 'indisponível' : `${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}` }] }]
    }
  }
})

// ---------------------------------------------------------------------------
// 12. Thermal & Power Controller
// ---------------------------------------------------------------------------

const POWER_REPORT = `
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
$ps = [System.Windows.Forms.SystemInformation]::PowerStatus
$bat = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ charge = $_.EstimatedChargeRemaining; status = $_.BatteryStatus } })
$events = @()
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = @('Microsoft-Windows-Kernel-Processor-Power','Microsoft-Windows-Kernel-Power'); Id = @(37, 41); StartTime = (Get-Date).AddDays(-14) } -MaxEvents 50 -ErrorAction Stop | ForEach-Object {
    $m = $_.Message; if ($m -and $m.Length -gt 400) { $m = $m.Substring(0, 400) + '…' }
    [pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; provider = $_.ProviderName; message = $m }
  })
} catch {}
[pscustomobject]@{ ac = [string]$ps.PowerLineStatus; charge = [string]$ps.BatteryChargeStatus; batteries = $bat; events = $events } | ConvertTo-Json -Depth 3 -Compress`

export interface ThermalFinding {
  severity: 'ok' | 'info' | 'warn'
  title: string
  evidence: string
  recommendation: string | null
}

/** Achados de energia/temperatura a partir de dados reais. Exportada para testes. */
export function thermalPowerFindings(input: {
  temps: { label: string; celsius: number }[]
  perfLimitPct: number | null
  effectiveMHz: number | null
  nominalMHz: number | null
  cpuPct: number | null
  plan: string | null
  onAc: boolean | null
  firmwareLimitEvents: number
  unexpectedShutdowns: number
}): ThermalFinding[] {
  const f: ThermalFinding[] = []
  if (input.temps.length === 0) {
    f.push({ severity: 'info', title: 'Sensor não disponível', evidence: 'Este computador não expõe temperaturas ao Windows nem há ferramenta de GPU compatível.', recommendation: null })
  } else {
    const hot = input.temps.filter((t) => t.celsius >= 90)
    f.push(
      hot.length
        ? { severity: 'warn', title: 'Temperatura alta', evidence: hot.map((t) => `${t.label}: ${t.celsius} °C`).join('; '), recommendation: 'Verifique ventoinhas, poeira e fluxo de ar. Não desative proteções térmicas.' }
        : { severity: 'ok', title: 'Temperaturas normais', evidence: input.temps.map((t) => `${t.label}: ${t.celsius} °C`).join('; '), recommendation: null }
    )
  }
  if (input.perfLimitPct !== null && input.perfLimitPct < 100) {
    f.push({
      severity: 'warn',
      title: 'Desempenho da CPU limitado agora',
      evidence: `O Windows informa limite de ${input.perfLimitPct}% (100% = sem limite).`,
      recommendation: input.onAc === false ? 'Conecte o carregador: na bateria o Windows limita o desempenho.' : 'Pode ser temperatura ou política de energia; confira o plano ativo e a refrigeração.'
    })
  }
  if (input.firmwareLimitEvents > 0) {
    f.push({
      severity: 'warn',
      title: 'Firmware limitou a velocidade do processador',
      evidence: `${input.firmwareLimitEvents} evento(s) 37 do Kernel-Processor-Power nos últimos 14 dias (limite imposto pelo firmware, geralmente por temperatura ou energia).`,
      recommendation: 'Verifique refrigeração e fonte. Atualizar a BIOS pode corrigir limites indevidos; o JK Optimize não altera firmware.'
    })
  }
  if (input.unexpectedShutdowns > 0) {
    f.push({
      severity: 'warn',
      title: 'Desligamentos inesperados',
      evidence: `${input.unexpectedShutdowns} evento(s) 41 do Kernel-Power nos últimos 14 dias.`,
      recommendation: 'Podem indicar falta de energia, fonte instável ou superaquecimento (correlação, não prova).'
    })
  }
  if (input.plan && /econom|saver/i.test(input.plan)) {
    f.push({ severity: 'warn', title: 'Plano de economia de energia ativo', evidence: `Plano: ${input.plan}.`, recommendation: 'Para jogos, use Equilibrado ou Alto desempenho.' })
  }
  if (input.onAc === false) f.push({ severity: 'info', title: 'Usando bateria', evidence: 'O computador não está na tomada.', recommendation: 'Conecte o carregador para desempenho máximo.' })
  if (input.effectiveMHz && input.nominalMHz && (input.cpuPct ?? 0) > 60 && input.effectiveMHz < input.nominalMHz * 0.6) {
    f.push({ severity: 'warn', title: 'Frequência baixa sob carga', evidence: `${input.effectiveMHz} MHz efetivos com ${input.cpuPct}% de uso (nominal ${input.nominalMHz} MHz).`, recommendation: 'Indica limitação por energia ou temperatura.' })
  }
  if (!f.some((x) => x.severity === 'warn')) f.push({ severity: 'ok', title: 'Sem evidência de limitação térmica ou energética', evidence: 'Nenhum indicador real apontou limitação nesta consulta.', recommendation: null })
  return f
}

defineQuery({
  id: 'thermal.power.report',
  module: 'performance',
  parse: noParams,
  async run() {
    const sample = demandSample()
    const [raw, power] = await Promise.all([runPowerShellJson<Record<string, unknown>>(POWER_REPORT, { timeoutMs: 45_000 }), getPowerState().catch(() => null)])
    const events = asArray(raw?.events).map((e) => e as { time: string; id: number; provider: string; message: string | null })
    const temps = sample ? [...sample.thermal.map((t) => ({ label: t.name, celsius: t.celsius, source: 'Zona térmica do Windows' })), ...sample.nvidia.filter((g) => g.temperatureC !== null).map((g) => ({ label: g.name, celsius: g.temperatureC!, source: 'nvidia-smi' }))] : []
    const ac = asString(raw?.ac)
    const onAc = ac === 'Online' ? true : ac === 'Offline' ? false : null
    return {
      at: new Date().toISOString(),
      sampleAt: sample?.ts ?? null,
      temps,
      cpu: sample ? { pct: sample.cpu.totalPct, effectiveMHz: sample.cpu.effectiveMHz, nominalMHz: sample.cpu.nominalMHz, perfLimitPct: sample.cpu.performanceLimitPct } : null,
      plan: power?.active?.name ?? null,
      power: { onAc, batteries: asArray(raw?.batteries).map((b) => ({ charge: asNumber((b as { charge: number }).charge) })) },
      events,
      findings: thermalPowerFindings({
        temps,
        perfLimitPct: sample?.cpu.performanceLimitPct ?? null,
        effectiveMHz: sample?.cpu.effectiveMHz ?? null,
        nominalMHz: sample?.cpu.nominalMHz ?? null,
        cpuPct: sample?.cpu.totalPct ?? null,
        plan: power?.active?.name ?? null,
        onAc,
        firmwareLimitEvents: events.filter((e) => e.id === 37).length,
        unexpectedShutdowns: events.filter((e) => e.id === 41).length
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 10. CPU Bottleneck Fixer
// ---------------------------------------------------------------------------

export type CpuVerdict = 'global-saturation' | 'thread-limited' | 'frequency-limited' | 'not-limiting' | 'inconclusive'

export const CPU_VERDICT_LABEL: Record<CpuVerdict, string> = {
  'global-saturation': 'CPU saturada como um todo',
  'thread-limited': 'Limitação em poucos threads (thread principal)',
  'frequency-limited': 'CPU com frequência limitada',
  'not-limiting': 'A CPU não parece ser o limite',
  inconclusive: 'Inconclusivo'
}

/** Análise específica de CPU. Exportada para testes. */
export function analyzeCpu(
  t: TelemetrySummary,
  competing: { name: string; avgPct: number }[],
  nominalMHz: number | null
): { verdict: CpuVerdict; label: string; evidence: string[]; recommendations: string[] } {
  const ev: string[] = []
  const rec: string[] = []
  if (t.samples < 8) return { verdict: 'inconclusive', label: CPU_VERDICT_LABEL.inconclusive, evidence: [`Apenas ${t.samples} amostras.`], recommendations: ['Repita a análise com o jogo em execução por pelo menos 30 s.'] }
  let verdict: CpuVerdict = 'not-limiting'
  const freqLow = t.effectiveMHzAvg !== null && nominalMHz !== null && t.effectiveMHzAvg < nominalMHz * 0.7 && (t.cpuAvgPct ?? 0) > 40
  if ((t.perfLimitedPct ?? 0) >= 30 || freqLow) {
    verdict = 'frequency-limited'
    ev.push(`Frequência efetiva média ${t.effectiveMHzAvg ?? '—'} MHz (nominal ${nominalMHz ?? '—'} MHz); limite de desempenho em ${t.perfLimitedPct ?? 0}% das amostras.`)
    rec.push('Investigue temperatura e energia no Thermal & Power Controller antes de mexer em gráficos.')
  } else if ((t.cpuAvgPct ?? 0) >= 90) {
    verdict = 'global-saturation'
    ev.push(`Uso médio de ${t.cpuAvgPct}% em todos os núcleos.`)
    rec.push('Feche programas que disputam a CPU e reduza densidade populacional e distância de detalhes.')
  } else if ((t.cpuCoreSaturatedPct ?? 0) >= 50 && (t.gpuAvgPct ?? 100) < 85) {
    verdict = 'thread-limited'
    ev.push(`Algum núcleo ≥ 90% em ${t.cpuCoreSaturatedPct}% das amostras, com uso médio total de ${t.cpuAvgPct}% e GPU em ${t.gpuAvgPct}%.`)
    rec.push('Reduza CityDensity, PedVariety/VehicleVariety e LodScale/MaxLodScale (aliviam a thread principal).', 'Mais núcleos não ajudam esse cenário; a frequência por núcleo é o que limita.')
  } else {
    ev.push(`Núcleo mais carregado em média ${t.cpuMaxCoreAvgPct ?? '—'}%, CPU total ${t.cpuAvgPct ?? '—'}%, GPU ${t.gpuAvgPct ?? '—'}%.`)
    if ((t.gpuHighPctTime ?? 0) >= 70) rec.push('A GPU está saturada: o ganho virá de ajustes gráficos de GPU, não de CPU.')
    else rec.push('Nem CPU nem GPU saturaram: o limite pode ser servidor, V-Sync/limite de quadros ou rede.')
  }
  if (t.coreFpsCorrelation !== null) ev.push(`Correlação entre núcleo mais carregado e FPS: ${t.coreFpsCorrelation} (${t.coreFpsCorrelation <= -0.3 ? 'FPS cai quando a CPU sobe' : 'sem relação forte'}).`)
  const heavy = competing.filter((c) => c.avgPct >= 5)
  if (heavy.length) {
    ev.push(`Outros programas usando CPU: ${heavy.map((c) => `${c.name} (${c.avgPct}%)`).join(', ')}.`)
    if (verdict !== 'not-limiting') rec.push('Feche os programas listados durante o jogo (RAM Pressure Controller ou Processos).')
  }
  return { verdict, label: CPU_VERDICT_LABEL[verdict], evidence: ev, recommendations: rec }
}

defineQuery({
  id: 'cpu.fixer.analyze',
  module: 'performance',
  parse(raw) {
    const p = obj(raw, ['durationSec', 'processName'])
    return {
      durationSec: int(p.durationSec, 'duração (s)', 20, 180, 45),
      processName: p.processName === undefined || p.processName === '' ? null : str(p.processName, 'processo', 84, PROCESS_NAME)
    }
  },
  async run({ durationSec, processName }, ctx) {
    const pm = getPresentMonPath()
    let fpsActive = false
    if (pm && processName && !liveStats().active) {
      try {
        startLive(pm, processName)
        fpsActive = true
      } catch {
        fpsActive = false
      }
    }
    const points: TelemetryPoint[] = []
    const procCpu = new Map<string, { sum: number; n: number }>()
    setPersistentConsumer('cpu-fixer', true)
    const off = onSample((s) => {
      const live = liveStats()
      points.push(pointFromSample(s, live.active && Date.now() - live.lastFrameAt < 2000 ? live.fps : null))
      for (const p of s.topCpu) {
        const e = procCpu.get(p.name) ?? { sum: 0, n: 0 }
        e.sum += p.cpuPct
        e.n++
        procCpu.set(p.name, e)
      }
      ctx.progress(`${points.length} amostras`, points.length, null)
    })
    try {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, durationSec * 1000)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t)
          resolve()
        })
      })
    } finally {
      off()
      setPersistentConsumer('cpu-fixer', false)
      if (fpsActive) stopLive()
    }
    const summary = summarizeTelemetry(points)
    const competing = [...procCpu.entries()]
      .filter(([name]) => !/^(gta5|gta5_enhanced|fivem|fivem_.*|idle|system|jk optimize|electron)$/i.test(name))
      .map(([name, v]) => ({ name, avgPct: Math.round((v.sum / Math.max(1, points.length)) * 10) / 10 }))
      .sort((a, b) => b.avgPct - a.avgPct)
      .slice(0, 8)
    return {
      summary,
      fpsMeasured: points.some((p) => p.fps !== null),
      competing,
      analysis: analyzeCpu(summary, competing, demandSample()?.cpu.nominalMHz ?? null),
      cancelled: ctx.signal.aborted
    }
  }
})
