// Visão geral da Central de Otimização: estado real e último resultado de cada ferramenta.
import { defineQuery } from '../ops/registry'
import { bool, obj } from '../ops/params'
import { queryLogs } from '../ops/log'
import { getPowerState } from './power'
import { detectInstall, getPresentMonPath } from './fivem'
import { listStartup } from './startup'
import { readValues } from './winsettings'
import { demandSample } from './sampler'
import { sessionStatus } from './fpslab'

defineQuery({
  id: 'optimizer.overview',
  module: 'performance',
  // light: pula a varredura do FiveM e a leitura dos logs (usado pelo Dashboard e pelo Monitoramento,
  // que só precisam de plano de energia, Modo de Jogo, inicialização e PresentMon).
  parse: (raw) => ({ light: bool(obj(raw, ['light']).light, 'light', false) }),
  async run({ light }) {
    const [power, fivem, startup, game] = await Promise.all([
      getPowerState().catch(() => null),
      light ? Promise.resolve(null) : detectInstall().catch(() => null),
      listStartup().catch(() => null),
      readValues([{ id: 'gm', key: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled' }]).catch(() => null)
    ])
    const sample = demandSample()
    const gm = game?.get('gm')
    // Último resultado por ação (logs dos últimos 14 dias, mais recentes primeiro).
    const lastResults: Record<string, { ts: string; level: string; message: string }> = {}
    for (const entry of light ? [] : queryLogs({ fromDays: 14, limit: 1000 })) {
      if (entry.actionId && !lastResults[entry.actionId]) lastResults[entry.actionId] = { ts: entry.ts, level: entry.level, message: entry.message }
    }
    const lab = sessionStatus()
    return {
      powerPlan: power?.active?.name ?? null,
      ultimateActive: power?.active?.ultimate ?? false,
      gameMode: gm === null || gm === undefined ? 'padrão (ativado)' : Number(gm) === 0 ? 'desativado' : 'ativado',
      startupEnabled: startup ? startup.entries.filter((e) => e.enabled).length : null,
      fivemFound: fivem?.fivem.found ?? false,
      gtaFound: !!fivem?.gta,
      presentMon: !!getPresentMonPath(),
      memoryCommitPct: sample?.memory.commitPct ?? null,
      cpuPct: sample?.cpu.totalPct ?? null,
      perfLimitPct: sample?.cpu.performanceLimitPct ?? null,
      temperatureAvailable: sample ? sample.thermal.length + sample.nvidia.length > 0 : null,
      labRunning: lab.running,
      lastResults
    }
  }
})
