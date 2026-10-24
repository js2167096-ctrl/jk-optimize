// Manifesto de atualização assinado pelo proprietário (Ed25519).
// O aplicativo só instala um pacote quando:
//   1) a assinatura do manifesto confere com a chave pública embutida;
//   2) a versão é maior que a instalada;
//   3) o tamanho e o SHA-512 do instalador baixado conferem com o manifesto.
// Módulo puro: usado pelo app e pelo script `atualizar`.
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

export interface UpdateManifest {
  format: 'jk-optimize-update'
  version: string
  file: string
  size: number
  sha512: string
  releasedAt: string
  notes: string
  signature?: string
}

const FIELDS: (keyof UpdateManifest)[] = ['format', 'version', 'file', 'size', 'sha512', 'releasedAt', 'notes']

/** Texto canônico assinado: campos em ordem fixa, sem a assinatura. */
export function canonicalManifest(m: UpdateManifest): string {
  return JSON.stringify(FIELDS.map((k) => [k, m[k]]))
}

export function signManifest(m: Omit<UpdateManifest, 'signature'>, privateKey: KeyObject): UpdateManifest {
  const base = { ...m } as UpdateManifest
  return { ...base, signature: sign(null, Buffer.from(canonicalManifest(base)), privateKey).toString('base64') }
}

export function parseManifest(raw: unknown): UpdateManifest {
  const m = raw as Record<string, unknown>
  const ok =
    m &&
    m.format === 'jk-optimize-update' &&
    typeof m.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(m.version) &&
    typeof m.file === 'string' &&
    /^[A-Za-z0-9._-]+\.exe$/.test(m.file) &&
    typeof m.size === 'number' &&
    Number.isSafeInteger(m.size) &&
    m.size > 0 &&
    m.size < 1024 ** 3 &&
    typeof m.sha512 === 'string' &&
    /^[A-Za-z0-9+/=]{80,100}$/.test(m.sha512) &&
    typeof m.releasedAt === 'string' &&
    typeof m.notes === 'string' &&
    m.notes.length <= 4000 &&
    typeof m.signature === 'string'
  if (!ok) throw new Error('Manifesto de atualização inválido.')
  return m as unknown as UpdateManifest
}

export function verifyManifest(m: UpdateManifest, publicKeyPem: string): boolean {
  if (!m.signature) return false
  try {
    return verify(null, Buffer.from(canonicalManifest(m)), createPublicKey(publicKeyPem), Buffer.from(m.signature, 'base64'))
  } catch {
    return false
  }
}

/** Compara versões x.y.z: >0 se a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
