// Tipos compartilhados entre processo principal, preload, executor e interface.

export interface AppError {
  code: string
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }

// ---------------------------------------------------------------------------
// Acesso e licenciamento
// ---------------------------------------------------------------------------

export type ActivationProblem =
  | 'invalid'
  | 'expired'
  | 'revoked'
  | 'machine-mismatch'
  | 'not-yet-valid'
  | 'verification-required'

export interface LicenseInfo {
  id: string
  issuedAt: string
  expiresAt: string | null
  machineBound: boolean
}

export type AccessState =
  /** Nenhuma chave pública de licenciamento embutida no build. */
  | { kind: 'unconfigured' }
  /** Chave do proprietário instalada nesta máquina, aguardando a senha. */
  | { kind: 'owner-locked' }
  /** Sessão administrativa desbloqueada. */
  | { kind: 'owner' }
  | { kind: 'activation-required'; problem: ActivationProblem | null }
  | { kind: 'active'; license: LicenseInfo }

export interface BootstrapInfo {
  appVersion: string
  isPackaged: boolean
  access: AccessState
  machineId: string | null
  executor: ExecutorStatus
  settings: Settings
  /** Marcos da inicialização no processo principal (ms desde o início do processo). */
  timings: import('../boot').BootMark[]
}

export interface IssuedKey {
  id: string
  label: string
  token: string
  createdAt: string
  expiresAt: string | null
  machineId: string | null
  status: 'active' | 'revoked'
  revokedAt: string | null
}

export interface GenerateKeyInput {
  label: string
  /** Dias de validade; null para sem expiração. */
  validDays: number | null
  /** Vincula a chave a um computador específico; null para qualquer computador. */
  machineId: string | null
}

// ---------------------------------------------------------------------------
// Sistema
// ---------------------------------------------------------------------------

export interface OsInfo {
  caption: string
  version: string
  build: string
  architecture: string
  hostname: string
  lastBoot: string | null
}

export interface CpuInfo {
  name: string
  cores: number | null
  threads: number | null
  maxClockMHz: number | null
}

export interface GpuInfo {
  name: string
  driverVersion: string | null
  resolution: string | null
}

export interface DiskInfo {
  drive: string
  label: string | null
  fileSystem: string | null
  totalBytes: number
  freeBytes: number
}

export interface MemoryModule {
  capacityBytes: number
  speedMHz: number | null
}

export interface StaticSystemInfo {
  os: OsInfo | null
  manufacturer: string | null
  model: string | null
  cpus: CpuInfo[]
  gpus: GpuInfo[]
  disks: DiskInfo[]
  memoryModules: MemoryModule[]
  totalMemoryBytes: number
  collectedAt: string
  /** Partes que não puderam ser coletadas, com o motivo. */
  unavailable: string[]
}

export interface LiveMetrics {
  /** Null na primeira amostra, enquanto não há intervalo de comparação. */
  cpuPercent: number | null
  memoryTotalBytes: number
  memoryUsedBytes: number
  uptimeSeconds: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type ExecutorState = 'starting' | 'ready' | 'unavailable' | 'stopped'

export interface ExecutorStatus {
  state: ExecutorState
  pid: number | null
  startedAt: string | null
  elevated: boolean | null
  message: string | null
}

export type TaskParamValue = boolean | number | string

export type TaskParamSpec =
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'integer'; default: number; min: number; max: number }
  | { key: string; label: string; type: 'enum'; default: string; options: { value: string; label: string }[] }

export type TaskCategory = 'diagnostic' | 'maintenance'

export interface TaskDescriptor {
  id: string
  name: string
  description: string
  category: TaskCategory
  /** Se true, exige confirmação explícita do usuário antes da execução. */
  changesSystem: boolean
  /** Se true, só pode rodar com o executor elevado (ainda não suportado nesta etapa). */
  requiresElevation: boolean
  params: TaskParamSpec[]
}

export type DetailTone = 'neutral' | 'ok' | 'warn' | 'error'

export interface TaskDetailRow {
  label: string
  value: string
  tone?: DetailTone
}

export interface TaskDetailSection {
  title: string
  rows: TaskDetailRow[]
}

export interface TaskOutput {
  summary: string
  sections: TaskDetailSection[]
  /** Valores numéricos medidos (ex.: benchmark), para gravação e comparação. */
  metrics?: Record<string, number | null>
}

export interface TaskRunRecord {
  runId: string
  taskId: string
  taskName: string
  params: Record<string, TaskParamValue>
  ok: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  output: TaskOutput | null
  error: AppError | null
}

export interface RunTaskInput {
  taskId: string
  params: Record<string, TaskParamValue>
  confirmed: boolean
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

export interface Settings {
  launchAtStartup: boolean
  reduceMotion: boolean
  metricsIntervalSeconds: 1 | 2 | 5
  /** Tema de cores (ver shared/constants/themes.ts); azul elétrico é o padrão. */
  theme: import('../constants/themes').ThemeId
}

// ---------------------------------------------------------------------------
// API exposta pelo preload em window.jk
// ---------------------------------------------------------------------------

export interface JkApi {
  app: {
    bootstrap(): Promise<Result<BootstrapInfo>>
    getAccess(): Promise<Result<AccessState>>
    /** Recebe cada etapa da inicialização assim que termina. Devolve a função para cancelar. */
    onBootProgress(listener: (step: import('../boot').BootStep) => void): () => void
  }
  license: {
    activate(key: string): Promise<Result<AccessState>>
    deactivate(): Promise<Result<AccessState>>
  }
  owner: {
    /** Abre um seletor de arquivo no processo principal e importa a chave do proprietário. */
    importKey(passphrase: string): Promise<Result<AccessState>>
    unlock(passphrase: string): Promise<Result<AccessState>>
    lock(): Promise<Result<AccessState>>
  }
  keys: {
    list(): Promise<Result<IssuedKey[]>>
    generate(input: GenerateKeyInput): Promise<Result<IssuedKey>>
    revoke(id: string): Promise<Result<IssuedKey>>
    exportRevocations(): Promise<Result<{ path: string | null; count: number }>>
  }
  system: {
    getStatic(refresh: boolean): Promise<Result<StaticSystemInfo>>
    getMetrics(): Promise<Result<LiveMetrics>>
  }
  executor: {
    status(): Promise<Result<ExecutorStatus>>
    restart(): Promise<Result<ExecutorStatus>>
    listTasks(): Promise<Result<TaskDescriptor[]>>
    run(input: RunTaskInput): Promise<Result<TaskRunRecord>>
    history(): Promise<Result<TaskRunRecord[]>>
    clearHistory(): Promise<Result<TaskRunRecord[]>>
  }
  settings: {
    get(): Promise<Result<Settings>>
    update(patch: Partial<Settings>): Promise<Result<Settings>>
    clearLocalData(): Promise<Result<null>>
  }
  ops: import('./ops').OpsApi
  perf: {
    /** Recebe cada amostra de telemetria assim que o coletor a emite. Devolve a função para cancelar. */
    onSample(listener: (sample: import('./perf').PerfSample) => void): () => void
  }
  window: {
    minimize(): Promise<Result<null>>
    toggleMaximize(): Promise<Result<boolean>>
    close(): Promise<Result<null>>
    isMaximized(): Promise<Result<boolean>>
    /** Redimensionamento pelas bordas próprias (janelas transparentes não redimensionam pelo Windows). */
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<Result<null>>
    /** Avisa quando a janela é maximizada ou restaurada. Devolve a função para cancelar. */
    onState(listener: (state: { maximized: boolean }) => void): () => void
  }
}
