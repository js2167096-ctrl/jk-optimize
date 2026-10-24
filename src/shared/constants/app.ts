import type { Settings } from '../types'

export const APP_NAME = 'JK Optimize'
export const EXECUTOR_NAME = 'JK Optimize Executor'

export const DEFAULT_SETTINGS: Settings = {
  launchAtStartup: false,
  reduceMotion: false,
  metricsIntervalSeconds: 1,
  theme: 'blue'
}

export const MAX_HISTORY_ENTRIES = 200
export const MAX_KEY_LABEL_LENGTH = 60
export const MAX_VALID_DAYS = 3650

export const ACTIVATION_PROBLEM_TEXT: Record<string, string> = {
  invalid: 'A chave informada não é válida para este aplicativo.',
  expired: 'A chave expirou. Solicite uma nova chave ao proprietário.',
  revoked: 'Esta chave foi revogada pelo proprietário.',
  'machine-mismatch': 'Esta chave está vinculada a outro computador.',
  'not-yet-valid': 'A data de emissão da chave está no futuro. Verifique o relógio do Windows.',
  'verification-required':
    'Não foi possível confirmar a licença com o servidor do proprietário há mais de 7 dias. Conecte-se à internet e abra o app de novo; a chave não foi revogada por isso.'
}
