// Autoridade de licenciamento: lista de revogação ASSINADA pelo proprietário
// (Ed25519), publicada em um endereço HTTPS. O app só aceita a lista se a
// assinatura conferir com a chave pública embutida e se a sequência não for
// anterior à última já aceita (impede reutilizar uma lista antiga).
//
// Política offline: falha de rede NÃO é revogação. O cliente continua liberado
// enquanto a última verificação bem-sucedida (ou a ativação) tiver menos de
// OFFLINE_GRACE_DAYS dias; depois disso, precisa se conectar para verificar.
// Módulo puro (sem Electron) nas funções de assinatura e avaliação.
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

export const OFFLINE_GRACE_DAYS = 7
export const RECHECK_MINUTES = 10

export interface RevocationList {
  format: 'jk-optimize-revocations'
  version: 1
  /** Número crescente (ms desde epoch na emissão). */
  sequence: number
  issuedAt: string
  revoked: string[]
  signature?: string
}

const ID = /^[0-9A-Z]{6}(-[0-9A-Z]{6}){3}$/

export function canonicalList(l: RevocationList): string {
  return JSON.stringify([l.format, l.version, l.sequence, l.issuedAt, [...l.revoked].sort()])
}

export function signRevocationList(l: Omit<RevocationList, 'signature'>, key: KeyObject): RevocationList {
  const base = { ...l, revoked: [...new Set(l.revoked)].sort() } as RevocationList
  return { ...base, signature: sign(null, Buffer.from(canonicalList(base)), key).toString('base64') }
}

export function parseRevocationList(raw: unknown): RevocationList {
  const l = raw as Record<string, unknown>
  const ok =
    l &&
    l.format === 'jk-optimize-revocations' &&
    l.version === 1 &&
    typeof l.sequence === 'number' &&
    Number.isSafeInteger(l.sequence) &&
    l.sequence > 0 &&
    typeof l.issuedAt === 'string' &&
    Array.isArray(l.revoked) &&
    l.revoked.length <= 100_000 &&
    l.revoked.every((id) => typeof id === 'string' && ID.test(id)) &&
    typeof l.signature === 'string'
  if (!ok) throw new Error('Lista de revogação em formato inválido.')
  return l as unknown as RevocationList
}

export function verifyRevocationList(l: RevocationList, publicKeyPem: string): boolean {
  if (!l.signature) return false
  try {
    return verify(null, Buffer.from(canonicalList(l)), createPublicKey(publicKeyPem), Buffer.from(l.signature, 'base64'))
  } catch {
    return false
  }
}

export interface AuthorityState {
  lastSequence: number
  revoked: string[]
  lastSuccess: string | null
  lastAttempt: string | null
  lastError: string | null
}

export const EMPTY_AUTHORITY: AuthorityState = { lastSequence: 0, revoked: [], lastSuccess: null, lastAttempt: null, lastError: null }

/**
 * Aplica uma lista baixada ao estado guardado. Recusa assinatura inválida e
 * listas mais antigas que a última aceita. Exportada para testes.
 */
export function acceptList(state: AuthorityState, raw: unknown, publicKeyPem: string, now: Date): { state: AuthorityState; outcome: 'accepted' | 'invalid' | 'rollback' } {
  let list: RevocationList
  try {
    list = parseRevocationList(raw)
  } catch (error) {
    return { state: { ...state, lastAttempt: now.toISOString(), lastError: (error as Error).message }, outcome: 'invalid' }
  }
  if (!verifyRevocationList(list, publicKeyPem)) {
    return { state: { ...state, lastAttempt: now.toISOString(), lastError: 'Assinatura da lista de revogação inválida.' }, outcome: 'invalid' }
  }
  if (list.sequence < state.lastSequence) {
    return { state: { ...state, lastAttempt: now.toISOString(), lastError: 'Lista de revogação mais antiga que a última aceita (recusada).' }, outcome: 'rollback' }
  }
  return {
    state: { lastSequence: list.sequence, revoked: list.revoked, lastSuccess: now.toISOString(), lastAttempt: now.toISOString(), lastError: null },
    outcome: 'accepted'
  }
}

/** A verificação online está vencida? (só quando há autoridade configurada) */
export function verificationOverdue(state: AuthorityState, activatedAt: string | null, now: number, graceDays = OFFLINE_GRACE_DAYS): boolean {
  const base = Math.max(state.lastSuccess ? Date.parse(state.lastSuccess) : 0, activatedAt ? Date.parse(activatedAt) : 0)
  return now - base > graceDays * 86_400_000
}

/** Identificador mascarado para logs (nunca registra a key). */
export function maskId(id: string): string {
  return `${id.slice(0, 6)}-…`
}
