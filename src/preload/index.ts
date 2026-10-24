// Ponte mínima entre a interface e o processo principal. Expõe apenas funções
// tipadas para os canais da lista permitida; nenhum acesso ao Node.js ou ao ipcRenderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, IPC_EVENTS, type IpcChannel } from '@shared/constants/ipc'
import type { JkApi } from '@shared/types'
import type { JobProgress } from '@shared/types/ops'
import type { PerfSample } from '@shared/types/perf'
import type { BootStep } from '@shared/boot'

const invoke = <T>(channel: IpcChannel, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args)

const api: JkApi = {
  app: {
    bootstrap: () => invoke(IPC.appBootstrap),
    getAccess: () => invoke(IPC.appGetAccess),
    onBootProgress: (listener) => {
      const handler = (_event: IpcRendererEvent, step: BootStep) => listener(step)
      ipcRenderer.on(IPC_EVENTS.bootProgress, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.bootProgress, handler)
    }
  },
  license: {
    activate: (key) => invoke(IPC.licenseActivate, key),
    deactivate: () => invoke(IPC.licenseDeactivate)
  },
  owner: {
    importKey: (passphrase) => invoke(IPC.ownerImportKey, passphrase),
    unlock: (passphrase) => invoke(IPC.ownerUnlock, passphrase),
    lock: () => invoke(IPC.ownerLock)
  },
  keys: {
    list: () => invoke(IPC.keysList),
    generate: (input) => invoke(IPC.keysGenerate, input),
    revoke: (id) => invoke(IPC.keysRevoke, id),
    exportRevocations: () => invoke(IPC.keysExportRevocations)
  },
  system: {
    getStatic: (refresh) => invoke(IPC.systemGetStatic, refresh),
    getMetrics: () => invoke(IPC.systemGetMetrics)
  },
  executor: {
    status: () => invoke(IPC.executorStatus),
    restart: () => invoke(IPC.executorRestart),
    listTasks: () => invoke(IPC.executorListTasks),
    run: (input) => invoke(IPC.executorRun, input),
    history: () => invoke(IPC.executorHistory),
    clearHistory: () => invoke(IPC.executorClearHistory)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
    clearLocalData: () => invoke(IPC.settingsClearLocalData)
  },
  ops: {
    query: (id, params, jobId) => invoke(IPC.opsQuery, id, params, jobId),
    actions: () => invoke(IPC.opsActions),
    preview: (actionId, params) => invoke(IPC.opsPreview, actionId, params),
    execute: (previewId, confirmed, jobId) => invoke(IPC.opsExecute, previewId, confirmed, jobId),
    revert: (changeId, force) => invoke(IPC.opsRevert, changeId, force),
    cancel: (jobId) => invoke(IPC.opsCancel, jobId),
    changes: () => invoke(IPC.opsChanges),
    logs: (query) => invoke(IPC.opsLogs, query),
    onProgress: (listener) => {
      const handler = (_event: IpcRendererEvent, progress: JobProgress) => listener(progress)
      ipcRenderer.on(IPC_EVENTS.opsProgress, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.opsProgress, handler)
    }
  },
  perf: {
    onSample: (listener) => {
      const handler = (_event: IpcRendererEvent, sample: PerfSample) => listener(sample)
      ipcRenderer.on(IPC_EVENTS.perfSample, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.perfSample, handler)
    }
  },
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: () => invoke(IPC.windowIsMaximized),
    setBounds: (bounds) => invoke(IPC.windowSetBounds, bounds),
    onState: (listener) => {
      const handler = (_event: IpcRendererEvent, state: { maximized: boolean }) => listener(state)
      ipcRenderer.on(IPC_EVENTS.windowState, handler)
      return () => ipcRenderer.removeListener(IPC_EVENTS.windowState, handler)
    }
  }
}

contextBridge.exposeInMainWorld('jk', Object.freeze(api))
