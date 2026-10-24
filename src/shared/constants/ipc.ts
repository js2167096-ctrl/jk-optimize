// Lista permitida de canais IPC. Nenhum outro canal é registrado no processo principal.
export const IPC = {
  appBootstrap: 'app:bootstrap',
  appGetAccess: 'app:get-access',

  licenseActivate: 'license:activate',
  licenseDeactivate: 'license:deactivate',

  ownerImportKey: 'owner:import-key',
  ownerUnlock: 'owner:unlock',
  ownerLock: 'owner:lock',

  keysList: 'keys:list',
  keysGenerate: 'keys:generate',
  keysRevoke: 'keys:revoke',
  keysExportRevocations: 'keys:export-revocations',

  systemGetStatic: 'system:get-static',
  systemGetMetrics: 'system:get-metrics',

  executorStatus: 'executor:status',
  executorRestart: 'executor:restart',
  executorListTasks: 'executor:list-tasks',
  executorRun: 'executor:run',
  executorHistory: 'executor:history',
  executorClearHistory: 'executor:clear-history',

  opsQuery: 'ops:query',
  opsActions: 'ops:actions',
  opsPreview: 'ops:preview',
  opsExecute: 'ops:execute',
  opsRevert: 'ops:revert',
  opsCancel: 'ops:cancel',
  opsChanges: 'ops:changes',
  opsLogs: 'ops:logs',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsClearLocalData: 'settings:clear-local-data',

  // Controles da janela sem moldura (barra superior própria).
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowSetBounds: 'window:set-bounds'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Únicos eventos enviados do processo principal para a interface. */
export const IPC_EVENTS = {
  opsProgress: 'ops:progress',
  windowState: 'window:state',
  /** Amostra de telemetria enviada pelo coletor assim que fica pronta (sem consulta periódica). */
  perfSample: 'perf:sample',
  /** Etapa real da inicialização concluída (alimenta a barra da tela de carregamento). */
  bootProgress: 'app:boot-progress'
} as const
