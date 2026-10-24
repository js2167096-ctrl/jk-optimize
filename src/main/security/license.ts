// Formato e verificação de chaves de ativação.
//
// Uma chave é um token assinado com Ed25519 pela chave privada do proprietário:
//   JKO1.<payload em base64url>.<assinatura em base64url>
// O aplicativo distribuído contém apenas a chave PÚBLICA, então consegue verificar
// chaves offline, mas não consegue emiti-las. Este módulo não depende do Electron
// para poder ser testado com `node --test` e reutilizado pelo script owner:init.
import { createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import type { ActivationProblem, LicenseInfo } from '@shared/types'

export const TOKEN_PREFIX = 'JKO1'
const MAX_TOKEN_LENGTH = 1024
const CLOCK_SKEW_MS = 5 * 60 * 1000
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface LicensePayload {
  v: 1
  /** Identificador único e aleatório da chave. */
  id: string
  /** Emissão (ms desde epoch). */
  iat: number
  /** Expiração (ms desde epoch) ou null. */
  exp: number | null
  /** Identificador do computador vinculado ou null. */
  mid: string | null
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload; info: LicenseInfo }
  | { ok: false; problem: ActivationProblem; payloadId?: string }

export interface VerifyContext {
  machineId: string | null
  revoked: ReadonlySet<string>
  now: number
}

/** Identificador de 120 bits gerado com CSPRNG, em base32 Crockford: XXXXXX-XXXXXX-XXXXXX-XXXXXX. */
export function generateKeyId(): string {
  const bytes = randomBytes(15)
  let out = ''
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  return out.match(/.{6}/g)!.join('-')
}

export function signLicense(payload: LicensePayload, privateKey: KeyObject): string {
  const body = `${TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
  const signature = sign(null, Buffer.from(body), privateKey).toString('base64url')
  return `${body}.${signature}`
}

export function normalizeToken(raw: string): string {
  return raw.replace(/\s+/g, '')
}

export function verifyLicense(rawToken: string, publicKeyPem: string, ctx: VerifyContext): VerifyResult {
  const token = normalizeToken(rawToken)
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, problem: 'invalid' }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, problem: 'invalid' }

  const [prefix, payloadB64, signatureB64] = parts
  let signatureValid = false
  try {
    signatureValid = verify(
      null,
      Buffer.from(`${prefix}.${payloadB64}`),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, 'base64url')
    )
  } catch {
    signatureValid = false
  }
  if (!signatureValid) return { ok: false, problem: 'invalid' }

  const payload = parsePayload(payloadB64)
  if (!payload) return { ok: false, problem: 'invalid' }

  if (ctx.revoked.has(payload.id)) return { ok: false, problem: 'revoked', payloadId: payload.id }
  if (payload.iat > ctx.now + CLOCK_SKEW_MS) return { ok: false, problem: 'not-yet-valid' }
  if (payload.exp !== null && ctx.now >= payload.exp) return { ok: false, problem: 'expired' }
  if (payload.mid !== null && payload.mid !== ctx.machineId) return { ok: false, problem: 'machine-mismatch' }

  return {
    ok: true,
    payload,
    info: {
      id: payload.id,
      issuedAt: new Date(payload.iat).toISOString(),
      expiresAt: payload.exp === null ? null : new Date(payload.exp).toISOString(),
      machineBound: payload.mid !== null
    }
  }
}

function parsePayload(b64: string): LicensePayload | null {
  let data: unknown
  try {
    data = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const p = data as Record<string, unknown>
  const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
  if (p.v !== 1) return null
  if (typeof p.id !== 'string' || !/^[0-9A-Z]{6}(-[0-9A-Z]{6}){3}$/.test(p.id)) return null
  if (!isTime(p.iat)) return null
  if (p.exp !== null && !isTime(p.exp)) return null
  if (p.mid !== null && (typeof p.mid !== 'string' || p.mid.length > 64)) return null
  return { v: 1, id: p.id, iat: p.iat, exp: p.exp as number | null, mid: p.mid as string | null }
}

/** Confere se a chave privada corresponde à chave pública embutida no build. */
export function privateKeyMatchesPublic(privateKey: KeyObject, publicKeyPem: string): boolean {
  try {
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    const embedded = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
    return derived.equals(embedded)
  } catch {
    return false
  }
}
