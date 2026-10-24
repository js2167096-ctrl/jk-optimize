// Tipos do registro de operações (consultas e ações) usados por todos os módulos.
import type { TaskDetailSection } from './index'

export type OpAccess = 'protected' | 'owner'
export type OpRisk = 'none' | 'low' | 'medium' | 'high'

export type OpModule =
  | 'cleanup'
  | 'power'
  | 'performance'
  | 'processes'
  | 'startup'
  | 'services'
  | 'apps'
  | 'fivem'
  | 'network'
  | 'windows'
  | 'monitoring'
  | 'updater'
  | 'executor'

export const OP_MODULE_LABEL: Record<OpModule, string> = {
  executor: 'Executor',
  cleanup: 'Limpeza',
  power: 'Energia',
  performance: 'Desempenho',
  processes: 'Processos',
  startup: 'Inicialização',
  services: 'Serviços',
  apps: 'Aplicativos',
  fivem: 'FiveM',
  network: 'Rede',
  windows: 'Windows',
  monitoring: 'Monitoramento',
  updater: 'Atualizações'
}

export interface ActionDescriptor {
  id: string
  module: OpModule
  title: string
  description: string
  risk: OpRisk
  reversible: boolean
  irreversibleReason: string | null
  requiresElevation: boolean
  access: OpAccess
}

export interface ChangeLine {
  target: string
  current: string
  intended: string
}

export interface ActionPreview {
  previewId: string
  actionId: string
  title: string
  summary: string
  changes: ChangeLine[]
  warnings: string[]
  risk: OpRisk
  reversible: boolean
  irreversibleReason: string | null
  requiresElevation: boolean
  /** Motivo pelo qual a ação não pode ser executada agora (null = pode). */
  blocked: string | null
  expiresAt: string
}

export interface ActionOutcome {
  ok: boolean
  /** true somente quando o resultado foi conferido depois da execução. */
  verified: boolean
  summary: string
  sections: TaskDetailSection[]
  changeId: string | null
}

export type ChangeStatus = 'applied' | 'reverted' | 'revert-failed'

export interface ChangeRecord {
  id: string
  formatVersion: 1
  actionId: string
  module: OpModule
  title: string
  createdAt: string
  summaryBefore: string
  summaryAfter: string
  reversible: boolean
  status: ChangeStatus
  revertedAt: string | null
  revertError: string | null
  /** SHA-256 do backup do estado anterior, conferido antes de reverter. */
  backupSha256: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  module: string
  message: string
  actionId?: string
  durationMs?: number
  exitCode?: number | null
}

export interface LogQuery {
  module?: string
  level?: LogLevel
  text?: string
  fromDays?: number
  limit?: number
}

export interface JobProgress {
  jobId: string
  message: string
  done: number
  total: number | null
  /** Dado parcial opcional (ex.: amostra de latência para o gráfico ao vivo). */
  data?: unknown
}

export interface QuickAction {
  id: string
  actionId: string
  label: string
  params: Record<string, unknown>
  createdAt: string
}

export interface OpsApi {
  query<T = unknown>(id: string, params?: unknown, jobId?: string): Promise<import('./index').Result<T>>
  actions(): Promise<import('./index').Result<ActionDescriptor[]>>
  preview(actionId: string, params: unknown): Promise<import('./index').Result<ActionPreview>>
  execute(previewId: string, confirmed: boolean, jobId?: string): Promise<import('./index').Result<ActionOutcome>>
  revert(changeId: string, force: boolean): Promise<import('./index').Result<ChangeRecord>>
  cancel(jobId: string): Promise<import('./index').Result<boolean>>
  changes(): Promise<import('./index').Result<ChangeRecord[]>>
  logs(query: LogQuery): Promise<import('./index').Result<LogEntry[]>>
  onProgress(listener: (progress: JobProgress) => void): () => void
}
