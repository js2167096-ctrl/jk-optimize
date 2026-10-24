// Autoridade de acesso do aplicativo. Toda decisão de autorização acontece aqui,
// no processo principal; a interface apenas exibe o estado devolvido.
//
// - Usuário comum: precisa de uma chave assinada pelo proprietário (verificada
//   com a chave pública embutida no build).
// - Proprietário: comprova a identidade possuindo a chave PRIVADA (arquivo
//   cifrado) e a senha dela. Nenhum estado da interface ou do armazenamento
//   local concede acesso administrativo por si só.
// - "Lembrar neste computador": depois do primeiro desbloqueio, a chave privada
//   é guardada cifrada pelo Windows (DPAPI), ligada à conta do Windows. Nas
//   próximas aberturas o app desbloqueia sozinho. "Bloquear sessão" apaga essa
//   lembrança e volta a exigir a senha.
import { BrowserWindow, dialog, net } from 'electron'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createPrivateKey, type KeyObject } from 'node:crypto'
import type { AccessState, GenerateKeyInput, IssuedKey } from '@shared/types'
import { ACTIVATION_PROBLEM_TEXT, MAX_KEY_LABEL_LENGTH, MAX_VALID_DAYS } from '@shared/constants/app'
import { LICENSE_PUBLIC_KEY_PEM } from './license-public-key'
import bundledRevocations from './revocations.json'
import { generateKeyId, normalizeToken, privateKeyMatchesPublic, signLicense, verifyLicense } from './license'
import { decryptOwnerKey, OwnerKeyError } from './owner-key-file'
import { AppFailure, expectInteger, expectRecord, expectString, ValidationError } from './validate'
import { dataPath, JsonStore, writeFileAtomic } from '../services/store'
import { getMachineId, MACHINE_ID_PATTERN } from '../services/machine'
import { protectForCurrentUser, unprotectForCurrentUser } from '../services/dpapi'
import { log } from '../ops/log'
import { LICENSE_AUTHORITY_URL } from './license-authority-config'
import { acceptList, maskId, OFFLINE_GRACE_DAYS, signRevocationList, verificationOverdue, type AuthorityState } from './license-authority'

const DAY_MS = 24 * 60 * 60 * 1000

interface ActivationData {
  token: string | null
  activatedAt: string | null
}

const activationStore = new JsonStore<ActivationData>('activation.json', (raw) => {
  const r = (raw ?? {}) as Partial<ActivationData>
  return {
    token: typeof r.token === 'string' ? r.token : null,
    activatedAt: typeof r.activatedAt === 'string' ? r.activatedAt : null
  }
})

const keysStore = new JsonStore<IssuedKey[]>('owner/issued-keys.json', (raw) =>
  Array.isArray(raw) ? (raw as IssuedKey[]).filter((k) => typeof k?.id === 'string' && typeof k.token === 'string') : []
)

// Funções, não constantes: a pasta de dados pode ser redefinida depois que os módulos carregam.
const ownerKeyPath = () => dataPath('owner', 'owner-key.jkokey')
const rememberedOwnerPath = () => dataPath('owner', 'owner-session.bin')

/** Chave privada do proprietário em memória. Existe somente durante a sessão desbloqueada. */
let ownerSession: KeyObject | null = null
let failedUnlocks = 0

/** Falhar em lembrar não impede o desbloqueio; apenas pedirá a senha de novo. */
async function rememberOwner(key: KeyObject): Promise<void> {
  try {
    const der = key.export({ type: 'pkcs8', format: 'der' })
    writeFileAtomic(rememberedOwnerPath(), (await protectForCurrentUser(der)).toString('base64'))
  } catch (error) {
    console.error('[access] não foi possível lembrar a sessão:', error)
  }
}

function forgetOwner(): void {
  rmSync(rememberedOwnerPath(), { force: true })
}

let restoring: Promise<void> | null = null

/** Restaura a sessão lembrada. Só funciona na mesma conta do Windows que a criou. */
function restoreRememberedOwner(publicKey: string): Promise<void> {
  if (ownerSession || !existsSync(rememberedOwnerPath())) return Promise.resolve()
  restoring ??= (async () => {
    try {
      const der = await unprotectForCurrentUser(Buffer.from(readFileSync(rememberedOwnerPath(), 'utf8'), 'base64'))
      const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      if (privateKeyMatchesPublic(key, publicKey)) ownerSession = key
      else forgetOwner()
    } catch {
      forgetOwner()
    } finally {
      restoring = null
    }
  })()
  return restoring
}

const authorityStore = new JsonStore<AuthorityState>('license-authority.json', (raw) => {
  const r = (raw ?? {}) as Partial<AuthorityState>
  return {
    lastSequence: typeof r.lastSequence === 'number' ? r.lastSequence : 0,
    revoked: Array.isArray(r.revoked) ? r.revoked.filter((x) => typeof x === 'string') : [],
    lastSuccess: typeof r.lastSuccess === 'string' ? r.lastSuccess : null,
    lastAttempt: typeof r.lastAttempt === 'string' ? r.lastAttempt : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null
  }
})

function revokedIds(): Set<string> {
  const ids = new Set<string>(Array.isArray(bundledRevocations.revoked) ? (bundledRevocations.revoked as string[]) : [])
  // Revogações confirmadas pela autoridade online (lista assinada pelo proprietário).
  for (const id of authorityStore.read().revoked) ids.add(id)
  // No computador do proprietário, revogações locais também valem imediatamente.
  for (const key of keysStore.read()) if (key.status === 'revoked') ids.add(key.id)
  return ids
}

export async function getAccess(): Promise<AccessState> {
  const publicKey = LICENSE_PUBLIC_KEY_PEM
  if (!publicKey) return { kind: 'unconfigured' }
  if (existsSync(ownerKeyPath())) await restoreRememberedOwner(publicKey)
  if (ownerSession) return { kind: 'owner' }
  if (existsSync(ownerKeyPath())) return { kind: 'owner-locked' }

  const { token, activatedAt } = activationStore.read()
  if (!token) return { kind: 'activation-required', problem: null }
  const result = verifyLicense(token, publicKey, {
    machineId: await getMachineId(),
    revoked: revokedIds(),
    now: Date.now()
  })
  if (!result.ok) {
    if (result.problem === 'revoked') {
      // Revogação confirmada: invalida a ativação local (o evento é registrado sem a key).
      activationStore.write({ token: null, activatedAt: null })
      log.warn('updater', `Licença revogada pela autoridade; ativação local removida (id ${maskId(result.payloadId ?? '')}).`)
    }
    return { kind: 'activation-required', problem: result.problem }
  }
  if (LICENSE_AUTHORITY_URL && verificationOverdue(authorityStore.read(), activatedAt, Date.now())) {
    return { kind: 'activation-required', problem: 'verification-required' }
  }
  return { kind: 'active', license: result.info }
}

// ---------------------------------------------------------------------------
// Autoridade online (lista de revogação assinada)
// ---------------------------------------------------------------------------

export async function checkAuthority(): Promise<{ configured: boolean; outcome: string }> {
  const publicKey = LICENSE_PUBLIC_KEY_PEM
  if (!LICENSE_AUTHORITY_URL || !publicKey) return { configured: false, outcome: 'unconfigured' }
  const state = authorityStore.read()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await net.fetch(LICENSE_AUTHORITY_URL, { signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > 4 * 1024 * 1024) throw new Error('resposta grande demais')
    const { state: next, outcome } = acceptList(state, JSON.parse(text), publicKey, new Date())
    authorityStore.write(next)
    if (outcome !== 'accepted') log.warn('updater', `Autoridade de licenças: ${next.lastError}`)
    return { configured: true, outcome }
  } catch (error) {
    // Falha de rede não é revogação: só registra a tentativa.
    authorityStore.write({ ...state, lastAttempt: new Date().toISOString(), lastError: `Sem conexão com a autoridade: ${(error as Error).message}` })
    return { configured: true, outcome: 'unreachable' }
  }
}

export function authorityStatus() {
  const s = authorityStore.read()
  return {
    url: LICENSE_AUTHORITY_URL,
    configured: !!LICENSE_AUTHORITY_URL,
    lastSuccess: s.lastSuccess,
    lastAttempt: s.lastAttempt,
    lastError: s.lastError,
    revokedCount: s.revoked.length,
    graceDays: OFFLINE_GRACE_DAYS
  }
}

/** Exige ativação válida ou sessão do proprietário. Chamado pelos serviços protegidos. */
export async function requireAccess(): Promise<void> {
  const access = await getAccess()
  if (access.kind !== 'active' && access.kind !== 'owner') {
    throw new AppFailure('access-denied', 'Ative o JK Optimize para usar este recurso.')
  }
}

export function requireOwner(): KeyObject {
  if (!ownerSession) throw new AppFailure('owner-required', 'Operação restrita ao proprietário. Desbloqueie a sessão administrativa.')
  return ownerSession
}

function requirePublicKey(): string {
  if (!LICENSE_PUBLIC_KEY_PEM) {
    throw new AppFailure('unconfigured', 'O licenciamento ainda não foi configurado neste build. Execute "npm run owner:init".')
  }
  return LICENSE_PUBLIC_KEY_PEM
}

// ---------------------------------------------------------------------------
// Ativação por chave
// ---------------------------------------------------------------------------

export async function activate(rawKey: unknown): Promise<AccessState> {
  const publicKey = requirePublicKey()
  const token = normalizeToken(expectString(rawKey, 'chave', 4096, 1))
  const result = verifyLicense(token, publicKey, {
    machineId: await getMachineId(),
    revoked: revokedIds(),
    now: Date.now()
  })
  if (!result.ok) throw new AppFailure(`activation-${result.problem}`, ACTIVATION_PROBLEM_TEXT[result.problem])
  activationStore.write({ token, activatedAt: new Date().toISOString() })
  return getAccess()
}

export async function deactivate(): Promise<AccessState> {
  activationStore.write({ token: null, activatedAt: null })
  return getAccess()
}

// ---------------------------------------------------------------------------
// Sessão do proprietário
// ---------------------------------------------------------------------------

async function throttle(): Promise<void> {
  const delay = Math.min(failedUnlocks * 1000, 10_000)
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))
}

async function openOwnerKey(content: string, passphrase: string, publicKey: string): Promise<KeyObject> {
  await throttle()
  let key: KeyObject
  try {
    key = await decryptOwnerKey(content, passphrase)
  } catch (error) {
    failedUnlocks++
    if (error instanceof OwnerKeyError) {
      throw new AppFailure(`owner-${error.reason}`, error.message)
    }
    throw error
  }
  if (!privateKeyMatchesPublic(key, publicKey)) {
    failedUnlocks++
    throw new AppFailure('owner-key-mismatch', 'Esta chave do proprietário não corresponde a este build do aplicativo.')
  }
  failedUnlocks = 0
  return key
}

export async function importOwnerKey(rawPassphrase: unknown, window: BrowserWindow | null): Promise<AccessState> {
  const publicKey = requirePublicKey()
  const passphrase = expectString(rawPassphrase, 'senha', 1024, 1)
  const options = {
    title: 'Selecionar chave do proprietário',
    properties: ['openFile' as const],
    filters: [{ name: 'Chave do proprietário JK Optimize', extensions: ['jkokey'] }]
  }
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) {
    throw new AppFailure('cancelled', 'Nenhum arquivo selecionado.')
  }
  const file = picked.filePaths[0]
  if (statSync(file).size > 16 * 1024) throw new AppFailure('owner-malformed', 'Arquivo de chave inválido.')
  const content = readFileSync(file, 'utf8')
  ownerSession = await openOwnerKey(content, passphrase, publicKey)
  // Guarda uma cópia (continua cifrada) e lembra a sessão neste computador.
  writeFileAtomic(ownerKeyPath(), content)
  await rememberOwner(ownerSession)
  return getAccess()
}

export async function unlockOwner(rawPassphrase: unknown): Promise<AccessState> {
  const publicKey = requirePublicKey()
  const passphrase = expectString(rawPassphrase, 'senha', 1024, 1)
  if (!existsSync(ownerKeyPath())) throw new AppFailure('owner-missing', 'Nenhuma chave do proprietário instalada neste computador.')
  ownerSession = await openOwnerKey(readFileSync(ownerKeyPath(), 'utf8'), passphrase, publicKey)
  await rememberOwner(ownerSession)
  return getAccess()
}

export async function lockOwner(): Promise<AccessState> {
  ownerSession = null
  forgetOwner()
  return getAccess()
}

// ---------------------------------------------------------------------------
// Gerenciamento de chaves (somente proprietário)
// ---------------------------------------------------------------------------

export function listKeys(): IssuedKey[] {
  requireOwner()
  return keysStore.read().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function generateKey(rawInput: unknown): IssuedKey {
  const privateKey = requireOwner()
  const input = expectRecord(rawInput, 'chave', ['label', 'validDays', 'machineId']) as Partial<GenerateKeyInput>
  const label = expectString(input.label, 'Descrição', MAX_KEY_LABEL_LENGTH, 1).trim()
  if (!label) throw new ValidationError('Descrição: informe um nome para identificar a chave.')
  const validDays = input.validDays === null ? null : expectInteger(input.validDays, 'Validade (dias)', 1, MAX_VALID_DAYS)
  let machineId: string | null = null
  if (input.machineId !== null && input.machineId !== undefined) {
    machineId = expectString(input.machineId, 'ID do computador', 64).trim().toUpperCase()
    if (!MACHINE_ID_PATTERN.test(machineId)) throw new ValidationError('ID do computador: formato XXXXX-XXXXX-XXXXX-XXXXX.')
  }

  const keys = keysStore.read()
  let id = generateKeyId()
  while (keys.some((k) => k.id === id)) id = generateKeyId()
  const now = Date.now()
  const exp = validDays === null ? null : now + validDays * DAY_MS
  const issued: IssuedKey = {
    id,
    label,
    token: signLicense({ v: 1, id, iat: now, exp, mid: machineId }, privateKey),
    createdAt: new Date(now).toISOString(),
    expiresAt: exp === null ? null : new Date(exp).toISOString(),
    machineId,
    status: 'active',
    revokedAt: null
  }
  keysStore.write([issued, ...keys])
  return issued
}

export function revokeKey(rawId: unknown): IssuedKey {
  requireOwner()
  const id = expectString(rawId, 'id', 64, 1)
  const keys = keysStore.read()
  const key = keys.find((k) => k.id === id)
  if (!key) throw new AppFailure('key-not-found', 'Chave não encontrada.')
  if (key.status !== 'revoked') {
    key.status = 'revoked'
    key.revokedAt = new Date().toISOString()
    keysStore.write(keys)
  }
  return key
}

/** Gera a lista de revogação ASSINADA (jk-revocations.json) para publicar no endereço da autoridade. */
export async function exportRevocations(window: BrowserWindow | null): Promise<{ path: string | null; count: number }> {
  const key = requireOwner()
  const ids = [...revokedIds()].sort()
  const now = new Date()
  const list = signRevocationList({ format: 'jk-optimize-revocations', version: 1, sequence: now.getTime(), issuedAt: now.toISOString(), revoked: ids }, key)
  const options = { title: 'Salvar lista de revogação assinada', defaultPath: 'jk-revocations.json', filters: [{ name: 'JSON', extensions: ['json'] }] }
  const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { path: null, count: ids.length }
  writeFileAtomic(picked.filePath, JSON.stringify(list, null, 2) + '\n')
  log.info('updater', `Lista de revogação assinada gerada com ${ids.length} chave(s).`)
  return { path: picked.filePath, count: ids.length }
}
