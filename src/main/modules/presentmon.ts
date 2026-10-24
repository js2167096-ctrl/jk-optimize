// Integração com o PresentMon (Intel, código aberto): mede FPS e frametime
// pelos eventos ETW do Windows, sem injeção em processos nem hooks no jogo.
// O usuário escolhe o executável (não é baixado pelo JK Optimize).
// Suporta a sintaxe da versão 2.x (--opção) e, se falhar, a da 1.x (-opção).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppFailure } from '../security/validate'
import { runElevated } from '../services/elevated'
import { summarizeFrames } from './framestats'

/** Resumo usado pelo analisador de gargalos e relatórios. */
export interface FrameStats {
  frames: number
  durationSec: number
  avgFps: number | null
  low1Fps: number | null
  frametimeAvgMs: number | null
  frametimeP99Ms: number | null
  frametimeMaxMs: number | null
  column: string
}

export const PROCESS_NAME = /^[A-Za-z0-9 _.()-]{1,80}\.exe$/
const FRAME_COLUMNS = ['MsBetweenPresents', 'msBetweenPresents', 'FrameTime', 'MsBetweenDisplayChange']
const MAX_FRAMES = 400_000

export function validatePresentMonPath(path: string): string {
  if (!/presentmon[^\\/]*\.exe$/i.test(basename(path))) throw new AppFailure('invalid-input', 'Selecione o executável do PresentMon (PresentMon*.exe).')
  if (!existsSync(path) || !statSync(path).isFile()) throw new AppFailure('not-found', 'O executável do PresentMon não foi encontrado.')
  return path
}

/** Extrai os frametimes (ms) do CSV do PresentMon. Exportada para testes. */
export function parseFrametimes(csv: string, processName?: string): { frames: number[]; column: string } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('//'))
  if (lines.length < 2) throw new AppFailure('no-frames', 'O PresentMon não registrou quadros (o jogo estava aberto e em primeiro plano?).')
  const header = lines[0].split(',').map((h) => h.trim())
  const column = FRAME_COLUMNS.find((c) => header.includes(c))
  if (!column) throw new AppFailure('csv-format', `Formato de CSV não reconhecido. Colunas: ${header.slice(0, 12).join(', ')}…`)
  const col = header.indexOf(column)
  const appCol = header.indexOf('Application')
  const frames: number[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    if (processName && appCol >= 0 && cells[appCol]?.toLowerCase() !== processName.toLowerCase()) continue
    const v = Number(cells[col])
    if (Number.isFinite(v) && v > 0 && v < 5000) frames.push(v)
    if (frames.length >= MAX_FRAMES) break
  }
  if (frames.length === 0) throw new AppFailure('no-frames', 'Nenhum quadro válido encontrado no CSV.')
  return { frames, column }
}

export function toFrameStats(frames: number[], column: string): FrameStats {
  const s = summarizeFrames(frames)
  return {
    frames: s.frames,
    durationSec: s.durationSec,
    avgFps: s.avgFps,
    low1Fps: s.low1Fps,
    frametimeAvgMs: s.frametimeAvgMs,
    frametimeP99Ms: s.frametimeP99Ms,
    frametimeMaxMs: s.frametimeMaxMs,
    column
  }
}

/** Mantida para compatibilidade: CSV → estatísticas. */
export function parsePresentMonCsv(csv: string, processName?: string): FrameStats {
  const { frames, column } = parseFrametimes(csv, processName)
  return toFrameStats(frames, column)
}

function argsFor(style: 2 | 1, processName: string, out: string, seconds: number): string[] {
  const d = style === 2 ? '--' : '-'
  return [`${d}process_name`, processName, `${d}output_file`, out, `${d}timed`, String(seconds), `${d}terminate_after_timed`, `${d}stop_existing_session`]
}

function runCapture(exe: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += String(c)))
    child.stdout.on('data', (c) => (stderr += String(c)))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    signal?.addEventListener('abort', () => child.kill(), { once: true })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: e.message })
    })
  })
}

const ELEVATED_CAPTURE = `
$p = Start-Process -FilePath ([string]$in.exe) -ArgumentList @($in.args) -WindowStyle Hidden -Wait -PassThru
Out-Result ([pscustomobject]@{ code = $p.ExitCode })
exit 0`

/** Captura N segundos de quadros do processo informado. */
export async function captureFrames(
  exe: string,
  processName: string,
  seconds: number,
  opts: { elevated: boolean; signal?: AbortSignal }
): Promise<{ frames: number[]; column: string; stats: FrameStats }> {
  validatePresentMonPath(exe)
  if (!PROCESS_NAME.test(processName)) throw new AppFailure('invalid-input', 'Nome de processo inválido.')
  const out = join(tmpdir(), `jko-pm-${randomUUID()}.csv`)
  try {
    let lastError = ''
    for (const style of [2, 1] as const) {
      const args = argsFor(style, processName, out, seconds)
      if (opts.elevated) {
        await runElevated(ELEVATED_CAPTURE, { exe, args }, { timeoutMs: (seconds + 60) * 1000, signal: opts.signal })
      } else {
        const r = await runCapture(exe, args, (seconds + 30) * 1000, opts.signal)
        lastError = r.stderr.trim()
      }
      if (existsSync(out) && statSync(out).size > 0) {
        const { frames, column } = parseFrametimes(readFileSync(out, 'utf8'), processName)
        return { frames, column, stats: toFrameStats(frames, column) }
      }
      if (opts.signal?.aborted) throw new AppFailure('cancelled', 'Captura cancelada.')
    }
    if (/access|acesso|privilege|admin|Performance Log Users/i.test(lastError)) {
      throw new AppFailure('presentmon-denied', 'O PresentMon precisa de permissão de administrador (ou do grupo "Performance Log Users"). Tente a captura como administrador.')
    }
    throw new AppFailure('presentmon-failed', `O PresentMon não gerou dados. ${lastError.slice(0, 300)}`)
  } finally {
    rmSync(out, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Captura contínua (overlay e FPS Lab): saída em stdout, FPS do último segundo
// e gravação opcional de todos os frametimes.
// ---------------------------------------------------------------------------

let live: { child: ReturnType<typeof spawn>; processName: string } | null = null
let window1s: { t: number; ms: number }[] = []
let liveError: string | null = null
let recording: number[] | null = null
let lastFrameAt = 0

export function startLive(exe: string, processName: string): void {
  stopLive()
  validatePresentMonPath(exe)
  if (!PROCESS_NAME.test(processName)) throw new AppFailure('invalid-input', 'Nome de processo inválido.')
  liveError = null
  const child = spawn(exe, ['--process_name', processName, '--output_stdout', '--stop_existing_session'], { windowsHide: true })
  live = { child, processName }
  let header: string[] | null = null
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line || line.startsWith('//')) continue
      const cells = line.split(',')
      if (!header) {
        if (cells.some((c) => FRAME_COLUMNS.includes(c.trim()))) header = cells.map((c) => c.trim())
        continue
      }
      const col = header.findIndex((h) => FRAME_COLUMNS.includes(h))
      const ms = Number(cells[col])
      if (Number.isFinite(ms) && ms > 0 && ms < 5000) {
        const now = Date.now()
        lastFrameAt = now
        window1s.push({ t: now, ms })
        window1s = window1s.filter((f) => now - f.t <= 1000)
        if (recording && recording.length < MAX_FRAMES) recording.push(ms)
      }
    }
  })
  child.stderr.on('data', (c) => (liveError = String(c).trim().slice(0, 300)))
  child.on('close', (code) => {
    if (live?.child === child) {
      live = null
      if (code !== 0 && !liveError) liveError = `PresentMon encerrou (código ${code}). Pode precisar de administrador ou do grupo "Performance Log Users".`
    }
  })
}

export function stopLive(): void {
  live?.child.kill()
  live = null
  window1s = []
}

export function liveStats(): { active: boolean; processName: string | null; fps: number | null; frametimeMs: number | null; error: string | null; lastFrameAt: number } {
  const now = Date.now()
  const frames = window1s.filter((f) => now - f.t <= 1000)
  const avg = frames.length ? frames.reduce((a, b) => a + b.ms, 0) / frames.length : null
  return {
    active: live !== null,
    processName: live?.processName ?? null,
    fps: frames.length ? frames.length : null,
    frametimeMs: avg === null ? null : Math.round(avg * 10) / 10,
    error: liveError,
    lastFrameAt
  }
}

/** Começa a guardar todos os frametimes da captura contínua. */
export function beginRecording(): void {
  recording = []
}

/** Encerra a gravação e devolve os frametimes medidos. */
export function endRecording(): number[] {
  const frames = recording ?? []
  recording = null
  return frames
}

export function recordingSize(): number {
  return recording?.length ?? 0
}
