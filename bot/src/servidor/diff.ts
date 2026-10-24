// Compara o plano com o estado atual do servidor. Só cria: nunca altera nem apaga o que já existe.
import { PermissionFlagsBits } from 'discord.js'
import type { DiffItem, GuildSnapshot, PlanDiff, ServerPlan } from './types.js'
import { bits } from './validate.js'

export const SERVER_LIMITS = { roles: 250, channels: 500 }

/** Discord normaliza nomes de canais (minúsculas, espaços viram hífen); compare sempre assim. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

export function diffPlan(plan: ServerPlan, snap: GuildSnapshot, botPermissions: bigint): PlanDiff {
  const items: DiffItem[] = []
  const conflicts: string[] = []

  const rolesByName = new Map(snap.roles.map((r) => [normalizeName(r.name), r]))
  for (const spec of plan.roles) {
    const existing = rolesByName.get(normalizeName(spec.name))
    items.push(existing ? { kind: 'role', name: spec.name, action: 'exists', spec, existingId: existing.id } : { kind: 'role', name: spec.name, action: 'create', spec })
  }

  const categories = snap.channels.filter((c) => c.kind === 'category')
  for (const cat of plan.categories) {
    const existing = categories.find((c) => normalizeName(c.name) === normalizeName(cat.name))
    items.push(existing ? { kind: 'category', name: cat.name, action: 'exists', spec: cat, existingId: existing.id } : { kind: 'category', name: cat.name, action: 'create', spec: cat })
    for (const ch of cat.channels) {
      const kind = ch.type
      const found = existing
        ? snap.channels.some((c) => c.parentId === existing.id && c.kind === kind && normalizeName(c.name) === normalizeName(ch.name))
        : false
      items.push({ kind: 'channel', name: ch.name, action: found ? 'exists' : 'create', spec: ch, categoryName: cat.name })
    }
  }

  const hasPerm = (p: bigint): boolean => (botPermissions & PermissionFlagsBits.Administrator) !== 0n || (botPermissions & p) === p
  const creates = items.filter((i) => i.action === 'create')
  const newRoles = creates.filter((i) => i.kind === 'role')
  const newChannels = creates.filter((i) => i.kind !== 'role')

  if (newRoles.length > 0 && !hasPerm(PermissionFlagsBits.ManageRoles)) conflicts.push('O bot não tem a permissão "Gerenciar Cargos".')
  if (newChannels.length > 0 && !hasPerm(PermissionFlagsBits.ManageChannels)) conflicts.push('O bot não tem a permissão "Gerenciar Canais".')
  if (snap.roles.length + newRoles.length > SERVER_LIMITS.roles) conflicts.push(`O servidor passaria do limite de ${SERVER_LIMITS.roles} cargos.`)
  if (snap.channels.length + newChannels.length > SERVER_LIMITS.channels) conflicts.push(`O servidor passaria do limite de ${SERVER_LIMITS.channels} canais.`)

  // O Discord só deixa o bot conceder permissões que ele próprio possui.
  const grantable = (names: readonly string[] | undefined, where: string): void => {
    const missing = (names ?? []).filter((n) => !hasPerm(bits([n as never])))
    if (missing.length > 0) conflicts.push(`${where}: o bot não possui ${[...new Set(missing)].join(', ')} e não pode concedê-las.`)
  }
  for (const i of creates) {
    if (i.kind === 'role') grantable(i.spec.permissions, `Cargo ${i.name}`)
    else if (i.kind === 'category') for (const o of i.spec.overwrites ?? []) grantable(o.allow, `Categoria ${i.name}`)
    else for (const o of i.spec.overwrites ?? []) grantable(o.allow, `Canal ${i.name}`)
  }
  return { items, conflicts: [...new Set(conflicts)] }
}

export function summarize(diff: PlanDiff): { create: DiffItem[]; exists: DiffItem[] } {
  return { create: diff.items.filter((i) => i.action === 'create'), exists: diff.items.filter((i) => i.action === 'exists') }
}
