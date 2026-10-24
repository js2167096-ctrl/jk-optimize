// Onde a interface é carregada (servidor do Vite em desenvolvimento ou arquivo empacotado).
import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
export const RENDERER_FILE = join(__dirname, '../renderer/index.html')
export const RENDERER_FILE_URL = pathToFileURL(RENDERER_FILE).href
export const PRELOAD_FILE = join(__dirname, '../preload/index.js')

/** Só a página do próprio aplicativo pode navegar ou falar com o processo principal. */
export function isTrustedUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (DEV_URL) return url.origin === new URL(DEV_URL).origin
    url.hash = ''
    url.search = ''
    return url.href === RENDERER_FILE_URL
  } catch {
    return false
  }
}

export function secureWebPreferences() {
  return {
    preload: PRELOAD_FILE,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false
  }
}
