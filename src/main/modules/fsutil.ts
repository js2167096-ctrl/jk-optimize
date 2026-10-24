// Varredura e exclusão de arquivos com limites e travas de segurança.
// Módulo puro (somente Node.js) para ser testado com `node --test`.
//
// Garantias:
// - nunca segue links simbólicos nem junctions (no Windows, o lstat do Node
//   reporta junctions como links simbólicos);
// - toda exclusão revalida, no momento de apagar, que o caminho real continua
//   dentro de uma raiz autorizada e que é um arquivo comum;
// - diretórios nunca são apagados em bloco: só arquivos, um a um, e depois
//   apenas pastas que ficaram vazias;
// - varreduras têm limite de entradas e de tempo, e podem ser canceladas.
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

export interface ScanLimits {
  maxEntries: number
  maxMs: number
  /** Ignora arquivos modificados há menos tempo que isso (protege arquivos em uso). */
  minAgeMs?: number
  signal?: AbortSignal
  onProgress?: (visited: number, currentDir: string) => void
}

export interface ScannedFile {
  path: string
  size: number
  mtimeMs: number
}

export interface ScanResult {
  files: ScannedFile[]
  totalBytes: number
  visited: number
  skippedRecent: number
  skippedLinks: number
  inaccessible: string[]
  partial: boolean
  reason: 'complete' | 'entry-limit' | 'time-limit' | 'cancelled'
}

const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, '')

/** true se `target` é a própria raiz ou está dentro dela (comparação sem diferenciar maiúsculas). */
export function isInside(root: string, target: string): boolean {
  const r = norm(root)
  const t = norm(target)
  return t === r || t.startsWith(r + sep) || t.startsWith(r + '/')
}

export async function scanFiles(root: string, limits: ScanLimits): Promise<ScanResult> {
  const started = Date.now()
  const result: ScanResult = {
    files: [],
    totalBytes: 0,
    visited: 0,
    skippedRecent: 0,
    skippedLinks: 0,
    inaccessible: [],
    partial: false,
    reason: 'complete'
  }
  const stack = [root]
  const now = Date.now()
  while (stack.length > 0) {
    if (limits.signal?.aborted) return { ...result, partial: true, reason: 'cancelled' }
    if (result.visited >= limits.maxEntries) return { ...result, partial: true, reason: 'entry-limit' }
    if (Date.now() - started > limits.maxMs) return { ...result, partial: true, reason: 'time-limit' }
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      if (result.inaccessible.length < 200) result.inaccessible.push(dir)
      continue
    }
    for (const entry of entries) {
      result.visited++
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        result.skippedLinks++
        continue
      }
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = await lstat(full)
        if (st.isSymbolicLink()) {
          result.skippedLinks++
          continue
        }
        if (limits.minAgeMs && now - st.mtimeMs < limits.minAgeMs) {
          result.skippedRecent++
          continue
        }
        result.files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
        result.totalBytes += st.size
      } catch {
        if (result.inaccessible.length < 200) result.inaccessible.push(full)
      }
    }
    if (result.visited % 2000 < entries.length) {
      limits.onProgress?.(result.visited, dir)
      await new Promise((r) => setImmediate(r))
    }
  }
  return result
}

export interface DeleteReport {
  deleted: number
  bytesFreed: number
  skippedLocked: number
  skippedDenied: number
  skippedOutside: number
  skippedChanged: number
  errors: string[]
  removedDirs: number
  /** Até 200 caminhos removidos, para conferência. */
  removedSample: string[]
}

/**
 * Apaga somente arquivos comuns dentro das raízes autorizadas, revalidando cada um.
 * Arquivos bloqueados ou negados são ignorados individualmente.
 */
export async function deleteFilesSafely(
  files: ScannedFile[],
  roots: string[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; minAgeMs?: number } = {}
): Promise<DeleteReport> {
  const report: DeleteReport = {
    deleted: 0,
    bytesFreed: 0,
    skippedLocked: 0,
    skippedDenied: 0,
    skippedOutside: 0,
    skippedChanged: 0,
    errors: [],
    removedDirs: 0,
    removedSample: []
  }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => resolve(r))))
  const touchedDirs = new Set<string>()
  let done = 0
  for (const file of files) {
    if (opts.signal?.aborted) break
    done++
    if (done % 200 === 0) opts.onProgress?.(done, files.length)
    try {
      if (!roots.some((r) => isInside(r, file.path))) {
        report.skippedOutside++
        continue
      }
      const st = await lstat(file.path)
      if (!st.isFile() || st.isSymbolicLink()) {
        report.skippedChanged++
        continue
      }
      if (opts.minAgeMs && Date.now() - st.mtimeMs < opts.minAgeMs) {
        report.skippedChanged++
        continue
      }
      const real = await realpath(file.path)
      if (!realRoots.some((r) => isInside(r, real))) {
        report.skippedOutside++
        continue
      }
      await unlink(real)
      if (report.removedSample.length < 200) report.removedSample.push(real)
      report.deleted++
      report.bytesFreed += st.size
      touchedDirs.add(real.slice(0, real.lastIndexOf(sep)))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'ETXTBSY') report.skippedLocked++
      else if (code === 'EPERM' || code === 'EACCES') report.skippedDenied++
      else if (code === 'ENOENT') report.skippedChanged++
      else if (report.errors.length < 50) report.errors.push(`${file.path}: ${(error as Error).message}`)
    }
  }
  // Remove apenas pastas que ficaram vazias, nunca a própria raiz.
  const dirs = [...touchedDirs].sort((a, b) => b.length - a.length)
  for (const dir of dirs) {
    let current = dir
    while (realRoots.some((r) => isInside(r, current) && norm(r) !== norm(current))) {
      try {
        await rmdir(current) // falha se não estiver vazia
        report.removedDirs++
      } catch {
        break
      }
      current = current.slice(0, current.lastIndexOf(sep))
    }
  }
  opts.onProgress?.(files.length, files.length)
  return report
}

// ---------------------------------------------------------------------------
// Categorias para o analisador de armazenamento
// ---------------------------------------------------------------------------

const CATEGORY_EXT: Record<string, string[]> = {
  Vídeos: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.flv'],
  Imagens: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.tif', '.tiff', '.raw', '.psd'],
  Áudio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'],
  Documentos: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.odt', '.rtf', '.csv'],
  Compactados: ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.img'],
  'Instaladores e executáveis': ['.exe', '.msi', '.msix', '.appx', '.dll'],
  'Jogos e pacotes': ['.rpf', '.pak', '.vpk', '.bsa', '.ba2', '.ucas', '.utoc'],
  Temporários: ['.tmp', '.log', '.dmp', '.etl', '.old', '.bak']
}

const EXT_TO_CATEGORY = new Map<string, string>()
for (const [category, exts] of Object.entries(CATEGORY_EXT)) for (const ext of exts) EXT_TO_CATEGORY.set(ext, category)

export function categorize(path: string): string {
  return EXT_TO_CATEGORY.get(extname(path).toLowerCase()) ?? 'Outros'
}

// ---------------------------------------------------------------------------
// Pastas temporárias do usuário e junção de varreduras
// ---------------------------------------------------------------------------

/** Resolve %TEMP%, %TMP% e %LOCALAPPDATA%\Temp, descartando vazios, inexistentes e repetidos (sem diferenciar maiúsculas). Exportada para testes. */
export function userTempPaths(vars: Record<string, string | undefined> = process.env, tmpdir: string = os.tmpdir(), exists: (p: string) => boolean = existsSync): string[] {
  const candidates = [vars.TEMP, vars.TMP, vars.LOCALAPPDATA ? join(vars.LOCALAPPDATA, 'Temp') : '', tmpdir]
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    if (!c || !c.trim()) continue
    const key = resolve(c).toLowerCase().replace(/[\\/]+$/, '')
    if (seen.has(key) || !exists(c)) continue
    seen.add(key)
    out.push(resolve(c))
  }
  return out
}


/** Junta as varreduras das pastas de uma mesma raiz. */
export function mergeScans(scans: ScanResult[]): ScanResult {
  const partial = scans.find((s) => s.partial)
  return {
    files: scans.flatMap((s) => s.files),
    totalBytes: scans.reduce((n, s) => n + s.totalBytes, 0),
    visited: scans.reduce((n, s) => n + s.visited, 0),
    skippedRecent: scans.reduce((n, s) => n + s.skippedRecent, 0),
    skippedLinks: scans.reduce((n, s) => n + s.skippedLinks, 0),
    inaccessible: scans.flatMap((s) => s.inaccessible).slice(0, 200),
    partial: !!partial,
    reason: partial?.reason ?? 'complete'
  }
}

