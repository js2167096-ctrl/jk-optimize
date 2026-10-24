// Instala a chave do proprietário no JK Optimize deste computador (%APPDATA%\JK Optimize),
// para não precisar selecionar o arquivo dentro do app. Na próxima abertura o app
// pede a senha uma vez e, a partir daí, abre direto.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'owner-keys', 'owner-key.jkokey')
const targetDir = join(process.env.APPDATA ?? '', 'JK Optimize', 'jk-data', 'owner')

if (!existsSync(source)) {
  console.error(`Chave não encontrada: ${source}. Rode "npm run owner:init" primeiro.`)
  process.exit(1)
}
mkdirSync(targetDir, { recursive: true })
copyFileSync(source, join(targetDir, 'owner-key.jkokey'))
// Uma sessão lembrada antiga pode ser de outra chave; o app pede a senha de novo.
rmSync(join(targetDir, 'owner-session.bin'), { force: true })
console.log(`Chave do proprietário instalada em ${targetDir}`)
