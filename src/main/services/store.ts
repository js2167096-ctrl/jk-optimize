// Persistência local em arquivos JSON dentro da pasta de dados do usuário.
// Escrita atômica (arquivo temporário + rename) para não corromper dados.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function dataPath(...segments: string[]): string {
  return join(app.getPath('userData'), 'jk-data', ...segments)
}

export function clearAllData(): void {
  rmSync(dataPath(), { recursive: true, force: true })
}

export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export class JsonStore<T> {
  private readonly name: string
  private readonly sanitize: (raw: unknown) => T

  /** `sanitize` recebe o JSON lido (ou undefined) e devolve um valor válido. */
  constructor(name: string, sanitize: (raw: unknown) => T) {
    this.name = name
    this.sanitize = sanitize
  }

  // Calculado a cada uso: a pasta de dados pode ser redefinida depois que os módulos carregam.
  private get file(): string {
    return dataPath(this.name)
  }

  read(): T {
    if (!existsSync(this.file)) return this.sanitize(undefined)
    try {
      // Remove o BOM que editores do Windows podem acrescentar ao salvar.
      return this.sanitize(JSON.parse(readFileSync(this.file, 'utf8').replace(/^﻿/, '')))
    } catch {
      return this.sanitize(undefined)
    }
  }

  write(value: T): T {
    writeFileAtomic(this.file, JSON.stringify(value, null, 2))
    return value
  }
}
