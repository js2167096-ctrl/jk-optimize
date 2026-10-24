// Linha do tempo da inicialização no processo principal (ms desde o início do processo).
import type { BootMark } from '@shared/boot'

const origin = Date.now() - process.uptime() * 1000
const marks: BootMark[] = []

export function markBoot(step: string): void {
  marks.push({ step, ms: Math.round(Date.now() - origin) })
}

export const bootTimeline = (): BootMark[] => [...marks]

/** Resolve com o resultado de `p` ou, passado o prazo, com o valor alternativo (o trabalho original continua em segundo plano). */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T | (() => T)): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(typeof fallback === 'function' ? (fallback as () => T)() : fallback), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(typeof fallback === 'function' ? (fallback as () => T)() : fallback)
      }
    )
  })
}
