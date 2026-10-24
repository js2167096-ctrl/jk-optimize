// Identificador estável deste computador, usado para vincular chaves.
// Derivado do MachineGuid do Windows com hash, para não expor o valor original.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

let cached: Promise<string | null> | null = null

export function getMachineId(): Promise<string | null> {
  cached ??= new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        const match = error ? null : /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(stdout)
        if (!match) return resolve(null)
        const hex = createHash('sha256')
          .update(`jk-optimize:${match[1].toLowerCase()}`)
          .digest('hex')
          .slice(0, 20)
          .toUpperCase()
        resolve(hex.match(/.{5}/g)!.join('-'))
      }
    )
  })
  return cached
}

export const MACHINE_ID_PATTERN = /^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/
