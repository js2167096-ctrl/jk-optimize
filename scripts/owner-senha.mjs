// Troca a senha do arquivo da chave do proprietário (owner-keys/owner-key.jkokey).
// A chave em si não muda: chaves já emitidas continuam válidas.
//
// Uso: definir JKO_OLD_PASSPHRASE e JKO_NEW_PASSPHRASE e rodar `npm run owner:senha`.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decryptOwnerKey, encryptOwnerKey } from '../src/main/security/owner-key-file.ts'

const MIN_LENGTH = 3
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keyFile = join(root, 'owner-keys', 'owner-key.jkokey')

const oldPass = process.env.JKO_OLD_PASSPHRASE
const newPass = process.env.JKO_NEW_PASSPHRASE
if (!oldPass || !newPass) {
  console.error('Defina JKO_OLD_PASSPHRASE e JKO_NEW_PASSPHRASE.')
  process.exit(1)
}
if (newPass.length < MIN_LENGTH) {
  console.error(`A nova senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`)
  process.exit(1)
}

try {
  const key = await decryptOwnerKey(readFileSync(keyFile, 'utf8'), oldPass)
  writeFileSync(keyFile, await encryptOwnerKey(key, newPass), { encoding: 'utf8', mode: 0o600 })
  console.log(`Senha da chave do proprietário alterada: ${keyFile}`)
} catch (error) {
  console.error(`Erro: ${error.message}`)
  process.exit(1)
}
