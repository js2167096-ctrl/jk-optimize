// Executa todos os testes automatizados:
//  1) scripts/license.test.mjs (Node puro, com remoção de tipos nativa);
//  2) tests/*.test.ts, empacotados com esbuild (aliases do projeto + substituto do Electron).
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.test-build')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const tests = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.ts'))
await build({
  entryPoints: tests.map((f) => join(root, 'tests', f)),
  outdir: outDir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  logLevel: 'warning',
  alias: {
    electron: join(root, 'tests', 'electron-stub.ts'),
    '@shared': join(root, 'src', 'shared')
  }
})

const files = readdirSync(outDir).filter((f) => f.endsWith('.cjs')).map((f) => join(outDir, f))
const node = process.execPath
const args = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-concurrency=1', join(root, 'scripts', 'license.test.mjs'), ...files]
const result = spawnSync(node, args, { stdio: 'inherit', cwd: root })
rmSync(outDir, { recursive: true, force: true })
process.exit(result.status ?? 1)
