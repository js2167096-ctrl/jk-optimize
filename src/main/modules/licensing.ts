// Estado da autoridade de licenças (lista de revogação assinada) e verificação periódica.
import { defineQuery } from '../ops/registry'
import { noParams } from '../ops/params'
import { log } from '../ops/log'
import { authorityStatus, checkAuthority } from '../security/access'
import { RECHECK_MINUTES } from '../security/license-authority'

defineQuery({ id: 'license.authority.status', module: 'updater', parse: noParams, run: async () => authorityStatus() })

defineQuery({
  id: 'license.authority.check',
  module: 'updater',
  parse: noParams,
  async run() {
    const r = await checkAuthority()
    return { ...r, status: authorityStatus() }
  }
})

let timer: NodeJS.Timeout | null = null

/** Verifica na abertura (com limite de tempo) e depois a cada RECHECK_MINUTES. */
export async function startLicenseChecks(timeoutMs = 6000): Promise<void> {
  if (!timer) {
    timer = setInterval(() => {
      void checkAuthority().catch((e) => log.error('updater', `Autoridade de licenças: ${(e as Error).message}`))
    }, RECHECK_MINUTES * 60_000)
  }
  await Promise.race([checkAuthority().catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))])
}

export function stopLicenseChecks(): void {
  if (timer) clearInterval(timer)
  timer = null
}
