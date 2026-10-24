// Cria a identidade do proprietário do JK Optimize:
//   - par de chaves Ed25519;
//   - chave privada cifrada com senha em owner-keys/owner-key.jkokey (NÃO distribuir);
//   - chave pública gravada em src/main/security/license-public-key.ts (vai no build).
//
// Uso: npm run owner:init            (pede a senha no terminal)
//      npm run owner:init -- --force (substitui uma identidade existente)
// Senha também pode vir de JKO_OWNER_PASSPHRASE (útil em automação).
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { encryptOwnerKey } from '../src/main/security/owner-key-file.ts'

const MIN_LENGTH = 3
const RECOMMENDED_LENGTH = 12
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keyFile = join(root, 'owner-keys', 'owner-key.jkokey')
const publicKeyFile = join(root, 'src', 'main', 'security', 'license-public-key.ts')

function askHidden(question) {
  return new Promise((resolvePromise) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl.stdoutMuted = false
    rl._writeToOutput = (text) => {
      if (!rl.stdoutMuted) rl.output.write(text)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolvePromise(answer)
    })
    rl.stdoutMuted = true
  })
}

async function readPassphrase() {
  if (process.env.JKO_OWNER_PASSPHRASE) return process.env.JKO_OWNER_PASSPHRASE
  const first = await askHidden(`Defina a senha da chave do proprietário (mínimo ${MIN_LENGTH}, recomendado ${RECOMMENDED_LENGTH}+ caracteres): `)
  const second = await askHidden('Repita a senha: ')
  if (first !== second) throw new Error('As senhas não coincidem.')
  return first
}

async function main() {
  if (existsSync(keyFile) && !process.argv.includes('--force')) {
    console.error(`Já existe uma chave do proprietário em ${keyFile}.`)
    console.error('Substituí-la invalida TODAS as chaves já emitidas. Use --force se tiver certeza.')
    process.exit(1)
  }

  const passphrase = await readPassphrase()
  if (passphrase.length < MIN_LENGTH) throw new Error(`A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`)
  if (passphrase.length < RECOMMENDED_LENGTH) {
    console.warn(`Aviso: senha curta. Recomendado: ${RECOMMENDED_LENGTH}+ caracteres. Guarde o arquivo .jkokey em local protegido.`)
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const encrypted = await encryptOwnerKey(privateKey, passphrase)

  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, encrypted, { encoding: 'utf8', mode: 0o600 })

  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
  writeFileSync(
    publicKeyFile,
    [
      '// Gerado por `npm run owner:init`. Não edite manualmente.',
      '// Contém apenas a chave PÚBLICA: serve para verificar chaves, nunca para emiti-las.',
      `export const LICENSE_PUBLIC_KEY_PEM: string | null = \`${pem}\``,
      ''
    ].join('\n'),
    'utf8'
  )

  console.log('\nIdentidade do proprietário criada.')
  console.log(`  Chave privada (cifrada): ${keyFile}`)
  console.log(`  Chave pública:           ${publicKeyFile}`)
  console.log('\nPróximos passos:')
  console.log('  1. Faça um backup do arquivo .jkokey e guarde a senha. Sem eles não é possível emitir chaves.')
  console.log('  2. Execute "npm run dev" e escolha "Sou o proprietário" para importar o arquivo.')
}

main().catch((error) => {
  console.error(`Erro: ${error.message}`)
  process.exit(1)
})
