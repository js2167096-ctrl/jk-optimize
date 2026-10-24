// Otimização para Jogos: catálogo, detecção (fontes combinadas, sem duplicar, FiveM × GTA V, emuladores), perfis e capas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GAME_CATALOG, gameById, graphicsFor, tweaksForLevel, LEVEL_TWEAKS } from '../src/shared/constants/games-catalog'
import { findExe, loadCover, matchCatalog, processRole, setManualPath, type ScanData } from '../src/main/modules/gamedetect'
import { emulatorRecommendation, resolveTweakChanges } from '../src/main/modules/gameprofiles'
import { describe as describeTweaks, TWEAKS, type Snapshot } from '../src/main/modules/tweaks'

const REQUIRED = [
  'MSI App Player', 'BlueStacks', 'LDPlayer', 'GameLoop', 'MEmu Play', 'Free Fire', 'FiveM', 'Grand Theft Auto V', 'Counter-Strike 2', 'Valorant', 'League of Legends', 'Fortnite', 'Minecraft', 'Roblox', 'Apex Legends',
  'PUBG: Battlegrounds', 'Overwatch 2', 'Rainbow Six Siege', 'Rocket League', 'EA SPORTS FC', 'Red Dead Redemption 2', 'God of War', 'God of War Ragnarök', 'Cyberpunk 2077', 'Forza Horizon 5', 'Elden Ring', 'Hogwarts Legacy', 'The Witcher 3',
  'Resident Evil 4', "Marvel's Spider-Man Remastered", "Marvel's Spider-Man: Miles Morales"
]

const emptyScan = (over: Partial<ScanData> = {}): ScanData => ({ uninstall: [], steam: [], epic: [], riot: [], dirs: [], procs: [], failed: [], ...over })
const detect = (scan: ScanData | null, extra: Partial<Parameters<typeof matchCatalog>[1]> = {}) =>
  new Map(matchCatalog(GAME_CATALOG, { scan, exists: () => true, findExeIn: () => null, ...extra }).map((d) => [d.id, d]))

test('catálogo: todos os itens pedidos, ids e nomes únicos, dados coerentes', () => {
  const names = GAME_CATALOG.map((g) => g.name)
  for (const n of REQUIRED) assert.ok(names.includes(n), `falta ${n}`)
  assert.equal(new Set(GAME_CATALOG.map((g) => g.id)).size, GAME_CATALOG.length)
  assert.equal(new Set(names).size, names.length)
  for (const g of GAME_CATALOG) {
    assert.match(g.accent, /^#[0-9a-f]{6}$/i, g.id)
    if (!g.viaEmulator) assert.ok(g.exes.length > 0, `${g.id}: sem executáveis`)
    for (const e of g.exes) assert.match(e, /^[\w .-]+\.exe$/i, `${g.id}: ${e}`)
    for (const id of g.steamAppIds ?? []) assert.ok(Number.isInteger(id) && id > 0)
    for (const p of [...(g.uninstall ?? []), ...(g.epic ?? []), g.pathHint ?? '', g.steamName ?? '']) assert.doesNotThrow(() => new RegExp(p, 'i'), `${g.id}: ${p}`)
  }
  assert.equal(gameById('free-fire')!.viaEmulator, true)
})

test('detecção: Steam por appid, executável confirmado e sem duplicar o jogo', () => {
  const scan = emptyScan({
    steam: [{ appid: 730, name: 'Counter-Strike 2', path: 'D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive', exists: true }],
    uninstall: [{ name: 'Grand Theft Auto V', version: '1.0', loc: 'C:\\Games\\GTAV' }],
    epic: [{ app: 'x', name: 'Grand Theft Auto V', loc: 'E:\\Epic\\GTAV' }]
  })
  const d = detect(scan, { findExeIn: (dir, exes) => (/Counter-Strike/.test(dir) && exes.includes('cs2.exe') ? `${dir}\\game\\bin\\win64\\cs2.exe` : null), gta: { dir: 'C:\\Games\\GTAV', source: 'GTA V: Rockstar Games Launcher' } })
  const cs = d.get('cs2')!
  assert.equal(cs.state, 'installed')
  assert.equal(cs.confidence, 'alta')
  assert.ok(cs.exe?.endsWith('cs2.exe'))
  assert.match(cs.sources[0], /Steam/)
  const gta = d.get('gta5')!
  assert.equal(gta.state, 'installed')
  assert.ok(gta.sources.length >= 3, 'várias fontes viram UMA detecção: ' + gta.sources.join(' | '))
  assert.equal(new Set(gta.sources).size, gta.sources.length)
  assert.equal([...d.values()].filter((x) => x.id === 'gta5').length, 1)
})

test('detecção: "não detectado" ≠ "não foi possível verificar"', () => {
  assert.equal(detect(emptyScan()).get('cs2')!.state, 'not-detected')
  const partial = detect(emptyScan({ failed: ['uninstall'] })).get('cs2')!
  assert.equal(partial.state, 'unknown')
  assert.match(partial.note ?? '', /não é possível afirmar/)
  assert.equal(detect(null).get('cs2')!.state, 'unknown')
})

test('FiveM: cliente, processo do jogo e auxiliar são diferenciados; nome parecido não confirma', () => {
  const scan = emptyScan({
    procs: [
      { name: 'FiveM.exe', pid: 10, path: 'C:\\Users\\u\\AppData\\Local\\FiveM\\FiveM.exe' },
      { name: 'FiveM_b3258_GTAProcess.exe', pid: 11, path: 'C:\\Users\\u\\AppData\\Local\\FiveM\\FiveM.app\\x.exe' },
      { name: 'FiveM_ChromeBrowser.exe', pid: 12, path: null },
      { name: 'GTA5.exe', pid: 13, path: 'C:\\GTAV\\GTA5.exe' },
      { name: 'FiveMFake.exe', pid: 14, path: null },
      { name: 'cs2helper.exe', pid: 15, path: null }
    ]
  })
  const d = detect(scan, { fivem: { found: true, dir: 'C:\\Users\\u\\AppData\\Local\\FiveM', source: 'Pasta padrão do FiveM' } })
  const roles = d.get('fivem')!.running.map((r) => `${r.role}:${r.name}`)
  assert.deepEqual(roles, ['Cliente FiveM:FiveM.exe', 'Processo do jogo (FiveM):FiveM_b3258_GTAProcess.exe', 'Processo auxiliar do FiveM:FiveM_ChromeBrowser.exe'])
  assert.deepEqual(d.get('gta5')!.running.map((r) => r.name), ['GTA5.exe'])
  assert.equal(d.get('cs2')!.running.length, 0)
  assert.equal(processRole(gameById('fivem')!, 'FiveMFake.exe'), null)
})

test('emuladores: MSI App Player e BlueStacks usam o mesmo .exe e são separados pelo caminho', () => {
  const scan = emptyScan({ procs: [{ name: 'HD-Player.exe', pid: 7, path: 'C:\\Program Files\\BlueStacks_msi5\\HD-Player.exe' }, { name: 'HD-Player.exe', pid: 8, path: null }] })
  const d = detect(scan)
  assert.deepEqual(d.get('msi-app-player')!.running.map((r) => r.pid), [7])
  assert.equal(d.get('bluestacks')!.running.length, 0)
  const nxt = detect(emptyScan({ procs: [{ name: 'HD-Player.exe', pid: 9, path: 'C:\\Program Files\\BlueStacks_nxt\\HD-Player.exe' }] }))
  assert.deepEqual(nxt.get('bluestacks')!.running.map((r) => r.pid), [9])
  assert.equal(nxt.get('msi-app-player')!.running.length, 0)
})

test('Free Fire depende dos emuladores: sem emulador = não detectado; com emulador = depende, nunca "instalado"', () => {
  assert.equal(detect(emptyScan()).get('free-fire')!.state, 'not-detected')
  const d = detect(emptyScan({ uninstall: [{ name: 'LDPlayer 9', version: '9.0.60', loc: 'C:\\LDPlayer\\LDPlayer9' }] }))
  assert.equal(d.get('ldplayer')!.state, 'installed')
  assert.equal(d.get('ldplayer')!.version, '9.0.60')
  assert.equal(d.get('free-fire')!.state, 'unknown')
  assert.match(d.get('free-fire')!.sources[0], /LDPlayer/)
})

test('indício fraco (pasta de dados sem executável) vira instalação provável, e caminho manual vale', () => {
  const mc = detect(emptyScan({ dirs: [{ id: 'minecraft', dir: process.env.APPDATA ? `${process.env.APPDATA}\\.minecraft` : 'x', exe: null, exists: true }] }), { exists: () => false })
  if (process.env.APPDATA) {
    assert.equal(mc.get('minecraft')!.state, 'installed')
    assert.equal(mc.get('minecraft')!.confidence, 'média')
  }
  const man = detect(emptyScan(), { manual: { 'elden-ring': 'F:\\Jogos\\ELDEN RING' }, findExeIn: () => 'F:\\Jogos\\ELDEN RING\\Game\\eldenring.exe' }).get('elden-ring')!
  assert.equal(man.state, 'installed')
  assert.equal(man.sources[0], 'Caminho informado manualmente')
  assert.equal(man.confidence, 'alta')
})

test('findExe: até 2 níveis, nomes exatos e sem erro em pasta ilegível', () => {
  const root = mkdtempSync(join(tmpdir(), 'jko-gm-'))
  try {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'game.exe'), 'x')
    writeFileSync(join(root, 'a', 'b', 'c', 'deep.exe'), 'x')
    assert.equal(findExe(root, ['game.exe']), join(root, 'a', 'b', 'game.exe'))
    assert.equal(findExe(root, ['deep.exe']), null, 'terceiro nível não é varrido')
    assert.equal(findExe(root, ['gam.exe']), null, 'nome parecido não vale')
    assert.equal(findExe(join(root, 'nada'), ['game.exe']), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('caminho manual: só com executável conhecido do jogo', () => {
  const root = mkdtempSync(join(tmpdir(), 'jko-gm-'))
  try {
    assert.throws(() => setManualPath('cs2', root), /não contém nenhum executável/)
    mkdirSync(join(root, 'game', 'bin'), { recursive: true })
    writeFileSync(join(root, 'game', 'bin', 'cs2.exe'), 'x')
    const r = setManualPath('cs2', root)
    assert.equal(r.saved, true)
    assert.ok(r.exe.endsWith('cs2.exe'))
    assert.throws(() => setManualPath('jogo-que-nao-existe', root), /fora do catálogo/)
    assert.throws(() => setManualPath('cs2', join(root, 'inexistente')), /não existe/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Perfis
// ---------------------------------------------------------------------------

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
function snapshot(over: { reg?: Record<string, string | number | null>; battery?: boolean; build?: number } = {}): Snapshot {
  return {
    ctx: { build: over.build ?? 19045, hasBattery: over.battery ?? false, schemes: [{ guid: BALANCED, name: 'Equilibrado', active: true, ultimate: false }, { guid: HIGH, name: 'Alto desempenho', active: false, ultimate: false }] },
    reg: new Map(Object.entries(over.reg ?? {})),
    power: new Map(Object.entries({ procMin: 5, usbSuspend: 1, pcieAspm: 1 })),
    extra: { silentCleanup: 'Ready', cortana: true }
  }
}

test('perfis: cada nível inclui o anterior e só usa ajustes que existem com valores válidos', () => {
  const ids = new Set(TWEAKS.map((t) => t.id))
  const ctx = snapshot().ctx
  for (const level of ['basic', 'intermediate', 'promax'] as const) {
    for (const t of tweaksForLevel(level)) {
      assert.ok(ids.has(t.id), `${level}: ${t.id}`)
      if (!t.value.startsWith('@')) assert.ok(TWEAKS.find((x) => x.id === t.id)!.options(ctx).some((o) => o.value === t.value), `${level}: ${t.id}=${t.value}`)
    }
  }
  const b = tweaksForLevel('basic').map((t) => t.id)
  const i = tweaksForLevel('intermediate').map((t) => t.id)
  const p = tweaksForLevel('promax').map((t) => t.id)
  assert.ok(b.every((x) => i.includes(x)) && i.every((x) => p.includes(x)) && b.length < i.length && i.length < p.length)
  for (const level of Object.keys(LEVEL_TWEAKS) as (keyof typeof LEVEL_TWEAKS)[]) for (const t of LEVEL_TWEAKS[level]) assert.ok(t.why.length > 20, t.id)
  // Nenhum ajuste de segurança ou serviço essencial nos perfis.
  for (const t of tweaksForLevel('promax')) assert.doesNotMatch(t.id, /defender|firewall|update|smartscreen|uac|telemetry|diagTrack|indexing/i)
})

test('perfis: resolução contra o estado real (aplicar, já configurado, indisponível, notebook)', () => {
  const states = describeTweaks(snapshot(), {})
  const r = resolveTweakChanges('promax', states, false)
  assert.equal(r.changes.powerPlan, HIGH, 'Pro Max desktop: Alto desempenho (sem Ultimate criado)')
  assert.equal(r.changes.gameDvr, 'off')
  assert.equal(r.changes.procMin, '100')
  assert.equal(r.rows.find((x) => x.id === 'gameMode')!.status, 'already', 'Modo de Jogo ausente no registro = ligado')
  const laptop = resolveTweakChanges('promax', describeTweaks(snapshot({ battery: true }), {}), true)
  assert.equal(laptop.rows.find((x) => x.id === 'usbSuspend')!.status, 'skipped')
  assert.equal(laptop.rows.find((x) => x.id === 'pcieAspm')!.status, 'skipped')
  assert.equal(laptop.changes.powerPlan, HIGH, 'Pro Max também em notebook usa o plano de maior desempenho existente')
  assert.ok(laptop.rows.every((x) => !x.elevated), 'nenhum ajuste dos perfis exige administrador')
  const policy = resolveTweakChanges('basic', describeTweaks(snapshot({ reg: { 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR|AllowGameDVR': 0 } }), {}), false)
  assert.equal(policy.rows.find((x) => x.id === 'gameDvr')!.status, 'unavailable')
  assert.match(policy.rows.find((x) => x.id === 'gameDvr')!.reason ?? '', /política/)
  const done = resolveTweakChanges('basic', describeTweaks(snapshot({ reg: { 'HKCU:\\System\\GameConfigStore|GameDVR_Enabled': 0, 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR|AppCaptureEnabled': 0 } }), {}), false)
  assert.equal(done.rows.find((x) => x.id === 'gameDvr')!.status, 'already')
  assert.equal(done.changes.gameDvr, undefined, 'não reaplica o que já está configurado')
})

test('gráficos por nível e recomendação de emulador seguem o hardware', () => {
  assert.equal(graphicsFor('basic', true), null)
  assert.equal(graphicsFor('intermediate', true), 'balanced')
  assert.equal(graphicsFor('promax', true), 'performance')
  assert.equal(graphicsFor('promax', false), 'balanced')
  assert.deepEqual(emulatorRecommendation(4, 16), { cpus: 2, ramMB: 4096 })
  assert.deepEqual(emulatorRecommendation(16, 32), { cpus: 4, ramMB: 4096 })
  assert.deepEqual(emulatorRecommendation(4, 8), { cpus: 2, ramMB: 2048 })
  assert.deepEqual(emulatorRecommendation(2, 4), { cpus: 2, ramMB: 1536 })
})

// ---------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 1)])

test('capas: baixa só de endereço fixo, guarda em cache, trata falha e item sem capa', async () => {
  const id = 'pubg'
  const file = (await import('../src/main/services/store')).dataPath('game-covers')
  rmSync(join(file, `${id}.jpg`), { force: true })
  rmSync(join(file, `${id}.jpg.fail`), { force: true })
  let calls = 0
  const ok = async (url: string) => {
    calls++
    assert.match(url, /^https:\/\/cdn\.akamai\.steamstatic\.com\/steam\/apps\/578080\/header\.jpg$/)
    return { ok: true, status: 200, type: 'image/jpeg', bytes: jpeg }
  }
  const first = await loadCover(id, ok)
  assert.equal(first.source, 'steam')
  assert.match(first.dataUrl ?? '', /^data:image\/jpeg;base64,/)
  const second = await loadCover(id, ok)
  assert.equal(second.source, 'cache')
  assert.equal(calls, 1, 'segunda leitura vem do disco')
  rmSync(join(file, `${id}.jpg`), { force: true })
  const bad = await loadCover(id, async () => ({ ok: false, status: 404, type: 'text/html', bytes: Buffer.from('x') }))
  assert.equal(bad.dataUrl, null)
  assert.match(bad.reason ?? '', /404/)
  let again = 0
  const retry = await loadCover(id, async () => (again++, { ok: true, status: 200, type: 'image/jpeg', bytes: jpeg }))
  assert.equal(retry.dataUrl, null, 'falha recente: não insiste')
  assert.equal(again, 0)
  rmSync(join(file, `${id}.jpg.fail`), { force: true })
  const notImage = await loadCover(id, async () => ({ ok: true, status: 200, type: 'text/html', bytes: Buffer.from('<html>') }))
  assert.equal(notImage.dataUrl, null)
  rmSync(join(file, `${id}.jpg.fail`), { force: true })
  const none = await loadCover('fivem', ok)
  assert.equal(none.dataUrl, null)
  assert.equal(calls, 1)
})

test('perfis: o plano de energia nunca é rebaixado nem sobrescreve plano personalizado', () => {
  const ULT = '150e2ee8-fe46-4b91-a25b-f98157151549'
  const mk = (active: string, ultimate: boolean, battery = false) => {
    const s = snapshot({ battery })
    s.ctx.schemes = [{ guid: BALANCED, name: 'Equilibrado', active: active === BALANCED, ultimate: false }, { guid: HIGH, name: 'Alto desempenho', active: active === HIGH, ultimate: false }, ...(ultimate ? [{ guid: ULT, name: 'Desempenho Máximo', active: active === ULT, ultimate: true }] : [])]
    return describeTweaks(s, {})
  }
  const withUltimate = resolveTweakChanges('basic', mk(ULT, true), false)
  assert.equal(withUltimate.changes.powerPlan, undefined, 'Ultimate ativo não vira Alto desempenho')
  assert.equal(withUltimate.rows.find((x) => x.id === 'powerPlan')!.status, 'already')
  assert.equal(resolveTweakChanges('promax', mk(ULT, true), false).changes.powerPlan, undefined, 'Pro Max já está no Ultimate')
  assert.equal(resolveTweakChanges('promax', mk(BALANCED, true), false).changes.powerPlan, ULT, 'Pro Max sobe do Equilibrado para o Ultimate existente')
  assert.equal(resolveTweakChanges('basic', mk(HIGH, false, true), true).changes.powerPlan, undefined, 'notebook em Alto desempenho não é rebaixado para Equilibrado')
  assert.equal(resolveTweakChanges('basic', mk(BALANCED, false), false).changes.powerPlan, HIGH, 'desktop Equilibrado sobe para Alto desempenho')
})
