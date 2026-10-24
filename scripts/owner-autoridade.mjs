// Configura o endereço HTTPS da lista de revogação assinada (autoridade de licenças).
// Uso: npm run owner:autoridade -- https://exemplo.com/jk-revocations.json
//      npm run owner:autoridade -- remover
// Depois, gere um novo build/instalador para que os clientes passem a consultar o endereço.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'src', 'main', 'security', 'license-authority-config.ts')
const arg = process.argv[2]
if (!arg) {
  console.error('Informe a URL HTTPS do jk-revocations.json ou "remover".')
  process.exit(1)
}
let value = 'null'
if (arg !== 'remover') {
  let url
  try {
    url = new URL(arg)
  } catch {
    console.error('URL inválida.')
    process.exit(1)
  }
  if (url.protocol !== 'https:') {
    console.error('Use um endereço HTTPS.')
    process.exit(1)
  }
  value = JSON.stringify(url.href)
}
writeFileSync(
  target,
  [
    '// Gerado por `npm run owner:autoridade -- <URL>`. Não edite manualmente.',
    '// Endereço HTTPS da lista de revogação assinada (jk-revocations.json); null = sem autoridade online.',
    `export const LICENSE_AUTHORITY_URL: string | null = ${value}`,
    ''
  ].join('\n'),
  'utf8'
)
console.log(value === 'null' ? 'Autoridade online removida.' : `Autoridade configurada: ${value}. Gere um novo instalador para valer nos clientes.`)
