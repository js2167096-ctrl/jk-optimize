// Módulo FiveM: detecção, cache, configurações, memória, gargalos, arquivos locais,
// perfis por servidor, inicialização e relatórios. Nada aqui interage com o
// anticheat, com arquivos protegidos do jogo ou com dados de servidores.
import { BrowserWindow, dialog, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import os from 'node:os'
import { formatBytes } from '@shared/format'
import type { TaskDetailSection } from '@shared/types'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { int, noParams, obj, oneOf, str, strList } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson } from '../services/powershell'
import { JsonStore } from '../services/store'
import { getStaticInfo } from '../services/system'
import { deleteFilesSafely, scanFiles } from './fsutil'
import { demandSample } from './sampler'
import { validatePresentMonPath } from './presentmon'

// ---------------------------------------------------------------------------
// Configuração local do módulo
// ---------------------------------------------------------------------------

export interface ServerProfile {
  id: string
  name: string
  address: string | null
  notes: string
  preferredPlan: string | null
  createdAt: string
  updatedAt: string
}

interface FivemConfig {
  fivemDir: string | null
  gtaDir: string | null
  presentMonPath: string | null
  profiles: ServerProfile[]
}

const config = new JsonStore<FivemConfig>('fivem.json', (raw) => {
  const r = (raw ?? {}) as Partial<FivemConfig>
  return {
    fivemDir: typeof r.fivemDir === 'string' ? r.fivemDir : null,
    gtaDir: typeof r.gtaDir === 'string' ? r.gtaDir : null,
    presentMonPath: typeof r.presentMonPath === 'string' ? r.presentMonPath : null,
    profiles: Array.isArray(r.profiles) ? r.profiles.filter((p) => typeof p?.id === 'string').slice(0, 100) : []
  }
})

export function getPresentMonPath(): string | null {
  const p = config.read().presentMonPath
  return p && existsSync(p) ? p : null
}

// ---------------------------------------------------------------------------
// 7.1 Detecção de instalações
// ---------------------------------------------------------------------------

const DETECT = `
$c = @()
try { $r = Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Rockstar Games\\Grand Theft Auto V' -ErrorAction Stop; if ($r.InstallFolder) { $c += [pscustomobject]@{ src = 'Rockstar Games Launcher'; path = $r.InstallFolder } } } catch {}
try { $r = Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Rockstar Games\\GTAV' -ErrorAction Stop; if ($r.InstallFolderSteam) { $c += [pscustomobject]@{ src = 'Steam (registro Rockstar)'; path = ($r.InstallFolderSteam -replace '\\\\GTAV$','') } } } catch {}
try {
  $steam = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath
  $vdf = Join-Path $steam 'steamapps\\libraryfolders.vdf'
  $libs = @($steam)
  if (Test-Path -LiteralPath $vdf) { $libs += ([regex]::Matches((Get-Content -Raw -LiteralPath $vdf), '"path"\\s+"([^"]+)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\\\\\','\\' }) }
  foreach ($l in ($libs | Select-Object -Unique)) { $c += [pscustomobject]@{ src = 'Steam'; path = (Join-Path $l 'steamapps\\common\\Grand Theft Auto V') } }
} catch {}
$man = Join-Path $env:ProgramData 'Epic\\EpicGamesLauncher\\Data\\Manifests'
if (Test-Path -LiteralPath $man) {
  foreach ($f in Get-ChildItem -LiteralPath $man -Filter *.item -ErrorAction SilentlyContinue) {
    try { $j = Get-Content -Raw -LiteralPath $f.FullName | ConvertFrom-Json; if ($j.DisplayName -like 'Grand Theft Auto V*') { $c += [pscustomobject]@{ src = 'Epic Games'; path = $j.InstallLocation } } } catch {}
  }
}
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(GTA5|GTA5_Enhanced|FiveM|FiveM_.*)$' } | ForEach-Object { $p = $null; try { $p = $_.Path } catch {}; [pscustomobject]@{ name = $_.ProcessName; pid = $_.Id; path = $p } })
foreach ($p in $procs) { if ($p.path -and $p.name -match '^GTA5') { $c += [pscustomobject]@{ src = 'Processo em execução'; path = (Split-Path $p.path) } } }
[pscustomobject]@{ candidates = $c; processes = $procs } | ConvertTo-Json -Depth 3 -Compress`

export interface GtaCandidate {
  source: string
  path: string
  valid: boolean
  edition: 'legacy' | 'enhanced' | null
}

export function gtaEdition(dir: string): GtaCandidate['edition'] {
  if (existsSync(join(dir, 'GTA5.exe'))) return 'legacy'
  if (existsSync(join(dir, 'GTA5_Enhanced.exe'))) return 'enhanced'
  return null
}

export function fivemAppDir(dir: string): string | null {
  const app = join(dir, 'FiveM.app')
  return existsSync(join(dir, 'FiveM.exe')) && existsSync(app) ? app : null
}

function readCitizenIni(appDir: string): Record<string, string> {
  const file = join(appDir, 'CitizenFX.ini')
  if (!existsSync(file)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([^=;#[\]]+?)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

export async function detectInstall() {
  const cfg = config.read()
  const raw = await runPowerShellJson<{ candidates: unknown; processes: unknown }>(DETECT, { timeoutMs: 45_000 })
  const defaultFivem = join(process.env.LOCALAPPDATA ?? '', 'FiveM')
  const fivemDir = cfg.fivemDir ?? (fivemAppDir(defaultFivem) ? defaultFivem : null)
  const appDir = fivemDir ? fivemAppDir(fivemDir) : null
  const ini = appDir ? readCitizenIni(appDir) : {}

  const seen = new Set<string>()
  const candidates: GtaCandidate[] = []
  const add = (source: string, path: string | null | undefined) => {
    if (!path) return
    const key = path.toLowerCase().replace(/[\\/]+$/, '')
    if (seen.has(key)) return
    seen.add(key)
    const edition = existsSync(path) ? gtaEdition(path) : null
    candidates.push({ source, path, valid: edition !== null, edition })
  }
  if (cfg.gtaDir) add('Escolhido manualmente', cfg.gtaDir)
  if (ini.IVPath) add('CitizenFX.ini (configuração do FiveM)', ini.IVPath)
  for (const c of asArray(raw?.candidates)) add(String((c as { src: string }).src), asString((c as { path: string }).path))

  const gta = candidates.find((c) => c.valid) ?? null
  return {
    fivem: {
      dir: fivemDir,
      appDir,
      found: appDir !== null,
      manual: cfg.fivemDir !== null,
      ini,
      updateChannel: ini.UpdateChannel ?? null
    },
    gta: gta ? { dir: gta.path, edition: gta.edition, source: gta.source } : null,
    candidates,
    processes: asArray(raw?.processes).map((p) => p as { name: string; pid: number; path: string | null }),
    notes: [
      ...(gta?.edition === 'enhanced' ? ['Foi encontrada a edição Enhanced do GTA V. Verifique se ela é compatível com a versão atual do FiveM.'] : []),
      ...(!appDir ? ['FiveM não encontrado no local padrão. Use "Escolher pasta do FiveM" se ele estiver em outro lugar.'] : [])
    ]
  }
}

defineQuery({ id: 'fivem.detect', module: 'fivem', parse: noParams, run: () => detectInstall() })

defineQuery({
  id: 'fivem.paths.pick',
  module: 'fivem',
  parse: (raw) => ({ kind: oneOf(obj(raw, ['kind']).kind, 'tipo', ['fivem', 'gta', 'presentmon', 'reset'] as const) }),
  async run({ kind }) {
    const cfg = config.read()
    if (kind === 'reset') {
      config.write({ ...cfg, fivemDir: null, gtaDir: null })
      return { saved: true }
    }
    const win = BrowserWindow.getFocusedWindow()
    const options =
      kind === 'presentmon'
        ? { title: 'Selecionar PresentMon', properties: ['openFile' as const], filters: [{ name: 'PresentMon', extensions: ['exe'] }] }
        : { title: kind === 'fivem' ? 'Pasta do FiveM (contém FiveM.exe)' : 'Pasta do GTA V (contém GTA5.exe)', properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { saved: false }
    const path = picked.filePaths[0]
    if (kind === 'fivem' && !fivemAppDir(path)) throw new AppFailure('invalid-path', 'Esta pasta não contém FiveM.exe e FiveM.app.')
    if (kind === 'gta' && !gtaEdition(path)) throw new AppFailure('invalid-path', 'Esta pasta não contém GTA5.exe.')
    if (kind === 'presentmon') validatePresentMonPath(path)
    config.write({ ...cfg, ...(kind === 'fivem' ? { fivemDir: path } : kind === 'gta' ? { gtaDir: path } : { presentMonPath: path }) })
    return { saved: true, path }
  }
})

defineQuery({
  id: 'fivem.presentmon.status',
  module: 'fivem',
  parse: noParams,
  async run() {
    const path = config.read().presentMonPath
    return { configured: !!path, path, exists: path ? existsSync(path) : false }
  }
})

// ---------------------------------------------------------------------------
// 7.2 Gerenciador de cache
// ---------------------------------------------------------------------------

const GAME_PROCESSES = /^(GTA5|GTA5_Enhanced|FiveM|FiveM_.*)$/i

export async function runningGameProcesses(): Promise<string[]> {
  const r = await runPowerShellJson<unknown>(`@(Get-Process | Where-Object { $_.ProcessName -match '^(GTA5|GTA5_Enhanced|FiveM|FiveM_.*)$' } | ForEach-Object ProcessName) | ConvertTo-Json -Compress`)
  return asArray(r).map(String).filter((n) => GAME_PROCESSES.test(n))
}

export const CACHE_CATEGORIES = {
  cache: { label: 'Cache geral (exceto arquivos do jogo)', rel: ['data', 'cache'], exclude: ['game'], heavy: false },
  game: { label: 'Arquivos do jogo baixados (data\\cache\\game)', rel: ['data', 'cache', 'game'], exclude: [], heavy: true },
  serverCache: { label: 'Cache de servidores (server-cache)', rel: ['data', 'server-cache'], exclude: [], heavy: false },
  serverCachePriv: { label: 'Cache privado de servidores (server-cache-priv)', rel: ['data', 'server-cache-priv'], exclude: [], heavy: false },
  crashes: { label: 'Relatórios de falha (crashes)', rel: ['crashes'], exclude: [], heavy: false },
  logs: { label: 'Logs do cliente (logs)', rel: ['logs'], exclude: [], heavy: false }
} as const
type CacheId = keyof typeof CACHE_CATEGORIES

async function scanCategory(appDir: string, id: CacheId, signal: AbortSignal) {
  const def = CACHE_CATEGORIES[id]
  const root = join(appDir, ...def.rel)
  if (!existsSync(root)) return null
  const roots = def.exclude.length
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => !(def.exclude as readonly string[]).includes(e.name.toLowerCase()))
        .map((e) => join(root, e.name))
    : [root]
  const files = []
  let bytes = 0
  const allowedRoots: string[] = []
  for (const r of roots) {
    if (statSync(r).isFile()) {
      const st = statSync(r)
      files.push({ path: r, size: st.size, mtimeMs: st.mtimeMs })
      bytes += st.size
      allowedRoots.push(root)
      continue
    }
    const scan = await scanFiles(r, { maxEntries: 300_000, maxMs: 60_000, signal })
    files.push(...scan.files)
    bytes += scan.totalBytes
    allowedRoots.push(r)
  }
  return { id, label: def.label, path: root, heavy: def.heavy, files, bytes, roots: allowedRoots }
}

defineQuery({
  id: 'fivem.cache.scan',
  module: 'fivem',
  parse: noParams,
  async run(_p, ctx) {
    const install = await detectInstall()
    if (!install.fivem.appDir) return { found: false, categories: [], running: [] }
    const categories = []
    for (const id of Object.keys(CACHE_CATEGORIES) as CacheId[]) {
      ctx.progress(`Analisando ${CACHE_CATEGORIES[id].label}`)
      const c = await scanCategory(install.fivem.appDir, id, ctx.signal)
      if (c) categories.push({ id: c.id, label: c.label, path: c.path, heavy: c.heavy, files: c.files.length, bytes: c.bytes })
    }
    return { found: true, categories, running: await runningGameProcesses(), preserved: ['CitizenFX.ini', 'data\\nui-storage (dados de interface dos servidores)', 'mods', 'plugins', 'citizen'] }
  }
})

defineAction<{ ids: CacheId[] }, never>({
  id: 'fivem.cache.clean',
  module: 'fivem',
  title: 'Limpar cache do FiveM',
  description: 'Apaga as categorias de cache escolhidas do FiveM, preservando configurações e dados do usuário.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'O FiveM baixa de novo o que for necessário; os arquivos apagados não voltam.',
  requiresElevation: false,
  exclusive: 'fivem-files',
  parse(raw) {
    const ids = strList(obj(raw, ['ids']).ids, 'categorias', 6, 20).map((id) => oneOf(id, 'categoria', Object.keys(CACHE_CATEGORIES) as CacheId[]))
    if (ids.length === 0) throw new AppFailure('invalid-input', 'Escolha ao menos uma categoria.')
    return { ids: [...new Set(ids)] }
  },
  async preview({ ids }, ctx) {
    const install = await detectInstall()
    if (!install.fivem.appDir) return { summary: 'FiveM não encontrado.', changes: [], warnings: [], blocked: 'FiveM não encontrado.' }
    const running = await runningGameProcesses()
    const cats = (await Promise.all(ids.map((id) => scanCategory(install.fivem.appDir!, id, ctx.signal)))).filter((c) => c !== null)
    return {
      summary: `${formatBytes(cats.reduce((s, c) => s + c.bytes, 0))} em ${cats.reduce((s, c) => s + c.files.length, 0)} arquivos.`,
      changes: cats.map((c) => ({ target: `${c.label} (${c.path})`, current: `${c.files.length} arquivos · ${formatBytes(c.bytes)}`, intended: 'Removido' })),
      warnings: [
        'Preservados: CitizenFX.ini, nui-storage, mods, plugins e a pasta citizen.',
        ...(ids.includes('game') ? ['Os arquivos do jogo baixados podem ter vários GB e serão baixados de novo no próximo início.'] : []),
        'A primeira entrada em servidores depois da limpeza será mais lenta.'
      ],
      blocked: running.length ? `Feche o FiveM/GTA V antes de limpar (em execução: ${running.join(', ')}).` : cats.length === 0 ? 'Nenhuma das categorias existe.' : null
    }
  },
  async precheck() {
    const running = await runningGameProcesses()
    return running.length ? `Feche o FiveM/GTA V antes de limpar (em execução: ${running.join(', ')}).` : null
  },
  async execute({ ids }, ctx) {
    const install = await detectInstall()
    const sections: TaskDetailSection[] = []
    let freed = 0
    for (const id of ids) {
      const c = await scanCategory(install.fivem.appDir!, id, ctx.signal)
      if (!c) continue
      const report = await deleteFilesSafely(c.files, c.roots, { signal: ctx.signal, onProgress: (d, t) => ctx.progress(c.label, d, t) })
      freed += report.bytesFreed
      sections.push({
        title: c.label,
        rows: [
          { label: 'Removidos', value: `${report.deleted} arquivos · ${formatBytes(report.bytesFreed)}`, tone: 'ok' },
          { label: 'Bloqueados/em uso', value: String(report.skippedLocked + report.skippedDenied) },
          ...report.errors.slice(0, 3).map((e) => ({ label: 'Erro', value: e, tone: 'error' as const }))
        ]
      })
    }
    return { ok: true, verified: true, summary: `${formatBytes(freed)} recuperados do cache do FiveM.`, sections }
  }
})

// ---------------------------------------------------------------------------
// 7.3 Analisador de configurações gráficas (gta5_settings.xml / settings.xml)
// ---------------------------------------------------------------------------

export function settingsFiles(): { id: 'fivem' | 'gta'; label: string; path: string }[] {
  const appdata = process.env.APPDATA ?? ''
  const docs = join(os.homedir(), 'Documents')
  return [
    { id: 'fivem', label: 'Configurações gráficas do FiveM', path: join(appdata, 'CitizenFX', 'gta5_settings.xml') },
    { id: 'gta', label: 'Configurações gráficas do GTA V', path: join(docs, 'Rockstar Games', 'GTA V', 'settings.xml') }
  ]
}

/** Lê os valores `<Chave value="x" />` dentro de <graphics> e <video>. Exportada para testes. */
export function parseGtaSettings(xml: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const section of ['graphics', 'video']) {
    const block = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, 'i').exec(xml)?.[1]
    if (!block) continue
    for (const m of block.matchAll(/<([A-Za-z0-9_]+)\s+value="([^"]*)"\s*\/>/g)) out[m[1]] = m[2]
  }
  return out
}

/** Altera somente o atributo value dos elementos indicados, preservando todo o resto. */
export function applyGtaSettings(xml: string, changes: Record<string, string>): string {
  let out = xml
  for (const [key, value] of Object.entries(changes)) {
    const re = new RegExp(`(<${key}\\s+value=")([^"]*)("\\s*/>)`)
    if (!re.test(out)) throw new AppFailure('setting-missing', `A chave ${key} não existe no arquivo.`)
    out = out.replace(re, `$1${value}$3`)
  }
  return out
}

/** Chaves que o JK Optimize pode alterar, com valores permitidos. */
const UNIT = /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/

export const TUNABLE: Record<string, { label: string; allowed: RegExp }> = {
  MSAA: { label: 'MSAA', allowed: /^(0|2|4|8)$/ },
  ReflectionMSAA: { label: 'MSAA de reflexos', allowed: /^(0|2|4|8)$/ },
  TXAA_Enabled: { label: 'TXAA', allowed: /^(true|false)$/ },
  FXAA_Enabled: { label: 'FXAA', allowed: /^(true|false)$/ },
  GrassQuality: { label: 'Qualidade da grama', allowed: /^[0-3]$/ },
  ShadowQuality: { label: 'Qualidade das sombras', allowed: /^[0-3]$/ },
  ReflectionQuality: { label: 'Qualidade dos reflexos', allowed: /^[0-3]$/ },
  ParticleQuality: { label: 'Qualidade das partículas', allowed: /^[0-2]$/ },
  PostFX: { label: 'Pós-processamento', allowed: /^[0-3]$/ },
  TextureQuality: { label: 'Qualidade das texturas', allowed: /^[0-2]$/ },
  Tessellation: { label: 'Tesselação', allowed: /^[0-3]$/ },
  SSAO: { label: 'Oclusão de ambiente (SSAO)', allowed: /^[0-2]$/ },
  MotionBlurStrength: { label: 'Desfoque de movimento', allowed: /^(0|0\.\d+|1)(\.0+)?$/ },
  DoF: { label: 'Profundidade de campo', allowed: /^(true|false)$/ },
  UltraShadows_Enabled: { label: 'Sombras de alta resolução', allowed: /^(true|false)$/ },
  Shadow_SoftShadows: { label: 'Sombras suaves', allowed: /^[0-5]$/ },
  CityDensity: { label: 'Densidade populacional', allowed: /^(0(\.\d+)?|1(\.0+)?)$/ },
  PedVarietyMultiplier: { label: 'Variedade de pedestres', allowed: /^(0(\.\d+)?|1(\.0+)?)$/ },
  VehicleVarietyMultiplier: { label: 'Variedade de veículos', allowed: /^(0(\.\d+)?|1(\.0+)?)$/ },
  VSync: { label: 'VSync', allowed: /^[0-2]$/ },
  WaterQuality: { label: 'Qualidade da água', allowed: /^[0-2]$/ },
  ShaderQuality: { label: 'Qualidade dos shaders', allowed: /^[0-2]$/ },
  AnisotropicFiltering: { label: 'Filtragem anisotrópica', allowed: /^(0|2|4|8|16)$/ },
  LodScale: { label: 'Escala de distância', allowed: UNIT },
  MaxLodScale: { label: 'Escala de distância estendida', allowed: UNIT },
  PedLodBias: { label: 'Detalhe de pedestres à distância', allowed: UNIT },
  VehicleLodBias: { label: 'Detalhe de veículos à distância', allowed: UNIT },
  Shadow_LongShadows: { label: 'Sombras longas', allowed: /^(true|false)$/ },
  HdStreamingInFlight: { label: 'Streaming de alta resolução em movimento', allowed: /^(true|false)$/ }
}

export type GraphicsProfile = 'performance' | 'balanced' | 'quality'

/** Itens que existem no arquivo mas não são alterados pelos perfis, com o motivo. */
export const NOT_EDITED: Record<string, string> = {
  ScreenWidth: 'Resolução: precisa corresponder a um modo suportado pelo monitor; altere dentro do jogo.',
  ScreenHeight: 'Resolução: precisa corresponder a um modo suportado pelo monitor; altere dentro do jogo.',
  SamplingMode: 'Escala de resolução: o significado de cada valor varia entre versões; altere dentro do jogo.',
  VSync: 'V-Sync é preferência pessoal (latência × tearing) e não é alterado pelos perfis.',
  Shadow_Distance: 'O efeito exato deste valor não é documentado; mantido sem alteração.',
  DX_Version: 'Versão do DirectX: alterar pode impedir o jogo de abrir.'
}

const f6 = (n: number) => n.toFixed(6)

/**
 * Perfis gráficos a partir do hardware detectado. Só propõe chaves que já existem
 * no arquivo e só valores aceitos por TUNABLE. Exportada para testes.
 */
export function buildGraphicsProfile(values: Record<string, string>, hw: { integratedGpu: boolean; ramGB: number }, profile: GraphicsProfile): Recommendation[] {
  const strong = !hw.integratedGpu
  const pick = <T,>(perf: T, bal: T, qual: T) => (profile === 'performance' ? perf : profile === 'balanced' ? bal : qual)
  const target: Record<string, string> = {
    MSAA: pick('0', '0', strong ? '2' : '0'),
    ReflectionMSAA: '0',
    TXAA_Enabled: 'false',
    FXAA_Enabled: pick('false', 'true', 'true'),
    TextureQuality: pick('0', hw.ramGB >= 12 ? '1' : '0', hw.ramGB >= 16 && strong ? '2' : '1'),
    ShadowQuality: pick('0', '1', strong ? '2' : '1'),
    ReflectionQuality: pick('0', '1', strong ? '2' : '1'),
    WaterQuality: pick('0', '1', strong ? '2' : '1'),
    ParticleQuality: pick('0', '1', strong ? '2' : '1'),
    GrassQuality: pick('0', '0', strong ? '2' : '1'),
    ShaderQuality: pick('0', '1', strong ? '2' : '1'),
    PostFX: pick('0', '1', strong ? '2' : '1'),
    SSAO: pick('0', '0', strong ? '1' : '0'),
    Tessellation: pick('0', '0', strong ? '2' : '0'),
    AnisotropicFiltering: pick('0', '4', '16'),
    Shadow_SoftShadows: pick('0', '1', '3'),
    UltraShadows_Enabled: 'false',
    Shadow_LongShadows: pick('false', 'false', strong ? 'true' : 'false'),
    DoF: pick('false', 'false', strong ? 'true' : 'false'),
    MotionBlurStrength: f6(0),
    LodScale: f6(pick(0, 0.5, strong ? 1 : 0.5)),
    MaxLodScale: f6(pick(0, 0, strong ? 0.3 : 0)),
    PedLodBias: f6(pick(0, 0.2, 0.5)),
    VehicleLodBias: f6(pick(0, 0.2, 0.5)),
    CityDensity: f6(pick(0, 0.5, 1)),
    PedVarietyMultiplier: f6(pick(0, 0.5, 1)),
    VehicleVarietyMultiplier: f6(pick(0, 0.5, 1)),
    HdStreamingInFlight: pick('false', 'false', hw.ramGB >= 16 ? 'true' : 'false')
  }
  const reason = profile === 'performance' ? 'Perfil Desempenho: prioriza quadros por segundo.' : profile === 'balanced' ? 'Perfil Equilibrado: qualidade moderada com bom desempenho.' : 'Perfil Qualidade: prioriza a imagem dentro do que o hardware suporta.'
  const out: Recommendation[] = []
  for (const [key, value] of Object.entries(target)) {
    const current = values[key]
    if (current === undefined || !TUNABLE[key]?.allowed.test(value)) continue
    const same = /^-?\d/.test(current) && /^-?\d/.test(value) ? Number(current) === Number(value) : current === value
    if (!same) out.push({ key, label: TUNABLE[key].label, current, recommended: value, reason })
  }
  return out
}

export interface Recommendation {
  key: string
  label: string
  current: string
  recommended: string
  reason: string
}

/** Recomendações a partir do hardware detectado e do objetivo. Exportada para testes. */
export function recommendSettings(
  values: Record<string, string>,
  hw: { integratedGpu: boolean; ramGB: number },
  goal: 'performance' | 'balanced'
): Recommendation[] {
  const recs: Recommendation[] = []
  const want = (key: string, recommended: string, reason: string, cmp: (cur: number, rec: number) => boolean = (c, r) => c > r) => {
    const cur = values[key]
    if (cur === undefined) return
    const isBool = recommended === 'true' || recommended === 'false'
    const differs = isBool ? cur !== recommended : cmp(Number(cur), Number(recommended))
    if (differs) recs.push({ key, label: TUNABLE[key]?.label ?? key, current: cur, recommended, reason })
  }
  const weak = hw.integratedGpu || goal === 'performance'
  want('MSAA', '0', 'MSAA é um dos ajustes mais caros para a GPU no GTA V.')
  want('ReflectionMSAA', '0', 'MSAA de reflexos custa desempenho com pouco ganho visual.')
  want('TXAA_Enabled', 'false', 'TXAA depende de MSAA e adiciona custo.')
  if (weak) {
    want('GrassQuality', '0', 'A grama é muito pesada em áreas abertas, especialmente em GPUs integradas.')
    want('ShadowQuality', '1', 'Sombras em qualidade alta consomem GPU e VRAM.')
    want('ReflectionQuality', '0', 'Reflexos de alta qualidade exigem renderização adicional.')
    want('PostFX', '0', 'Pós-processamento (bloom, desfoque) reduz o FPS em GPUs modestas.')
    want('Tessellation', '0', 'Tesselação aumenta a carga geométrica.')
    want('SSAO', '0', 'SSAO tem custo relevante em GPUs integradas.')
    want('DoF', 'false', 'Profundidade de campo é um efeito de pós-processamento caro.')
    want('MotionBlurStrength', '0', 'Desfoque de movimento não melhora o desempenho e pode atrapalhar a visibilidade.')
    want('UltraShadows_Enabled', 'false', 'Sombras de alta resolução exigem muita VRAM.')
  }
  if (hw.ramGB < 12 || hw.integratedGpu) {
    want('TextureQuality', '1', `Com ${hw.ramGB} GB de RAM${hw.integratedGpu ? ' e GPU integrada (memória compartilhada)' : ''}, texturas no máximo aumentam travadas por falta de memória.`)
  }
  if (goal === 'performance') {
    want('CityDensity', '0.5', 'Menos pedestres e veículos simulados reduz a carga de CPU.')
  }
  return recs
}

export function readSettingsFile(id: 'fivem' | 'gta') {
  const file = settingsFiles().find((f) => f.id === id)!
  if (!existsSync(file.path)) return null
  const xml = readFileSync(file.path, 'utf8')
  return { ...file, xml, values: parseGtaSettings(xml), sha256: createHash('sha256').update(xml).digest('hex') }
}

export async function hardwareProfile() {
  const info = await getStaticInfo(false)
  const integrated = info.gpus.length > 0 && info.gpus.every((g) => /vega \d+ graphics|uhd graphics|hd graphics|iris|radeon\(tm\) graphics|radeon graphics/i.test(g.name))
  return { integratedGpu: integrated, ramGB: Math.round(info.totalMemoryBytes / 1024 ** 3), gpus: info.gpus.map((g) => g.name) }
}

defineQuery({
  id: 'fivem.settings.analyze',
  module: 'fivem',
  parse: (raw) => ({ goal: oneOf(obj(raw, ['goal']).goal, 'objetivo', ['performance', 'balanced'] as const, 'balanced') }),
  async run({ goal }) {
    const hw = await hardwareProfile()
    const files = settingsFiles().map((f) => {
      const data = readSettingsFile(f.id)
      return {
        id: f.id,
        label: f.label,
        path: f.path,
        exists: !!data,
        values: data?.values ?? {},
        recommendations: data ? recommendSettings(data.values, hw, goal) : []
      }
    })
    const install = await detectInstall().catch(() => null)
    return { hardware: hw, files, citizenIni: install?.fivem.ini ?? {}, citizenIniPath: install?.fivem.appDir ? join(install.fivem.appDir, 'CitizenFX.ini') : null }
  }
})

defineQuery({
  id: 'fivem.settings.profile',
  module: 'fivem',
  parse(raw) {
    const p = obj(raw, ['file', 'profile'])
    return { file: oneOf(p.file, 'arquivo', ['fivem', 'gta'] as const), profile: oneOf(p.profile, 'perfil', ['performance', 'balanced', 'quality'] as const) }
  },
  async run({ file, profile }) {
    const data = readSettingsFile(file)
    if (!data) return { exists: false, changes: [], notEdited: [] }
    const hw = await hardwareProfile()
    return {
      exists: true,
      changes: buildGraphicsProfile(data.values, hw, profile),
      notEdited: Object.entries(NOT_EDITED)
        .filter(([k]) => data.values[k] !== undefined)
        .map(([key, reason]) => ({ key, current: data.values[key], reason })),
      frameLimit: 'O GTA V/FiveM não grava limite de quadros neste arquivo; use o limitador do driver de vídeo se quiser um limite.'
    }
  }
})

interface SettingsBackup {
  file: 'fivem' | 'gta'
  path: string
  content: string
}

defineAction<{ file: 'fivem' | 'gta'; changes: Record<string, string> }, SettingsBackup>({
  id: 'fivem.settings.apply',
  module: 'fivem',
  title: 'Aplicar ajustes gráficos do FiveM/GTA V',
  description: 'Altera somente as chaves escolhidas do arquivo de configurações gráficas, com cópia completa do arquivo original.',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'fivem-files',
  parse(raw) {
    const p = obj(raw, ['file', 'changes'])
    const file = oneOf(p.file, 'arquivo', ['fivem', 'gta'] as const)
    const changesRaw = obj(p.changes, Object.keys(TUNABLE))
    const changes: Record<string, string> = {}
    for (const [k, v] of Object.entries(changesRaw)) {
      const value = str(v, k, 12)
      if (!TUNABLE[k].allowed.test(value)) throw new AppFailure('invalid-input', `Valor não permitido para ${k}: ${value}.`)
      changes[k] = value
    }
    if (Object.keys(changes).length === 0) throw new AppFailure('invalid-input', 'Nenhuma alteração escolhida.')
    return { file, changes }
  },
  async preview({ file, changes }) {
    const data = readSettingsFile(file)
    const running = await runningGameProcesses()
    return {
      summary: data ? `${data.label}: ${Object.keys(changes).length} ajuste(s).` : 'Arquivo não encontrado.',
      changes: Object.entries(changes).map(([k, v]) => ({ target: `${TUNABLE[k].label} (${k})`, current: data?.values[k] ?? 'ausente', intended: v })),
      warnings: [
        'Uma cópia completa do arquivo atual é guardada para reversão.',
        'Ganhos de FPS dependem do hardware e do servidor; meça antes e depois na aba Gargalos.'
      ],
      blocked: !data
        ? 'O arquivo de configurações não existe (abra o jogo uma vez para criá-lo).'
        : running.length
          ? `Feche o FiveM/GTA V antes (em execução: ${running.join(', ')}); o jogo regrava o arquivo ao fechar.`
          : Object.keys(changes).find((k) => data.values[k] === undefined)
            ? 'Alguma chave escolhida não existe neste arquivo.'
            : null
    }
  },
  async precheck() {
    const running = await runningGameProcesses()
    return running.length ? 'Feche o FiveM/GTA V antes de aplicar.' : null
  },
  async execute({ file, changes }) {
    const data = readSettingsFile(file)
    if (!data) throw new AppFailure('not-found', 'Arquivo não encontrado.')
    const updated = applyGtaSettings(data.xml, changes)
    writeFileSync(data.path, updated, 'utf8')
    const check = parseGtaSettings(readFileSync(data.path, 'utf8'))
    const ok = Object.entries(changes).every(([k, v]) => check[k] === v)
    return {
      ok,
      verified: true,
      summary: ok ? `${Object.keys(changes).length} ajuste(s) aplicados e conferidos em ${basename(data.path)}.` : 'Os valores lidos depois da gravação não conferem.',
      change: {
        before: { file, path: data.path, content: data.xml },
        after: { sha256: createHash('sha256').update(updated).digest('hex'), changes },
        summaryBefore: Object.keys(changes).map((k) => `${k}=${data.values[k]}`).join(', '),
        summaryAfter: Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(', ')
      }
    }
  },
  async revert(before, after, ctx) {
    if (!existsSync(before.path)) throw new AppFailure('not-found', 'O arquivo de configurações não existe mais.')
    const current = readFileSync(before.path, 'utf8')
    const expected = (after as { sha256: string }).sha256
    if (createHash('sha256').update(current).digest('hex') !== expected && !ctx.force) {
      throw new AppFailure('state-changed', 'O arquivo foi modificado depois do ajuste (provavelmente pelo jogo). Use "forçar" para restaurar a cópia original mesmo assim.')
    }
    if ((await runningGameProcesses()).length) throw new AppFailure('blocked', 'Feche o FiveM/GTA V antes de reverter.')
    writeFileSync(before.path, before.content, 'utf8')
    if (readFileSync(before.path, 'utf8') !== before.content) throw new AppFailure('revert-failed', 'A cópia restaurada não confere.')
    return 'Arquivo de configurações original restaurado.'
  }
})

// ---------------------------------------------------------------------------
// 7.4 Diagnóstico de memória
// ---------------------------------------------------------------------------

const GAME_MEMORY = `
@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(GTA5|GTA5_Enhanced|FiveM|FiveM_.*)$' } | ForEach-Object {
  $start = $null; try { $start = $_.StartTime.ToUniversalTime().ToString('o') } catch {}
  [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; ws = $_.WorkingSet64; private = $_.PrivateMemorySize64; paged = $_.PagedMemorySize64; virtual = $_.VirtualMemorySize64; peakWs = $_.PeakWorkingSet64; start = $start }
}) | ConvertTo-Json -Compress`

async function gameMemory() {
  const r = await runPowerShellJson<unknown>(GAME_MEMORY)
  return asArray(r).map((p) => {
    const x = p as Record<string, unknown>
    return {
      pid: asNumber(x.pid) ?? 0,
      name: String(x.name),
      workingSet: asNumber(x.ws) ?? 0,
      privateBytes: asNumber(x.private) ?? 0,
      pagedBytes: asNumber(x.paged) ?? 0,
      virtualBytes: asNumber(x.virtual) ?? 0,
      peakWorkingSet: asNumber(x.peakWs) ?? 0,
      startTime: asString(x.start)
    }
  })
}

/** Tendência linear (bytes por minuto) por mínimos quadrados. Exportada para testes. */
export function growthPerMinute(points: { t: number; v: number }[]): number | null {
  if (points.length < 3) return null
  const n = points.length
  const t0 = points[0].t
  const xs = points.map((p) => (p.t - t0) / 60000)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = points.reduce((a, p) => a + p.v, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (points[i].v - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? null : num / den
}

defineQuery({ id: 'fivem.memory.now', module: 'fivem', parse: noParams, run: async () => ({ at: new Date().toISOString(), processes: await gameMemory(), sample: demandSample() }) })

defineQuery({
  id: 'fivem.memory.record',
  module: 'fivem',
  parse: (raw) => ({ minutes: int(obj(raw, ['minutes']).minutes, 'duração (min)', 1, 60, 5), intervalSec: 10 }),
  async run({ minutes, intervalSec }, ctx) {
    const series: { t: number; processes: Awaited<ReturnType<typeof gameMemory>>; commitPct: number | null }[] = []
    const end = Date.now() + minutes * 60_000
    while (Date.now() < end && !ctx.signal.aborted) {
      const processes = await gameMemory()
      const sample = demandSample()
      series.push({ t: Date.now(), processes, commitPct: sample?.memory.commitPct ?? null })
      ctx.progress(`${series.length} amostras`, Date.now() - (end - minutes * 60_000), minutes * 60_000, series.at(-1))
      await new Promise((r) => setTimeout(r, intervalSec * 1000))
    }
    const main = (s: (typeof series)[number]) => s.processes.reduce((a, p) => a + p.privateBytes, 0)
    const growth = growthPerMinute(series.filter((s) => s.processes.length).map((s) => ({ t: s.t, v: main(s) })))
    const maxCommit = Math.max(...series.map((s) => s.commitPct ?? 0))
    return {
      series,
      cancelled: ctx.signal.aborted,
      privateGrowthBytesPerMin: growth,
      maxCommitPct: series.some((s) => s.commitPct !== null) ? maxCommit : null,
      pressure: maxCommit >= 90 ? 'Pressão de memória alta: a memória comprometida passou de 90% do limite.' : null,
      note: series.every((s) => s.processes.length === 0) ? 'Nenhum processo do FiveM/GTA V esteve em execução durante a gravação.' : null
    }
  }
})

// ---------------------------------------------------------------------------
// 7.6 Verificador de arquivos e modificações locais (somente leitura)
// ---------------------------------------------------------------------------

const KNOWN_FILES: { pattern: RegExp; what: string; note: string }[] = [
  { pattern: /^dinput8\.dll$/i, what: 'Carregador de ASI (dinput8.dll)', note: 'Usado para carregar plugins .asi no GTA V. O FiveM não carrega plugins da pasta do GTA.' },
  { pattern: /^ScriptHookV\.dll$/i, what: 'Script Hook V', note: 'Bloqueado pelo FiveM; afeta apenas o GTA V fora do FiveM.' },
  { pattern: /^ScriptHookVDotNet.*\.(dll|asi)$/i, what: 'Script Hook V .NET', note: 'Plugin para o modo história do GTA V.' },
  { pattern: /\.asi$/i, what: 'Plugin ASI', note: 'Plugin carregado por um carregador de ASI.' },
  { pattern: /^(dxgi|d3d11)\.dll$/i, what: 'Injeção gráfica (ReShade/ENB) por DLL', note: 'Pode conflitar com overlays e com o FiveM; o FiveM tem suporte próprio a ReShade em FiveM.app\\plugins.' },
  { pattern: /^(enbseries|enblocal)\.ini$/i, what: 'Configuração ENB', note: 'Modificação gráfica.' },
  { pattern: /^ReShade\.ini$/i, what: 'Configuração ReShade', note: 'Modificação gráfica.' },
  { pattern: /^commandline\.txt$/i, what: 'Argumentos de linha de comando do GTA V', note: 'Parâmetros extras lidos pelo jogo.' },
  { pattern: /^OpenIV\.asi$/i, what: 'OpenIV.asi', note: 'Permite carregar a pasta mods\\ do GTA V.' }
]

defineQuery({
  id: 'fivem.files.check',
  module: 'fivem',
  parse: noParams,
  async run() {
    const install = await detectInstall()
    const results: { location: string; file: string; what: string; note: string; confidence: 'confirmed' | 'possible'; sizeBytes: number | null }[] = []
    const check = (dir: string | null, label: string) => {
      if (!dir || !existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const known = KNOWN_FILES.find((k) => k.pattern.test(entry.name))
        if (known && entry.isFile()) {
          results.push({ location: label, file: join(dir, entry.name), what: known.what, note: known.note, confidence: 'confirmed', sizeBytes: statSync(join(dir, entry.name)).size })
        }
        if (entry.isDirectory() && /^(mods|scripts|reshade-shaders|enbseries)$/i.test(entry.name)) {
          results.push({ location: label, file: join(dir, entry.name), what: `Pasta "${entry.name}"`, note: 'Indica modificações locais; o conteúdo não foi analisado.', confidence: 'possible', sizeBytes: null })
        }
      }
    }
    check(install.gta?.dir ?? null, 'Pasta do GTA V')
    if (install.fivem.appDir) {
      for (const sub of ['plugins', 'mods']) {
        const dir = join(install.fivem.appDir, sub)
        if (existsSync(dir)) {
          const files = readdirSync(dir)
          if (files.length) {
            results.push({
              location: 'FiveM.app',
              file: dir,
              what: sub === 'plugins' ? 'Plugins do cliente FiveM (ex.: ReShade)' : 'Mods do cliente FiveM',
              note: `${files.length} item(ns). Servidores com "modo puro" podem recusar mods do cliente.`,
              confidence: 'possible',
              sizeBytes: null
            })
          }
        }
      }
    }
    return {
      scanned: [install.gta?.dir ?? null, install.fivem.appDir].filter(Boolean),
      results,
      disclaimer: 'Nomes de arquivo não provam que algo é malicioso ou proibido. Nada foi alterado; arquivos de servidor e do anticheat não são examinados.'
    }
  }
})

// ---------------------------------------------------------------------------
// 7.7 / 7.9 Perfis por servidor e inicialização
// ---------------------------------------------------------------------------

const ADDRESS = /^([a-zA-Z0-9.-]{1,253}|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$|^cfx\.re\/join\/[a-z0-9]{3,10}$/i

function parseProfile(raw: unknown): Omit<ServerProfile, 'id' | 'createdAt' | 'updatedAt'> {
  const p = obj(raw, ['name', 'address', 'notes', 'preferredPlan'])
  return {
    name: str(p.name, 'nome', 60).trim(),
    address: p.address === null || p.address === undefined || p.address === '' ? null : str(p.address, 'endereço', 260, ADDRESS),
    notes: p.notes === undefined || p.notes === '' ? '' : str(p.notes, 'notas', 500),
    preferredPlan: p.preferredPlan === null || p.preferredPlan === undefined || p.preferredPlan === '' ? null : str(p.preferredPlan, 'plano', 38, /^[0-9a-f-]{36}$/i)
  }
}

defineQuery({ id: 'fivem.profiles.list', module: 'fivem', parse: noParams, run: async () => config.read().profiles })

defineQuery({
  id: 'fivem.profiles.save',
  module: 'fivem',
  parse(raw) {
    const p = obj(raw, ['id', 'profile'])
    return { id: p.id === undefined || p.id === null ? null : str(p.id, 'id', 40), profile: parseProfile(p.profile) }
  },
  async run({ id, profile }) {
    const cfg = config.read()
    const now = new Date().toISOString()
    if (id) {
      const existing = cfg.profiles.find((p) => p.id === id)
      if (!existing) throw new AppFailure('not-found', 'Perfil não encontrado.')
      Object.assign(existing, profile, { updatedAt: now })
    } else {
      if (cfg.profiles.length >= 100) throw new AppFailure('limit', 'Limite de 100 perfis.')
      cfg.profiles.push({ id: randomUUID(), ...profile, createdAt: now, updatedAt: now })
    }
    return config.write(cfg).profiles
  }
})

defineQuery({
  id: 'fivem.profiles.duplicate',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'id', 40) }),
  async run({ id }) {
    const cfg = config.read()
    const p = cfg.profiles.find((x) => x.id === id)
    if (!p) throw new AppFailure('not-found', 'Perfil não encontrado.')
    const now = new Date().toISOString()
    cfg.profiles.push({ ...p, id: randomUUID(), name: `${p.name} (cópia)`.slice(0, 60), createdAt: now, updatedAt: now })
    return config.write(cfg).profiles
  }
})

defineQuery({
  id: 'fivem.profiles.delete',
  module: 'fivem',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'id', 40) }),
  async run({ id }) {
    const cfg = config.read()
    if (!cfg.profiles.some((p) => p.id === id)) throw new AppFailure('not-found', 'Perfil não encontrado.')
    cfg.profiles = cfg.profiles.filter((p) => p.id !== id)
    return config.write(cfg).profiles
  }
})

defineQuery({
  id: 'fivem.profiles.export',
  module: 'fivem',
  parse: noParams,
  async run() {
    const win = BrowserWindow.getFocusedWindow()
    const options = { title: 'Exportar perfis', defaultPath: 'jk-optimize-perfis-fivem.json', filters: [{ name: 'JSON', extensions: ['json'] }] }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { saved: null }
    writeFileSync(picked.filePath, JSON.stringify({ format: 'jk-optimize-fivem-profiles', version: 1, profiles: config.read().profiles }, null, 2), 'utf8')
    return { saved: picked.filePath }
  }
})

defineAction<{ address: string | null }, never>({
  id: 'fivem.launch',
  module: 'fivem',
  title: 'Iniciar FiveM',
  description: 'Abre o FiveM; com um endereço, usa o link oficial fivem://connect/ para entrar no servidor.',
  risk: 'none',
  reversible: false,
  irreversibleReason: 'Apenas abre o jogo; não altera configurações.',
  requiresElevation: false,
  parse(raw) {
    const p = obj(raw, ['address'])
    return { address: p.address === null || p.address === undefined || p.address === '' ? null : str(p.address, 'endereço', 260, ADDRESS) }
  },
  async preview({ address }) {
    const install = await detectInstall()
    return {
      summary: address ? `Conectar a ${address}` : 'Abrir o FiveM',
      changes: [],
      warnings: ['Nenhum parâmetro extra de desempenho é adicionado: só são usados mecanismos oficiais do FiveM.'],
      blocked: install.fivem.found ? null : 'FiveM não encontrado.'
    }
  },
  async execute({ address }) {
    const install = await detectInstall()
    if (address) await shell.openExternal(`fivem://connect/${address}`)
    else {
      const err = await shell.openPath(join(install.fivem.dir!, 'FiveM.exe'))
      if (err) throw new AppFailure('launch-failed', err)
    }
    return { ok: true, verified: false, summary: address ? `FiveM solicitado para conectar a ${address}.` : 'FiveM aberto.' }
  }
})
