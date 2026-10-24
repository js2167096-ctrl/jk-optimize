import { PermissionFlagsBits } from 'discord.js'
import type { OverwriteSpec, PermissionName, ResolvedOverwrite, ServerPlan } from './types.js'

/** Permissões que um plano nunca pode conceder a um cargo. */
export const FORBIDDEN_ROLE_PERMISSIONS: readonly PermissionName[] = ['Administrator', 'ManageGuild', 'ManageRoles']

export const LIMITS = { name: 100, topic: 1024, channelsPerCategory: 50, slowmodeMax: 21_600 }

export function bits(names: readonly PermissionName[] | undefined): bigint {
  let out = 0n
  for (const n of names ?? []) {
    const flag = PermissionFlagsBits[n]
    if (flag === undefined) throw new Error(`Permissão desconhecida: ${n}`)
    out |= flag
  }
  return out
}

/** Valida um plano. Retorna a lista de problemas (vazia = válido). */
export function validatePlan(plan: ServerPlan): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  const checkPerms = (where: string, names: readonly PermissionName[] | undefined): void => {
    for (const n of names ?? []) if (PermissionFlagsBits[n] === undefined) problems.push(`${where}: permissão desconhecida "${n}".`)
  }
  const checkName = (where: string, name: string): void => {
    if (name.trim() === '' || name.length > LIMITS.name) problems.push(`${where}: nome vazio ou com mais de ${LIMITS.name} caracteres.`)
  }

  for (const r of plan.roles) {
    if (keys.has(r.key)) problems.push(`Cargo duplicado: chave "${r.key}".`)
    keys.add(r.key)
    checkName(`Cargo ${r.key}`, r.name)
    checkPerms(`Cargo ${r.name}`, r.permissions)
    for (const p of r.permissions) if (FORBIDDEN_ROLE_PERMISSIONS.includes(p)) problems.push(`Cargo ${r.name}: o plano não pode conceder ${p}.`)
  }

  const checkOverwrites = (where: string, list: readonly OverwriteSpec[] | undefined): void => {
    for (const o of list ?? []) {
      if (o.role !== 'everyone' && !keys.has(o.role)) problems.push(`${where}: cargo "${o.role}" não existe no plano.`)
      checkPerms(where, o.allow)
      checkPerms(where, o.deny)
      for (const p of o.allow ?? []) if (FORBIDDEN_ROLE_PERMISSIONS.includes(p)) problems.push(`${where}: não pode permitir ${p}.`)
    }
  }

  for (const c of plan.categories) {
    checkName(`Categoria ${c.name}`, c.name)
    checkOverwrites(`Categoria ${c.name}`, c.overwrites)
    if (c.channels.length > LIMITS.channelsPerCategory) problems.push(`Categoria ${c.name}: mais de ${LIMITS.channelsPerCategory} canais.`)
    for (const ch of c.channels) {
      const where = `Canal ${ch.name}`
      checkName(where, ch.name)
      checkOverwrites(where, ch.overwrites)
      if (ch.topic && (ch.type !== 'text' || ch.topic.length > LIMITS.topic)) problems.push(`${where}: tópico inválido.`)
      if (ch.slowmode !== undefined && (ch.type !== 'text' || !Number.isInteger(ch.slowmode) || ch.slowmode < 0 || ch.slowmode > LIMITS.slowmodeMax)) {
        problems.push(`${where}: modo lento deve ser inteiro de 0 a ${LIMITS.slowmodeMax} e só vale em canais de texto.`)
      }
    }
  }
  return problems
}

/** Converte overwrites do plano em IDs reais. Itens do canal substituem os da categoria para o mesmo cargo. */
export function resolveOverwrites(
  everyoneId: string,
  roleIds: ReadonlyMap<string, string>,
  ...layers: (readonly OverwriteSpec[] | undefined)[]
): ResolvedOverwrite[] {
  const merged = new Map<string, ResolvedOverwrite>()
  for (const layer of layers) {
    for (const o of layer ?? []) {
      const id = o.role === 'everyone' ? everyoneId : roleIds.get(o.role)
      if (!id) throw new Error(`Cargo "${o.role}" não foi resolvido.`)
      merged.set(id, { id, type: 'role', allow: bits(o.allow), deny: bits(o.deny) })
    }
  }
  return [...merged.values()]
}
