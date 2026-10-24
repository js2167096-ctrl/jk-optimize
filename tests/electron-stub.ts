// Substituto mínimo do módulo "electron" para os testes automatizados.
// Usado SOMENTE nos testes: nunca entra no aplicativo.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = process.env.JKO_TEST_DATA ?? mkdtempSync(join(tmpdir(), 'jko-test-'))
process.env.JKO_TEST_DATA = userData

export const handlers = new Map<string, (...args: unknown[]) => unknown>()

export const app = {
  getPath: (_name: string) => userData,
  setPath: () => undefined,
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  quit: () => undefined,
  relaunch: () => undefined,
  exit: () => undefined
}

export const ipcMain = {
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
}

export const BrowserWindow = {
  getAllWindows: () => [],
  fromWebContents: () => null,
  getFocusedWindow: () => null
}

export const dialog = {}
export const shell = { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined }
export const Notification = { isSupported: () => false }
export const screen = {}
export const net = {}
export const safeStorage = { isEncryptionAvailable: () => false }
export const utilityProcess = {
  fork: () => {
    throw new Error('utilityProcess indisponível nos testes')
  }
}
export const session = {}
export const Menu = {}
