// Perfis de otimização por jogo (Básica, Intermediária e Pro Max). Reaproveita as operações reais do app:
// ajustes do Windows (tweaks.apply), configurações gráficas do FiveM/GTA V (fivem.settings.apply, com cópia do arquivo)
// e o diário de alterações. O perfil é uma ação com preview, confirmação, progresso por etapas reais, histórico e reversão.
import { randomUUID } from 'node:crypto'
import { GAME_CATALOG, gameById, graphicsFor, OPT_LEVELS, tweaksForLevel, type GameDef, type OptLevel } from '@shared/constants/games-catalog'
import type { TaskDetailSection } from '@shared/types'
import { AppFailure } from '../security/validate'
import { executeAction, journal, listChanges, previewAction, revertChange } from '../ops/registry'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, oneOf, str, strList } from '../ops/params'
import { log } from '../ops/log'
import { JsonStore } from '../services/store'
import { runPowerShellWith } from '../services/powershell'
import { getStaticInfo } from '../services/system'
import { CRITICAL_PROCESSES } from '../security/protection'
import { buildGraphicsProfile, hardwareProfile, readSettingsFile, recommendSettings, runningGameProcesses } from './fivem'
import { listProcesses } from './processes'
import { demandSample } from './sampler'
import { describe, takeSnapshot, type TweakState } from './tweaks'
import { detectionOf, type Detection } from './gamedetect'

// ---------------------------------------------------------------------------
// Plano (análise de compatibilidade, sem alterar nada)
// ---------------------------------------------------------------------------

export type RowStatus = 'apply' | 'already' | 'unavailable' | 'skipped' | 'info'

export interface PlanRow {
  kind: 'tweak' | 'graphics' | 'info'
  id: string
  label: string
  current: string
  intended: string
  status: RowStatus
  why: string
  reason: string | null
  elevated: boolean
  needsRestart: boolean
}

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

/** Posição do plano de energia (maior = mais desempenho). 0 = plano personalizado desconhecido. */
function planRank(guid: string | null, ultimate: string | null): number {
  return guid === null ? 0 : guid === ultimate ? 3 : guid === HIGH ? 2 : guid === BALANCED ? 1 : 0
}

/** Resolve os ajustes do nível contra o estado real do Windows (puro: testável). */
export function resolveTweakChanges(level: OptLevel, states: TweakState[], hasBattery: boolean): { changes: Record<string, string>; rows: PlanRow[] } {
  const rows: PlanRow[] = []
  const changes: Record<string, string> = {}
  for (const t of tweaksForLevel(level)) {
    const s = states.find((x) => x.id === t.id)
    const base = { kind: 'tweak' as const, id: t.id, label: s?.name ?? t.id, why: t.why, elevated: s?.elevated ?? false, needsRestart: s?.needsRestart ?? false }
    if (!s) {
      rows.push({ ...base, current: '—', intended: '—', status: 'unavailable', reason: 'Ajuste não existe nesta versão.' })
      continue
    }
    if (t.desktopOnly && hasBattery) {
      rows.push({ ...base, current: s.currentLabel, intended: '—', status: 'skipped', reason: 'Notebook: não aplicado para não afetar a bateria.' })
      continue
    }
    if (s.unavailable) {
      rows.push({ ...base, current: 'Indisponível', intended: '—', status: 'unavailable', reason: s.unavailable })
      continue
    }
    const value = t.value === '@ideal' ? s.profiles.ideal : t.value === '@max' ? s.profiles.max : t.value
    if (!value || !s.options.some((o) => o.value === value)) {
      rows.push({ ...base, current: s.currentLabel, intended: '—', status: 'unavailable', reason: 'Valor não suportado neste computador.' })
      continue
    }
    const label = s.options.find((o) => o.value === value)!.label
    // Plano de energia: nunca troca por um plano de menos desempenho nem substitui um plano personalizado.
    if (t.id === 'powerPlan' && s.current && s.current !== value) {
      const ultimate = s.profiles.max && s.profiles.max !== HIGH && s.profiles.max !== BALANCED ? s.profiles.max : null
      const cur = planRank(s.current, ultimate)
      if (cur === 0 || cur >= planRank(value, ultimate)) {
        rows.push({ ...base, current: s.currentLabel, intended: label, status: 'already', reason: cur === 0 ? 'Plano de energia personalizado: mantido como está.' : 'O plano atual já oferece desempenho igual ou maior.' })
        continue
      }
    }
    if (s.current === value) {
      rows.push({ ...base, current: s.currentLabel, intended: label, status: 'already', reason: 'Já está configurado.' })
      continue
    }
    changes[t.id] = value
    rows.push({ ...base, current: s.currentLabel, intended: label, status: 'apply', reason: null })
  }
  return { changes, rows }
}

export function emulatorRecommendation(threads: number, ramGB: number): { cpus: number; ramMB: number } {
  return { cpus: Math.min(4, Math.max(2, Math.floor(threads / 2))), ramMB: ramGB >= 16 ? 4096 : ramGB >= 8 ? 2048 : 1536 }
}

export interface GamePlan {
  gameId: string
  level: OptLevel
  detection: Detection | null
  rows: PlanRow[]
  tweakChanges: Record<string, string>
  graphics: { file: 'fivem' | 'gta'; path: string; profile: 'performance' | 'balanced'; changes: Record<string, string> } | null
  warnings: string[]
  blocked: string | null
  hardware: { cpu: string | null; cores: number | null; threads: number | null; ramGB: number; gpus: string[]; integratedGpu: boolean; hasBattery: boolean }
}

function installBlock(g: GameDef, d: Detection | null): string | null {
  if (!d) return 'A detecção ainda não terminou.'
  if (g.viaEmulator) return d.sources.length ? null : 'Nenhum emulador compatível foi detectado: instale um emulador para otimizar o Windows para este jogo.'
  if (d.state === 'installed') return null
  if (d.state === 'unknown') return 'A detecção foi inconclusiva: não foi possível verificar a instalação. Atualize a detecção ou indique a pasta manualmente.'
  return `${g.name} não foi detectado neste computador. Instale o jogo ou indique a pasta manualmente; ajustes específicos não são aplicados a uma instalação inexistente.`
}

export async function buildPlan(id: string, level: OptLevel): Promise<GamePlan> {
  const g = gameById(id)
  if (!g) throw new AppFailure('not-found', 'Jogo fora do catálogo.')
  const [detection, snapshot, hw, info] = await Promise.all([detectionOf(id), takeSnapshot(), hardwareProfile(), getStaticInfo(false)])
  const states = describe(snapshot, {})
  const { changes, rows } = resolveTweakChanges(level, states, snapshot.ctx.hasBattery)
  const warnings: string[] = []
  let graphics: GamePlan['graphics'] = null

  if (g.profile === 'fivem' || g.profile === 'gta5') {
    const file = g.profile === 'fivem' ? 'fivem' : 'gta'
    const data = readSettingsFile(file)
    const profile = graphicsFor(level, hw.integratedGpu)
    if (!data) {
      rows.push({ kind: 'graphics', id: file, label: 'Configurações gráficas', current: '—', intended: '—', status: 'unavailable', why: 'Ajusta as chaves gráficas conhecidas do arquivo de configurações.', reason: 'O arquivo de configurações ainda não existe (abra o jogo uma vez para criá-lo).', elevated: false, needsRestart: false })
    } else if (!profile) {
      const recs = recommendSettings(data.values, hw, 'balanced')
      rows.push({ kind: 'info', id: file, label: 'Análise das configurações gráficas', current: `${recs.length} chave(s) com margem`, intended: 'Somente análise neste nível', status: 'info', why: 'A Otimização Básica não grava no arquivo gráfico; use a Intermediária ou a Pro Max para aplicar.', reason: null, elevated: false, needsRestart: false })
    } else {
      const recs = buildGraphicsProfile(data.values, hw, profile)
      if (recs.length === 0) {
        rows.push({ kind: 'graphics', id: file, label: 'Configurações gráficas', current: 'Já no perfil', intended: profile === 'performance' ? 'Desempenho' : 'Equilibrado', status: 'already', why: 'Chaves gráficas conhecidas.', reason: 'O arquivo já está com os valores do perfil.', elevated: false, needsRestart: false })
      } else {
        const running = await runningGameProcesses()
        graphics = { file, path: data.path, profile, changes: Object.fromEntries(recs.map((r) => [r.key, r.recommended])) }
        for (const r of recs) rows.push({ kind: 'graphics', id: `${file}:${r.key}`, label: `${r.label} (${r.key})`, current: r.current, intended: r.recommended, status: running.length ? 'skipped' : 'apply', why: r.reason, reason: running.length ? `Feche ${running.join(', ')} para gravar o arquivo gráfico.` : null, elevated: false, needsRestart: false })
        if (running.length) warnings.push(`Configurações gráficas não serão gravadas enquanto ${running.join(', ')} estiver em execução (o jogo regrava o arquivo ao fechar).`)
        else warnings.push('Uma cópia completa do arquivo gráfico é guardada antes da alteração; a reversão restaura essa cópia (se o jogo alterou o arquivo depois, o JK Optimize avisa em vez de sobrescrever).')
      }
    }
  }
  if (g.kind === 'emulator' || g.viaEmulator) {
    const rec = emulatorRecommendation(info.cpus[0]?.threads ?? 4, hw.ramGB)
    rows.push({ kind: 'info', id: 'emulator', label: 'Configuração do emulador (recomendação)', current: 'Definida no próprio emulador', intended: `${rec.cpus} núcleos · ${rec.ramMB} MB de RAM`, status: 'info', why: `Valores sugeridos para ${info.cpus[0]?.threads ?? '?'} threads e ${hw.ramGB} GB de RAM. O JK Optimize não altera os arquivos do emulador (formato não validado): ajuste em Configurações > Desempenho do emulador e reinicie-o.`, reason: null, elevated: false, needsRestart: false })
    if (hw.integratedGpu) warnings.push('GPU integrada detectada: prefira o renderizador DirectX compatível e resolução menor no emulador. O JK Optimize não ativa virtualização na BIOS.')
  }
  const apply = rows.filter((r) => r.status === 'apply')
  if (apply.some((r) => r.needsRestart)) warnings.push('Alguns ajustes só valem depois de reiniciar o Windows; o JK Optimize não reinicia sozinho.')
  if (apply.some((r) => r.elevated)) warnings.push('Alguns ajustes exigem administrador (o Windows pede a permissão uma única vez).')
  const block = installBlock(g, detection)
  return {
    gameId: id,
    level,
    detection,
    rows,
    tweakChanges: changes,
    graphics: graphics && !(await runningGameProcesses()).length ? graphics : null,
    warnings,
    blocked: block ?? (apply.length === 0 ? (rows.some((r) => r.status === 'already') ? 'Este perfil já está aplicado: nenhum ajuste pendente.' : 'Perfil sem ações compatíveis com este computador ou jogo.') : null),
    hardware: { cpu: info.cpus[0]?.name ?? null, cores: info.cpus[0]?.cores ?? null, threads: info.cpus[0]?.threads ?? null, ramGB: hw.ramGB, gpus: hw.gpus, integratedGpu: hw.integratedGpu, hasBattery: snapshot.ctx.hasBattery }
  }
}

const parsePlan = (raw: unknown) => {
  const p = obj(raw, ['id', 'level'])
  return { id: str(p.id, 'jogo', 40, /^[a-z0-9-]+$/), level: oneOf(p.level, 'nível', ['basic', 'intermediate', 'promax'] as const) }
}

defineQuery({ id: 'games.plan', module: 'fivem', parse: parsePlan, run: ({ id, level }) => buildPlan(id, level) })

defineQuery({
  id: 'games.hardware',
  module: 'fivem',
  parse: noParams,
  async run() {
    const [hw, info, snap] = await Promise.all([hardwareProfile(), getStaticInfo(false), takeSnapshot()])
    return { cpu: info.cpus[0]?.name ?? null, cores: info.cpus[0]?.cores ?? null, threads: info.cpus[0]?.threads ?? null, ramGB: hw.ramGB, gpus: hw.gpus, integratedGpu: hw.integratedGpu, hasBattery: snap.ctx.hasBattery, disks: info.disks.map((d) => ({ drive: d.drive, totalBytes: d.totalBytes, freeBytes: d.freeBytes })) }
  }
})

// ---------------------------------------------------------------------------
// Execução (ação) e reversão
// ---------------------------------------------------------------------------

interface Child {
  actionId: string
  changeId: string
  label: string
}

interface RunReport {
  entryId: string
  rows: { label: string; value: string; tone: 'ok' | 'warn' | 'error' }[]
  metricsBefore: Metrics | null
  metricsAfter: Metrics | null
}

interface Metrics {
  cpuPct: number | null
  ramAvailableGB: number | null
  commitPct: number | null
}

interface Backup {
  gameId: string
  level: OptLevel
  children: Child[]
  report: RunReport
}

export interface RunEntry {
  id: string
  at: string
  gameId: string
  level: OptLevel
  outcome: 'ok' | 'partial' | 'failed'
  summary: string
  rows: RunReport['rows']
  metricsBefore: Metrics | null
  metricsAfter: Metrics | null
}

const runs = new JsonStore<RunEntry[]>('games-runs.json', (raw) => (Array.isArray(raw) ? (raw as RunEntry[]).slice(0, 200) : []))

function metrics(): Metrics | null {
  const s = demandSample()
  if (!s) return null
  return {
    cpuPct: s.cpu.totalPct,
    ramAvailableGB: s.memory.availableBytes === null ? null : Math.round((s.memory.availableBytes / 1024 ** 3) * 10) / 10,
    commitPct: s.memory.commitPct
  }
}

async function nested(actionId: string, params: unknown): Promise<{ blocked: string | null; changeId: string | null; ok: boolean; summary: string; sections: TaskDetailSection[] }> {
  const p = await previewAction(actionId, params)
  if (p.blocked) return { blocked: p.blocked, changeId: null, ok: false, summary: p.blocked, sections: [] }
  const o = await executeAction(p.previewId, true, null)
  return { blocked: null, changeId: o.changeId, ok: o.ok, summary: o.summary, sections: o.sections }
}

type ItemState = 'running' | 'ok' | 'error' | 'skipped'

defineAction<{ id: string; level: OptLevel }, Backup>({
  id: 'games.profile.apply',
  module: 'fivem',
  title: 'Aplicar otimização para jogos',
  description: 'Aplica o perfil escolhido ao jogo: ajustes reversíveis do Windows e, no FiveM/GTA V, as configurações gráficas, com histórico e reversão.',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'games-profile',
  parse: parsePlan,
  async preview({ id, level }) {
    const plan = await buildPlan(id, level)
    const apply = plan.rows.filter((r) => r.status === 'apply')
    return {
      summary: `${apply.length} ajuste(s) a aplicar${plan.rows.filter((r) => r.status === 'already').length ? `, ${plan.rows.filter((r) => r.status === 'already').length} já configurado(s)` : ''}.`,
      changes: apply.map((r) => ({ target: r.label, current: r.current, intended: r.intended })),
      warnings: [
        ...plan.warnings,
        ...plan.rows.filter((r) => r.status === 'unavailable' || r.status === 'skipped').map((r) => `${r.label}: ${r.reason}`),
        'Os ajustes são reversíveis pelo Histórico. Os nomes Básica, Intermediária e Pro Max indicam a abrangência dos ajustes, não um ganho garantido de FPS.'
      ],
      blocked: plan.blocked
    }
  },
  async precheck({ id, level }) {
    return (await buildPlan(id, level)).blocked
  },
  async execute({ id, level }, ctx) {
    const g = gameById(id)!
    const levelName = OPT_LEVELS.find((l) => l.id === level)!.name
    ctx.progress('Analisando a compatibilidade', 0, null, { stage: 'verifying' })
    const plan = await buildPlan(id, level)
    const apply = plan.rows.filter((r) => r.status === 'apply')
    const entryId = randomUUID()
    const report: RunReport = { entryId, rows: [], metricsBefore: metrics(), metricsAfter: null }
    const children: Child[] = []
    const tweakRows = apply.filter((r) => r.kind === 'tweak')
    const gfxRows = apply.filter((r) => r.kind === 'graphics')
    const stepsTotal = (tweakRows.length ? 1 : 0) + (plan.graphics ? 1 : 0)
    let stepsDone = 0
    let applied = 0
    let failed = 0
    const emit = (itemId: string, name: string, state: ItemState, message?: string) => ctx.progress(`${name}…`, stepsDone, stepsTotal, { stage: 'item', id: itemId, name, state, message })

    if (tweakRows.length) {
      for (const r of tweakRows) emit(`tweak:${r.id}`, r.label, 'running')
      if (ctx.signal.aborted) {
        for (const r of tweakRows) emit(`tweak:${r.id}`, r.label, 'skipped', 'Cancelado')
        report.rows.push({ label: 'Ajustes do Windows', value: 'Cancelado antes de começar', tone: 'warn' })
      } else {
        try {
          const out = await nested('tweaks.apply', { changes: plan.tweakChanges })
          if (out.changeId) children.push({ actionId: 'tweaks.apply', changeId: out.changeId, label: 'Ajustes do Windows' })
          const rowByName = new Map((out.sections[0]?.rows ?? []).map((x) => [x.label, x]))
          for (const r of tweakRows) {
            const row = rowByName.get(r.label)
            const bad = out.blocked !== null || !row || /^Falhou|Cancelado/.test(row.value)
            if (bad) failed++
            else applied++
            emit(`tweak:${r.id}`, r.label, bad ? 'error' : 'ok', row?.value ?? out.blocked ?? 'Sem resultado do Windows')
            report.rows.push({ label: r.label, value: row?.value ?? out.blocked ?? 'Sem resultado', tone: bad ? 'error' : 'ok' })
          }
        } catch (error) {
          failed += tweakRows.length
          for (const r of tweakRows) {
            emit(`tweak:${r.id}`, r.label, 'error', (error as Error).message)
            report.rows.push({ label: r.label, value: `Falhou: ${(error as Error).message}`, tone: 'error' })
          }
        }
      }
      stepsDone++
    }

    if (plan.graphics) {
      const gname = `Configurações gráficas (${plan.graphics.file === 'fivem' ? 'FiveM' : 'GTA V'})`
      emit('graphics', gname, 'running')
      if (ctx.signal.aborted) {
        emit('graphics', gname, 'skipped', 'Cancelado')
        report.rows.push({ label: gname, value: 'Cancelado antes de começar', tone: 'warn' })
      } else {
        try {
          const out = await nested('fivem.settings.apply', { file: plan.graphics.file, changes: plan.graphics.changes })
          if (out.changeId) children.push({ actionId: 'fivem.settings.apply', changeId: out.changeId, label: gname })
          if (out.blocked || !out.ok) {
            failed++
            emit('graphics', gname, 'error', out.blocked ?? out.summary)
            report.rows.push({ label: gname, value: `Falhou: ${out.blocked ?? out.summary}`, tone: 'error' })
          } else {
            applied += gfxRows.length
            emit('graphics', gname, 'ok', `${gfxRows.length} chave(s) gravadas e conferidas`)
            report.rows.push({ label: gname, value: `${gfxRows.length} chave(s) gravadas e conferidas (cópia do arquivo guardada)`, tone: 'ok' })
          }
        } catch (error) {
          failed++
          emit('graphics', gname, 'error', (error as Error).message)
          report.rows.push({ label: gname, value: `Falhou: ${(error as Error).message}`, tone: 'error' })
        }
      }
      stepsDone++
    }
    for (const r of plan.rows.filter((x) => x.status === 'unavailable' || x.status === 'skipped')) report.rows.push({ label: r.label, value: `Ignorado: ${r.reason}`, tone: 'warn' })
    for (const r of plan.rows.filter((x) => x.status === 'already')) report.rows.push({ label: r.label, value: 'Já configurado', tone: 'ok' })
    ctx.progress('Conferindo e registrando', stepsTotal, stepsTotal, { stage: 'checking' })
    report.metricsAfter = metrics()
    const restart = tweakRows.filter((r) => r.needsRestart && children.length).map((r) => r.label)
    if (restart.length) report.rows.push({ label: 'Reinicialização necessária', value: `${restart.join(', ')}. O JK Optimize não reinicia o computador sozinho.`, tone: 'warn' })

    const outcome: RunEntry['outcome'] = applied === 0 ? 'failed' : failed === 0 ? 'ok' : 'partial'
    const summary =
      outcome === 'ok'
        ? `${levelName} aplicada em ${g.name}: ${applied} ajuste(s) conferido(s).`
        : outcome === 'partial'
          ? `${levelName} aplicada parcialmente em ${g.name}: ${applied} ajuste(s) conferido(s), ${failed} com falha.`
          : `${levelName} não foi aplicada em ${g.name}: nenhum ajuste foi concluído.`
    runs.write([{ id: entryId, at: new Date().toISOString(), gameId: id, level, outcome, summary, rows: report.rows, metricsBefore: report.metricsBefore, metricsAfter: report.metricsAfter }, ...runs.read()].slice(0, 200))
    log[outcome === 'ok' ? 'info' : 'warn']('games', summary)
    const sections: TaskDetailSection[] = [{ title: `${levelName} · ${g.name}`, rows: report.rows }]
    if (report.metricsBefore || report.metricsAfter) {
      const f = (m: Metrics | null) => (m ? `CPU ${m.cpuPct ?? '—'}% · RAM livre ${m.ramAvailableGB ?? '—'} GB · memória comprometida ${m.commitPct ?? '—'}%` : 'indisponível')
      sections.push({ title: 'Medições do Windows (instantâneos, não são FPS)', rows: [{ label: 'Antes', value: f(report.metricsBefore) }, { label: 'Depois', value: f(report.metricsAfter) }] })
    }
    return {
      ok: outcome === 'ok',
      verified: true,
      summary,
      sections,
      change: children.length
        ? { before: { gameId: id, level, children, report }, after: { children: children.map((c) => c.changeId) }, summaryBefore: `${levelName} em ${g.name}: estado anterior guardado em ${children.length} registro(s)`, summaryAfter: `${levelName} em ${g.name}: ${applied} ajuste(s)` }
        : undefined
    }
  },
  async revert(before, _after, ctx) {
    const restored: string[] = []
    const preserved: string[] = []
    const failed: string[] = []
    for (const c of [...before.children].reverse()) {
      try {
        await revertChange(c.changeId, ctx.force)
        restored.push(c.label)
      } catch (error) {
        const e = error as AppFailure
        if (e.code === 'already-reverted') restored.push(`${c.label} (já revertido antes)`)
        else if (e.code === 'state-changed') preserved.push(`${c.label}: ${e.message}`)
        else failed.push(`${c.label}: ${e.message}`)
      }
    }
    if (restored.length === 0 && failed.length === 0 && preserved.length > 0) throw new AppFailure('state-changed', `Alterado depois por outro programa ou pelo jogo; estado atual preservado. ${preserved.join(' ')}`)
    if (failed.length) throw new AppFailure('revert-failed', `Restaurado: ${restored.join(', ') || 'nada'}. Falhou: ${failed.join('; ')}.`)
    return `Restaurado: ${restored.join(', ')}.${preserved.length ? ` Preservado (alterado depois): ${preserved.join(' ')}` : ''}`
  }
})

// ---------------------------------------------------------------------------
// Histórico do jogo (execuções + estado real de reversão no diário)
// ---------------------------------------------------------------------------

defineQuery({
  id: 'games.history',
  module: 'fivem',
  parse: (raw) => ({ id: raw === undefined ? null : (obj(raw, ['id']).id === undefined ? null : str(obj(raw, ['id']).id, 'jogo', 40, /^[a-z0-9-]+$/)) }),
  async run({ id }) {
    const changes = new Map(listChanges().filter((c) => c.actionId === 'games.profile.apply').map((c) => [c.id, c]))
    const byEntry = new Map<string, { changeId: string; status: string; revertedAt: string | null; reversible: boolean }>()
    for (const c of changes.values()) {
      try {
        const b = journal.readBackup(c.id).before as Backup
        if (b?.report?.entryId) byEntry.set(b.report.entryId, { changeId: c.id, status: c.status, revertedAt: c.revertedAt, reversible: c.reversible })
      } catch {
        // backup ilegível: a execução aparece sem a opção de reverter
      }
    }
    return runs
      .read()
      .filter((r) => !id || r.gameId === id)
      .map((r) => ({ ...r, change: byEntry.get(r.id) ?? null }))
  }
})

// ---------------------------------------------------------------------------
// Aplicativos em segundo plano (o usuário escolhe quais fechar; nada é encerrado automaticamente)
// ---------------------------------------------------------------------------

const GAME_EXES = new Set(GAME_CATALOG.flatMap((g) => g.exes).map((e) => e.replace(/\.exe$/i, '').toLowerCase()))
const isGameName = (n: string) => GAME_EXES.has(n.toLowerCase()) || /^(fivem|gta5|fivem_.*)$/i.test(n)

export interface BackgroundApp {
  name: string
  count: number
  ramBytes: number
  title: string | null
}

export async function backgroundCandidates(): Promise<BackgroundApp[]> {
  const list = await listProcesses()
  const map = new Map<string, BackgroundApp>()
  for (const p of list) {
    if (p.protectedReason || !p.hasWindow || !p.sameSession || CRITICAL_PROCESSES.has(p.name.toLowerCase()) || isGameName(p.name)) continue
    const cur = map.get(p.name.toLowerCase()) ?? { name: p.name, count: 0, ramBytes: 0, title: p.windowTitle }
    cur.count++
    cur.ramBytes += p.privateBytes
    map.set(p.name.toLowerCase(), cur)
  }
  return [...map.values()].sort((a, b) => b.ramBytes - a.ramBytes).slice(0, 20)
}

defineQuery({ id: 'games.apps.candidates', module: 'processes', parse: noParams, run: () => backgroundCandidates() })

const CLOSE_NICELY = `
$res = foreach ($name in @($in.names)) {
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId })
  $closed = 0
  foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow(); if ($p.WaitForExit(8000)) { $closed++ } } }
  [pscustomobject]@{ name = [string]$name; found = $procs.Count; closed = $closed }
}
@($res) | ConvertTo-Json -Compress`

defineAction<{ names: string[] }, never>({
  id: 'games.apps.close',
  module: 'processes',
  title: 'Fechar aplicativos em segundo plano',
  description: 'Pede aos aplicativos escolhidos que fechem normalmente (nunca de forma forçada).',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Um aplicativo fechado não volta sozinho e dados não salvos podem ser perdidos; o fechamento é normal, não forçado.',
  requiresElevation: false,
  exclusive: 'games-close',
  parse: (raw) => ({ names: [...new Set(strList(obj(raw, ['names']).names, 'aplicativos', 20, 80, /^[\p{L}\p{N} ._()+-]+$/u))] }),
  async preview({ names }) {
    const cands = new Map((await backgroundCandidates()).map((c) => [c.name.toLowerCase(), c]))
    const ok = names.filter((n) => cands.has(n.toLowerCase()))
    return {
      summary: `${ok.length} aplicativo(s) a fechar.`,
      changes: ok.map((n) => ({ target: n, current: `${cands.get(n.toLowerCase())!.count} janela(s) aberta(s)`, intended: 'Fechamento normal solicitado' })),
      warnings: ['O fechamento é normal: o aplicativo pode pedir para salvar o trabalho e, se ele não fechar, continua aberto (nada é forçado).', ...names.filter((n) => !cands.has(n.toLowerCase())).map((n) => `${n}: não é um aplicativo que possa ser fechado com segurança.`)],
      blocked: ok.length === 0 ? 'Nenhum dos aplicativos escolhidos pode ser fechado com segurança.' : null
    }
  },
  async execute({ names }, ctx) {
    const cands = new Set((await backgroundCandidates()).map((c) => c.name.toLowerCase()))
    const allowed = names.filter((n) => cands.has(n.toLowerCase()))
    const rows: { label: string; value: string; tone: 'ok' | 'warn' | 'error' }[] = []
    let closedApps = 0
    for (const [i, n] of allowed.entries()) {
      if (ctx.signal.aborted) {
        rows.push({ label: n, value: 'Não processado (cancelado)', tone: 'warn' })
        continue
      }
      ctx.progress(`Fechando ${n}…`, i, allowed.length, { stage: 'item', id: n, name: n, state: 'running' })
      const r = await runPowerShellWith<{ name: string; found: number; closed: number } | { name: string; found: number; closed: number }[]>(CLOSE_NICELY, { names: [n] }, { timeoutMs: 40_000 })
      const row = (Array.isArray(r) ? r[0] : r) ?? { found: 0, closed: 0, name: n }
      const done = row.found > 0 && row.closed === row.found
      if (done) closedApps++
      rows.push({ label: n, value: row.found === 0 ? 'Já não estava aberto' : done ? `${row.closed} instância(s) fechadas (conferido)` : `${row.closed} de ${row.found} fecharam; as demais continuam abertas (não são forçadas)`, tone: done || row.found === 0 ? 'ok' : 'warn' })
      ctx.progress(`${n}`, i + 1, allowed.length, { stage: 'item', id: n, name: n, state: done || row.found === 0 ? 'ok' : 'error', message: rows[rows.length - 1].value })
    }
    return { ok: rows.every((r) => r.tone === 'ok'), verified: true, summary: `${closedApps} de ${allowed.length} aplicativo(s) fechado(s).`, sections: [{ title: 'Aplicativos', rows }] }
  }
})
