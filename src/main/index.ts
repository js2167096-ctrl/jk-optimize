import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME } from '@shared/constants/app'
import { IPC_EVENTS } from '@shared/constants/ipc'
import { registerIpc } from './ipc'
import { startExecutor, stopExecutor } from './executor/host'
import { applyLaunchAtStartup, getSettings } from './services/settings'
import { DEV_URL, isTrustedUrl, RENDERER_FILE, secureWebPreferences } from './target'
import { startMonitoring, stopMonitoring } from './modules/monitoring'
import { demandSample, onSample, setSamplerInterval } from './modules/sampler'
import { markBoot } from './startup'
import { startGameBoost, stopGameBoost } from './modules/gameboost'
import { stopLicenseChecks } from './modules/licensing'

// Pasta de dados alternativa (testes automatizados). Isola os testes dos dados reais
// do usuário e também da trava de instância única, que é por pasta de dados.
if (process.env.JKO_USER_DATA_DIR) app.setPath('userData', process.env.JKO_USER_DATA_DIR)

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  'connect-src ws://localhost:* http://localhost:*',
  "object-src 'none'"
].join('; ')

let mainWindow: BrowserWindow | null = null
const APP_ICON = join(app.getAppPath(), 'build', 'icon.ico')

function hardenSessions(): void {
  const ses = session.defaultSession
  // Únicas permissões concedidas: área de transferência (botões "Copiar") e notificações (alertas).
  const allowed = (permission: string) => permission === 'clipboard-sanitized-write' || permission === 'notifications'
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed(permission))
  if (DEV_URL) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] } })
    })
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      // Links externos (ex.: documentação) abrem no navegador padrão, nunca dentro do app.
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    // Sem moldura e transparente: os cantos arredondados e a barra superior são desenhados pela
    // interface (WindowFrame). Os botões da janela usam os canais window:* da lista permitida.
    // Instalado, o ícone vem do executável (build/icon.ico embutido pelo instalador); em desenvolvimento, do arquivo.
    icon: existsSync(APP_ICON) ? APP_ICON : undefined,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    webPreferences: secureWebPreferences()
  })
  win.once('ready-to-show', () => {
    markBoot('janela visível')
    win.show()
  })
  const sendState = () => win.webContents.send(IPC_EVENTS.windowState, { maximized: win.isMaximized() })
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  // Fechar a janela principal encerra o app, mesmo com o overlay aberto.
  win.on('closed', () => {
    mainWindow = null
    app.quit()
  })
  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(RENDERER_FILE)
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  process.on('uncaughtException', (error) => console.error('[main] exceção não tratada:', error))
  process.on('unhandledRejection', (reason) => console.error('[main] promessa rejeitada:', reason))

  markBoot('processo iniciado')
  void app.whenReady().then(() => {
    markBoot('app pronto')
    app.setAppUserModelId('com.jkoptimize.app')
    Menu.setApplicationMenu(null)
    hardenSessions()
    registerIpc(isTrustedUrl)
    applyLaunchAtStartup(getSettings().launchAtStartup)
    void startExecutor()
    setSamplerInterval(getSettings().metricsIntervalSeconds * 1000)
    mainWindow = createWindow()
    markBoot('janela criada')
    // A coleta de métricas começa já na abertura, em segundo plano (processo separado): o painel não espera por ela.
    demandSample()
    // Cada amostra vai para a interface assim que o coletor a emite (sem esperar a próxima consulta periódica).
    onSample((sample) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(IPC_EVENTS.perfSample, sample)
    })
    startMonitoring()
    void startGameBoost().catch((error) => console.error('[main] Game Boost:', error))
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    stopGameBoost()
    stopLicenseChecks()
    stopMonitoring()
    stopExecutor()
  })
}
