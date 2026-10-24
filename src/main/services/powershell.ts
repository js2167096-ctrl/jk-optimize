// Executa scripts PowerShell FIXOS, definidos como constantes no código.
// Nunca recebe texto vindo da interface. O script vai codificado em base64
// (-EncodedCommand), sem interpolação em linha de comando. Dados variáveis
// (já validados) entram pela entrada padrão em JSON, nunca no texto do script.
import { execFile, spawn } from 'node:child_process'

const PRELUDE = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::InputEncoding=[System.Text.Encoding]::UTF8;'
const ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']

export function encodeScript(script: string): string {
  return Buffer.from(PRELUDE + script, 'utf16le').toString('base64')
}

/**
 * Com a entrada padrão redirecionada, o PowerShell escreve erros em CLIXML
 * ("#< CLIXML <Objs>…<S S="Error">texto</S>…"). Extrai o texto legível.
 */
export function readableStderr(stderr: string): string {
  const text = stderr.trim()
  if (!text.startsWith('#< CLIXML')) return text
  const parts = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1]
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  )
  const joined = parts.join('').replace(/\r\n/g, '\n').trim()
  return joined || 'Erro do PowerShell sem mensagem.'
}

export class PowerShellError extends Error {
  readonly exitCode: number | null
  constructor(message: string, exitCode: number | null) {
    super(message)
    this.exitCode = exitCode
  }
}

export interface RunOptions {
  timeoutMs?: number
  /** Texto enviado pela entrada padrão. */
  input?: string
  signal?: AbortSignal
}

/** `input` vai pela entrada padrão (stdin), nunca pela linha de comando. */
export function runPowerShell(script: string, timeoutMs = 20_000, input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      [...ARGS, encodeScript(script)],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code as number) : null
          reject(new PowerShellError(readableStderr(stderr) || error.message, code))
        } else resolve(stdout)
      }
    )
    child.stdin?.end(input ?? '')
  })
}

export async function runPowerShellJson<T = unknown>(script: string, opts: RunOptions = {}): Promise<T | null> {
  const out = (await runPowerShell(script, opts.timeoutMs ?? 30_000, opts.input, opts.signal)).trim()
  return out ? (JSON.parse(out) as T) : null
}

/** Script com parâmetros: os dados vão em JSON pela entrada padrão e o script lê `$in`. */
export function withInput(script: string): string {
  return `$in = [Console]::In.ReadToEnd() | ConvertFrom-Json\n${script}`
}

export async function runPowerShellWith<T = unknown>(script: string, params: unknown, opts: RunOptions = {}): Promise<T | null> {
  return runPowerShellJson<T>(withInput(script), { ...opts, input: JSON.stringify(params) })
}

/**
 * Processo longo com saída linha a linha (ex.: teste de latência). Cancela ao abortar o sinal.
 * Resolve com o código de saída.
 */
export function streamPowerShell(
  script: string,
  onLine: (line: string) => void,
  opts: RunOptions = {}
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [...ARGS, encodeScript(script)], { windowsHide: true })
    let buffer = ''
    let stderr = ''
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null
    const onAbort = () => child.kill()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) onLine(line)
      }
    })
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (buffer.trim()) onLine(buffer.trim())
      if (code !== 0 && !opts.signal?.aborted && stderr.trim()) reject(new PowerShellError(readableStderr(stderr), code))
      else resolve(code)
    })
    child.stdin.end(opts.input ?? '')
  })
}

/** Normaliza valores que o ConvertTo-Json pode devolver como item único ou nulo. */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === null || value === undefined ? [] : [value]
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Escapa um texto para uso como literal entre aspas simples no PowerShell. */
export function psLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}
