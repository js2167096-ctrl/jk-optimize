// Perfis de Windows para jogos: Desempenho, Equilibrado e Qualidade.
// Cada item é uma configuração real e verificável; o perfil mostra o que muda,
// guarda o estado anterior de todos os itens e permite restaurar tudo.
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { obj, oneOf } from '../ops/params'
import { log } from '../ops/log'
import { getStaticInfo } from '../services/system'
import { getPowerState, setActive } from './power'
import { readValues, writeValue, type RegValue } from './winsettings'
import { detectInstall } from './fivem'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export type WindowsProfile = 'performance' | 'balanced' | 'quality'

export const PROFILE_LABEL: Record<WindowsProfile, string> = { performance: 'Desempenho', balanced: 'Equilibrado', quality: 'Qualidade' }

const BALANCED_GUID = '381b4222-f694-41f0-9685-ff5bb260df2e'
const HIGH_GUID = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

const REG = {
  gameMode: { key: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', type: 'DWord' as const },
  gameDvr: { key: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'DWord' as const },
  dvrPolicy: { key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', name: 'AllowGameDVR' },
  transparency: { key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', name: 'EnableTransparency', type: 'DWord' as const },
  gpuPrefs: { key: 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences', type: 'String' as const }
}

export interface PlanItem {
  id: string
  label: string
  kind: 'power' | 'registry'
  key?: string
  name?: string
  type?: 'DWord' | 'String'
  current: RegValue
  intended: RegValue
  currentLabel: string
  intendedLabel: string
  applicable: boolean
  note: string | null
}

const onOff = (v: RegValue, missing = 'não definido') => (v === null ? missing : Number(v) === 0 ? 'desativado' : 'ativado')

/** Monta a lista de itens do perfil para o estado atual. */
export async function buildProfilePlan(profile: WindowsProfile): Promise<PlanItem[]> {
  const [power, info, install] = await Promise.all([getPowerState(), getStaticInfo(false), detectInstall().catch(() => null)])
  const gameExes = [
    install?.fivem.dir ? join(install.fivem.dir, 'FiveM.exe') : null,
    install?.gta?.dir ? join(install.gta.dir, install.gta.edition === 'enhanced' ? 'GTA5_Enhanced.exe' : 'GTA5.exe') : null
  ].filter((p): p is string => !!p && existsSync(p))
  const values = await readValues([
    { id: 'gameMode', key: REG.gameMode.key, name: REG.gameMode.name },
    { id: 'gameDvr', key: REG.gameDvr.key, name: REG.gameDvr.name },
    { id: 'dvrPolicy', key: REG.dvrPolicy.key, name: REG.dvrPolicy.name },
    { id: 'transparency', key: REG.transparency.key, name: REG.transparency.name },
    ...gameExes.map((exe, i) => ({ id: `gpu${i}`, key: REG.gpuPrefs.key, name: exe }))
  ])
  const items: PlanItem[] = []

  // Plano de energia
  const ultimate = power.schemes.find((s) => s.ultimate)
  const high = power.schemes.find((s) => s.guid === HIGH_GUID)
  const balanced = power.schemes.find((s) => s.guid === BALANCED_GUID)
  const target = profile === 'performance' ? ultimate ?? high ?? balanced : profile === 'quality' ? high ?? ultimate ?? balanced : balanced
  items.push({
    id: 'power',
    label: 'Plano de energia',
    kind: 'power',
    current: power.active?.guid ?? null,
    intended: target?.guid ?? null,
    currentLabel: power.active?.name ?? '—',
    intendedLabel: target?.name ?? 'indisponível',
    applicable: !!target,
    note: target ? null : 'Nenhum plano compatível encontrado.'
  })

  // Modo de Jogo (todos os perfis)
  items.push({
    id: 'gameMode',
    label: 'Modo de Jogo',
    kind: 'registry',
    ...REG.gameMode,
    current: values.get('gameMode') ?? null,
    intended: 1,
    currentLabel: onOff(values.get('gameMode') ?? null, 'não definido (padrão: ativado)'),
    intendedLabel: 'ativado',
    applicable: true,
    note: null
  })

  // Gravação em segundo plano (somente Desempenho)
  const dvrLocked = values.get('dvrPolicy') !== null && values.get('dvrPolicy') !== undefined
  if (profile === 'performance') {
    items.push({
      id: 'gameDvr',
      label: 'Gravação em segundo plano (Game DVR)',
      kind: 'registry',
      ...REG.gameDvr,
      current: values.get('gameDvr') ?? null,
      intended: 0,
      currentLabel: onOff(values.get('gameDvr') ?? null),
      intendedLabel: 'desativado',
      applicable: !dvrLocked,
      note: dvrLocked ? 'Definido por política do sistema; não é alterado.' : null
    })
  }

  // Transparência do Windows
  if (profile !== 'balanced') {
    const want = profile === 'performance' ? 0 : 1
    items.push({
      id: 'transparency',
      label: 'Efeitos de transparência do Windows',
      kind: 'registry',
      ...REG.transparency,
      current: values.get('transparency') ?? null,
      intended: want,
      currentLabel: onOff(values.get('transparency') ?? null, 'não definido (padrão: ativado)'),
      intendedLabel: want ? 'ativado' : 'desativado',
      applicable: true,
      note: null
    })
  }

  // Preferência de GPU por jogo (só com mais de uma GPU física)
  const physical = info.gpus.filter((g) => !/basic (display|render)|virtual/i.test(g.name))
  if (profile !== 'balanced') {
    if (physical.length < 2) {
      items.push({
        id: 'gpuPref',
        label: 'Preferência de GPU para FiveM/GTA V',
        kind: 'registry',
        current: null,
        intended: null,
        currentLabel: '—',
        intendedLabel: '—',
        applicable: false,
        note: `Não aplicável: há ${physical.length} GPU física neste computador.`
      })
    } else {
      gameExes.forEach((exe, i) => {
        const cur = values.get(`gpu${i}`) ?? null
        items.push({
          id: `gpu${i}`,
          label: `Preferência de GPU: ${exe.split('\\').pop()}`,
          kind: 'registry',
          key: REG.gpuPrefs.key,
          name: exe,
          type: 'String',
          current: cur,
          intended: 'GpuPreference=2;',
          currentLabel: cur === null ? 'padrão do Windows' : String(cur),
          intendedLabel: 'Alto desempenho (GpuPreference=2)',
          applicable: true,
          note: null
        })
      })
    }
  }
  return items
}

const differs = (i: PlanItem) => i.applicable && String(i.current) !== String(i.intended)

interface ProfileBackup {
  profile: WindowsProfile
  items: { id: string; label: string; kind: 'power' | 'registry'; key?: string; name?: string; type?: 'DWord' | 'String'; before: RegValue; after: RegValue }[]
}

async function applyItem(item: { kind: 'power' | 'registry'; key?: string; name?: string; type?: 'DWord' | 'String' }, value: RegValue): Promise<RegValue> {
  if (item.kind === 'power') {
    if (typeof value !== 'string') throw new AppFailure('invalid', 'Plano inválido.')
    await setActive(value)
    return (await getPowerState()).active?.guid ?? null
  }
  return writeValue(item.key!, item.name!, item.type!, value)
}

const same = (a: RegValue, b: RegValue) => String(a) === String(b)

defineQuery({
  id: 'profiles.windows.plan',
  module: 'power',
  parse: (raw) => ({ profile: oneOf(obj(raw, ['profile']).profile, 'perfil', ['performance', 'balanced', 'quality'] as const) }),
  run: async ({ profile }) => buildProfilePlan(profile)
})

defineAction<{ profile: WindowsProfile }, ProfileBackup>({
  id: 'profiles.windows.apply',
  module: 'power',
  title: 'Aplicar perfil de Windows para jogos',
  description: 'Aplica o perfil escolhido (plano de energia, Modo de Jogo, gravação em segundo plano, transparência e preferência de GPU), guardando o estado anterior.',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'power',
  parse: (raw) => ({ profile: oneOf(obj(raw, ['profile']).profile, 'perfil', ['performance', 'balanced', 'quality'] as const) }),
  async preview({ profile }) {
    const plan = await buildProfilePlan(profile)
    const changes = plan.filter(differs)
    return {
      summary: `Perfil ${PROFILE_LABEL[profile]}: ${changes.length} configuração(ões) a alterar.`,
      changes: changes.map((i) => ({ target: i.label, current: i.currentLabel, intended: i.intendedLabel })),
      warnings: [
        'Os perfis alteram apenas configurações existentes e verificáveis; não há ganho de FPS garantido.',
        ...plan.filter((i) => !i.applicable && i.note).map((i) => `${i.label}: ${i.note}`)
      ],
      blocked: changes.length === 0 ? 'O computador já está com as configurações deste perfil.' : null
    }
  },
  async execute({ profile }) {
    const plan = (await buildProfilePlan(profile)).filter(differs)
    const done: ProfileBackup['items'] = []
    const rows: { label: string; value: string; tone: 'ok' | 'error' }[] = []
    for (const item of plan) {
      try {
        const now = await applyItem(item, item.intended)
        if (!same(now, item.intended)) throw new Error(`valor lido depois: ${now ?? 'ausente'}`)
        done.push({ id: item.id, label: item.label, kind: item.kind, key: item.key, name: item.name, type: item.type, before: item.current, after: now })
        rows.push({ label: item.label, value: `${item.currentLabel} → ${item.intendedLabel} (conferido)`, tone: 'ok' })
      } catch (error) {
        rows.push({ label: item.label, value: `Falhou: ${(error as Error).message}`, tone: 'error' })
        log.warn('power', `Perfil ${PROFILE_LABEL[profile]}: ${item.label} falhou — ${(error as Error).message}`)
      }
    }
    const failed = plan.length - done.length
    return {
      ok: failed === 0 && done.length > 0,
      verified: true,
      summary:
        failed === 0
          ? `Perfil ${PROFILE_LABEL[profile]} aplicado: ${done.length} configuração(ões) conferidas.`
          : `Perfil ${PROFILE_LABEL[profile]} aplicado parcialmente: ${done.length} de ${plan.length} configurações (veja Detalhes).`,
      sections: [{ title: `Perfil ${PROFILE_LABEL[profile]}`, rows }],
      change: done.length
        ? {
            before: { profile, items: done },
            after: { items: done.map((d) => ({ id: d.id, value: d.after })) },
            summaryBefore: done.map((d) => `${d.label}: ${d.before ?? 'padrão'}`).join('; '),
            summaryAfter: `Perfil ${PROFILE_LABEL[profile]} (${done.length} itens)`
          }
        : undefined
    }
  },
  async revert(before, _after, ctx) {
    const results: string[] = []
    const failures: string[] = []
    for (const item of before.items) {
      try {
        const current = item.kind === 'power' ? (await getPowerState()).active?.guid ?? null : (await readValues([{ id: 'x', key: item.key!, name: item.name! }])).get('x') ?? null
        if (!same(current, item.after) && !ctx.force) {
          failures.push(`${item.label}: alterado depois do perfil (mantido)`)
          continue
        }
        if (item.kind === 'power' && item.before === null) continue
        const now = await applyItem(item, item.before)
        if (!same(now, item.before)) throw new Error('valor não conferiu')
        results.push(item.label)
      } catch (error) {
        failures.push(`${item.label}: ${(error as Error).message}`)
      }
    }
    if (results.length === 0 && failures.length) throw new AppFailure('state-changed', `Nada foi restaurado. ${failures.join('; ')}`)
    return `Restaurado: ${results.join(', ')}${failures.length ? `. Não restaurado: ${failures.join('; ')}` : ''}.`
  }
})
