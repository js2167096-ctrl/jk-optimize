import { isThemeId, THEME_IDS } from '@shared/constants/themes'
import { app } from 'electron'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/constants/app'
import { expectBoolean, expectRecord, expectString, ValidationError } from '../security/validate'
import { JsonStore } from './store'

const INTERVALS = [1, 2, 5] as const

const store = new JsonStore<Settings>('settings.json', (raw) => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>
  return {
    launchAtStartup: typeof r.launchAtStartup === 'boolean' ? r.launchAtStartup : DEFAULT_SETTINGS.launchAtStartup,
    reduceMotion: typeof r.reduceMotion === 'boolean' ? r.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
    metricsIntervalSeconds: INTERVALS.includes(r.metricsIntervalSeconds as 1)
      ? (r.metricsIntervalSeconds as Settings['metricsIntervalSeconds'])
      : DEFAULT_SETTINGS.metricsIntervalSeconds,
    theme: isThemeId(r.theme) ? r.theme : DEFAULT_SETTINGS.theme
  }
})

export function getSettings(): Settings {
  return store.read()
}

export function updateSettings(rawPatch: unknown): Settings {
  const patch = expectRecord(rawPatch, 'configurações', ['launchAtStartup', 'reduceMotion', 'metricsIntervalSeconds', 'theme'])
  const next = { ...store.read() }
  if ('launchAtStartup' in patch) next.launchAtStartup = expectBoolean(patch.launchAtStartup, 'launchAtStartup')
  if ('reduceMotion' in patch) next.reduceMotion = expectBoolean(patch.reduceMotion, 'reduceMotion')
  if ('metricsIntervalSeconds' in patch) {
    if (!INTERVALS.includes(patch.metricsIntervalSeconds as 1)) {
      throw new ValidationError('metricsIntervalSeconds: use 1, 2 ou 5.')
    }
    next.metricsIntervalSeconds = patch.metricsIntervalSeconds as Settings['metricsIntervalSeconds']
  }
  if ('theme' in patch) {
    const theme = expectString(patch.theme, 'theme', 10)
    if (!isThemeId(theme)) throw new ValidationError(`theme: use um destes: ${THEME_IDS.join(', ')}.`)
    next.theme = theme as Settings['theme']
  }
  applyLaunchAtStartup(next.launchAtStartup)
  return store.write(next)
}

/** Só registra a inicialização com o Windows na versão instalada (em desenvolvimento registraria o electron.exe). */
export function applyLaunchAtStartup(enabled: boolean): void {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled })
}
