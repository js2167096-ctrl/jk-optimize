// Arquivo da chave privada do proprietário, cifrado com senha.
// Derivação scrypt + AES-256-GCM. A chave nunca é gravada em texto puro.
// Sem dependência do Electron: usado pelo app e pelo script owner:init.
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, scrypt, type KeyObject } from 'node:crypto'

const FORMAT = 'jk-optimize-owner-key'
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 }
const MAX_SCRYPT_N = 2 ** 20
const MAX_MEM = 512 * 1024 * 1024

export class OwnerKeyError extends Error {
  readonly reason: 'malformed' | 'wrong-passphrase'
  constructor(reason: 'malformed' | 'wrong-passphrase') {
    super(reason === 'malformed' ? 'Arquivo de chave inválido.' : 'Senha incorreta.')
    this.reason = reason
  }
}

interface OwnerKeyFile {
  format: typeof FORMAT
  v: 1
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string }
  data: string
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFKC'), salt, 32, { N, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  })
}

export async function encryptOwnerKey(privateKey: KeyObject, passphrase: string): Promise<string> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p)
  const plain = privateKey.export({ type: 'pkcs8', format: 'der' })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const file: OwnerKeyFile = {
    format: FORMAT,
    v: 1,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64')
  }
  return JSON.stringify(file, null, 2)
}

export async function decryptOwnerKey(content: string, passphrase: string): Promise<KeyObject> {
  const file = parseFile(content)
  const { N, r, p } = file.kdf
  const key = await deriveKey(passphrase, Buffer.from(file.kdf.salt, 'base64'), N, r, p)
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'))
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()])
  } catch {
    throw new OwnerKeyError('wrong-passphrase')
  }
  try {
    const privateKey = createPrivateKey({ key: plain, format: 'der', type: 'pkcs8' })
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('tipo de chave inesperado')
    return privateKey
  } catch {
    throw new OwnerKeyError('malformed')
  } finally {
    plain.fill(0)
  }
}

function parseFile(content: string): OwnerKeyFile {
  if (content.length > 16 * 1024) throw new OwnerKeyError('malformed')
  let f: OwnerKeyFile
  try {
    f = JSON.parse(content) as OwnerKeyFile
  } catch {
    throw new OwnerKeyError('malformed')
  }
  const isB64 = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9+/=]+$/.test(s)
  const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
  const ok =
    f?.format === FORMAT &&
    f.v === 1 &&
    f.kdf?.name === 'scrypt' &&
    isInt(f.kdf.N) &&
    f.kdf.N <= MAX_SCRYPT_N &&
    (f.kdf.N & (f.kdf.N - 1)) === 0 &&
    isInt(f.kdf.r) &&
    f.kdf.r <= 16 &&
    isInt(f.kdf.p) &&
    f.kdf.p <= 4 &&
    isB64(f.kdf.salt) &&
    f.cipher?.name === 'aes-256-gcm' &&
    isB64(f.cipher.iv) &&
    isB64(f.cipher.tag) &&
    isB64(f.data)
  if (!ok) throw new OwnerKeyError('malformed')
  return f
}
