// Reinicialização do computador, sempre solicitada pelo usuário e com confirmação na interface.
// O Windows agenda o reinício com contagem regressiva e ele pode ser cancelado (shutdown /a).
// Nunca é chamada automaticamente: só existe como ação confirmada pelo usuário.
import { execFile } from 'node:child_process'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams } from '../ops/params'
import { log } from '../ops/log'

export const RESTART_DELAY_SEC = 30

/** Argumentos FIXOS do shutdown.exe (nenhum texto da interface entra no comando). Exportada para testes. */
export function restartArgs(delaySec: number = RESTART_DELAY_SEC): string[] {
  const seconds = Math.min(Math.max(Math.trunc(delaySec), 10), 300)
  return ['/r', '/t', String(seconds), '/c', 'JK Optimize: reiniciando para concluir os ajustes aplicados. Salve seus trabalhos.']
}

export const ABORT_ARGS = ['/a']

function runShutdown(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile('shutdown.exe', args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code === undefined ? 1 : Number((error as { code?: number }).code) || 1) : 0
      resolve({ code, text: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

defineAction<Record<string, never>, never>({
  id: 'system.restart',
  module: 'windows',
  title: 'Reiniciar o computador',
  description: `Agenda o reinício do Windows para daqui a ${RESTART_DELAY_SEC} segundos (pode ser cancelado). Aplicativos abertos podem ser interrompidos.`,
  risk: 'high',
  reversible: false,
  irreversibleReason: `Reiniciar interrompe aplicativos abertos. É possível cancelar durante os ${RESTART_DELAY_SEC} segundos de contagem.`,
  requiresElevation: false,
  exclusive: 'system-restart',
  parse: noParams,
  async preview() {
    return {
      summary: `O Windows reiniciará em ${RESTART_DELAY_SEC} segundos depois da confirmação.`,
      changes: [{ target: 'Computador', current: 'Ligado', intended: `Reinicia em ${RESTART_DELAY_SEC} s (cancelável)` }],
      warnings: ['Aplicativos abertos podem ser interrompidos. Salve seus trabalhos antes de continuar.'],
      blocked: null
    }
  },
  async execute() {
    const r = await runShutdown(restartArgs())
    if (r.code !== 0) {
      log.warn('windows', `Reinício não agendado (código ${r.code}): ${r.text.slice(0, 200)}`)
      return { ok: false, verified: true, summary: `O Windows não agendou o reinício (código ${r.code}).`, sections: [{ title: 'Detalhes', rows: [{ label: 'Resposta', value: r.text || 'sem texto', tone: 'error' }] }] }
    }
    log.info('windows', `Reinício agendado para ${RESTART_DELAY_SEC} s a pedido do usuário.`)
    return { ok: true, verified: true, summary: `O Windows reiniciará em ${RESTART_DELAY_SEC} segundos. Você pode cancelar até lá.` }
  }
})

defineQuery({
  id: 'system.restart.abort',
  module: 'windows',
  parse: noParams,
  async run() {
    const r = await runShutdown(ABORT_ARGS)
    // Código 1116: não havia reinício em andamento (nada a cancelar).
    if (r.code !== 0 && !/1116/.test(r.text)) throw new AppFailure('abort-failed', `Não foi possível cancelar o reinício (código ${r.code}).`)
    log.info('windows', 'Reinício cancelado pelo usuário.')
    return { cancelled: r.code === 0 }
  }
})
