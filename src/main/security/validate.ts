// Validação dos dados recebidos pelos canais IPC. Tudo que vem da interface é
// tratado como não confiável.

export class ValidationError extends Error {}

/** Falha esperada, com código e mensagem que podem ser exibidos ao usuário. */
export class AppFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function expectString(value: unknown, field: string, maxLength: number, minLength = 0): string {
  if (typeof value !== 'string') throw new ValidationError(`${field}: texto esperado.`)
  if (value.length < minLength) throw new ValidationError(`${field}: mínimo de ${minLength} caracteres.`)
  if (value.length > maxLength) throw new ValidationError(`${field}: máximo de ${maxLength} caracteres.`)
  return value
}

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${field}: verdadeiro/falso esperado.`)
  return value
}

export function expectInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field}: inteiro entre ${min} e ${max} esperado.`)
  }
  return value
}

export function expectRecord(value: unknown, field: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field}: objeto esperado.`)
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`${field}: campo não permitido "${key}".`)
  }
  return value as Record<string, unknown>
}

export function expectNoArgs(args: unknown[]): void {
  if (args.length > 0) throw new ValidationError('Este canal não aceita parâmetros.')
}
