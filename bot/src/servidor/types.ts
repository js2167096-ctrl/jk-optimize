// Tipos do módulo de administração de servidores (Fase 2).
import type { PermissionsString } from 'discord.js'

export type PermissionName = PermissionsString

export interface RoleSpec {
  /** Chave estável usada pelas permissões de canais. */
  key: string
  name: string
  color?: number
  hoist?: boolean
  mentionable?: boolean
  permissions: PermissionName[]
}

export interface OverwriteSpec {
  /** Chave de um cargo do plano ou 'everyone'. */
  role: string
  allow?: PermissionName[]
  deny?: PermissionName[]
}

export interface ChannelSpec {
  name: string
  type: 'text' | 'voice'
  topic?: string
  /** Modo lento em segundos (0-21600), só canais de texto. */
  slowmode?: number
  overwrites?: OverwriteSpec[]
}

export interface CategorySpec {
  name: string
  overwrites?: OverwriteSpec[]
  channels: ChannelSpec[]
}

export interface ServerPlan {
  id: string
  title: string
  description: string
  roles: RoleSpec[]
  categories: CategorySpec[]
}

export interface SnapshotRole {
  id: string
  name: string
  managed: boolean
}

export interface SnapshotChannel {
  id: string
  name: string
  kind: 'category' | 'text' | 'voice' | 'other'
  parentId: string | null
}

export interface GuildSnapshot {
  roles: SnapshotRole[]
  channels: SnapshotChannel[]
}

export interface ResolvedOverwrite {
  id: string
  type: 'role' | 'member'
  allow: bigint
  deny: bigint
}

/** Operações do Discord de que o módulo precisa (implementada com discord.js; falsa nos testes). */
export interface GuildPort {
  id: string
  botId: string
  /** Permissões do bot no servidor (nível de cargo). */
  botPermissions(): bigint
  snapshot(): Promise<GuildSnapshot>
  createRole(spec: { name: string; color?: number; hoist?: boolean; mentionable?: boolean; permissions: bigint }, reason: string): Promise<{ id: string }>
  createCategory(name: string, overwrites: ResolvedOverwrite[], reason: string): Promise<{ id: string }>
  createChannel(
    spec: { name: string; type: 'text' | 'voice'; parentId: string; topic?: string; slowmode?: number; overwrites: ResolvedOverwrite[] },
    reason: string
  ): Promise<{ id: string }>
  /** Retorna false se o item já não existe. */
  deleteRole(id: string, reason: string): Promise<boolean>
  deleteChannel(id: string, reason: string): Promise<boolean>
  childCount(categoryId: string): Promise<number>
  setSlowmode(channelId: string, seconds: number, reason: string): Promise<boolean>
}

export type DiffItem =
  | { kind: 'role'; name: string; action: 'create' | 'exists'; spec: RoleSpec; existingId?: string }
  | { kind: 'category'; name: string; action: 'create' | 'exists'; spec: CategorySpec; existingId?: string }
  | { kind: 'channel'; name: string; action: 'create' | 'exists'; spec: ChannelSpec; categoryName: string }

export interface PlanDiff {
  items: DiffItem[]
  conflicts: string[]
}
