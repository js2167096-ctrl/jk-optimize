// Cálculo de espaço, recuperação de arquivos, caminhos inválidos, links/junctions e cancelamento.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { categorize, deleteFilesSafely, isInside, scanFiles } from '../src/main/modules/fsutil'

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'jko-fs-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
  mkdirSync(outside)
  const old = new Date(Date.now() - 3 * 86_400_000)
  const files = { a: join(root, 'a.tmp'), b: join(root, 'sub', 'b.log'), c: join(root, 'sub', 'deep', 'c.bin'), secret: join(outside, 'precioso.txt') }
  writeFileSync(files.a, 'x'.repeat(100))
  writeFileSync(files.b, 'y'.repeat(200))
  writeFileSync(files.c, 'z'.repeat(300))
  writeFileSync(files.secret, 'não apagar')
  for (const f of Object.values(files)) utimesSync(f, old, old)
  return { base, root, outside, files }
}

test('isInside respeita a raiz e não confunde prefixos', () => {
  assert.equal(isInside('C:\\Temp', 'C:\\Temp\\a.txt'), true)
  assert.equal(isInside('C:\\Temp', 'c:\\temp\\SUB\\b'), true)
  assert.equal(isInside('C:\\Temp', 'C:\\Temp'), true)
  assert.equal(isInside('C:\\Temp', 'C:\\Temp2\\a.txt'), false)
  assert.equal(isInside('C:\\Temp', 'C:\\Temp\\..\\Windows\\x'), false)
})

test('varredura soma tamanhos reais e ignora junctions e arquivos recentes', async () => {
  const { root, outside } = sandbox()
  symlinkSync(outside, join(root, 'atalho-junction'), 'junction')
  writeFileSync(join(root, 'recente.tmp'), 'novo')
  const scan = await scanFiles(root, { maxEntries: 1000, maxMs: 10_000, minAgeMs: 86_400_000 })
  assert.equal(scan.files.length, 3)
  assert.equal(scan.totalBytes, 600)
  assert.equal(scan.skippedLinks, 1)
  assert.equal(scan.skippedRecent, 1)
  assert.equal(scan.reason, 'complete')
  assert.ok(!scan.files.some((f) => f.path.includes('precioso')))
})

test('limite de entradas produz resultado parcial', async () => {
  const { root } = sandbox()
  const scan = await scanFiles(root, { maxEntries: 1, maxMs: 10_000 })
  assert.equal(scan.partial, true)
  assert.equal(scan.reason, 'entry-limit')
})

test('cancelamento interrompe a varredura', async () => {
  const { root } = sandbox()
  const controller = new AbortController()
  controller.abort()
  const scan = await scanFiles(root, { maxEntries: 1000, maxMs: 10_000, signal: controller.signal })
  assert.equal(scan.reason, 'cancelled')
})

test('exclusão segura: apaga só dentro da raiz, recupera bytes e remove pastas vazias', async () => {
  const { root, files } = sandbox()
  const scan = await scanFiles(root, { maxEntries: 1000, maxMs: 10_000 })
  const forged = [...scan.files, { path: files.secret, size: 10, mtimeMs: 0 }]
  const report = await deleteFilesSafely(forged, [root])
  assert.equal(report.deleted, 3)
  assert.equal(report.bytesFreed, 600)
  assert.equal(report.skippedOutside, 1)
  assert.ok(existsSync(files.secret), 'arquivo fora da raiz não pode ser apagado')
  assert.ok(existsSync(root), 'a raiz nunca é removida')
  assert.ok(!existsSync(join(root, 'sub')), 'pastas que ficaram vazias são removidas')
})

test('exclusão segura: caminho que passa por junction para fora da raiz é recusado', async () => {
  const { root, outside, files } = sandbox()
  symlinkSync(outside, join(root, 'ponte'), 'junction')
  const viaJunction = { path: join(root, 'ponte', 'precioso.txt'), size: 10, mtimeMs: 0 }
  const report = await deleteFilesSafely([viaJunction], [root])
  assert.equal(report.deleted, 0)
  assert.ok(existsSync(files.secret))
})

test('exclusão segura: arquivo inexistente conta como alterado, sem erro', async () => {
  const { root } = sandbox()
  const report = await deleteFilesSafely([{ path: join(root, 'nao-existe.tmp'), size: 1, mtimeMs: 0 }], [root])
  assert.equal(report.deleted, 0)
  assert.equal(report.skippedChanged, 1)
  assert.equal(report.errors.length, 0)
})

test('exclusão segura respeita idade mínima no momento de apagar', async () => {
  const { root } = sandbox()
  const fresh = join(root, 'agora.tmp')
  writeFileSync(fresh, 'acabou de ser escrito')
  const report = await deleteFilesSafely([{ path: fresh, size: 21, mtimeMs: 0 }], [root], { minAgeMs: 3_600_000 })
  assert.equal(report.deleted, 0)
  assert.ok(existsSync(fresh))
})

test('categorias do analisador', () => {
  assert.equal(categorize('C:\\x\\filme.MKV'), 'Vídeos')
  assert.equal(categorize('C:\\x\\setup.exe'), 'Instaladores e executáveis')
  assert.equal(categorize('C:\\x\\update.rpf'), 'Jogos e pacotes')
  assert.equal(categorize('C:\\x\\sem-extensao'), 'Outros')
})
