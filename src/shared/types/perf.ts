// Amostra de telemetria real coletada pelo amostrador do processo principal.
// Campos null = dado indisponível nesta máquina (nunca zero inventado).

export interface CoreLoad {
  name: string
  pct: number
}

export interface GpuAdapterSample {
  luid: string
  /** Nome provável do adaptador (null quando não foi possível associar o LUID). */
  name: string | null
  utilizationPct: number
  engines: { type: string; pct: number }[]
  dedicatedBytes: number | null
  sharedBytes: number | null
}

export interface ThermalZoneSample {
  name: string
  celsius: number
  passiveLimitPct: number | null
  throttleReasons: number | null
}

export interface NvidiaSample {
  index: number
  name: string
  temperatureC: number | null
  utilizationPct: number | null
  memoryUsedMB: number | null
  memoryTotalMB: number | null
}

export interface ProcessLoad {
  pid: number
  name: string
  cpuPct: number
  workingSetPrivate: number
  privateBytes: number
}

export interface PerfSample {
  /** Momento em que a amostra foi emitida pelo coletor (ms desde 1970). */
  ts: number
  /** Tempo que o coletor levou para reunir os contadores desta amostra (ms). */
  collectMs: number | null
  /** Última leitura de GPU, temperatura e processos (atualizados a cada dois ciclos). */
  slowTs: number | null
  cpu: {
    totalPct: number | null
    perCore: CoreLoad[]
    /** "% Processor Performance": desempenho relativo à frequência nominal. */
    performancePct: number | null
    /** Frequência nominal (base) informada pelo contador. */
    nominalMHz: number | null
    /** Frequência efetiva derivada do contador (nominal × desempenho). */
    effectiveMHz: number | null
    /** < 100 indica limitação do desempenho por política de energia ou temperatura. */
    performanceLimitPct: number | null
  }
  memory: {
    totalBytes: number | null
    availableBytes: number | null
    committedBytes: number | null
    commitLimitBytes: number | null
    commitPct: number | null
    pagesPerSec: number | null
    /** Cache em espera: memória reaproveitável que o Windows libera sob demanda (conta como disponível). */
    standbyBytes: number | null
    modifiedBytes: number | null
    /** Memória livre e zerada (sem uso nenhum). */
    freeBytes: number | null
    systemCacheBytes: number | null
  }
  gpus: GpuAdapterSample[]
  gpuProcesses: { pid: number; pct: number }[]
  thermal: ThermalZoneSample[]
  nvidia: NvidiaSample[]
  topCpu: ProcessLoad[]
  topMemory: ProcessLoad[]
  /** Fontes que falharam nesta amostra. */
  errors: string[]
}
