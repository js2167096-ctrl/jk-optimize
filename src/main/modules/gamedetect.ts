// Detecção real de jogos e emuladores. Uma única varredura leve (entradas de desinstalação, manifestos do Steam,
// manifestos do Epic, metadados da Riot, pastas conhecidas do catálogo e processos), cacheada por alguns segundos.
// Nunca percorre o disco inteiro: só as pastas listadas em games-catalog.ts. Cada resultado traz a origem e a confiança;
// "não detectado" e "não foi possível verificar" são estados diferentes.
import { BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GAME_CATALOG, gameById, steamCoverUrl, type GameDef } from '@shared/constants/games-catalog'
import { AppFailure } from '../security/validate'
import { defineQuery } from '../ops/registry'
import { bool, noParams, obj, str } from '../ops/params'
import { log } from '../ops/log'
import { asArray, runPowerShellWith } from '../services/powershell'
import { dataPath, JsonStore } from '../services/store'
import { detectInstall } from './fivem'

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type DetectState = 'installed' | 'not-detected' | 'unknown'
export type Confidence = 'alta' | 'média'

export interface RunningProcess {
  name: string
  pid: number
  /** Papel do processo (ex.: cliente do FiveM × processo do jogo × auxiliar). */
  role: string
}

export interface Detection {
  id: string
  state: DetectState
  confidence: Confidence | null
  /** Origens que confirmaram a detecção (uma por fonte, sem repetição). */
  sources: string[]
  path: string | null
  exe: string | null
  version: string | null
  running: RunningProcess[]
  /** Explicação para o estado (ex.: "depende do emulador", "verificação falhou"). */
  note: string | null
}

export interface ScanData {
  uninstall: { name: string; version: string; loc: string }[]
  steam: { appid: number; name: string; path: string; exists: boolean }[]
  epic: { app: string; name: string; loc: string }[]
  riot: { id: string; path: string }[]
  dirs: { id: string; dir: string; exe: string | null; exists: boolean }[]
  procs: { name: string; pid: number; path: string | null }[]
  /** Fontes que falharam (impedem afirmar "não instalado"). */
  failed: string[]
}

// ---------------------------------------------------------------------------
// Varredura (PowerShell, um processo)
// ---------------------------------------------------------------------------

const SCAN = `
$ErrorActionPreference = 'SilentlyContinue'
$failed = @()
$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$uninstall = @()
try { $uninstall = @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { [pscustomobject]@{ name = [string]$_.DisplayName; version = [string]$_.DisplayVersion; loc = [string]$_.InstallLocation } }) } catch { $failed += 'uninstall' }
$steamApps = @()
try {
  $root = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath
  if (-not $root) { $root = (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -ErrorAction Stop).InstallPath }
  $libs = @($root)
  $vdf = Join-Path $root 'steamapps\\libraryfolders.vdf'
  if (Test-Path -LiteralPath $vdf) { $libs += ([regex]::Matches((Get-Content -Raw -LiteralPath $vdf), '"path"\\s+"([^"]+)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\\\\\', '\\' }) }
  foreach ($l in ($libs | Where-Object { $_ } | Select-Object -Unique)) {
    $apps = Join-Path $l 'steamapps'
    foreach ($f in @(Get-ChildItem -LiteralPath $apps -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue)) {
      $t = Get-Content -Raw -LiteralPath $f.FullName
      $id = [regex]::Match($t, '"appid"\\s+"(\\d+)"').Groups[1].Value
      $nm = [regex]::Match($t, '"name"\\s+"([^"]*)"').Groups[1].Value
      $dir = [regex]::Match($t, '"installdir"\\s+"([^"]*)"').Groups[1].Value
      if ($id -and $dir) { $p = Join-Path (Join-Path $apps 'common') $dir; $steamApps += [pscustomobject]@{ appid = [int]$id; name = $nm; path = $p; exists = (Test-Path -LiteralPath $p) } }
    }
  }
} catch { }
$epic = @()
$man = Join-Path $env:ProgramData 'Epic\\EpicGamesLauncher\\Data\\Manifests'
if (Test-Path -LiteralPath $man) {
  foreach ($f in @(Get-ChildItem -LiteralPath $man -Filter *.item -ErrorAction SilentlyContinue)) {
    try { $j = Get-Content -Raw -LiteralPath $f.FullName | ConvertFrom-Json; $epic += [pscustomobject]@{ app = [string]$j.AppName; name = [string]$j.DisplayName; loc = [string]$j.InstallLocation } } catch {}
  }
}
$riot = @()
foreach ($id in @($in.riot)) {
  $y = Join-Path $env:ProgramData ('Riot Games\\Metadata\\' + $id + '\\' + $id + '.product_settings.yaml')
  if (Test-Path -LiteralPath $y) {
    $m = [regex]::Match((Get-Content -Raw -LiteralPath $y), 'product_install_full_path:\\s*"?([^"\\r\\n]+)"?')
    if ($m.Success) { $riot += [pscustomobject]@{ id = [string]$id; path = ($m.Groups[1].Value.Trim() -replace '/', '\\') } }
  }
}
$dirs = @()
foreach ($d in @($in.dirs)) {
  $exists = Test-Path -LiteralPath $d.dir
  $exe = $null
  if ($exists -and @($d.exes).Count -gt 0) {
    $hit = Get-ChildItem -LiteralPath $d.dir -Recurse -Depth 2 -File -ErrorAction SilentlyContinue | Where-Object { @($d.exes) -contains $_.Name } | Select-Object -First 1
    if ($hit) { $exe = $hit.FullName }
  }
  $dirs += [pscustomobject]@{ id = [string]$d.id; dir = [string]$d.dir; exe = $exe; exists = $exists }
}
$procs = @()
try { $procs = @(Get-Process -ErrorAction Stop | ForEach-Object { $p = $null; try { $p = $_.Path } catch {}; [pscustomobject]@{ name = $_.ProcessName + '.exe'; pid = $_.Id; path = $p } }) } catch { $failed += 'processes' }
[pscustomobject]@{ uninstall = $uninstall; steam = @($steamApps); epic = @($epic); riot = @($riot); dirs = @($dirs); procs = $procs; failed = $failed } | ConvertTo-Json -Depth 4 -Compress`

function expandEnv(template: string): string {
  return template.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? `%${name}%`)
}

function scanInput() {
  const dirs: { id: string; dir: string; exes: string[] }[] = []
  for (const g of GAME_CATALOG) {
    for (const d of [...(g.dirs ?? []), ...(g.markers ?? [])]) {
      const dir = expandEnv(d)
      if (!dir.includes('%')) dirs.push({ id: g.id, dir, exes: (g.markers ?? []).includes(d) ? [] : g.exes })
    }
  }
  return { riot: GAME_CATALOG.map((g) => g.riotMeta).filter((x): x is string => !!x), dirs }
}

export async function runScan(): Promise<ScanData> {
  const raw = await runPowerShellWith<Record<string, unknown>>(SCAN, scanInput(), { timeoutMs: 60_000 })
  if (!raw) throw new AppFailure('scan-failed', 'A varredura não retornou dados.')
  const list = (v: unknown) => asArray(v) as Record<string, unknown>[]
  return {
    uninstall: list(raw.uninstall).map((u) => ({ name: String(u.name ?? ''), version: String(u.version ?? ''), loc: String(u.loc ?? '') })),
    steam: list(raw.steam).map((s) => ({ appid: Number(s.appid), name: String(s.name ?? ''), path: String(s.path ?? ''), exists: s.exists === true })),
    epic: list(raw.epic).map((e) => ({ app: String(e.app ?? ''), name: String(e.name ?? ''), loc: String(e.loc ?? '') })),
    riot: list(raw.riot).map((r) => ({ id: String(r.id), path: String(r.path) })),
    dirs: list(raw.dirs).map((d) => ({ id: String(d.id), dir: String(d.dir), exe: d.exe ? String(d.exe) : null, exists: d.exists === true })),
    procs: list(raw.procs).map((p) => ({ name: String(p.name), pid: Number(p.pid), path: p.path ? String(p.path) : null })),
    failed: asArray(raw.failed).map(String)
  }
}

// ---------------------------------------------------------------------------
// Correspondência (pura, testável)
// ---------------------------------------------------------------------------

const lc = (s: string) => s.toLowerCase()
const rx = (source: string) => new RegExp(source, 'i')

/** Procura um executável conhecido até `depth` níveis abaixo de `dir`. */
export function findExe(dir: string, exes: string[], depth = 2, fs = { exists: existsSync, list: (d: string) => readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })) }): string | null {
  if (!dir || exes.length === 0 || !fs.exists(dir)) return null
  const want = new Set(exes.map(lc))
  const walk = (d: string, level: number): string | null => {
    let entries: { name: string; dir: boolean }[]
    try {
      entries = fs.list(d)
    } catch {
      return null
    }
    for (const e of entries) if (!e.dir && want.has(lc(e.name))) return join(d, e.name)
    if (level >= depth) return null
    for (const e of entries.filter((x) => x.dir)) {
      const hit = walk(join(d, e.name), level + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(dir, 0)
}

/** Papel de um processo conhecido (para diferenciar o cliente do FiveM do processo do jogo e de auxiliares). */
export function processRole(game: GameDef, name: string): string | null {
  const n = lc(name)
  if (game.id === 'fivem') {
    if (n === 'fivem.exe') return 'Cliente FiveM'
    if (/^fivem_.*gtaprocess\.exe$/.test(n)) return 'Processo do jogo (FiveM)'
    if (/^fivem_.*\.exe$/.test(n)) return 'Processo auxiliar do FiveM'
    return null
  }
  if (game.id === 'gta5') return n === 'gta5.exe' || n === 'gta5_enhanced.exe' ? 'Grand Theft Auto V' : null
  return game.exes.some((e) => lc(e) === n) ? (game.kind === 'emulator' ? 'Emulador' : 'Jogo') : null
}

export interface MatchInput {
  scan: ScanData | null
  /** Resultado do detector específico do FiveM/GTA V (reaproveita o módulo existente). */
  fivem?: { found: boolean; dir: string | null; source: string } | null
  gta?: { dir: string; source: string } | null
  manual?: Record<string, string>
  exists?: (p: string) => boolean
  findExeIn?: (dir: string, exes: string[]) => string | null
}

const tail = (p: string) => lc(p.replace(/[\\/]+$/, ''))

/** Combina todas as fontes em UM resultado por jogo (nunca cartões duplicados). */
export function matchCatalog(catalog: GameDef[], input: MatchInput): Detection[] {
  const exists = input.exists ?? existsSync
  const findIn = input.findExeIn ?? ((dir: string, exes: string[]) => findExe(dir, exes))
  const scan = input.scan
  const out: Detection[] = []

  for (const g of catalog) {
    const sources: string[] = []
    let path: string | null = null
    let exe: string | null = null
    let version: string | null = null
    let weak = false
    const note: string[] = []
    const take = (source: string, p: string | null, strong = true) => {
      if (!sources.includes(source)) sources.push(source)
      if (!strong) weak = true
      if (p && !path) path = p
    }

    const manual = input.manual?.[g.id]
    if (manual && exists(manual)) take('Caminho informado manualmente', manual)

    if (g.id === 'fivem' && input.fivem?.found && input.fivem.dir) take(input.fivem.source, input.fivem.dir)
    if (g.id === 'gta5' && input.gta) take(input.gta.source, input.gta.dir)

    if (scan) {
      for (const s of scan.steam) {
        const byId = g.steamAppIds?.includes(s.appid)
        const byName = g.steamName ? rx(g.steamName).test(s.name) : false
        if ((byId || byName) && s.exists) take(`Steam (appmanifest_${s.appid}.acf)`, s.path)
      }
      for (const e of scan.epic) {
        if (g.epic?.some((p) => rx(p).test(e.name) || rx(p).test(e.app)) && e.loc && exists(e.loc)) take('Epic Games Launcher (manifesto)', e.loc)
      }
      for (const u of scan.uninstall) {
        if (g.uninstall?.some((p) => rx(p).test(u.name))) {
          take(`Entrada de desinstalação do Windows (${u.name})`, u.loc && exists(u.loc) ? u.loc : null)
          if (u.version && !version) version = u.version
        }
      }
      for (const r of scan.riot) if (r.id === g.riotMeta && exists(r.path)) take('Metadados da Riot Games', r.path)
      for (const d of scan.dirs.filter((x) => x.id === g.id && x.exists)) {
        if (d.exe) {
          take('Pasta conhecida com executável', dirOf(d.exe))
          if (!exe) exe = d.exe
        } else if ((g.markers ?? []).some((m) => tail(expandEnv(m)) === tail(d.dir))) take('Pasta de dados do jogo (indício)', d.dir, false)
      }
      for (const p of scan.procs) {
        const role = processRole(g, p.name)
        if (!role || g.id === 'fivem' || g.id === 'gta5') continue
        if (g.pathHint && !(p.path && rx(g.pathHint).test(p.path))) continue
        if (p.path) take('Processo em execução', dirOf(p.path))
      }
    }

    // Confirma o executável no caminho encontrado (até 2 níveis).
    if (path && !exe) exe = findIn(path, g.exes)
    if (path && g.pathHint && exe && !rx(g.pathHint).test(exe)) {
      // Executável encontrado pertence a outro produto (ex.: BlueStacks × MSI App Player).
      exe = null
    }

    const running: RunningProcess[] = []
    if (scan) {
      for (const p of scan.procs) {
        const role = processRole(g, p.name)
        if (!role) continue
        if (g.pathHint && g.id !== 'fivem' && g.id !== 'gta5' && !(p.path && rx(g.pathHint).test(p.path))) continue
        running.push({ name: p.name, pid: p.pid, role })
      }
    }

    const found = sources.length > 0
    let state: DetectState = found ? 'installed' : scan && scan.failed.length === 0 ? 'not-detected' : 'unknown'
    if (!found && scan && scan.failed.length > 0) note.push(`Verificação incompleta (${scan.failed.join(', ')}): não é possível afirmar que não está instalado.`)
    if (!found && !scan) note.push('A varredura não pôde ser executada.')
    const confidence: Confidence | null = !found ? null : exe && !weak ? 'alta' : sources.some((s) => /Steam|Epic|Riot|manualmente/.test(s)) && !weak ? 'alta' : 'média'

    if (g.viaEmulator) {
      state = 'unknown'
      note.length = 0
    }
    out.push({ id: g.id, state, confidence, sources, path, exe, version, running, note: note.join(' ') || null })
  }

  // Jogos que dependem de emuladores: o estado vem dos emuladores compatíveis detectados.
  const emus = out.filter((d) => gameById(d.id)?.kind === 'emulator' && d.state === 'installed')
  for (const d of out) {
    const g = gameById(d.id)
    if (!g?.viaEmulator) continue
    d.state = emus.length ? 'unknown' : scan && scan.failed.length === 0 ? 'not-detected' : 'unknown'
    d.sources = emus.map((e) => `Emulador compatível detectado: ${gameById(e.id)!.name}`)
    d.confidence = null
    d.running = emus.flatMap((e) => e.running)
    d.note = emus.length ? 'Emulador compatível detectado; não é possível confirmar a instalação do jogo dentro dele.' : 'Nenhum emulador compatível foi detectado.'
  }
  return out
}

const dirOf = (file: string) => dirname(file)

// ---------------------------------------------------------------------------
// Cache da varredura e consultas
// ---------------------------------------------------------------------------

const manualStore = new JsonStore<{ manual: Record<string, string> }>('games.json', (raw) => {
  const m = (raw as { manual?: Record<string, unknown> } | null)?.manual ?? {}
  const manual: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) if (gameById(k) && typeof v === 'string') manual[k] = v
  return { manual }
})

const TTL_MS = 45_000
interface DetectResult {
  detections: Detection[]
  scannedAt: string
  failed: string[]
}
let cache = null as { at: number; result: DetectResult } | null
let inflight = null as Promise<DetectResult> | null

export async function detectGames(refresh = false) {
  if (!refresh && cache && Date.now() - cache.at < TTL_MS) return cache.result
  if (inflight) return inflight
  inflight = (async () => {
    let scan: ScanData | null = null
    try {
      scan = await runScan()
    } catch (error) {
      log.warn('games', `Varredura de jogos falhou: ${(error as Error).message}`)
    }
    const fiv = await detectInstall().catch(() => null)
    const detections = matchCatalog(GAME_CATALOG, {
      scan,
      fivem: fiv ? { found: fiv.fivem.found, dir: fiv.fivem.dir, source: fiv.fivem.manual ? 'Pasta do FiveM escolhida manualmente' : 'Pasta padrão do FiveM (%LOCALAPPDATA%\\FiveM)' } : null,
      gta: fiv?.gta ? { dir: fiv.gta.dir, source: `GTA V: ${fiv.gta.source}` } : null,
      manual: manualStore.read().manual
    })
    // FiveM: o executável confirmado é o cliente.
    const f = detections.find((d) => d.id === 'fivem')
    if (f?.path && !f.exe && existsSync(join(f.path, 'FiveM.exe'))) f.exe = join(f.path, 'FiveM.exe')
    const result = { detections, scannedAt: new Date().toISOString(), failed: scan?.failed ?? ['varredura'] }
    cache = { at: Date.now(), result }
    return result
  })().finally(() => {
    inflight = null
  })
  return inflight
}

export const detectionOf = async (id: string) => (await detectGames(false)).detections.find((d) => d.id === id) ?? null

defineQuery({
  id: 'games.scan',
  module: 'fivem',
  parse: (raw) => ({ refresh: bool(obj(raw, ['refresh']).refresh, 'atualizar', false) }),
  run: ({ refresh }) => detectGames(refresh)
})

const RUNNING_SCRIPT = `
@(Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $p = $null; try { $p = $_.Path } catch {}; [pscustomobject]@{ name = $_.ProcessName + '.exe'; pid = $_.Id; path = $p } }) | ConvertTo-Json -Compress`

defineQuery({
  id: 'games.running',
  module: 'fivem',
  parse: noParams,
  async run() {
    const raw = await runPowerShellWith<unknown>(RUNNING_SCRIPT, {}, { timeoutMs: 20_000 })
    const procs = asArray(raw).map((p) => p as { name: string; pid: number; path: string | null })
    const running: Record<string, RunningProcess[]> = {}
    for (const g of GAME_CATALOG) {
      if (g.viaEmulator) continue
      for (const p of procs) {
        const role = processRole(g, p.name)
        if (!role) continue
        if (g.pathHint && g.id !== 'fivem' && g.id !== 'gta5' && !(p.path && rx(g.pathHint).test(p.path))) continue
        ;(running[g.id] ??= []).push({ name: p.name, pid: p.pid, role })
      }
    }
    return { running, at: new Date().toISOString() }
  }
})

// ---------------------------------------------------------------------------
// Caminho manual
// ---------------------------------------------------------------------------

defineQuery({
  id: 'games.path.pick',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'jogo', 40, /^[a-z0-9-]+$/) }),
  async run({ id }) {
    const g = gameById(id)
    if (!g) throw new AppFailure('not-found', 'Jogo fora do catálogo.')
    if (g.viaEmulator || g.exes.length === 0) throw new AppFailure('not-supported', 'Este item não tem uma pasta própria para indicar.')
    const win = BrowserWindow.getFocusedWindow()
    const options = { title: `Pasta de instalação de ${g.name}`, properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { saved: false }
    return setManualPath(id, picked.filePaths[0])
  }
})

/** Valida e grava o caminho indicado: a pasta precisa conter um executável conhecido (até 2 níveis). */
export function setManualPath(id: string, dir: string): { saved: boolean; path: string; exe: string } {
  const g = gameById(id)
  if (!g) throw new AppFailure('not-found', 'Jogo fora do catálogo.')
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppFailure('invalid-path', 'A pasta não existe.')
  const exe = findExe(dir, g.exes)
  if (!exe) throw new AppFailure('invalid-path', `Esta pasta não contém nenhum executável conhecido de ${g.name} (${g.exes.join(', ')}).`)
  if (g.pathHint && !rx(g.pathHint).test(exe)) throw new AppFailure('invalid-path', `O executável encontrado não pertence a ${g.name}.`)
  const cur = manualStore.read()
  manualStore.write({ manual: { ...cur.manual, [id]: dir } })
  cache = null
  log.info('games', `Caminho de ${g.name} informado manualmente: ${dir}`)
  return { saved: true, path: dir, exe }
}

defineQuery({
  id: 'games.path.clear',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'jogo', 40, /^[a-z0-9-]+$/) }),
  async run({ id }) {
    const cur = manualStore.read()
    const { [id]: _drop, ...rest } = cur.manual
    manualStore.write({ manual: rest })
    cache = null
    return { cleared: true }
  }
})

// ---------------------------------------------------------------------------
// Capas: imagem pública do Steam, guardada em disco (cache local) e entregue como data URL
// ---------------------------------------------------------------------------

const COVER_HOST = /^https:\/\/cdn\.akamai\.steamstatic\.com\/steam\/apps\/\d+\/header\.jpg$/
const COVER_MAX = 2 * 1024 * 1024
const FAIL_RETRY_MS = 6 * 3600_000

function coverFile(id: string): string {
  const dir = dataPath('game-covers')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.jpg`)
}

const isJpeg = (b: Buffer) => b.length > 1000 && b[0] === 0xff && b[1] === 0xd8

export async function loadCover(id: string, fetcher: (url: string) => Promise<{ ok: boolean; status: number; type: string; bytes: Buffer }> = defaultFetch): Promise<{ dataUrl: string | null; source: 'cache' | 'steam' | null; reason: string | null }> {
  const g = gameById(id)
  if (!g) throw new AppFailure('not-found', 'Jogo fora do catálogo.')
  const appId = g.steamAppIds?.[0]
  if (!appId) return { dataUrl: null, source: null, reason: 'Sem capa oficial pública conhecida para este item.' }
  const file = coverFile(id)
  if (existsSync(file)) {
    const b = readFileSync(file)
    if (isJpeg(b)) return { dataUrl: `data:image/jpeg;base64,${b.toString('base64')}`, source: 'cache', reason: null }
  }
  const failFile = `${file}.fail`
  if (existsSync(failFile) && Date.now() - statSync(failFile).mtimeMs < FAIL_RETRY_MS) return { dataUrl: null, source: null, reason: 'A capa não está disponível agora (nova tentativa em algumas horas).' }
  const urls = [steamCoverUrl(appId), ...(g.steamAppIds ?? []).slice(1).map(steamCoverUrl)]
  let reason = 'Capa indisponível.'
  for (const url of urls) {
    if (!COVER_HOST.test(url)) continue
    try {
      const r = await fetcher(url)
      if (!r.ok) {
        reason = `A loja respondeu ${r.status}.`
        continue
      }
      if (!/^image\/jpeg/i.test(r.type) || !isJpeg(r.bytes) || r.bytes.length > COVER_MAX) {
        reason = 'A resposta não era uma imagem válida.'
        continue
      }
      writeFileSync(file, r.bytes)
      return { dataUrl: `data:image/jpeg;base64,${r.bytes.toString('base64')}`, source: 'steam', reason: null }
    } catch (error) {
      reason = `Sem conexão para baixar a capa (${(error as Error).message}).`
    }
  }
  writeFileSync(failFile, new Date().toISOString())
  return { dataUrl: null, source: null, reason }
}

async function defaultFetch(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  return { ok: res.ok, status: res.status, type: res.headers.get('content-type') ?? '', bytes: Buffer.from(await res.arrayBuffer()) }
}

defineQuery({
  id: 'games.cover',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'jogo', 40, /^[a-z0-9-]+$/) }),
  run: ({ id }) => loadCover(id)
})

