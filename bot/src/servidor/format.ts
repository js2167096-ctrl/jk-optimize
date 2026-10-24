import type { ApplyReport, BatchInfo, UndoReport } from './apply.js'
import type { PlanDiff, ServerPlan } from './types.js'

const MAX = 1800

const icon = (kind: string): string => (kind === 'role' ? '🎭' : kind === 'category' ? '📁' : '💬')

function clip(text: string): string {
  return text.length <= MAX ? text : `${text.slice(0, MAX - 40)}\n… (lista cortada por tamanho)`
}

export function formatPreview(plan: ServerPlan, diff: PlanDiff): string {
  const create = diff.items.filter((i) => i.action === 'create')
  const exists = diff.items.filter((i) => i.action === 'exists')
  const lines = [`**Prévia: ${plan.title}**`, `Vai criar **${create.length}** item(ns); **${exists.length}** já existe(m) e não será(ão) alterado(s). Nada é apagado.`]
  if (create.length > 0) lines.push('', ...create.map((i) => `${icon(i.kind)} ${i.name}`))
  if (exists.length > 0) lines.push('', `Já existem: ${exists.map((i) => i.name).join(', ')}`)
  return clip(lines.join('\n'))
}

export function formatConflicts(problems: readonly string[]): string {
  return clip(['**Não dá para aplicar agora:**', ...problems.map((p) => `• ${p}`)].join('\n'))
}

export function formatApplyReport(report: ApplyReport): string {
  const c = report.created
  const lines = [
    report.ok ? '✅ **Modelo aplicado.**' : '⚠️ **Aplicação interrompida.**',
    `Criados: ${c.roles} cargo(s), ${c.categories} categoria(s), ${c.channels} canal(is). Já existiam: ${report.skipped}.`
  ]
  if (report.problems.length > 0) lines.push(...report.problems.map((p) => `• ${p}`))
  if (report.batchId !== null) lines.push(`Lote #${report.batchId}. Use \`/servidor desfazer\` para remover só o que o bot criou.`)
  return clip(lines.join('\n'))
}

export function formatUndoPreview(batch: BatchInfo): string {
  const lines = [
    `**Desfazer o lote #${batch.id}** (${batch.templateId})`,
    `Vai apagar **${batch.items.length}** item(ns) criado(s) pelo bot, do mais novo ao mais antigo. Categorias que ganharam canais de outras pessoas são mantidas.`,
    '',
    ...[...batch.items].reverse().map((i) => `${icon(i.kind)} ${i.name}`)
  ]
  return clip(lines.join('\n'))
}

export function formatUndoReport(r: UndoReport): string {
  const lines = ['**Desfazer concluído.**', `Removidos: ${r.removed}. Já não existiam: ${r.alreadyGone}.`]
  if (r.keptNonEmpty.length > 0) lines.push(`Mantidas por terem canais de outras pessoas: ${r.keptNonEmpty.join(', ')}.`)
  if (r.problems.length > 0) lines.push(...r.problems.map((p) => `• ${p}`))
  return clip(lines.join('\n'))
}
