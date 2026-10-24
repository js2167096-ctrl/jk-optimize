// Registro dos canais IPC. Cada canal declara o nível de acesso exigido, e a
// verificação acontece aqui, antes de chegar ao serviço.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AppError, BootstrapInfo, Result } from '@shared/types'
import { IPC, IPC_EVENTS, type IpcChannel } from '@shared/constants/ipc'
import type { BootStep } from '@shared/boot'
import { bootTimeline, markBoot, withDeadline } from './startup'
import * as access from './security/access'
import { AppFailure, expectBoolean, expectInteger, expectNoArgs, expectRecord, expectString, ValidationError } from './security/validate'
import * as ops from './ops/registry'
import './modules'
import { startLicenseChecks } from './modules/licensing'
import { setSamplerInterval } from './modules/sampler'
import { queryLogs } from './ops/log'
import type { LogQuery } from '@shared/types/ops'
import * as executor from './executor/host'
import { getMachineId } from './services/machine'
import { getSettings, updateSettings } from './services/settings'
import { getMetrics, getStaticInfo } from './services/system'
import { clearAllData } from './services/store'

type Guard = 'public' | 'protected' | 'owner'
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

let isTrustedUrl: (url: string) => boolean = () => false

function toAppError(error: unknown): AppError {
  if (error instanceof AppFailure) return { code: error.code, message: error.message }
  if (error instanceof ValidationError) return { code: 'invalid-input', message: error.message }
  console.error('[ipc] erro inesperado:', error)
  return { code: 'internal-error', message: 'Ocorreu um erro interno. Tente novamente.' }
}

function handle(channel: IpcChannel, guard: Guard, handler: Handler): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
    try {
      const url = event.senderFrame?.url ?? ''
      if (!isTrustedUrl(url)) throw new AppFailure('forbidden-sender', 'Origem não autorizada.')
      if (guard === 'protected') await access.requireAccess()
      if (guard === 'owner') access.requireOwner()
      return { ok: true, data: await handler(event, ...args) }
    } catch (error) {
      return { ok: false, error: toAppError(error) }
    }
  })
}

const windowOf = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)

function parseLogQuery(raw: unknown): LogQuery {
  const q = expectRecord(raw ?? {}, 'filtro', ['module', 'level', 'text', 'fromDays', 'limit'])
  const level = q.level === undefined ? undefined : expectString(q.level, 'nível', 10)
  if (level !== undefined && !['info', 'warn', 'error'].includes(level)) throw new ValidationError('nível inválido.')
  return {
    module: q.module === undefined ? undefined : expectString(q.module, 'módulo', 40),
    level: level as LogQuery['level'],
    text: q.text === undefined ? undefined : expectString(q.text, 'texto', 200),
    fromDays: q.fromDays === undefined ? undefined : expectInteger(q.fromDays, 'dias', 1, 14),
    limit: q.limit === undefined ? undefined : expectInteger(q.limit, 'limite', 1, 1000)
  }
}

export function registerIpc(trusted: (url: string) => boolean): void {
  isTrustedUrl = trusted

  handle(IPC.appBootstrap, 'public', async (e, ...args): Promise<BootstrapInfo> => {
    expectNoArgs(args)
    // Cada etapa avisa a interface quando termina de verdade (a barra de carregamento não usa temporizador).
    const done = (step: BootStep): void => {
      markBoot(`bootstrap:${step}`)
      if (!e.sender.isDestroyed()) e.sender.send(IPC_EVENTS.bootProgress, step)
    }
    markBoot('bootstrap:inicio')
    const settings = getSettings()
    done('settings')
    // Identificação do computador e executor andam em paralelo com a licença; cada um tem prazo próprio,
    // para o painel abrir dentro do limite mesmo se algum deles demorar (o estado real continua sendo exibido).
    const machineP = withDeadline(getMachineId(), 3000, null).then((r) => (done('identity'), r))
    const testDelay = Number(process.env.JKO_E2E_BOOT_DELAY_MS) || 0 // somente para testes: alonga a etapa do executor
    const executorP = withDeadline(executor.startExecutor().then(async (r) => (testDelay ? (await new Promise((res) => setTimeout(res, testDelay)), r) : r)), 6000, () => executor.getExecutorStatus()).then((r) => (done('executor'), r))
    // Autoridade de licenças antes de decidir o acesso (limitada a 4 s).
    await startLicenseChecks(4000)
    done('license')
    const accessState = await access.getAccess()
    done('access')
    const [machineId, executorStatus] = await Promise.all([machineP, executorP])
    markBoot('bootstrap:fim')
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      access: accessState,
      machineId,
      executor: executorStatus,
      settings,
      timings: bootTimeline()
    }
  })
  handle(IPC.appGetAccess, 'public', () => access.getAccess())

  handle(IPC.licenseActivate, 'public', (_e, key) => access.activate(key))
  handle(IPC.licenseDeactivate, 'public', () => access.deactivate())

  handle(IPC.ownerImportKey, 'public', (e, passphrase) => access.importOwnerKey(passphrase, windowOf(e)))
  handle(IPC.ownerUnlock, 'public', (_e, passphrase) => access.unlockOwner(passphrase))
  handle(IPC.ownerLock, 'public', () => access.lockOwner())

  handle(IPC.keysList, 'owner', () => access.listKeys())
  handle(IPC.keysGenerate, 'owner', (_e, input) => access.generateKey(input))
  handle(IPC.keysRevoke, 'owner', (_e, id) => access.revokeKey(id))
  handle(IPC.keysExportRevocations, 'owner', (e) => access.exportRevocations(windowOf(e)))

  handle(IPC.systemGetStatic, 'protected', (_e, refresh) => getStaticInfo(expectBoolean(refresh, 'refresh')))
  handle(IPC.systemGetMetrics, 'protected', () => getMetrics())

  handle(IPC.executorStatus, 'protected', () => executor.getExecutorStatus())
  handle(IPC.executorRestart, 'protected', () => executor.restartExecutor())
  handle(IPC.executorListTasks, 'protected', () => executor.listTasks())
  handle(IPC.executorRun, 'protected', (_e, input) => executor.runTask(input))
  handle(IPC.executorHistory, 'protected', () => executor.getHistory())
  handle(IPC.executorClearHistory, 'protected', () => executor.clearHistory())

  ops.setProgressSink((progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && isTrustedUrl(win.webContents.getURL())) win.webContents.send(IPC_EVENTS.opsProgress, progress)
    }
  })

  // Operações dos módulos: o nível exigido vem da definição de cada operação.
  const guardFor = async (level: 'protected' | 'owner') => {
    await access.requireAccess()
    if (level === 'owner') access.requireOwner()
  }
  handle(IPC.opsQuery, 'protected', async (_e, id, params, jobId) => {
    await guardFor(ops.getQueryAccess(expectString(id, 'consulta', 80, 1)))
    return ops.runQuery(id as string, params, jobId)
  })
  handle(IPC.opsActions, 'protected', () => ops.listActions())
  handle(IPC.opsPreview, 'protected', async (_e, id, params) => {
    await guardFor(ops.getActionAccess(expectString(id, 'ação', 80, 1)))
    return ops.previewAction(id as string, params)
  })
  handle(IPC.opsExecute, 'protected', async (_e, previewId, confirmed, jobId) => {
    await guardFor(ops.previewAccess(previewId))
    return ops.executeAction(previewId, confirmed, jobId)
  })
  handle(IPC.opsRevert, 'protected', (_e, changeId, force) => ops.revertChange(changeId, force))
  handle(IPC.opsCancel, 'protected', (_e, jobId) => ops.cancelJob(jobId))
  handle(IPC.opsChanges, 'protected', () => ops.listChanges())
  handle(IPC.opsLogs, 'protected', (_e, query) => queryLogs(parseLogQuery(query)))

  handle(IPC.settingsGet, 'public', () => getSettings())
  handle(IPC.settingsUpdate, 'protected', (_e, patch) => {
    const next = updateSettings(patch)
    // O intervalo escolhido vale para o coletor de telemetria (antes só a consulta da interface mudava).
    setSamplerInterval(next.metricsIntervalSeconds * 1000)
    return next
  })
  handle(IPC.settingsClearLocalData, 'public', async (e) => {
    // Confirmação nativa no processo principal: não pode ser pulada pela interface.
    const options = {
      type: 'warning' as const,
      buttons: ['Cancelar', 'Apagar dados'],
      defaultId: 0,
      cancelId: 0,
      title: 'Limpar dados locais',
      message: 'Apagar todos os dados locais do JK Optimize?',
      detail:
        'Serão removidos: ativação, configurações, histórico do executor, chaves emitidas e a cópia local da chave do proprietário. O aplicativo será reiniciado.'
    }
    const win = windowOf(e)
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    if (response !== 1) throw new AppFailure('cancelled', 'Operação cancelada.')
    executor.stopExecutor()
    clearAllData()
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
    return null
  })

  // Janela sem moldura: os botões da barra superior própria chamam estes canais.
  handle(IPC.windowMinimize, 'public', (e) => {
    windowOf(e)?.minimize()
    return null
  })
  handle(IPC.windowToggleMaximize, 'public', (e) => {
    const win = windowOf(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle(IPC.windowClose, 'public', (e) => {
    windowOf(e)?.close()
    return null
  })
  handle(IPC.windowIsMaximized, 'public', (e) => windowOf(e)?.isMaximized() ?? false)
  handle(IPC.windowSetBounds, 'public', (e, raw) => {
    const b = expectRecord(raw, 'janela', ['x', 'y', 'width', 'height'])
    const win = windowOf(e)
    if (!win || win.isMaximized() || win.isFullScreen()) return null
    // Janelas transparentes não são redimensionáveis pelo Windows, e o Electron informa o tamanho
    // mínimo igual ao atual; o mínimo real do app é fixo (igual ao da criação da janela).
    const [minW, minH] = [1024, 680]
    win.setBounds({
      x: expectInteger(b.x, 'x', -20000, 20000),
      y: expectInteger(b.y, 'y', -20000, 20000),
      width: Math.max(minW, expectInteger(b.width, 'largura', 200, 20000)),
      height: Math.max(minH, expectInteger(b.height, 'altura', 200, 20000))
    })
    return null
  })
}
