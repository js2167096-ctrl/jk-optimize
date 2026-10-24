import { diagnostico } from './diagnostico.js'
import { ping } from './ping.js'
import { servidor } from './servidor.js'
import { slowmode } from './slowmode.js'
import type { Command } from './types.js'

export const COMMANDS: readonly Command[] = [ping, diagnostico, servidor, slowmode]

export function commandMap(commands: readonly Command[] = COMMANDS): Map<string, Command> {
  return new Map(commands.map((c) => [c.data.name, c]))
}
