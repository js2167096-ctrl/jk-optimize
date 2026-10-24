// Etapas reais da inicialização e o cálculo do progresso da tela de carregamento.
// Cada etapa só entra em "concluídas" quando a operação correspondente terminou de verdade
// (nada é preenchido por temporizador). O progresso é a soma dos pesos das etapas concluídas.

export type BootStep = 'settings' | 'license' | 'access' | 'identity' | 'executor'
export type BootStage = 'resources' | BootStep | 'interface'

export interface BootStageDef {
  id: BootStage
  /** Peso no progresso total (somam 100). Proporcional ao tempo típico de cada etapa. */
  weight: number
  /** Texto exibido enquanto a etapa é a primeira pendente. */
  label: string
}

export const BOOT_STAGES: readonly BootStageDef[] = [
  { id: 'resources', weight: 10, label: 'Carregando recursos' },
  { id: 'settings', weight: 10, label: 'Carregando configurações' },
  { id: 'license', weight: 15, label: 'Verificando a licença' },
  { id: 'access', weight: 15, label: 'Verificando o acesso' },
  { id: 'identity', weight: 10, label: 'Identificando este computador' },
  { id: 'executor', weight: 25, label: 'Iniciando o executor' },
  { id: 'interface', weight: 15, label: 'Preparando a interface' }
]

/** Progresso de 0 a 100 conforme as etapas concluídas. */
export function bootProgress(done: ReadonlySet<BootStage>): number {
  return Math.round(BOOT_STAGES.reduce((sum, s) => sum + (done.has(s.id) ? s.weight : 0), 0))
}

/** Etapa em andamento (a primeira ainda não concluída) ou null quando tudo terminou. */
export function currentStage(done: ReadonlySet<BootStage>): BootStageDef | null {
  return BOOT_STAGES.find((s) => !done.has(s.id)) ?? null
}

export function bootLabel(done: ReadonlySet<BootStage>): string {
  const s = currentStage(done)
  return s ? `${s.label}...` : 'Pronto'
}

/** Marcos da inicialização no processo principal (ms desde o início do processo). */
export interface BootMark {
  step: string
  ms: number
}
