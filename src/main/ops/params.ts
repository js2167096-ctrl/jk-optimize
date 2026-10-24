// Validação compacta dos parâmetros das operações. Tudo que vem do renderer é
// tratado como não confiável; campos desconhecidos são recusados.
import { ValidationError } from '../security/validate'

export type Raw = Record<string, unknown>

export function obj(raw: unknown, allowed: readonly string[]): Raw {
  const value = raw ?? {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Parâmetros: objeto esperado.')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`Parâmetro não permitido: ${key}.`)
  }
  return value as Raw
}

export function noParams(raw: unknown): Record<string, never> {
  obj(raw, [])
  return {}
}

export function bool(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') throw new ValidationError(`${field}: verdadeiro/falso esperado.`)
  return value
}

export function int(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field}: inteiro entre ${min} e ${max}.`)
  }
  return value
}

export function num(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${field}: número entre ${min} e ${max}.`)
  }
  return value
}

export function str(value: unknown, field: string, max: number, pattern?: RegExp, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ValidationError(`${field}: texto de 1 a ${max} caracteres.`)
  }
  if (pattern && !pattern.test(value)) throw new ValidationError(`${field}: formato inválido.`)
  return value
}

export function oneOf<T extends string>(value: unknown, field: string, options: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new ValidationError(`${field}: valor inválido.`)
  }
  return value as T
}

export function strList(value: unknown, field: string, maxItems: number, maxLen: number, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new ValidationError(`${field}: lista de até ${maxItems} itens.`)
  return value.map((v, i) => str(v, `${field}[${i}]`, maxLen, pattern))
}

/** GUID entre chaves ou não. */
export const GUID = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/
/** Nome de host DNS ou endereço IPv4/IPv6. */
export const HOST = /^(?=.{1,253}$)(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?|\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]{2,39})$/
