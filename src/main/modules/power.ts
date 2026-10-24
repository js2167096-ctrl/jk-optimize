// Energia: planos de energia, Ultimate Performance e configurações de jogo do Windows.
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { GUID, noParams, obj, oneOf, str } from '../ops/params'
import { asArray, asNumber, runPowerShellJson, runPowerShellWith } from '../services/powershell'
import { runElevated } from '../services/elevated'

export const ULTIMATE_TEMPLATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61'
/** Recurso de nome do plano Ultimate (independe do idioma do Windows). */
const ULTIMATE_RESOURCE = /powrprof\.dll,-19\b/i

export interface PowerScheme {
  guid: string
  name: string
  active: boolean
  ultimate: boolean
}

const LIST_SCRIPT = `
$list = (powercfg /list) | Out-String
$schemes = @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes' -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ guid = $_.PSChildName.ToLower(); friendly = [string](Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).FriendlyName }
})
$battery = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue).Count
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
[pscustomobject]@{ list = $list; schemes = $schemes; battery = $battery; build = $build } | ConvertTo-Json -Depth 3 -Compress`

/** Interpreta a saída de `powercfg /list` (qualquer idioma: GUID, nome entre parênteses, * = ativo). */
export function parsePowercfgList(text: string): { guid: string; name: string; active: boolean }[] {
  const out: { guid: string; name: string; active: boolean }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\((.+)\)\s*(\*)?\s*$/i.exec(line)
    if (m) out.push({ guid: m[1].toLowerCase(), name: m[2].trim(), active: m[3] === '*' })
  }
  return out
}

export async function getPowerState() {
  const raw = await runPowerShellJson<{ list: string; schemes: unknown; battery: number; build: number }>(LIST_SCRIPT)
  if (!raw) throw new AppFailure('powercfg-failed', 'Não foi possível consultar os planos de energia.')
  const friendly = new Map(asArray(raw.schemes).map((s) => [String((s as { guid: string }).guid), String((s as { friendly: string }).friendly ?? '')]))
  const schemes: PowerScheme[] = parsePowercfgList(raw.list).map((s) => ({ ...s, ultimate: ULTIMATE_RESOURCE.test(friendly.get(s.guid) ?? '') }))
  return {
    schemes,
    active: schemes.find((s) => s.active) ?? null,
    hasBattery: (asNumber(raw.battery) ?? 0) > 0,
    build: asNumber(raw.build) ?? 0
  }
}

const SET_ACTIVE = `
$out = (powercfg /setactive $in.guid) 2>&1 | Out-String
$code = $LASTEXITCODE
$active = (powercfg /getactivescheme) | Out-String
[pscustomobject]@{ code = $code; out = $out; active = $active } | ConvertTo-Json -Compress`

export async function setActive(guid: string): Promise<void> {
  const r = await runPowerShellWith<{ code: number; out: string; active: string }>(SET_ACTIVE, { guid })
  const active = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(r?.active ?? '')?.[1] ?? '').toLowerCase()
  if (!r || r.code !== 0 || active !== guid) {
    throw new AppFailure('powercfg-failed', `O Windows não aplicou o plano (código ${r?.code ?? '?'}). ${r?.out?.trim() ?? ''}`)
  }
}

defineQuery({ id: 'power.plans', module: 'power', parse: noParams, run: () => getPowerState() })

interface PlanBackup {
  previous: string
  previousName: string
}

defineAction<{ guid: string }, PlanBackup>({
  id: 'power.plan.set',
  module: 'power',
  title: 'Ativar plano de energia',
  description: 'Ativa um plano de energia existente e confirma que o Windows o aplicou.',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'power',
  parse: (raw) => ({ guid: str(obj(raw, ['guid']).guid, 'plano', 38, GUID).replace(/[{}]/g, '').toLowerCase() }),
  async preview({ guid }) {
    const state = await getPowerState()
    const target = state.schemes.find((s) => s.guid === guid)
    return {
      summary: target ? `Ativar "${target.name}".` : 'Plano não encontrado.',
      changes: [{ target: 'Plano de energia ativo', current: state.active?.name ?? '—', intended: target?.name ?? '—' }],
      warnings: target?.ultimate ? ['O plano Ultimate aumenta o consumo de energia e o calor; o ganho real depende do hardware.'] : [],
      blocked: !target ? 'Este plano não existe neste computador.' : target.active ? 'Este plano já está ativo.' : null
    }
  },
  async execute({ guid }) {
    const state = await getPowerState()
    const target = state.schemes.find((s) => s.guid === guid)!
    const previous = state.active
    await setActive(guid)
    return {
      ok: true,
      verified: true,
      summary: `Plano "${target.name}" ativo (conferido com powercfg).`,
      change: {
        before: { previous: previous?.guid ?? '', previousName: previous?.name ?? '' },
        after: { guid, name: target.name },
        summaryBefore: `Plano ativo: ${previous?.name ?? '—'}`,
        summaryAfter: `Plano ativo: ${target.name}`
      }
    }
  },
  async revert(before, after, ctx) {
    const state = await getPowerState()
    const expected = (after as { guid: string }).guid
    if (state.active?.guid !== expected && !ctx.force) {
      throw new AppFailure('state-changed', `O plano ativo mudou desde a alteração (agora: ${state.active?.name ?? '—'}). Use "forçar" para voltar mesmo assim.`)
    }
    if (!state.schemes.some((s) => s.guid === before.previous)) throw new AppFailure('missing', 'O plano anterior não existe mais.')
    await setActive(before.previous)
    return `Plano "${before.previousName}" reativado.`
  }
})

// ---------------------------------------------------------------------------
// Ultimate Performance
// ---------------------------------------------------------------------------

const DUPLICATE = `
$out = (powercfg /duplicatescheme ${ULTIMATE_TEMPLATE}) 2>&1 | Out-String
[pscustomobject]@{ code = $LASTEXITCODE; out = $out } | ConvertTo-Json -Compress`

const DELETE_SCHEME = `
$out = (powercfg /delete $in.guid) 2>&1 | Out-String
[pscustomobject]@{ code = $LASTEXITCODE; out = $out } | ConvertTo-Json -Compress`

interface UltimateBackup {
  previous: string
  previousName: string
  created: string | null
}

defineAction<Record<string, never>, UltimateBackup>({
  id: 'power.ultimate.enable',
  module: 'power',
  title: 'Ativar Ultimate Performance',
  description: 'Cria o plano Ultimate Performance a partir do modelo do Windows (se não existir) e o ativa.',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'power',
  parse: noParams,
  async preview() {
    const state = await getPowerState()
    const existing = state.schemes.find((s) => s.ultimate)
    const supported = state.build >= 17134
    return {
      summary: existing ? `O plano "${existing.name}" já existe e será ativado.` : 'O plano será criado a partir do modelo do Windows e ativado.',
      changes: [
        ...(existing ? [] : [{ target: 'Planos de energia', current: 'Sem Ultimate Performance', intended: 'Ultimate Performance criado' }]),
        { target: 'Plano ativo', current: state.active?.name ?? '—', intended: existing?.name ?? 'Ultimate Performance' }
      ],
      warnings: [
        'Não há ganho garantido de FPS: o plano reduz economias de energia (núcleos estacionados, timers) e aumenta consumo e calor.',
        ...(state.hasBattery ? ['Este computador tem bateria: a autonomia será reduzida e a Microsoft não recomenda o plano em uso com bateria.'] : [])
      ],
      blocked: !supported
        ? 'Requer Windows 10 versão 1803 (build 17134) ou superior.'
        : existing?.active
          ? 'O Ultimate Performance já está ativo.'
          : null
    }
  },
  async execute() {
    const state = await getPowerState()
    let target = state.schemes.find((s) => s.ultimate)
    let created: string | null = null
    if (!target) {
      const r = await runPowerShellJson<{ code: number; out: string }>(DUPLICATE)
      const guid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(r?.out ?? '')?.[1]?.toLowerCase()
      if (!r || r.code !== 0 || !guid) {
        throw new AppFailure('ultimate-unsupported', `O Windows recusou criar o plano (código ${r?.code ?? '?'}): ${r?.out?.trim() ?? ''}`)
      }
      created = guid
      target = (await getPowerState()).schemes.find((s) => s.guid === guid)
      if (!target) throw new AppFailure('ultimate-unsupported', 'O plano foi criado, mas não aparece na lista do Windows.')
    }
    await setActive(target.guid)
    return {
      ok: true,
      verified: true,
      summary: `${created ? 'Plano criado e ativado' : 'Plano ativado'}: "${target.name}" (conferido).`,
      change: {
        before: { previous: state.active?.guid ?? '', previousName: state.active?.name ?? '', created },
        after: { guid: target.guid, name: target.name },
        summaryBefore: `Plano ativo: ${state.active?.name ?? '—'}`,
        summaryAfter: `Plano ativo: ${target.name}${created ? ' (criado)' : ''}`
      }
    }
  },
  async revert(before, after, ctx) {
    const state = await getPowerState()
    const expected = (after as { guid: string }).guid
    if (state.active?.guid !== expected && !ctx.force) {
      throw new AppFailure('state-changed', `O plano ativo mudou desde a alteração (agora: ${state.active?.name ?? '—'}).`)
    }
    if (before.previous && state.schemes.some((s) => s.guid === before.previous)) await setActive(before.previous)
    if (before.created && state.schemes.some((s) => s.guid === before.created)) {
      let r = await runPowerShellWith<{ code: number; out: string }>(DELETE_SCHEME, { guid: before.created })
      if (r?.code !== 0) {
        const elevated = await runElevated<{ code: number }>(
          `$o = (powercfg /delete $in.guid) 2>&1 | Out-String; Out-Result ([pscustomobject]@{ code = $LASTEXITCODE; out = $o }); exit 0`,
          { guid: before.created }
        )
        r = { code: elevated.output?.code ?? -1, out: '' }
      }
      if (r?.code !== 0) throw new AppFailure('delete-failed', 'O plano anterior foi reativado, mas o plano criado não pôde ser removido.')
    }
    return `Plano "${before.previousName}" reativado${before.created ? ' e plano criado removido' : ''}.`
  }
})

// ---------------------------------------------------------------------------
// Game Mode e configurações de jogo
// ---------------------------------------------------------------------------

interface GameSetting {
  id: 'gameMode' | 'gameDvr' | 'appCapture'
  label: string
  description: string
  key: string
  value: string
  /** Comportamento do Windows quando o valor não existe. */
  defaultWhenMissing: string
  policy?: { key: string; value: string }
}

const GAME_SETTINGS: GameSetting[] = [
  {
    id: 'gameMode',
    label: 'Modo de Jogo',
    description: 'Prioriza o jogo em execução e evita reinicializações do Windows Update durante a partida.',
    key: 'HKCU:\\Software\\Microsoft\\GameBar',
    value: 'AutoGameModeEnabled',
    defaultWhenMissing: 'não definido (padrão do Windows: ativado)'
  },
  {
    id: 'gameDvr',
    label: 'Gravação em segundo plano (Game DVR)',
    description: 'Grava continuamente os últimos minutos do jogo; consome CPU/GPU quando ativa.',
    key: 'HKCU:\\System\\GameConfigStore',
    value: 'GameDVR_Enabled',
    defaultWhenMissing: 'não definido',
    policy: { key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR' }
  },
  {
    id: 'appCapture',
    label: 'Capturas da Xbox Game Bar',
    description: 'Permite capturas e gravações pela Game Bar.',
    key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR',
    value: 'AppCaptureEnabled',
    defaultWhenMissing: 'não definido',
    policy: { key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', value: 'AllowGameDVR' }
  }
]

const READ_VALUES = `
$res = foreach ($s in $in.items) {
  $v = $null; $exists = $false
  try { $p = Get-ItemProperty -LiteralPath $s.key -Name $s.value -ErrorAction Stop; $v = $p.($s.value); $exists = $true } catch {}
  [pscustomobject]@{ id = $s.id; exists = $exists; value = $v }
}
@($res) | ConvertTo-Json -Compress`

async function readRegistry(items: { id: string; key: string; value: string }[]): Promise<Map<string, number | null>> {
  const raw = await runPowerShellWith<unknown>(READ_VALUES, { items })
  const map = new Map<string, number | null>()
  for (const r of asArray(raw)) {
    const row = r as { id: string; exists: boolean; value: unknown }
    map.set(row.id, row.exists ? (asNumber(row.value) ?? null) : null)
  }
  return map
}

async function gameSettingsState() {
  const values = await readRegistry(GAME_SETTINGS.map((s) => ({ id: s.id, key: s.key, value: s.value })))
  const policies = await readRegistry(
    GAME_SETTINGS.filter((s) => s.policy).map((s) => ({ id: s.id, key: s.policy!.key, value: s.policy!.value }))
  )
  const hags = await readRegistry([{ id: 'hags', key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value: 'HwSchMode' }])
  return {
    settings: GAME_SETTINGS.map((s) => {
      const value = values.get(s.id) ?? null
      const policy = policies.get(s.id) ?? null
      return {
        id: s.id,
        label: s.label,
        description: s.description,
        registry: `${s.key}\\${s.value}`,
        value,
        state: value === null ? s.defaultWhenMissing : value === 0 ? 'desativado' : 'ativado',
        confirmed: value !== null,
        lockedByPolicy: policy !== null ? `Definido por política do sistema (AllowGameDVR=${policy}); não será alterado.` : null
      }
    }),
    hardwareScheduling: {
      value: hags.get('hags') ?? null,
      state: hags.get('hags') === 2 ? 'ativado' : hags.get('hags') === 1 ? 'desativado' : 'não definido pelo driver/Windows',
      note: 'Somente leitura: alterar exige administrador e reinicialização.'
    }
  }
}

defineQuery({ id: 'power.game.settings', module: 'power', parse: noParams, run: () => gameSettingsState() })

const WRITE_DWORD = `
if ($in.remove) { Remove-ItemProperty -LiteralPath $in.key -Name $in.value -ErrorAction SilentlyContinue }
else {
  if (-not (Test-Path -LiteralPath $in.key)) { New-Item -Path $in.key -Force | Out-Null }
  Set-ItemProperty -LiteralPath $in.key -Name $in.value -Value ([int]$in.data) -Type DWord
}
$now = $null; try { $now = (Get-ItemProperty -LiteralPath $in.key -Name $in.value -ErrorAction Stop).($in.value) } catch {}
[pscustomobject]@{ now = $now } | ConvertTo-Json -Compress`

async function writeSetting(setting: GameSetting, data: number | null): Promise<number | null> {
  const r = await runPowerShellWith<{ now: unknown }>(WRITE_DWORD, { key: setting.key, value: setting.value, data: data ?? 0, remove: data === null })
  return asNumber(r?.now) ?? null
}

defineAction<{ id: GameSetting['id']; enabled: boolean }, { id: GameSetting['id']; value: number | null }>({
  id: 'power.game.set',
  module: 'power',
  title: 'Alterar configuração de jogo do Windows',
  description: 'Liga ou desliga Modo de Jogo, gravação em segundo plano ou capturas da Game Bar (configurações do usuário).',
  risk: 'low',
  reversible: true,
  requiresElevation: false,
  exclusive: 'game-settings',
  parse(raw) {
    const p = obj(raw, ['id', 'enabled'])
    return { id: oneOf(p.id, 'configuração', ['gameMode', 'gameDvr', 'appCapture'] as const), enabled: p.enabled === true }
  },
  async preview({ id, enabled }) {
    const state = await gameSettingsState()
    const s = state.settings.find((x) => x.id === id)!
    return {
      summary: `${enabled ? 'Ativar' : 'Desativar'} ${s.label}.`,
      changes: [{ target: s.registry, current: s.state, intended: enabled ? 'ativado (1)' : 'desativado (0)' }],
      warnings: [],
      blocked: s.lockedByPolicy
    }
  },
  async execute({ id, enabled }) {
    const setting = GAME_SETTINGS.find((s) => s.id === id)!
    const before = (await readRegistry([{ id, key: setting.key, value: setting.value }])).get(id) ?? null
    const now = await writeSetting(setting, enabled ? 1 : 0)
    const ok = now === (enabled ? 1 : 0)
    return {
      ok,
      verified: ok,
      summary: ok ? `${setting.label}: ${enabled ? 'ativado' : 'desativado'} (conferido no registro).` : 'O valor lido depois da gravação não confere.',
      change: ok
        ? {
            before: { id, value: before },
            after: { id, value: now },
            summaryBefore: `${setting.label}: ${before === null ? setting.defaultWhenMissing : before}`,
            summaryAfter: `${setting.label}: ${now}`
          }
        : undefined
    }
  },
  async revert(before, after, ctx) {
    const setting = GAME_SETTINGS.find((s) => s.id === before.id)
    if (!setting) throw new AppFailure('backup-integrity', 'Configuração desconhecida no backup.')
    const expected = (after as { value: number | null }).value
    const current = (await readRegistry([{ id: setting.id, key: setting.key, value: setting.value }])).get(setting.id) ?? null
    if (current !== expected && !ctx.force) {
      throw new AppFailure('state-changed', `${setting.label} foi alterado depois (valor atual: ${current ?? 'não definido'}).`)
    }
    const now = await writeSetting(setting, before.value)
    if (now !== before.value) throw new AppFailure('revert-failed', 'O valor restaurado não confere com o backup.')
    return `${setting.label} restaurado para ${before.value === null ? setting.defaultWhenMissing : before.value}.`
  }
})
