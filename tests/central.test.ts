// Central de Otimização: regras de GPU, perfis de serviços, tarefas, recursos, afinidade, catálogo de aplicativos
// e limpeza de temporários em uma pasta de teste real (nunca em %TEMP% do usuário).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { compareProfile, featureProtection, gpuKind, gpuVendor, taskProtection, validAffinityMask } from '../src/main/modules/central-rules'
import { deleteFilesSafely, mergeScans, scanFiles, userTempPaths } from '../src/main/modules/fsutil'
import { APP_CATALOG, APP_CATEGORIES, searchApps } from '../src/shared/constants/apps-catalog'
import { listActions } from '../src/main/ops/registry'
import '../src/main/modules'

// --------------------------------------------------------------------------- GPU

test('GPU: fabricante pelo identificador PCI, com o nome como reserva', () => {
  assert.equal(gpuVendor('PCI\\VEN_10DE&DEV_2504', 'NVIDIA GeForce RTX 3060', 'NVIDIA'), 'nvidia')
  assert.equal(gpuVendor('PCI\\VEN_1002&DEV_73BF', 'AMD Radeon RX 6800 XT', 'Advanced Micro Devices'), 'amd')
  assert.equal(gpuVendor('PCI\\VEN_8086&DEV_9A49', 'Intel(R) Iris(R) Xe Graphics', 'Intel Corporation'), 'intel')
  assert.equal(gpuVendor('ROOT\\BASICDISPLAY', 'Microsoft Basic Display Adapter', 'Microsoft'), 'microsoft')
  assert.equal(gpuVendor(null, 'Radeon RX 580', null), 'amd')
  assert.equal(gpuVendor(null, 'Placa Desconhecida', null), 'other')
})

test('GPU: integrada x dedicada sem depender de modelo fixo', () => {
  assert.equal(gpuKind('nvidia', 'NVIDIA GeForce GTX 1650').kind, 'dedicated')
  assert.equal(gpuKind('intel', 'Intel(R) UHD Graphics 630').kind, 'integrated')
  assert.equal(gpuKind('intel', 'Intel(R) Arc(TM) A750 Graphics').kind, 'dedicated')
  assert.equal(gpuKind('amd', 'AMD Radeon(TM) Graphics').kind, 'integrated')
  assert.equal(gpuKind('amd', 'AMD Radeon RX 6600').kind, 'dedicated')
  assert.equal(gpuKind('microsoft', 'Microsoft Basic Display Adapter').kind, 'unknown')
})

// --------------------------------------------------------------------------- Serviços

const local = [
  { name: 'Spooler', startMode: 'Auto', delayed: false, modifiable: true, protectedReason: null },
  { name: 'WinDefend', startMode: 'Auto', delayed: false, modifiable: false, protectedReason: 'Segurança' },
  { name: 'Fax', startMode: 'Manual', delayed: false, modifiable: true, protectedReason: null }
]

test('perfil de serviços: compara com o computador local e ignora o que não existe', () => {
  const r = compareProfile(
    [
      { name: 'Spooler', mode: 'Manual' },
      { name: 'Fax', mode: 'Manual' },
      { name: 'WinDefend', mode: 'Disabled' },
      { name: 'ServicoSoNoOutroPC', mode: 'Disabled' }
    ],
    local
  )
  assert.deepEqual(
    r.map((x) => [x.name, x.status]),
    [['Spooler', 'differs'], ['Fax', 'same'], ['WinDefend', 'protected'], ['ServicoSoNoOutroPC', 'missing']]
  )
  assert.equal(r[0].current, 'Automatic')
})

test('tarefas e recursos: itens do próprio Windows e de segurança ficam bloqueados', () => {
  assert.ok(taskProtection('\\Microsoft\\Windows\\Defrag\\', 'ScheduledDefrag'))
  assert.equal(taskProtection('\\', 'MinhaTarefa'), null)
  assert.equal(taskProtection('\\Vendor\\', 'Atualizador'), null)
  assert.ok(featureProtection('Windows-Defender-Default-Definitions'))
  assert.equal(featureProtection('Microsoft-Hyper-V-All'), null)
})

test('afinidade: máscara precisa ter ao menos um núcleo e só núcleos existentes', () => {
  assert.equal(validAffinityMask(0, 8), false)
  assert.equal(validAffinityMask(1, 8), true)
  assert.equal(validAffinityMask(255, 8), true)
  assert.equal(validAffinityMask(256, 8), false)
  assert.equal(validAffinityMask(1.5, 8), false)
})

// --------------------------------------------------------------------------- Catálogo de aplicativos

test('catálogo: apps exigidos, https, ids únicos e descrição no formato esperado', () => {
  const names = APP_CATALOG.map((a) => a.name)
  for (const required of ['Google Chrome', 'Mozilla Firefox', 'Brave', '7-Zip', 'WinRAR', 'Steam', 'Epic Games Launcher', 'Discord', 'WhatsApp', 'Microsoft PowerToys']) assert.ok(names.includes(required), `falta ${required}`)
  assert.equal(new Set(APP_CATALOG.map((a) => a.id)).size, APP_CATALOG.length)
  for (const a of APP_CATALOG) {
    const u = new URL(a.url)
    assert.equal(u.protocol, 'https:', a.name)
    assert.ok(a.description.length >= 80 && a.description.length <= 260, `${a.name}: descrição com ${a.description.length} caracteres`)
    assert.ok(APP_CATEGORIES.includes(a.category))
  }
  assert.ok(APP_CATALOG.some((a) => a.category === 'Drivers e hardware'))
})

// --------------------------------------------------------------------------- Registro de operações

test('as novas operações estão registradas com o risco e a elevação esperados', async () => {
  const actions = listActions()
  const byId = new Map(actions.map((a) => [a.id, a]))
  for (const id of ['services.control', 'services.batch', 'tasks.toggle', 'features.toggle', 'cleanup.recycle.empty', 'processes.affinity']) assert.ok(byId.has(id), `ação ${id} ausente`)
  assert.equal(byId.get('services.control')!.requiresElevation, true)
  assert.equal(byId.get('services.batch')!.reversible, true)
  assert.equal(byId.get('cleanup.recycle.empty')!.reversible, false)
  assert.notEqual(byId.get('cleanup.recycle.empty')!.risk, 'none')
})

// --------------------------------------------------------------------------- Limpeza de temporários

test('%TEMP%, %TMP% e %LOCALAPPDATA%\\Temp: resolve, ignora vazios e inexistentes e não repete pastas', () => {
  const exists = (p: string) => !p.includes('inexistente')
  const same = userTempPaths({ TEMP: 'C:\\Users\\a\\AppData\\Local\\Temp', TMP: 'c:\\users\\a\\appdata\\local\\temp\\', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a\\AppData\\Local\\Temp', exists)
  assert.equal(same.length, 1)
  const different = userTempPaths({ TEMP: 'D:\\Temp', TMP: '', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'D:\\Temp', exists)
  assert.equal(different.length, 2)
  assert.deepEqual(userTempPaths({ TEMP: 'X:\\inexistente', TMP: undefined }, 'X:\\inexistente', exists), [])
})

function sandbox() {
  const dir = mkdtempSync(join(os.tmpdir(), 'jko-limpeza-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}
const age = (path: string, hours: number) => {
  const t = new Date(Date.now() - hours * 3_600_000)
  utimesSync(path, t, t)
}

test('limpeza real: remove só o elegível, conta bytes exatos e mantém recentes e pastas fora da raiz', async () => {
  const { dir, done } = sandbox()
  try {
    const root = join(dir, 'Temp')
    const outside = join(dir, 'Documentos')
    mkdirSync(join(root, 'sub'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(root, 'velho.tmp'), 'a'.repeat(1000))
    writeFileSync(join(root, 'sub', 'velho2.tmp'), 'b'.repeat(500))
    writeFileSync(join(root, 'recente.tmp'), 'c'.repeat(200))
    writeFileSync(join(outside, 'importante.txt'), 'não apagar')
    age(join(root, 'velho.tmp'), 48)
    age(join(root, 'sub', 'velho2.tmp'), 48)

    const scan = await scanFiles(root, { maxEntries: 1000, maxMs: 5000, minAgeMs: 24 * 3_600_000 })
    assert.equal(scan.files.length, 2)
    assert.equal(scan.totalBytes, 1500)
    assert.equal(scan.skippedRecent, 1)

    // Um arquivo da lista fora da raiz autorizada nunca é apagado.
    const hostile = [...scan.files, { path: join(outside, 'importante.txt'), size: 10, mtimeMs: 0 }]
    const report = await deleteFilesSafely(hostile, [root], { minAgeMs: 24 * 3_600_000 })
    assert.equal(report.deleted, 2)
    assert.equal(report.bytesFreed, 1500)
    assert.equal(report.skippedOutside, 1)
    assert.ok(existsSync(join(outside, 'importante.txt')))
    assert.ok(existsSync(join(root, 'recente.tmp')))
    assert.ok(!existsSync(join(root, 'velho.tmp')))
    assert.ok(!existsSync(join(root, 'sub')), 'pasta que ficou vazia é removida')
    assert.ok(existsSync(root), 'a raiz nunca é removida')
  } finally {
    done()
  }
})

test('limpeza real: arquivo bloqueado ou inexistente não interrompe o restante', async () => {
  const { dir, done } = sandbox()
  try {
    writeFileSync(join(dir, 'a.tmp'), 'x'.repeat(10))
    writeFileSync(join(dir, 'b.tmp'), 'y'.repeat(20))
    const scan = await scanFiles(dir, { maxEntries: 100, maxMs: 5000 })
    // Apaga um antes da limpeza: simula arquivo removido por outro programa no meio do processo.
    rmSync(join(dir, 'a.tmp'))
    const report = await deleteFilesSafely(scan.files, [dir])
    assert.equal(report.deleted, 1)
    assert.equal(report.bytesFreed, 20)
    assert.equal(report.skippedChanged, 1)
    assert.equal(statSync(dir).isDirectory(), true)
  } finally {
    done()
  }
})

test('limpeza real: caminho inexistente é tratado sem exceção e junção de varreduras soma os totais', async () => {
  const empty = await scanFiles(join(os.tmpdir(), 'jko-nao-existe-123456'), { maxEntries: 10, maxMs: 1000 })
  assert.equal(empty.files.length, 0)
  const m = mergeScans([
    { files: [{ path: 'a', size: 1, mtimeMs: 0 }], totalBytes: 1, visited: 2, skippedRecent: 1, skippedLinks: 0, inaccessible: [], partial: false, reason: 'complete' },
    { files: [{ path: 'b', size: 4, mtimeMs: 0 }], totalBytes: 4, visited: 3, skippedRecent: 0, skippedLinks: 1, inaccessible: ['x'], partial: true, reason: 'time-limit' }
  ])
  assert.equal(m.totalBytes, 5)
  assert.equal(m.files.length, 2)
  assert.equal(m.partial, true)
  assert.equal(m.reason, 'time-limit')
})

test('catálogo ampliado: 30 aplicativos sem duplicação, os 20 originais preservados e pesquisa tolerante a acentos', () => {
  const originais = ['chrome', 'firefox', 'brave', '7zip', 'winrar', 'steam', 'epic', 'discord', 'whatsapp', 'powertoys', 'acrobat', 'sumatra', 'vlc', 'notepadpp', 'obs', 'nvidia-driver', 'amd-driver', 'intel-driver', 'hwinfo', 'cpuz']
  const ids = APP_CATALOG.map((a) => a.id)
  for (const id of originais) assert.ok(ids.includes(id), 'perdeu ' + id)
  assert.equal(APP_CATALOG.length, 30)
  const chave = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  assert.equal(new Set(APP_CATALOG.map((a) => chave(a.name))).size, APP_CATALOG.length, 'nomes repetidos')
  assert.equal(new Set(APP_CATALOG.map((a) => new URL(a.url).href.replace(/\/$/, ''))).size, APP_CATALOG.length, 'links repetidos')
  for (const c of APP_CATEGORIES) assert.ok(APP_CATALOG.some((a) => a.category === c), 'categoria vazia: ' + c)
  const nomes = (q: string) => searchApps(q).map((a) => a.id)
  assert.deepEqual(nomes('Claude'), ['claude'])
  assert.ok(['canva', 'pinterest'].every((id) => nomes('design').includes(id)))
  assert.ok(nomes('IA').includes('claude'))
  assert.ok(['vlc', 'obs'].every((id) => nomes('video').includes(id)) && nomes('vídeo').includes('vlc'))
  assert.ok(['nvidia-driver', 'amd-driver', 'intel-driver', 'nvidia-app'].every((id) => nomes('driver').includes(id)))
  assert.deepEqual(nomes('zzzz-nada'), [])
  assert.equal(nomes('  ').length, 30)
})
