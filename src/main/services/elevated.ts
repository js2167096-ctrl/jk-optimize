// Componente privilegiado explicitamente controlado.
//
// Executa UM script fixo (constante no código) com privilégios de administrador,
// pedindo a elevação ao Windows (UAC) somente naquele momento. Os parâmetros,
// já validados pelo chamador, vão em um arquivo JSON numa pasta temporária
// exclusiva; o script também os revalida. O resultado volta em out.json e a
// saída longa (SFC, DISM) em log.txt, lida durante a execução para progresso.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppFailure } from '../security/validate'
import { encodeScript, psLiteral, runPowerShell, PowerShellError } from './powershell'

export const UAC_CANCELLED = 1223

export interface ElevatedResult<T> {
  exitCode: number
  output: T | null
  log: string
}

export interface ElevatedOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Chamado com o conteúdo novo de log.txt enquanto o script roda. */
  onLog?: (text: string) => void
}

function innerScript(dir: string, body: string): string {
  const inFile = psLiteral(join(dir, 'in.json'))
  const outFile = psLiteral(join(dir, 'out.json'))
  const logFile = psLiteral(join(dir, 'log.txt'))
  return `$ErrorActionPreference='Stop'
$OUT=${outFile}; $LOG=${logFile}
function Out-Result($o){ $o | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $OUT -Encoding UTF8 }
try {
  $in = Get-Content -Raw -LiteralPath ${inFile} -Encoding UTF8 | ConvertFrom-Json
${body}
} catch {
  Out-Result ([pscustomobject]@{ error = $_.Exception.Message })
  exit 1
}`
}

function outerScript(encodedInner: string): string {
  return `try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encodedInner}')
  exit $p.ExitCode
} catch {
  if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.HResult -eq -2147023673) { exit 1223 }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`
}

export async function runElevated<T = unknown>(body: string, params: unknown, opts: ElevatedOptions = {}): Promise<ElevatedResult<T>> {
  const dir = join(tmpdir(), `jko-elev-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'in.json'), JSON.stringify(params ?? {}), 'utf8')
  const encoded = encodeScript(innerScript(dir, body))
  if (encoded.length > 30_000) throw new Error('Script elevado grande demais para a linha de comando.')

  let lastLength = 0
  const poll = opts.onLog
    ? setInterval(() => {
        try {
          const file = join(dir, 'log.txt')
          if (!existsSync(file)) return
          const text = readLogText(file)
          if (text.length !== lastLength) {
            lastLength = text.length
            opts.onLog!(text)
          }
        } catch {
          // arquivo em uso; tenta no próximo ciclo
        }
      }, 1000)
    : null

  try {
    let exitCode = 0
    try {
      await runPowerShell(outerScript(encoded), opts.timeoutMs ?? 120_000, undefined, opts.signal)
    } catch (error) {
      exitCode = error instanceof PowerShellError && error.exitCode !== null ? error.exitCode : -1
      if (exitCode === UAC_CANCELLED) {
        throw new AppFailure('elevation-cancelled', 'A permissão de administrador foi negada no aviso do Windows. Nada foi alterado.')
      }
      if (exitCode === -1) throw error
    }
    const outFile = join(dir, 'out.json')
    const output = existsSync(outFile) ? (JSON.parse(readFileSync(outFile, 'utf8').replace(/^﻿/, '')) as T) : null
    const logFile = join(dir, 'log.txt')
    const log = existsSync(logFile) ? readLogText(logFile) : ''
    const err = (output as { error?: unknown } | null)?.error
    if (typeof err === 'string') throw new AppFailure('elevated-failed', err)
    return { exitCode, output, log }
  } finally {
    if (poll) clearInterval(poll)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** SFC grava em UTF-16; DISM e PowerShell em UTF-8. */
function readLogText(file: string): string {
  const buf = readFileSync(file)
  const utf16 = buf.length > 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || buf.subarray(0, 200).filter((b) => b === 0).length > 40)
  return (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/\u0000/g, '').replace(/^﻿/, '')
}
