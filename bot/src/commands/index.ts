import { diagnostico } from './diagnostico.js'
import { ping } from './ping.js'
import type { Command } from './types.js'

export const COMMANDS: readonly Command[] = [ping, diagnostico]

export function commandMap(commands: readonly Command[] = COMMANDS): Map<string, Command> {
  return new Map(commands.map((c) => [c.data.name, c]))
}
