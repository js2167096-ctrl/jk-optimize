// Módulo de limpeza e armazenamento: temporários, caches de shaders e analisador.
import { shell } from 'electron'
import { existsSync, statfsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { formatBytes } from '@shared/format'
import type { TaskDetailSection } from '@shared/types'
import { defineAction, defineQuery } from '../ops/registry'
import { bool, int, noParams, obj, oneOf, str } from '../ops/params'
import { AppFailure } from '../security/validate'
import { runElevated } from '../services/elevated'
import { getStaticInfo } from '../services/system'
import { categorize, deleteFilesSafely, isInside, mergeScans, scanFiles, userTempPaths, type ScanResult } from './fsutil'

const MAX_ELEVATED_FILES = 100_000

/** Espaço livre real da unidade que contém o caminho. */
function driveFree(path: string): number | null {
  try {
    const s = statfsSync(path)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}
const env = (name: string) => process.env[name] ?? ''

// ---------------------------------------------------------------------------
// 4.1 Temporários
// ---------------------------------------------------------------------------

export interface TempRoot {
  id: 'user' | 'windows' | 'prefetch'
  label: string
  /** Primeira pasta (para exibição). */
  path: string
  /** Todas as pastas da raiz, sem repetição (%TEMP%, %TMP% e %LOCALAPPDATA%\Temp costumam ser a mesma). */
  paths: string[]
  needsAdmin: boolean
}

export function tempRoots(): TempRoot[] {
  const user = userTempPaths()
  const roots: TempRoot[] = [{ id: 'user', label: 'Temporários do usuário (%TEMP%, %TMP%)', path: user[0] ?? os.tmpdir(), paths: user.length ? user : [os.tmpdir()], needsAdmin: false }]
  const sysRoot = env('SystemRoot') || 'C:\\Windows'
  const winTemp = join(sysRoot, 'Temp')
  if (existsSync(winTemp)) roots.push({ id: 'windows', label: 'Temporários do Windows', path: winTemp, paths: [winTemp], needsAdmin: true })
  const prefetch = join(sysRoot, 'Prefetch')
  if (existsSync(prefetch)) roots.push({ id: 'prefetch', label: 'Prefetch do Windows', path: prefetch, paths: [prefetch], needsAdmin: true })
  return roots
}

interface TempParams {
  roots: ('user' | 'windows' | 'prefetch')[]
  minAgeHours: number
}

function parseTemp(raw: unknown): TempParams {
  const p = obj(raw, ['roots', 'minAgeHours'])
  if (!Array.isArray(p.roots) || p.roots.length === 0 || p.roots.length > 3) throw new AppFailure('invalid-input', 'Escolha ao menos uma pasta.')
  const roots = [...new Set(p.roots.map((r) => oneOf(r, 'pasta', ['user', 'windows', 'prefetch'] as const)))]
  // 0 = sem filtro de idade (arquivos em uso continuam sendo ignorados). Padrão de 1 h: o filtro antigo de 24 h deixava quase tudo de fora.
  return { roots, minAgeHours: int(p.minAgeHours, 'idade mínima (horas)', 0, 720, 1) }
}

const SCAN_LIMITS = { maxEntries: 400_000, maxMs: 90_000 }

async function scanTemp(params: TempParams, signal: AbortSignal, progress: (m: string, d?: number) => void) {
  const results: { root: TempRoot; scan: ScanResult }[] = []
  for (const root of tempRoots().filter((r) => params.roots.includes(r.id))) {
    const scans: ScanResult[] = []
    for (const path of root.paths) {
      scans.push(
        await scanFiles(path, {
          ...SCAN_LIMITS,
          minAgeMs: params.minAgeHours * 3_600_000,
          signal,
          onProgress: (visited) => progress(`Analisando ${root.label}: ${visited.toLocaleString('pt-BR')} itens`, visited)
        })
      )
    }
    results.push({ root, scan: mergeScans(scans) })
  }
  return results
}

function scanNote(scan: ScanResult): string | null {
  if (scan.reason === 'entry-limit') return 'Varredura parcial: limite de itens atingido.'
  if (scan.reason === 'time-limit') return 'Varredura parcial: limite de tempo atingido.'
  return null
}

defineQuery({
  id: 'cleanup.temp.scan',
  module: 'cleanup',
  parse: parseTemp,
  async run(params, ctx) {
    const results = await scanTemp(params, ctx.signal, ctx.progress)
    return results.map(({ root, scan }) => ({
      id: root.id,
      label: root.label,
      path: root.path,
      paths: root.paths,
      needsAdmin: root.needsAdmin,
      files: scan.files.length,
      bytes: scan.totalBytes,
      skippedRecent: scan.skippedRecent,
      skippedLinks: scan.skippedLinks,
      inaccessible: scan.inaccessible.length,
      note: scanNote(scan),
      largest: [...scan.files]
        .sort((a, b) => b.size - a.size)
        .slice(0, 40)
        .map((f) => ({ path: f.path, size: f.size, modified: new Date(f.mtimeMs).toISOString() }))
    }))
  }
})

// Script elevado: remove somente arquivos da lista que estejam dentro de C:\Windows\Temp,
// não sejam pontos de reanálise e sejam arquivos comuns.
const ELEVATED_TEMP_DELETE = `
$sub = if ([string]$in.root -eq 'prefetch') { 'Prefetch' } else { 'Temp' }
$root = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot $sub)).TrimEnd('\\') + '\\'
$deleted = 0; $bytes = 0; $locked = 0; $outside = 0
foreach ($p in @($in.files)) {
  try {
    $full = [IO.Path]::GetFullPath([string]$p)
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $outside++; continue }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $outside++; continue }
    $size = $item.Length
    Remove-Item -LiteralPath $full -Force -ErrorAction Stop
    $deleted++; $bytes += $size
  } catch { $locked++ }
}
Out-Result ([pscustomobject]@{ deleted = $deleted; bytes = $bytes; locked = $locked; outside = $outside })
exit 0`

defineAction<TempParams & { elevated: boolean }, never>({
  id: 'cleanup.temp.clean',
  module: 'cleanup',
  title: 'Limpar arquivos temporários',
  description: 'Remove arquivos temporários antigos das pastas escolhidas, ignorando arquivos em uso, recentes e links.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Arquivos apagados não vão para a Lixeira.',
  requiresElevation: (p) => p.elevated && (p.roots.includes('windows') || p.roots.includes('prefetch')),
  exclusive: 'cleanup',
  parse(raw) {
    const p = obj(raw, ['roots', 'minAgeHours', 'elevated'])
    return { ...parseTemp({ roots: p.roots, minAgeHours: p.minAgeHours }), elevated: bool(p.elevated, 'elevar', false) }
  },
  async preview(params, ctx) {
    const results = await scanTemp(params, ctx.signal, ctx.progress)
    const total = results.reduce((s, r) => s + r.scan.totalBytes, 0)
    const count = results.reduce((s, r) => s + r.scan.files.length, 0)
    return {
      summary: `${count.toLocaleString('pt-BR')} arquivos elegíveis, ${formatBytes(total)}. Somente arquivos com mais de ${params.minAgeHours} h.`,
      changes: results.map(({ root, scan }) => ({
        target: `${root.label} (${root.paths.join('; ')})`,
        current: `${scan.files.length.toLocaleString('pt-BR')} arquivos · ${formatBytes(scan.totalBytes)}`,
        intended: 'Arquivos elegíveis removidos'
      })),
      warnings: [
        'Arquivos em uso, recentes, links simbólicos e junctions são ignorados.',
        ...((params.roots.includes('windows') || params.roots.includes('prefetch')) && !params.elevated
          ? ['Sem administrador, a maior parte de C:\\Windows\\Temp e Prefetch será ignorada por falta de permissão.']
          : []),
        ...(params.roots.includes('prefetch') ? ['Prefetch: o Windows recria esses arquivos; as primeiras aberturas de programas podem ficar um pouco mais lentas.'] : []),
        ...results.map((r) => scanNote(r.scan)).filter((n): n is string => !!n)
      ],
      blocked: count === 0 ? 'Nenhum arquivo elegível encontrado.' : null
    }
  },
  async execute(params, ctx) {
    const results = await scanTemp(params, ctx.signal, ctx.progress)
    const sections: TaskDetailSection[] = []
    const removed: string[] = []
    const freeBefore = driveFree(os.tmpdir())
    let freed = 0
    let deleted = 0
    for (const { root, scan } of results) {
      if ((root.id === 'windows' || root.id === 'prefetch') && params.elevated) {
        ctx.progress('Aguardando permissão de administrador…')
        const { output } = await runElevated<{ deleted: number; bytes: number; locked: number; outside: number }>(
          ELEVATED_TEMP_DELETE,
          { root: root.id, files: scan.files.slice(0, MAX_ELEVATED_FILES).map((f) => f.path) },
          { timeoutMs: 15 * 60_000, signal: ctx.signal }
        )
        const r = output ?? { deleted: 0, bytes: 0, locked: 0, outside: 0 }
        freed += r.bytes
        deleted += r.deleted
        sections.push({
          title: root.label,
          rows: [
            { label: 'Removidos', value: `${r.deleted.toLocaleString('pt-BR')} arquivos · ${formatBytes(r.bytes)}`, tone: 'ok' },
            { label: 'Em uso ou bloqueados', value: String(r.locked) },
            { label: 'Fora da raiz/links', value: String(r.outside) }
          ]
        })
        continue
      }
      const report = await deleteFilesSafely(scan.files, root.paths, {
        signal: ctx.signal,
        minAgeMs: params.minAgeHours * 3_600_000,
        onProgress: (done, total) => ctx.progress(`Removendo (${root.label})`, done, total)
      })
      freed += report.bytesFreed
      deleted += report.deleted
      removed.push(...report.removedSample)
      sections.push({
        title: root.label,
        rows: [
          { label: 'Removidos', value: `${report.deleted.toLocaleString('pt-BR')} arquivos · ${formatBytes(report.bytesFreed)}`, tone: 'ok' },
          { label: 'Em uso (ignorados)', value: String(report.skippedLocked) },
          { label: 'Sem permissão (ignorados)', value: String(report.skippedDenied), tone: report.skippedDenied ? 'warn' : 'neutral' },
          { label: 'Alterados/links (ignorados)', value: String(report.skippedChanged + report.skippedOutside) },
          { label: 'Pastas vazias removidas', value: String(report.removedDirs) },
          ...report.errors.slice(0, 5).map((e) => ({ label: 'Erro', value: e, tone: 'error' as const }))
        ]
      })
    }
    // Medição real: espaço livre da unidade antes e depois (outros programas podem
    // gravar ao mesmo tempo, por isso os dois números são mostrados).
    const freeAfter = driveFree(os.tmpdir())
    const measured = freeBefore !== null && freeAfter !== null ? freeAfter - freeBefore : null
    sections.push({
      title: 'Medição',
      rows: [
        { label: 'Soma dos arquivos removidos', value: formatBytes(freed) },
        { label: 'Espaço livre na unidade (medido)', value: freeBefore !== null && freeAfter !== null ? `${formatBytes(freeBefore)} → ${formatBytes(freeAfter)} (${measured! >= 0 ? '+' : '−'}${formatBytes(Math.abs(measured!))})` : 'indisponível' }
      ]
    })
    if (removed.length) sections.push({ title: `Arquivos removidos (primeiros ${removed.length})`, rows: removed.slice(0, 50).map((p, i) => ({ label: String(i + 1), value: p })) })
    return {
      ok: true,
      verified: true,
      summary: `${deleted.toLocaleString('pt-BR')} arquivos removidos; espaço livre ${measured === null ? '' : `${measured >= 0 ? '+' : '−'}${formatBytes(Math.abs(measured))} medido`} (soma dos arquivos: ${formatBytes(freed)}).`,
      sections
    }
  }
})

// ---------------------------------------------------------------------------
// 4.2 Caches de shaders
// ---------------------------------------------------------------------------

type Vendor = 'nvidia' | 'amd' | 'intel' | 'any'

interface ShaderCacheDef {
  id: string
  label: string
  path: string
  vendor: Vendor
  description: string
}

function shaderCacheDefs(): ShaderCacheDef[] {
  const local = env('LOCALAPPDATA')
  const localLow = local ? join(local, '..', 'LocalLow') : ''
  const programData = env('ProgramData')
  return [
    { id: 'd3d', label: 'Cache de shaders do DirectX', path: join(local, 'D3DSCache'), vendor: 'any', description: 'Mantido pelo Windows (o mesmo da Limpeza de Disco).' },
    { id: 'nv-dx', label: 'NVIDIA DXCache', path: join(local, 'NVIDIA', 'DXCache'), vendor: 'nvidia', description: 'Cache DirectX do driver NVIDIA.' },
    { id: 'nv-gl', label: 'NVIDIA GLCache', path: join(local, 'NVIDIA', 'GLCache'), vendor: 'nvidia', description: 'Cache OpenGL/Vulkan do driver NVIDIA.' },
    { id: 'nv-low', label: 'NVIDIA PerDriverVersion', path: join(localLow, 'NVIDIA', 'PerDriverVersion', 'DXCache'), vendor: 'nvidia', description: 'Cache por versão de driver (drivers recentes).' },
    { id: 'nv-pd', label: 'NVIDIA NV_Cache', path: join(programData, 'NVIDIA Corporation', 'NV_Cache'), vendor: 'nvidia', description: 'Cache compartilhado do driver NVIDIA.' },
    { id: 'amd-dx', label: 'AMD DxCache', path: join(local, 'AMD', 'DxCache'), vendor: 'amd', description: 'Cache DirectX do driver AMD.' },
    { id: 'amd-dxc', label: 'AMD DxcCache', path: join(local, 'AMD', 'DxcCache'), vendor: 'amd', description: 'Cache do compilador DXC do driver AMD.' },
    { id: 'amd-gl', label: 'AMD GLCache', path: join(local, 'AMD', 'GLCache'), vendor: 'amd', description: 'Cache OpenGL do driver AMD.' },
    { id: 'amd-vk', label: 'AMD VkCache', path: join(local, 'AMD', 'VkCache'), vendor: 'amd', description: 'Cache Vulkan do driver AMD.' },
    { id: 'intel', label: 'Intel ShaderCache', path: join(localLow, 'Intel', 'ShaderCache'), vendor: 'intel', description: 'Cache de shaders do driver Intel.' }
  ]
}

async function detectVendors(): Promise<Set<Vendor>> {
  const info = await getStaticInfo(false)
  const vendors = new Set<Vendor>(['any'])
  for (const gpu of info.gpus) {
    const name = gpu.name.toLowerCase()
    if (name.includes('nvidia') || name.includes('geforce') || name.includes('quadro')) vendors.add('nvidia')
    if (name.includes('amd') || name.includes('radeon')) vendors.add('amd')
    if (name.includes('intel')) vendors.add('intel')
  }
  return vendors
}

async function shaderCaches(signal: AbortSignal) {
  const vendors = await detectVendors()
  const out = []
  for (const def of shaderCacheDefs()) {
    if (!def.path || !existsSync(def.path)) continue
    const scan = await scanFiles(def.path, { maxEntries: 200_000, maxMs: 30_000, signal })
    out.push({
      ...def,
      confirmed: vendors.has(def.vendor),
      files: scan.files.length,
      bytes: scan.totalBytes,
      partial: scan.partial,
      scan
    })
  }
  return out
}

defineQuery({
  id: 'cleanup.shaders.scan',
  module: 'cleanup',
  parse: noParams,
  async run(_p, ctx) {
    return (await shaderCaches(ctx.signal)).map(({ scan: _scan, ...rest }) => rest)
  }
})

defineAction<{ ids: string[] }, never>({
  id: 'cleanup.shaders.clean',
  module: 'cleanup',
  title: 'Limpar caches de shaders',
  description: 'Remove caches de shaders confirmados para a GPU instalada. Eles são recriados automaticamente.',
  risk: 'low',
  reversible: false,
  irreversibleReason: 'O cache é recriado pelos jogos e drivers, mas os arquivos apagados não voltam.',
  requiresElevation: false,
  exclusive: 'cleanup',
  parse(raw) {
    const p = obj(raw, ['ids'])
    if (!Array.isArray(p.ids) || p.ids.length === 0 || p.ids.length > 20) throw new AppFailure('invalid-input', 'Escolha ao menos um cache.')
    const valid = new Set(shaderCacheDefs().map((d) => d.id))
    const ids = p.ids.map((id) => str(id, 'cache', 20))
    for (const id of ids) if (!valid.has(id)) throw new AppFailure('invalid-input', `Cache desconhecido: ${id}.`)
    return { ids }
  },
  async preview(params, ctx) {
    const caches = (await shaderCaches(ctx.signal)).filter((c) => params.ids.includes(c.id))
    const unconfirmed = caches.filter((c) => !c.confirmed)
    return {
      summary: `${caches.length} cache(s), ${formatBytes(caches.reduce((s, c) => s + c.bytes, 0))} no total.`,
      changes: caches.map((c) => ({ target: `${c.label} (${c.path})`, current: `${c.files} arquivos · ${formatBytes(c.bytes)}`, intended: 'Esvaziado' })),
      warnings: [
        'Depois da limpeza, jogos podem carregar mais devagar e ter travadas momentâneas enquanto os shaders são recompilados.',
        'Feche os jogos antes de limpar; arquivos em uso são ignorados.'
      ],
      blocked: unconfirmed.length
        ? `Não confirmado para a GPU instalada: ${unconfirmed.map((c) => c.label).join(', ')}.`
        : caches.length === 0
          ? 'Nenhum dos caches escolhidos existe neste computador.'
          : null
    }
  },
  async execute(params, ctx) {
    const caches = (await shaderCaches(ctx.signal)).filter((c) => params.ids.includes(c.id) && c.confirmed)
    const sections: TaskDetailSection[] = []
    let freed = 0
    for (const cache of caches) {
      const report = await deleteFilesSafely(cache.scan.files, [cache.path], { signal: ctx.signal })
      freed += report.bytesFreed
      sections.push({
        title: cache.label,
        rows: [
          { label: 'Removidos', value: `${report.deleted} arquivos · ${formatBytes(report.bytesFreed)}`, tone: 'ok' },
          { label: 'Em uso (ignorados)', value: String(report.skippedLocked) },
          { label: 'Sem permissão', value: String(report.skippedDenied) }
        ]
      })
    }
    return { ok: true, verified: true, summary: `${formatBytes(freed)} recuperados de ${caches.length} cache(s).`, sections }
  }
})

// ---------------------------------------------------------------------------
// 4.3 Analisador de armazenamento
// ---------------------------------------------------------------------------

/** Caminhos devolvidos pela última análise: só eles podem ser abertos no Explorador. */
const revealable = new Set<string>()

defineQuery({
  id: 'cleanup.storage.drives',
  module: 'cleanup',
  parse: noParams,
  async run() {
    const info = await getStaticInfo(true)
    return info.disks.map((d) => {
      let fs: { total: number; free: number } | null = null
      try {
        const s = statfsSync(`${d.drive}\\`)
        fs = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
      } catch {
        fs = null
      }
      return { ...d, totalBytes: fs?.total ?? d.totalBytes, freeBytes: fs?.free ?? d.freeBytes }
    })
  }
})

function analysisRoots(): Record<string, string> {
  const home = os.homedir()
  return {
    home,
    downloads: join(home, 'Downloads'),
    documents: join(home, 'Documents'),
    desktop: join(home, 'Desktop'),
    videos: join(home, 'Videos'),
    appdata: env('LOCALAPPDATA')
  }
}

defineQuery({
  id: 'cleanup.storage.analyze',
  module: 'cleanup',
  parse(raw) {
    const p = obj(raw, ['root', 'drive'])
    if (p.drive !== undefined) return { drive: str(p.drive, 'unidade', 3, /^[A-Za-z]:$/) }
    return { root: oneOf(p.root, 'pasta', ['home', 'downloads', 'documents', 'desktop', 'videos', 'appdata'] as const) }
  },
  async run(params, ctx) {
    const root = 'drive' in params ? `${params.drive!.toUpperCase()}\\` : analysisRoots()[params.root!]
    if (!root || !existsSync(root)) throw new AppFailure('not-found', 'Pasta ou unidade não encontrada.')
    const scan = await scanFiles(root, {
      maxEntries: 1_500_000,
      maxMs: 180_000,
      signal: ctx.signal,
      onProgress: (visited, dir) => ctx.progress(`${visited.toLocaleString('pt-BR')} itens · ${dir}`, visited)
    })
    const categories = new Map<string, { bytes: number; files: number }>()
    const folders = new Map<string, number>()
    for (const f of scan.files) {
      const cat = categorize(f.path)
      const c = categories.get(cat) ?? { bytes: 0, files: 0 }
      c.bytes += f.size
      c.files++
      categories.set(cat, c)
      const rel = f.path.slice(root.length).replace(/^[\\/]+/, '')
      const top = rel.includes('\\') ? join(root, rel.split('\\')[0]) : root
      folders.set(top, (folders.get(top) ?? 0) + f.size)
    }
    revealable.clear()
    const largest = [...scan.files].sort((a, b) => b.size - a.size).slice(0, 50)
    const topFolders = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
    for (const f of largest) revealable.add(f.path)
    for (const [path] of topFolders) revealable.add(path)
    return {
      root,
      logicalBytes: scan.totalBytes,
      files: scan.files.length,
      visited: scan.visited,
      partial: scan.partial,
      reason: scan.reason,
      skippedLinks: scan.skippedLinks,
      inaccessible: scan.inaccessible.slice(0, 50),
      inaccessibleCount: scan.inaccessible.length,
      categories: [...categories.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes),
      folders: topFolders.map(([path, bytes]) => ({ path, bytes })),
      largest: largest.map((f) => ({ path: f.path, size: f.size, category: categorize(f.path), modified: new Date(f.mtimeMs).toISOString() }))
    }
  }
})

defineQuery({
  id: 'cleanup.storage.reveal',
  module: 'cleanup',
  parse: (raw) => ({ path: str(obj(raw, ['path']).path, 'caminho', 1024) }),
  async run({ path }) {
    if (!revealable.has(path)) throw new AppFailure('not-allowed', 'Só é possível abrir caminhos da última análise.')
    if (!Object.values(analysisRoots()).some((r) => isInside(r, path)) && !/^[A-Za-z]:\\/.test(path)) {
      throw new AppFailure('not-allowed', 'Caminho fora das áreas analisadas.')
    }
    shell.showItemInFolder(path)
    return true
  }
})
