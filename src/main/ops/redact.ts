// Remove segredos de textos antes de gravá-los em logs ou históricos.
// Módulo puro (sem Electron) para poder ser testado com `node --test`.

const LICENSE_TOKEN = /JKO1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const SECRET_PAIR = /\b(senha|password|passphrase|token|chave|key|secret)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi
const SECRET_KEYS = /^(senha|password|passphrase|token|secret|key|chave|licenseKey)$/i

export function redactText(text: string): string {
  return text.replace(LICENSE_TOKEN, 'JKO1.[removido]').replace(SECRET_PAIR, '$1=[removido]')
}

/** Cópia de um objeto com campos sensíveis substituídos. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[profundo demais]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[removido]' : redactValue(v, depth + 1)
    return out
  }
  return value
}
