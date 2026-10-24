// Índice de otimização do Dashboard: cada critério é uma verificação objetiva sobre dados
// realmente coletados. O índice é "critérios atendidos ÷ critérios avaliados"; critério sem
// dado fica "indisponível" e não entra na conta. Nada aqui estima ganho de FPS.

export interface IndexInput {
  powerPlan: string | null
  /** Texto do Windows: "ativado", "desativado" ou "padrão (ativado)". */
  gameMode: string | null
  startupEnabled: number | null
  memoryCommitPct: number | null
  /** "% Performance Limit" do processador (100 = sem limitação). */
  perfLimitPct: number | null
  /** Menor percentual de espaço livre entre as unidades. */
  minDiskFreePct: number | null
  executorReady: boolean
}

export type CriterionState = 'ok' | 'fail' | 'unknown'

export interface Criterion {
  id: string
  label: string
  state: CriterionState
  detail: string
  /** Seção da Otimização que resolve o critério quando ele falha. */
  section: string | null
  recommendation: string | null
}

export const STARTUP_LIMIT = 15
export const MEMORY_LIMIT_PCT = 85
export const DISK_FREE_MIN_PCT = 15
/** Abaixo disso o índice em % não é exibido (poucos critérios avaliados). */
export const MIN_EVALUATED_FOR_PERCENT = 3

const SAVER = /econom|saver/i

export function evaluateIndex(i: IndexInput): { criteria: Criterion[]; passed: number; evaluated: number; total: number; percent: number | null } {
  const c: Criterion[] = [
    i.powerPlan === null
      ? { id: 'power', label: 'Plano de energia sem economia agressiva', state: 'unknown', detail: 'Plano não identificado', section: 'power', recommendation: null }
      : SAVER.test(i.powerPlan)
        ? { id: 'power', label: 'Plano de energia sem economia agressiva', state: 'fail', detail: `Plano ativo: ${i.powerPlan}`, section: 'power', recommendation: 'Troque o plano de energia (economia de energia reduz o desempenho).' }
        : { id: 'power', label: 'Plano de energia sem economia agressiva', state: 'ok', detail: `Plano ativo: ${i.powerPlan}`, section: 'power', recommendation: null },
    i.gameMode === null
      ? { id: 'gamemode', label: 'Modo de Jogo ativado', state: 'unknown', detail: 'Estado não lido', section: 'gamemode', recommendation: null }
      : /ativado/i.test(i.gameMode) && !/desativado/i.test(i.gameMode)
        ? { id: 'gamemode', label: 'Modo de Jogo ativado', state: 'ok', detail: i.gameMode, section: 'gamemode', recommendation: null }
        : { id: 'gamemode', label: 'Modo de Jogo ativado', state: 'fail', detail: i.gameMode, section: 'gamemode', recommendation: 'Ative o Modo de Jogo em Otimização › Basic Tweaks.' },
    i.startupEnabled === null
      ? { id: 'startup', label: `Até ${STARTUP_LIMIT} programas na inicialização`, state: 'unknown', detail: 'Lista não lida', section: 'startup', recommendation: null }
      : i.startupEnabled <= STARTUP_LIMIT
        ? { id: 'startup', label: `Até ${STARTUP_LIMIT} programas na inicialização`, state: 'ok', detail: `${i.startupEnabled} ativos`, section: 'startup', recommendation: null }
        : { id: 'startup', label: `Até ${STARTUP_LIMIT} programas na inicialização`, state: 'fail', detail: `${i.startupEnabled} ativos`, section: 'startup', recommendation: `Revise a inicialização: ${i.startupEnabled} programas abrem com o Windows.` },
    i.memoryCommitPct === null
      ? { id: 'memory', label: `Memória comprometida abaixo de ${MEMORY_LIMIT_PCT}%`, state: 'unknown', detail: 'Contador indisponível', section: 'memory', recommendation: null }
      : i.memoryCommitPct < MEMORY_LIMIT_PCT
        ? { id: 'memory', label: `Memória comprometida abaixo de ${MEMORY_LIMIT_PCT}%`, state: 'ok', detail: `${i.memoryCommitPct}% agora`, section: 'memory', recommendation: null }
        : { id: 'memory', label: `Memória comprometida abaixo de ${MEMORY_LIMIT_PCT}%`, state: 'fail', detail: `${i.memoryCommitPct}% agora`, section: 'memory', recommendation: 'A memória está sob pressão: feche aplicativos pesados (Otimização › Process Manager).' },
    i.perfLimitPct === null
      ? { id: 'perflimit', label: 'Processador sem limitação de desempenho', state: 'unknown', detail: 'Contador indisponível', section: 'thermal', recommendation: null }
      : i.perfLimitPct >= 100
        ? { id: 'perflimit', label: 'Processador sem limitação de desempenho', state: 'ok', detail: 'Sem limitação reportada', section: 'thermal', recommendation: null }
        : { id: 'perflimit', label: 'Processador sem limitação de desempenho', state: 'fail', detail: `Limitado a ${i.perfLimitPct}%`, section: 'thermal', recommendation: 'O Windows está limitando o processador; veja Otimização › Power Settings.' },
    i.minDiskFreePct === null
      ? { id: 'disk', label: `Pelo menos ${DISK_FREE_MIN_PCT}% de espaço livre`, state: 'unknown', detail: 'Unidades não lidas', section: 'temp', recommendation: null }
      : i.minDiskFreePct >= DISK_FREE_MIN_PCT
        ? { id: 'disk', label: `Pelo menos ${DISK_FREE_MIN_PCT}% de espaço livre`, state: 'ok', detail: `${i.minDiskFreePct}% livre na unidade mais cheia`, section: 'temp', recommendation: null }
        : { id: 'disk', label: `Pelo menos ${DISK_FREE_MIN_PCT}% de espaço livre`, state: 'fail', detail: `${i.minDiskFreePct}% livre na unidade mais cheia`, section: 'temp', recommendation: 'Pouco espaço livre: use Otimização › Limpeza de temporários.' },
    { id: 'executor', label: 'Executor do JK Optimize ativo', state: i.executorReady ? 'ok' : 'fail', detail: i.executorReady ? 'Pronto' : 'Indisponível', section: null, recommendation: i.executorReady ? null : 'Abra a aba Executor e reinicie o serviço.' }
  ]
  const evaluated = c.filter((x) => x.state !== 'unknown').length
  const passed = c.filter((x) => x.state === 'ok').length
  return { criteria: c, passed, evaluated, total: c.length, percent: evaluated >= MIN_EVALUATED_FOR_PERCENT ? Math.round((passed / evaluated) * 100) : null }
}
