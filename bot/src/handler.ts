import { MessageFlags } from 'discord.js'
import type { Command, Deps, InteractionLike } from './commands/types.js'
import { writeAudit } from './db/index.js'
import { isBotAdmin } from './permissions.js'

/** Limitador simples por usuário (janela deslizante em memória). */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  /** Retorna true se a ação é permitida e a registra. */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }
}

const EPHEMERAL = MessageFlags.Ephemeral

async function say(i: InteractionLike, content: string): Promise<void> {
  if (i.replied || i.deferred) await i.followUp({ content, flags: EPHEMERAL })
  else await i.reply({ content, flags: EPHEMERAL })
}

/** Valida limite de uso e autorização, executa o comando e audita comandos administrativos. */
export async function handleCommand(
  interaction: InteractionLike,
  commands: ReadonlyMap<string, Command>,
  deps: Deps,
  limiter: RateLimiter
): Promise<void> {
  const command = commands.get(interaction.commandName)
  if (!command) {
    await say(interaction, 'Comando desconhecido.')
    return
  }

  if (!limiter.allow(interaction.user.id)) {
    await say(interaction, 'Calma! Você está usando comandos rápido demais. Tente de novo em alguns segundos.')
    return
  }

  const actor = { userId: interaction.user.id, memberPermissions: interaction.memberPermissions?.bitfield ?? null }
  const audit = (outcome: 'ok' | 'denied' | 'error', details?: Record<string, unknown>): void => {
    if (!command.adminOnly) return
    writeAudit(deps.db, { guildId: interaction.guildId, actorId: actor.userId, action: `command:${command.data.name}`, outcome, details })
  }

  if (command.adminOnly && !isBotAdmin(actor, deps.config.ownerIds)) {
    audit('denied')
    await say(interaction, 'Você não tem permissão para usar este comando.')
    return
  }

  try {
    await command.execute(interaction, deps)
    audit('ok')
  } catch (error) {
    deps.log.error('Falha ao executar comando', { command: command.data.name, error })
    audit('error', { message: (error as Error).message })
    try {
      await say(interaction, 'Ocorreu um erro ao executar o comando. O problema foi registrado.')
    } catch (replyError) {
      deps.log.warn('Não foi possível responder ao usuário após o erro', { error: replyError })
    }
  }
}
