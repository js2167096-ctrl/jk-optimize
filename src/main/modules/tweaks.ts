// Central de ajustes: cada ajuste lê e grava uma configuração REAL do Windows
// (registro do usuário, SystemParametersInfo, powercfg ou, com UAC, um valor fixo do HKLM)
// e confere o resultado lendo de novo. Perfis Padrão / Ideal / Máximo têm valores
// documentados por ajuste; o perfil Padrão volta ao estado registrado na primeira leitura.
import { defineAction, defineQuery, listChanges, revertChange } from '../ops/registry'
import { noParams, obj, str, strList } from '../ops/params'
import { AppFailure } from '../security/validate'
import { JsonStore } from '../services/store'
import { runPowerShellWith, asArray } from '../services/powershell'
import { log } from '../ops/log'
import { readValues, writeValue, type RegValue } from './winsettings'
import { getPowerState, setActive } from './power'
import { runElevatedOps, type ElevOp } from './elevops'

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type TweakCategory = 'Personalização' | 'Energia' | 'Windows' | 'Jogos' | 'Dispositivos' | 'Privacidade' | 'Windows avançado'

interface RegEntry {
  key: string
  name: string
  type: 'DWord' | 'String'
}

interface PowerSetting {
  sub: string
  setting: string
}

export interface TweakContext {
  build: number
  hasBattery: boolean
  schemes: { guid: string; name: string; active: boolean; ultimate: boolean }[]
}

/** Leituras que não vêm do registro (tarefas agendadas, componentes instalados). */
export interface SnapshotExtra {
  /** Estado da tarefa SilentCleanup (Ready, Disabled…) ou null quando não existe. */
  silentCleanup: string | null
  /** Cortana presente neste Windows. */
  cortana: boolean
}

export interface Snapshot {
  ctx: TweakContext
  reg: Map<string, RegValue>
  power: Map<string, number | null>
  extra?: SnapshotExtra
}

interface TweakDef {
  id: string
  name: string
  description: string
  icon: string
  category: TweakCategory
  control: 'toggle' | 'select'
  /** Para interruptores: [desligado, ligado]. */
  options: (ctx: TweakContext) => { value: string; label: string }[]
  note?: string
  elevated?: boolean
  /** O valor só passa a valer depois de reiniciar o Windows. */
  needsRestart?: boolean
  /** Operações de administrador do ajuste: o lote junta todas num único pedido do Windows (UAC). */
  elevOps?: (value: string, s: Snapshot) => ElevOp[]
  /** Operações de administrador que devolvem o estado bruto anterior (reversão). */
  elevRestore?: (raw: unknown, s: Snapshot) => ElevOp[]
  /** Ordem de aplicação (o plano de energia vem antes das configurações do plano). */
  order: number
  read: (s: Snapshot) => string | null
  /** Estado bruto para restaurar exatamente (ex.: valor ausente no registro). */
  raw: (s: Snapshot) => unknown
  write: (value: string, s: Snapshot) => Promise<void>
  restoreRaw: (raw: unknown, s: Snapshot) => Promise<void>
  /** Leitura bruta atual para conferir divergência na reversão. */
  sameRaw: (a: unknown, b: unknown) => boolean
  profiles: (ctx: TweakContext, s: Snapshot) => { ideal: string | null; max: string | null }
  unavailable?: (s: Snapshot) => string | null
}

const regId = (e: { key: string; name: string }) => `${e.key}|${e.name}`
const eq = (a: unknown, b: unknown) => (a === null || a === undefined ? b === null || b === undefined : b !== null && b !== undefined && String(a) === String(b))

// ---------------------------------------------------------------------------
// Registro do usuário
// ---------------------------------------------------------------------------

function regTweak(
  base: Omit<TweakDef, 'read' | 'raw' | 'write' | 'restoreRaw' | 'sameRaw' | 'options' | 'control'> & {
    entries: RegEntry[]
    /** Valores brutos de cada entrada por opção (null = remover o valor). */
    values: Record<string, (string | number | null)[]>
    labels: Record<string, string>
    control?: 'toggle' | 'select'
    /** Opção que corresponde ao valor ausente. */
    missing: string
    /** Grava via SystemParametersInfo (efeito imediato); o registro é lido para conferir. */
    spi?: (value: string) => { op: string; value: number }
  }
): TweakDef {
  const order = Object.keys(base.values)
  return {
    ...base,
    control: base.control ?? 'toggle',
    options: () => order.map((v) => ({ value: v, label: base.labels[v] })),
    read(s) {
      const first = s.reg.get(regId(base.entries[0]))
      if (first === null || first === undefined) return base.missing
      return order.find((opt) => eq(base.values[opt][0], first)) ?? `custom:${first}`
    },
    raw: (s) => base.entries.map((e) => s.reg.get(regId(e)) ?? null),
    async write(value) {
      const vals = base.values[value]
      if (!vals) throw new AppFailure('invalid-input', 'Valor não permitido para este ajuste.')
      if (base.spi) {
        const r = await runPowerShellWith<{ ok: boolean; err: number }>(SPI_SCRIPT, base.spi(value))
        if (!r?.ok) throw new AppFailure('spi-failed', `O Windows recusou a alteração (código ${r?.err ?? '?'}).`)
        return
      }
      for (const [i, e] of base.entries.entries()) await writeValue(e.key, e.name, e.type, vals[i])
    },
    async restoreRaw(raw) {
      const vals = raw as RegValue[]
      if (base.spi) {
        const opt = order.find((o) => eq(base.values[o][0], vals[0])) ?? base.missing
        await this.write(opt, null as never)
        return
      }
      for (const [i, e] of base.entries.entries()) await writeValue(e.key, e.name, e.type, vals[i] ?? null)
    },
    sameRaw: (a, b) => JSON.stringify((a as unknown[]).map((x) => (x === null ? null : String(x)))) === JSON.stringify((b as unknown[]).map((x) => (x === null ? null : String(x))))
  }
}

// SystemParametersInfo: só operações desta lista; os números vêm validados do código.
const SPI_SCRIPT = `
Add-Type -Namespace JKO -Name Spi -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct ANIM { public uint cbSize; public int iMinAnimate; }
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SystemParametersInfo(uint action, uint uParam, int[] pv, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, EntryPoint = "SystemParametersInfo")]
public static extern bool SpiPtr(uint action, uint uParam, System.IntPtr pv, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, EntryPoint = "SystemParametersInfo")]
public static extern bool SpiAnim(uint action, uint uParam, ref ANIM pv, uint flags);
'@
$f = 3
$v = [int]$in.value
switch ($in.op) {
  'mouse' { if ($v -eq 1) { $a = [int[]](6, 10, 1) } else { $a = [int[]](0, 0, 0) }; $ok = [JKO.Spi]::SystemParametersInfo(0x0004, 0, $a, $f) }
  'kbdelay' { $ok = [JKO.Spi]::SpiPtr(0x0017, [uint32]$v, [System.IntPtr]::Zero, $f) }
  'kbspeed' { $ok = [JKO.Spi]::SpiPtr(0x000B, [uint32]$v, [System.IntPtr]::Zero, $f) }
  'drag' { $ok = [JKO.Spi]::SpiPtr(0x0025, [uint32]$v, [System.IntPtr]::Zero, $f) }
  'menudelay' { $ok = [JKO.Spi]::SpiPtr(0x006B, [uint32]$v, [System.IntPtr]::Zero, $f) }
  'anim' { $s = New-Object JKO.Spi+ANIM; $s.cbSize = 8; $s.iMinAnimate = $v; $ok = [JKO.Spi]::SpiAnim(0x0049, 8, [ref]$s, $f) }
  default { throw 'operação não permitida' }
}
[pscustomobject]@{ ok = [bool]$ok; err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() } | ConvertTo-Json -Compress`

// ---------------------------------------------------------------------------
// powercfg (configurações do plano de energia)
// ---------------------------------------------------------------------------

const PCFG_READ = `
$res = foreach ($i in $in.items) {
  $o = (powercfg /q $i.scheme $i.sub $i.setting) 2>$null | Out-String
  $hex = [regex]::Matches($o, '0x([0-9a-fA-F]{8})') | ForEach-Object { [Convert]::ToInt64($_.Groups[1].Value, 16) }
  $ac = $null
  if ($LASTEXITCODE -eq 0 -and $hex.Count -ge 2) { $ac = $hex[$hex.Count - 2] }
  [pscustomobject]@{ id = $i.id; ac = $ac }
}
@($res) | ConvertTo-Json -Compress`

const PCFG_WRITE = `
$o = (powercfg /setacvalueindex $in.scheme $in.sub $in.setting $in.value) 2>&1 | Out-String
$code = $LASTEXITCODE
if ($code -eq 0 -and $in.active) { powercfg /setactive $in.scheme | Out-Null }
[pscustomobject]@{ code = $code; out = $o } | ConvertTo-Json -Compress`

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function readPowerSettings(items: { id: string; scheme: string; sub: string; setting: string }[]): Promise<Map<string, number | null>> {
  if (items.length === 0) return new Map()
  const raw = await runPowerShellWith<unknown>(PCFG_READ, { items }, { timeoutMs: 30_000 })
  return new Map(asArray(raw).map((r) => [String((r as { id: string }).id), typeof (r as { ac: unknown }).ac === 'number' ? ((r as { ac: number }).ac) : null]))
}

async function writePowerSetting(scheme: string, p: PowerSetting, value: number, active: boolean): Promise<void> {
  if (!GUID.test(scheme)) throw new AppFailure('invalid-input', 'Plano inválido.')
  const r = await runPowerShellWith<{ code: number; out: string }>(PCFG_WRITE, { scheme, sub: p.sub, setting: p.setting, value, active })
  if (!r || r.code !== 0) throw new AppFailure('powercfg-failed', `powercfg recusou a alteração (código ${r?.code ?? '?'}). ${r?.out?.trim() ?? ''}`)
}

function activeScheme(s: Snapshot): string | null {
  return s.ctx.schemes.find((x) => x.active)?.guid ?? null
}

function powerTweak(
  base: Omit<TweakDef, 'read' | 'raw' | 'write' | 'restoreRaw' | 'sameRaw' | 'options' | 'control' | 'unavailable'> & {
    setting: PowerSetting
    values: Record<string, number>
    labels: Record<string, string>
    control?: 'toggle' | 'select'
  }
): TweakDef {
  const order = Object.keys(base.values)
  return {
    ...base,
    control: base.control ?? 'toggle',
    options: () => order.map((v) => ({ value: v, label: base.labels[v] })),
    read(s) {
      const ac = s.power.get(base.id)
      if (ac === null || ac === undefined) return null
      return order.find((o) => base.values[o] === ac) ?? `custom:${ac}`
    },
    raw: (s) => ({ scheme: activeScheme(s), ac: s.power.get(base.id) ?? null }),
    async write(value, s) {
      const scheme = activeScheme(s)
      if (!scheme) throw new AppFailure('powercfg-failed', 'Plano ativo desconhecido.')
      if (base.values[value] === undefined) throw new AppFailure('invalid-input', 'Valor não permitido para este ajuste.')
      await writePowerSetting(scheme, base.setting, base.values[value], true)
    },
    async restoreRaw(raw) {
      const r = raw as { scheme: string | null; ac: number | null }
      if (!r.scheme || r.ac === null) return
      const active = ((await getPowerState()).active?.guid ?? '') === r.scheme
      await writePowerSetting(r.scheme, base.setting, r.ac, active)
    },
    sameRaw: (a, b) => (a as { ac: unknown }).ac === (b as { ac: unknown }).ac,
    unavailable: (s) => (s.power.get(base.id) === null || s.power.get(base.id) === undefined ? 'Esta configuração não existe no plano de energia ativo deste computador.' : null)
  }
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
const HAGS: RegEntry = { key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', name: 'HwSchMode', type: 'DWord' }
const DVR_POLICY = { key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR', name: 'AllowGameDVR' }
const ON_OFF = { on: 'Ativado', off: 'Desativado' }

/** Executa um lote administrativo e falha se qualquer operação for recusada pelo Windows. */
async function elevWrite(ops: ElevOp[]): Promise<void> {
  const results = await runElevatedOps(ops)
  const bad = results.find((r) => !r.ok)
  if (bad) throw new AppFailure('elevated-failed', `O Windows recusou a alteração: ${bad.error ?? 'erro desconhecido'}`)
}

const pick = (ctx: TweakContext, guid: string) => ctx.schemes.some((s) => s.guid === guid)

const CORE_TWEAKS: TweakDef[] = [
  // ----- Energia
  {
    id: 'powerPlan',
    name: 'Perfil de energia',
    description: 'Seleciona um plano de energia existente e confirma o resultado com o powercfg.',
    icon: 'power',
    category: 'Energia',
    control: 'select',
    order: 0,
    options: (ctx) => ctx.schemes.map((s) => ({ value: s.guid, label: s.name })),
    read: (s) => activeScheme(s),
    raw: (s) => activeScheme(s),
    async write(value, s) {
      if (!s.ctx.schemes.some((x) => x.guid === value)) throw new AppFailure('invalid-input', 'Plano de energia inexistente neste computador.')
      await setActive(value)
    },
    async restoreRaw(raw) {
      if (typeof raw === 'string' && GUID.test(raw)) await setActive(raw)
    },
    sameRaw: (a, b) => a === b,
    profiles: (ctx) => ({
      ideal: ctx.hasBattery ? BALANCED : pick(ctx, HIGH) ? HIGH : BALANCED,
      max: ctx.schemes.find((x) => x.ultimate)?.guid ?? (pick(ctx, HIGH) ? HIGH : BALANCED)
    })
  },
  powerTweak({
    id: 'procMin',
    name: 'Estado mínimo do processador (na tomada)',
    description: 'Frequência mínima que o plano ativo permite ao processador. Valores altos reduzem a demora para acelerar, com mais consumo e calor.',
    icon: 'cpu',
    category: 'Energia',
    control: 'select',
    order: 10,
    setting: { sub: '54533251-82be-4824-96c1-47b60b740d00', setting: '893dee8e-2bef-41e0-89c6-b55d0929964c' },
    values: { '5': 5, '50': 50, '100': 100 },
    labels: { '5': '5%', '50': '50%', '100': '100%' },
    note: 'A proteção térmica do processador continua ativa em qualquer valor.',
    profiles: (ctx) => ({ ideal: '5', max: ctx.hasBattery ? '5' : '100' })
  }),
  // ----- Dispositivos
  powerTweak({
    id: 'usbSuspend',
    name: 'Suspensão seletiva de USB (na tomada)',
    description: 'Permite ao Windows suspender portas USB ociosas. Desativar evita atrasos ao reativar mouse, teclado e headset.',
    icon: 'usb',
    category: 'Dispositivos',
    order: 11,
    setting: { sub: '2a737441-1930-4402-8d77-b2bebba308a3', setting: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226' },
    values: { off: 0, on: 1 },
    labels: ON_OFF,
    profiles: (ctx) => ({ ideal: null, max: ctx.hasBattery ? null : 'off' })
  }),
  powerTweak({
    id: 'pcieAspm',
    name: 'Economia de energia do PCI Express (na tomada)',
    description: 'Gerenciamento de energia do link PCIe (placa de vídeo, SSD NVMe). Desligado mantém o link sempre ativo.',
    icon: 'circuit',
    category: 'Dispositivos',
    control: 'select',
    order: 12,
    setting: { sub: '501a4d13-42af-4429-9fd1-a8218c268e20', setting: 'ee12f906-d277-404b-b6da-e5fa1a576df5' },
    values: { '0': 0, '1': 1, '2': 2 },
    labels: { '0': 'Desligado', '1': 'Economia moderada', '2': 'Economia máxima' },
    profiles: (ctx) => ({ ideal: null, max: ctx.hasBattery ? null : '0' })
  }),
  // ----- Mouse e teclado
  regTweak({
    id: 'mouseAccel',
    name: 'Aceleração do mouse',
    description: 'Consulta e permite modificar a aceleração do ponteiro ("Aumentar a precisão do ponteiro") do Windows.',
    icon: 'mouse',
    category: 'Dispositivos',
    order: 20,
    entries: [
      { key: 'HKCU:\\Control Panel\\Mouse', name: 'MouseSpeed', type: 'String' },
      { key: 'HKCU:\\Control Panel\\Mouse', name: 'MouseThreshold1', type: 'String' },
      { key: 'HKCU:\\Control Panel\\Mouse', name: 'MouseThreshold2', type: 'String' }
    ],
    values: { off: ['0', '0', '0'], on: ['1', '6', '10'] },
    labels: ON_OFF,
    missing: 'on',
    spi: (v) => ({ op: 'mouse', value: v === 'on' ? 1 : 0 }),
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  regTweak({
    id: 'kbDelay',
    name: 'Atraso de repetição do teclado',
    description: 'Tempo até uma tecla pressionada começar a repetir.',
    icon: 'keyboard',
    category: 'Dispositivos',
    control: 'select',
    order: 21,
    entries: [{ key: 'HKCU:\\Control Panel\\Keyboard', name: 'KeyboardDelay', type: 'String' }],
    values: { '0': ['0'], '1': ['1'], '2': ['2'], '3': ['3'] },
    labels: { '0': 'Curto (~250 ms)', '1': 'Médio (~500 ms)', '2': 'Longo (~750 ms)', '3': 'Muito longo (~1 s)' },
    missing: '1',
    spi: (v) => ({ op: 'kbdelay', value: Number(v) }),
    profiles: () => ({ ideal: null, max: '0' })
  }),
  regTweak({
    id: 'kbSpeed',
    name: 'Velocidade de repetição do teclado',
    description: 'Quantas vezes por segundo a tecla se repete enquanto pressionada.',
    icon: 'keyboard',
    category: 'Dispositivos',
    control: 'select',
    order: 22,
    entries: [{ key: 'HKCU:\\Control Panel\\Keyboard', name: 'KeyboardSpeed', type: 'String' }],
    values: { '31': ['31'], '20': ['20'], '10': ['10'], '0': ['0'] },
    labels: { '31': 'Rápida', '20': 'Média', '10': 'Lenta', '0': 'Muito lenta' },
    missing: '31',
    spi: (v) => ({ op: 'kbspeed', value: Number(v) }),
    profiles: () => ({ ideal: '31', max: '31' })
  }),
  // ----- Efeitos visuais
  regTweak({
    id: 'transparency',
    name: 'Efeitos de transparência',
    description: 'Transparência da barra de tarefas, menu Iniciar e Central de Ações.',
    icon: 'sparkles',
    category: 'Personalização',
    order: 30,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', name: 'EnableTransparency', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'on', max: 'off' })
  }),
  regTweak({
    id: 'minAnimate',
    name: 'Animar janelas ao minimizar e maximizar',
    description: 'Animação das janelas ao abrir, minimizar e maximizar.',
    icon: 'window',
    category: 'Personalização',
    order: 31,
    entries: [{ key: 'HKCU:\\Control Panel\\Desktop\\WindowMetrics', name: 'MinAnimate', type: 'String' }],
    values: { off: ['0'], on: ['1'] },
    labels: ON_OFF,
    missing: 'on',
    spi: (v) => ({ op: 'anim', value: v === 'on' ? 1 : 0 }),
    profiles: () => ({ ideal: 'on', max: 'off' })
  }),
  regTweak({
    id: 'dragFull',
    name: 'Mostrar conteúdo ao arrastar janelas',
    description: 'Desenha a janela inteira durante o arraste (desligado mostra só o contorno).',
    icon: 'window',
    category: 'Personalização',
    order: 32,
    entries: [{ key: 'HKCU:\\Control Panel\\Desktop', name: 'DragFullWindows', type: 'String' }],
    values: { off: ['0'], on: ['1'] },
    labels: ON_OFF,
    missing: 'on',
    spi: (v) => ({ op: 'drag', value: v === 'on' ? 1 : 0 }),
    profiles: () => ({ ideal: 'on', max: 'on' })
  }),
  regTweak({
    id: 'menuDelay',
    name: 'Atraso para abrir menus',
    description: 'Tempo de espera antes de abrir submenus ao passar o mouse.',
    icon: 'menu',
    category: 'Personalização',
    control: 'select',
    order: 33,
    entries: [{ key: 'HKCU:\\Control Panel\\Desktop', name: 'MenuShowDelay', type: 'String' }],
    values: { '400': ['400'], '200': ['200'], '100': ['100'], '0': ['0'] },
    labels: { '400': '400 ms (padrão)', '200': '200 ms', '100': '100 ms', '0': 'Sem atraso' },
    missing: '400',
    spi: (v) => ({ op: 'menudelay', value: Number(v) }),
    profiles: () => ({ ideal: '200', max: '100' })
  }),
  regTweak({
    id: 'taskbarAnim',
    name: 'Animações da barra de tarefas',
    description: 'Animações dos botões da barra de tarefas.',
    icon: 'sparkles',
    category: 'Personalização',
    order: 34,
    note: 'Vale após reiniciar o Windows Explorer ou entrar de novo na conta.',
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'TaskbarAnimations', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'on', max: 'off' })
  }),
  // ----- Windows
  regTweak({
    id: 'tips',
    name: 'Dicas e sugestões do Windows',
    description: 'Notificações com dicas e sugestões ao usar o Windows.',
    icon: 'bell',
    category: 'Windows',
    order: 40,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', name: 'SubscribedContent-338389Enabled', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  regTweak({
    id: 'adId',
    name: 'ID de anúncio',
    description: 'Identificador usado por aplicativos para anúncios personalizados.',
    icon: 'eye',
    category: 'Windows',
    order: 41,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', name: 'Enabled', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  regTweak({
    id: 'trackDocs',
    name: 'Histórico de documentos recentes',
    description: 'Registra os arquivos abertos recentemente para mostrar no Início e no Explorador.',
    icon: 'eye',
    category: 'Privacidade',
    order: 42,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'Start_TrackDocs', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  regTweak({
    id: 'tailored',
    name: 'Experiências personalizadas com dados de diagnóstico',
    description: 'Permite que a Microsoft use dados de diagnóstico para sugerir dicas e anúncios.',
    icon: 'eye',
    category: 'Privacidade',
    order: 43,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Privacy', name: 'TailoredExperiencesWithDiagnosticDataEnabled', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  regTweak({
    id: 'inputPersonalization',
    name: 'Coleta de digitação e escrita à mão',
    description: 'Permite que o Windows colete o que você digita e escreve para personalizar sugestões.',
    icon: 'eye',
    category: 'Privacidade',
    order: 44,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\InputPersonalization', name: 'RestrictImplicitTextCollection', type: 'DWord' }],
    values: { off: [1], on: [0] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  regTweak({
    id: 'feedbackPrompts',
    name: 'Pedidos de feedback do Windows',
    description: 'Define com que frequência o Windows pergunta sua opinião. Desativado = nunca perguntar.',
    icon: 'eye',
    category: 'Privacidade',
    order: 45,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Siuf\\Rules', name: 'NumberOfSIUFInPeriod', type: 'DWord' }],
    values: { off: [0], on: [null] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'off', max: 'off' })
  }),
  {
    ...regTweak({
      id: 'bgApps',
      name: 'Aplicativos em segundo plano',
      description: 'Permite que aplicativos da Microsoft Store rodem em segundo plano.',
      icon: 'layers',
      category: 'Windows',
      order: 42,
      entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', name: 'GlobalUserDisabled', type: 'DWord' }],
      values: { off: [1], on: [0] },
      labels: { off: 'Bloqueados', on: 'Permitidos' },
      missing: 'on',
      note: 'Bloquear pode atrasar notificações de aplicativos da Store.',
      profiles: () => ({ ideal: null, max: 'off' })
    }),
    unavailable: (s: Snapshot) => (s.ctx.build >= 22000 ? 'No Windows 11 esta opção é por aplicativo (Configurações › Aplicativos).' : null)
  },
  regTweak({
    id: 'startupDelay',
    name: 'Atraso dos aplicativos de inicialização',
    description: 'O Windows espera alguns segundos antes de abrir os aplicativos de inicialização. Sem atraso, eles abrem logo após o login.',
    icon: 'timer',
    category: 'Windows',
    order: 43,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize', name: 'StartupDelayInMSec', type: 'DWord' }],
    values: { on: [null], off: [0] },
    labels: { on: 'Com atraso (padrão)', off: 'Sem atraso' },
    missing: 'on',
    profiles: () => ({ ideal: null, max: 'off' })
  }),
  // ----- Jogos
  regTweak({
    id: 'gameMode',
    name: 'Modo de Jogo',
    description: 'Prioriza o jogo em execução e evita reinicializações do Windows Update durante a partida.',
    icon: 'gamepad',
    category: 'Jogos',
    order: 50,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: ON_OFF,
    missing: 'on',
    profiles: () => ({ ideal: 'on', max: 'on' })
  }),
  {
    ...regTweak({
      id: 'gameDvr',
      name: 'Gravação em segundo plano (Game DVR)',
      description: 'Grava continuamente os últimos minutos do jogo; consome CPU e GPU quando ativa.',
      icon: 'video',
      category: 'Jogos',
      order: 51,
      entries: [{ key: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'DWord' }],
      values: { off: [0], on: [1] },
      labels: ON_OFF,
      missing: 'on',
      profiles: () => ({ ideal: 'off', max: 'off' })
    }),
    unavailable: (s: Snapshot) => {
      const p = s.reg.get(regId(DVR_POLICY))
      return p !== null && p !== undefined ? `Definido por política do sistema (AllowGameDVR=${p}).` : null
    }
  },
  {
    ...regTweak({
      id: 'appCapture',
      name: 'Capturas da Xbox Game Bar',
      description: 'Permite capturas de tela e gravações pela Game Bar.',
      icon: 'camera',
      category: 'Jogos',
      order: 52,
      entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', type: 'DWord' }],
      values: { off: [0], on: [1] },
      labels: ON_OFF,
      missing: 'on',
      profiles: () => ({ ideal: null, max: 'off' })
    }),
    unavailable: (s: Snapshot) => {
      const p = s.reg.get(regId(DVR_POLICY))
      return p !== null && p !== undefined ? `Definido por política do sistema (AllowGameDVR=${p}).` : null
    }
  },
  // ----- GPU (administrador)
  {
    id: 'hags',
    name: 'Agendamento de GPU acelerado por hardware',
    description: 'A GPU gerencia a própria memória de vídeo. Exige GPU e driver compatíveis.',
    icon: 'gpu',
    category: 'Jogos',
    control: 'toggle',
    elevated: true,
    needsRestart: true,
    order: 60,
    note: 'Pede permissão de administrador e só vale depois de reiniciar o computador.',
    options: () => [
      { value: 'off', label: 'Desativado' },
      { value: 'on', label: 'Ativado' }
    ],
    read(s) {
      const v = s.reg.get(regId(HAGS))
      return v === null || v === undefined ? null : Number(v) === 2 ? 'on' : Number(v) === 1 ? 'off' : null
    },
    raw: (s) => s.reg.get(regId(HAGS)) ?? null,
    elevOps: (value) => [{ k: 'reg', key: HAGS.key, name: HAGS.name, type: 'DWord', data: value === 'on' ? 2 : 1 }],
    elevRestore: (raw) => (raw === 1 || raw === 2 ? [{ k: 'reg', key: HAGS.key, name: HAGS.name, type: 'DWord', data: Number(raw) }] : []),
    async write(value, s) {
      await elevWrite(this.elevOps!(value, s))
    },
    async restoreRaw(raw, s) {
      const ops = this.elevRestore!(raw, s)
      if (ops.length) await elevWrite(ops)
    },
    sameRaw: (a, b) => eq(a, b),
    profiles: () => ({ ideal: null, max: 'on' }),
    unavailable: (s) =>
      s.ctx.build < 19041
        ? 'Exige Windows 10 versão 2004 ou mais recente.'
        : s.reg.get(regId(HAGS)) === null || s.reg.get(regId(HAGS)) === undefined
          ? 'A GPU ou o driver instalado não oferece esta opção (valor HwSchMode ausente).'
          : null
  }
]

// ---------------------------------------------------------------------------
// Windows avançado (Otimização 2): ajustes de políticas, serviços, hibernação e sistema de arquivos.
// Todos leem o estado real, gravam por um mecanismo suportado pelo Windows, conferem de novo e guardam o valor anterior.
// Os que alteram HKLM, serviços ou o sistema usam UM pedido de administrador por lote (elevops.ts).
// ---------------------------------------------------------------------------

const POLICY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\'
const CDM = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager'
const HIB: RegEntry = { key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power', name: 'HibernateEnabled', type: 'DWord' }
const FASTBOOT: RegEntry = { key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power', name: 'HiberbootEnabled', type: 'DWord' }
const LASTACCESS: RegEntry = { key: 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', name: 'NtfsDisableLastAccessUpdate', type: 'DWord' }
const NO_PROFILE = () => ({ ideal: null, max: null })

type RegBase = Parameters<typeof regTweak>[0]

/** Ajuste de registro em HKLM: grava pelo lote administrativo e confere lendo de novo. */
function hklmTweak(base: RegBase): TweakDef {
  const t = regTweak(base)
  const opsFor = (vals: (string | number | null)[]): ElevOp[] => base.entries.map((e, i) => ({ k: 'reg', key: e.key, name: e.name, type: e.type, data: vals[i] ?? null }))
  return {
    ...t,
    elevated: true,
    elevOps: (value) => opsFor(base.values[value]),
    elevRestore: (raw) => opsFor(raw as RegValue[]),
    async write(value) {
      if (!base.values[value]) throw new AppFailure('invalid-input', 'Valor não permitido para este ajuste.')
      await elevWrite(opsFor(base.values[value]))
    },
    async restoreRaw(raw) {
      await elevWrite(opsFor(raw as RegValue[]))
    }
  }
}

const SERVICE_OPTIONS = [
  { value: 'auto', label: 'Automático' },
  { value: 'delayed', label: 'Automático (atrasado)' },
  { value: 'manual', label: 'Manual' },
  { value: 'off', label: 'Desativado' }
]

type SvcStart = 'auto' | 'delayed' | 'manual' | 'disabled'
const svcStartOf = (start: unknown, delayed: unknown): SvcStart => {
  const n = Number(start)
  return n === 2 ? (Number(delayed) === 1 ? 'delayed' : 'auto') : n === 3 ? 'manual' : 'disabled'
}

/** Tipo de inicialização de um serviço (lido do registro do serviço); alterado pelo gerenciador de serviços do Windows. */
function serviceTweak(base: { id: string; name: string; description: string; icon: string; order: number; svc: string; note?: string }): TweakDef {
  const start: RegEntry = { key: `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${base.svc}`, name: 'Start', type: 'DWord' }
  const delayed: RegEntry = { key: start.key, name: 'DelayedAutostart', type: 'DWord' }
  const opsFor = (to: SvcStart): ElevOp[] => [{ k: 'svc', name: base.svc, start: to, run: to === 'disabled' ? false : to === 'manual' ? null : true }]
  const def: TweakDef & { entries: RegEntry[] } = {
    id: base.id,
    name: base.name,
    description: base.description,
    icon: base.icon,
    category: 'Windows avançado',
    control: 'select',
    elevated: true,
    order: base.order,
    note: base.note,
    entries: [start, delayed],
    options: () => SERVICE_OPTIONS,
    read(s) {
      const st = s.reg.get(regId(start))
      if (st === null || st === undefined) return null
      const n = Number(st)
      return n === 2 ? (Number(s.reg.get(regId(delayed)) ?? 0) === 1 ? 'delayed' : 'auto') : n === 3 ? 'manual' : n === 4 ? 'off' : `custom:${n}`
    },
    raw: (s) => ({ start: s.reg.get(regId(start)) ?? null, delayed: s.reg.get(regId(delayed)) ?? null }),
    elevOps: (value) => opsFor(value === 'off' ? 'disabled' : (value as SvcStart)),
    elevRestore: (raw) => {
      const r = raw as { start: unknown; delayed: unknown }
      return r.start === null || r.start === undefined ? [] : opsFor(svcStartOf(r.start, r.delayed))
    },
    async write(value, s) {
      await elevWrite(this.elevOps!(value, s))
    },
    async restoreRaw(raw, s) {
      const ops = this.elevRestore!(raw, s)
      if (ops.length) await elevWrite(ops)
    },
    sameRaw: (a, b) => {
      const x = a as { start: unknown; delayed: unknown }
      const y = b as { start: unknown; delayed: unknown }
      return String(x.start) === String(y.start) && String(x.delayed ?? 0) === String(y.delayed ?? 0)
    },
    profiles: NO_PROFILE,
    unavailable: (s) => (s.reg.get(regId(start)) === null || s.reg.get(regId(start)) === undefined ? 'Este serviço não existe neste Windows.' : null)
  }
  return def
}

/** Valor de NtfsDisableLastAccessUpdate → número de `fsutil behavior set disablelastaccess` que o restaura. */
export function lastAccessFsutilValue(raw: unknown): 0 | 1 | 2 | 3 {
  if (raw === null || raw === undefined) return 2
  const n = Number(raw) >>> 0
  return (n >= 0x80000000 ? n & 3 : n & 1) as 0 | 1 | 2 | 3
}

const ADVANCED_TWEAKS: TweakDef[] = [
  // ----- Configurações básicas e Otimizar Windows
  regTweak({
    id: 'notifications',
    name: 'Notificações de aplicativos',
    description: 'Mostra notificações pop-up (toasts) de aplicativos e do Windows.',
    icon: 'bell',
    category: 'Windows avançado',
    order: 70,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', name: 'ToastEnabled', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: { off: 'Desativadas', on: 'Ativadas' },
    missing: 'on',
    note: 'Desativadas: alertas de aplicativos (mensagens, agenda, avisos de segurança dos aplicativos) deixam de aparecer; reversível a qualquer momento.',
    profiles: NO_PROFILE
  }),
  regTweak({
    id: 'startSuggestions',
    name: 'Sugestões do menu Iniciar',
    description: 'Aplicativos sugeridos e anúncios no menu Iniciar.',
    icon: 'layers',
    category: 'Windows avançado',
    order: 71,
    entries: [
      { key: CDM, name: 'SystemPaneSuggestionsEnabled', type: 'DWord' },
      { key: CDM, name: 'SubscribedContent-338388Enabled', type: 'DWord' }
    ],
    values: { off: [0, 0], on: [1, 1] },
    labels: { off: 'Desativadas', on: 'Ativadas' },
    missing: 'on',
    profiles: NO_PROFILE
  }),
  regTweak({
    id: 'windowsSuggestions',
    name: 'Sugestões do Windows (Configurações e instalação automática)',
    description: 'Sugestões em Configurações, tela de bloqueio e instalação silenciosa de aplicativos sugeridos.',
    icon: 'layers',
    category: 'Windows avançado',
    order: 72,
    entries: [
      { key: CDM, name: 'SubscribedContent-338393Enabled', type: 'DWord' },
      { key: CDM, name: 'SubscribedContent-353694Enabled', type: 'DWord' },
      { key: CDM, name: 'SubscribedContent-353696Enabled', type: 'DWord' },
      { key: CDM, name: 'SilentInstalledAppsEnabled', type: 'DWord' },
      { key: CDM, name: 'SoftLandingEnabled', type: 'DWord' }
    ],
    values: { off: [0, 0, 0, 0, 0], on: [1, 1, 1, 1, 1] },
    labels: { off: 'Desativadas', on: 'Ativadas' },
    missing: 'on',
    profiles: NO_PROFILE
  }),
  hklmTweak({
    id: 'activityFeed',
    name: 'Feed de atividades e histórico de atividades',
    description: 'Política do Windows que controla a coleta e publicação do histórico de atividades (linha do tempo).',
    icon: 'eye',
    category: 'Windows avançado',
    order: 73,
    entries: [
      { key: `${POLICY}System`, name: 'EnableActivityFeed', type: 'DWord' },
      { key: `${POLICY}System`, name: 'PublishUserActivities', type: 'DWord' },
      { key: `${POLICY}System`, name: 'UploadUserActivities', type: 'DWord' }
    ],
    values: { off: [0, 0, 0], on: [null, null, null] },
    labels: { off: 'Desativado (política)', on: 'Padrão do Windows' },
    missing: 'on',
    note: 'Grava uma política do Windows (administrador). "Padrão" remove a política.',
    profiles: NO_PROFILE
  }),
  serviceTweak({
    id: 'bluetooth',
    name: 'Bluetooth (serviço de suporte)',
    description: 'Tipo de inicialização do Serviço de Suporte a Bluetooth (bthserv).',
    icon: 'usb',
    order: 74,
    svc: 'bthserv',
    note: 'Desativado: para o serviço e nenhum dispositivo Bluetooth (fone, controle, mouse) funciona até reativar.'
  }),
  {
    ...hklmTweak({
      id: 'cortana',
      name: 'Cortana e componentes relacionados',
      description: 'Política que permite ou bloqueia a Cortana.',
      icon: 'eye',
      category: 'Windows avançado',
      order: 75,
      entries: [{ key: `${POLICY}Windows Search`, name: 'AllowCortana', type: 'DWord' }],
      values: { off: [0], on: [null] },
      labels: { off: 'Bloqueada (política)', on: 'Padrão do Windows' },
      missing: 'on',
      profiles: NO_PROFILE
    }),
    unavailable: (s: Snapshot) => (s.extra && !s.extra.cortana ? 'A Cortana não está instalada neste Windows.' : null)
  },
  hklmTweak({
    id: 'bgAppsPolicy',
    name: 'Aplicativos em segundo plano (política do sistema)',
    description: 'Política "Permitir que aplicativos sejam executados em segundo plano"; vale também no Windows 11, onde o ajuste por usuário é individual por aplicativo.',
    icon: 'layers',
    category: 'Windows avançado',
    order: 76,
    entries: [{ key: `${POLICY}AppPrivacy`, name: 'LetAppsRunInBackground', type: 'DWord' }],
    values: { off: [2], on: [null] },
    labels: { off: 'Bloqueados (política)', on: 'Padrão do Windows' },
    missing: 'on',
    note: 'Bloquear pode atrasar notificações e sincronização de aplicativos da Microsoft Store.',
    profiles: NO_PROFILE
  }),
  // ----- Desativar Windows
  hklmTweak({
    id: 'telemetry',
    name: 'Telemetria e diagnóstico (nível)',
    description: 'Política "Permitir dados de diagnóstico". O Windows Home e Pro tratam o nível 0 como Básico (necessário); só Enterprise/Education chegam a "Segurança".',
    icon: 'eye',
    category: 'Windows avançado',
    control: 'select',
    order: 77,
    entries: [{ key: `${POLICY}DataCollection`, name: 'AllowTelemetry', type: 'DWord' }],
    values: { default: [null], basic: [1], off: [0] },
    labels: { default: 'Padrão do Windows', basic: 'Básico (necessário)', off: 'Mínimo (0)' },
    missing: 'default',
    note: 'Grava a política suportada. O nível efetivo depende da edição do Windows; o JK Optimize mostra o valor gravado, não promete telemetria zero.',
    profiles: NO_PROFILE
  }),
  serviceTweak({
    id: 'diagTrack',
    name: 'Serviço de telemetria (Experiências de Usuário Conectado)',
    description: 'Tipo de inicialização do serviço DiagTrack, que envia dados de diagnóstico à Microsoft.',
    icon: 'eye',
    order: 78,
    svc: 'DiagTrack',
    note: 'Desativado: o serviço é parado. O Windows Update e a segurança não dependem dele.'
  }),
  hklmTweak({
    id: 'gameDvrPolicy',
    name: 'Game DVR (política do sistema)',
    description: 'Política AllowGameDVR: bloqueia a gravação em segundo plano para todos os usuários.',
    icon: 'video',
    category: 'Windows avançado',
    order: 53,
    entries: [{ key: `${POLICY}GameDVR`, name: 'AllowGameDVR', type: 'DWord' }],
    values: { off: [0], on: [null] },
    labels: { off: 'Bloqueado (política)', on: 'Padrão do Windows' },
    missing: 'on',
    note: 'Com a política ativa, os ajustes individuais de Game DVR ficam definidos pelo sistema.',
    profiles: NO_PROFILE
  }),
  regTweak({
    id: 'gameBar',
    name: 'Xbox Game Bar (painel e atalho)',
    description: 'Abertura da Game Bar pelo controle/atalho e painel de inicialização.',
    icon: 'gamepad',
    category: 'Windows avançado',
    order: 54,
    entries: [
      { key: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'UseNexusForGameBarEnabled', type: 'DWord' },
      { key: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'ShowStartupPanel', type: 'DWord' }
    ],
    values: { off: [0, 0], on: [1, 1] },
    labels: { off: 'Desativada', on: 'Ativada' },
    missing: 'on',
    profiles: NO_PROFILE
  }),
  {
    id: 'hibernation',
    name: 'Hibernação',
    description: 'Arquivo de hibernação (hiberfil.sys) e o comando Hibernar.',
    icon: 'power',
    category: 'Windows avançado',
    control: 'toggle',
    elevated: true,
    order: 79,
    note: 'Desativar remove o hiberfil.sys (libera espaço em disco), desativa Hibernar e também a Inicialização Rápida. Ativar de novo recria o arquivo.',
    entries: [HIB],
    options: () => [
      { value: 'off', label: 'Desativada' },
      { value: 'on', label: 'Ativada' }
    ],
    read: (s) => {
      const v = s.reg.get(regId(HIB))
      return v === null || v === undefined ? null : Number(v) === 1 ? 'on' : 'off'
    },
    raw: (s) => s.reg.get(regId(HIB)) ?? null,
    elevOps: (value) => [{ k: 'hib', on: value === 'on' }],
    elevRestore: (raw) => (raw === null || raw === undefined ? [] : [{ k: 'hib', on: Number(raw) === 1 }]),
    async write(value, s) {
      await elevWrite(this.elevOps!(value, s))
    },
    async restoreRaw(raw, s) {
      const ops = this.elevRestore!(raw, s)
      if (ops.length) await elevWrite(ops)
    },
    sameRaw: (a, b) => eq(a, b),
    profiles: NO_PROFILE,
    unavailable: (s) => (s.reg.get(regId(HIB)) === null || s.reg.get(regId(HIB)) === undefined ? 'O Windows não informa suporte à hibernação neste computador.' : null)
  } as TweakDef & { entries: RegEntry[] },
  {
    ...hklmTweak({
      id: 'fastStartup',
      name: 'Inicialização Rápida',
      description: 'Desligar o computador salva parte do sistema em disco para iniciar mais rápido (depende da hibernação).',
      icon: 'timer',
      category: 'Windows avançado',
      order: 80,
      entries: [FASTBOOT],
      values: { off: [0], on: [1] },
      labels: { off: 'Desativada', on: 'Ativada' },
      missing: 'off',
      needsRestart: true,
      note: 'Desativada: o desligamento é completo (útil para drivers e atualizações), mas o próximo início pode demorar um pouco mais.',
      profiles: NO_PROFILE
    }),
    unavailable: (s: Snapshot) => (Number(s.reg.get(regId(HIB)) ?? 1) === 0 ? 'Exige a hibernação ativada.' : null)
  },
  serviceTweak({
    id: 'indexing',
    name: 'Indexação (Windows Search)',
    description: 'Serviço WSearch, que mantém o índice usado pelas pesquisas do Explorador de Arquivos e do menu Iniciar. O escopo são as pastas definidas em "Opções de Indexação".',
    icon: 'search',
    order: 81,
    svc: 'WSearch',
    note: 'Desativado: pesquisas de arquivos e do menu Iniciar ficam mais lentas e podem não achar conteúdo; o índice existente é mantido e volta a funcionar ao reativar.'
  }),
  regTweak({
    id: 'storageSense',
    name: 'Limpeza automática de disco (Sensor de Armazenamento)',
    description: 'Limpeza automática de temporários e Lixeira feita pelo Windows.',
    icon: 'trash',
    category: 'Windows avançado',
    order: 82,
    entries: [{ key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy', name: '01', type: 'DWord' }],
    values: { off: [0], on: [1] },
    labels: { off: 'Desativada', on: 'Ativada' },
    missing: 'off',
    note: 'Sem valor gravado, o Windows decide sozinho (só quando o espaço está acabando).',
    profiles: NO_PROFILE
  }),
  {
    id: 'silentCleanup',
    name: 'Tarefa de limpeza de disco automática (SilentCleanup)',
    description: 'Tarefa agendada do Windows que executa a Limpeza de Disco em segundo plano quando o espaço é baixo.',
    icon: 'timer',
    category: 'Windows avançado',
    control: 'toggle',
    elevated: true,
    order: 83,
    options: () => [
      { value: 'off', label: 'Desativada' },
      { value: 'on', label: 'Ativada' }
    ],
    read: (s) => (s.extra?.silentCleanup == null ? null : s.extra.silentCleanup === 'Disabled' ? 'off' : 'on'),
    raw: (s) => s.extra?.silentCleanup ?? null,
    elevOps: (value) => [{ k: 'task', path: '\\Microsoft\\Windows\\DiskCleanup\\', name: 'SilentCleanup', enable: value === 'on' }],
    elevRestore: (raw) => (raw === null || raw === undefined ? [] : [{ k: 'task', path: '\\Microsoft\\Windows\\DiskCleanup\\', name: 'SilentCleanup', enable: raw !== 'Disabled' }]),
    async write(value, s) {
      await elevWrite(this.elevOps!(value, s))
    },
    async restoreRaw(raw, s) {
      const ops = this.elevRestore!(raw, s)
      if (ops.length) await elevWrite(ops)
    },
    sameRaw: (a, b) => (a === 'Disabled') === (b === 'Disabled'),
    profiles: NO_PROFILE,
    unavailable: (s) => (s.extra && s.extra.silentCleanup === null ? 'A tarefa SilentCleanup não existe neste Windows.' : null)
  },
  // ----- Rede (cada um com a configuração específica que altera)
  hklmTweak({
    id: 'netThrottle',
    name: 'Limitação de rede para multimídia (NetworkThrottlingIndex)',
    description: 'O agendador multimídia limita pacotes de rede por segundo enquanto há áudio/vídeo (padrão 10). Desativar remove o limite.',
    icon: 'network',
    category: 'Windows avançado',
    order: 84,
    entries: [{ key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', name: 'NetworkThrottlingIndex', type: 'DWord' }],
    values: { default: [10], off: [-1] },
    labels: { default: 'Padrão do Windows (10)', off: 'Sem limite' },
    missing: 'default',
    needsRestart: true,
    note: 'O efeito em jogos depende do computador e da rede; o JK Optimize não promete ganho. Vale para novas sessões multimídia.',
    profiles: NO_PROFILE
  }),
  hklmTweak({
    id: 'qosLimit',
    name: 'Limite de largura de banda do QoS (NonBestEffortLimit)',
    description: 'Política do Agendador de Pacotes QoS que define a porcentagem reservada a tráfego prioritário. Zero = sem reserva.',
    icon: 'network',
    category: 'Windows avançado',
    order: 85,
    entries: [{ key: `${POLICY}Psched`, name: 'NonBestEffortLimit', type: 'DWord' }],
    values: { default: [null], off: [0] },
    labels: { default: 'Padrão do Windows', off: 'Sem reserva (0%)' },
    missing: 'default',
    note: 'Nas versões atuais o Windows já não reserva banda por padrão; o ajuste só grava a política e a conexão é testada na aba Internet Test.',
    profiles: NO_PROFILE
  }),
  // ----- Sistema de arquivos
  {
    id: 'lastAccess',
    name: 'Registro de último acesso dos arquivos (NTFS)',
    description: 'O NTFS grava a data do último acesso a cada arquivo lido (fsutil behavior disablelastaccess).',
    icon: 'hard-drive',
    category: 'Windows avançado',
    control: 'toggle',
    elevated: true,
    needsRestart: true,
    order: 86,
    note: 'Desativar reduz gravações no disco. Programas de backup e de limpeza que usam "último acesso" podem ficar menos precisos. Pode exigir reinício para valer em todos os volumes.',
    entries: [LASTACCESS],
    options: () => [
      { value: 'off', label: 'Não registrar' },
      { value: 'on', label: 'Registrar (padrão)' }
    ],
    read: (s) => {
      const v = s.reg.get(regId(LASTACCESS))
      return v === null || v === undefined ? 'on' : (Number(v) & 1) === 1 ? 'off' : 'on'
    },
    raw: (s) => s.reg.get(regId(LASTACCESS)) ?? null,
    elevOps: (value) => [{ k: 'lastaccess', value: value === 'off' ? 1 : 2 }],
    elevRestore: (raw) => [{ k: 'lastaccess', value: lastAccessFsutilValue(raw) }],
    async write(value, s) {
      await elevWrite(this.elevOps!(value, s))
    },
    async restoreRaw(raw, s) {
      await elevWrite(this.elevRestore!(raw, s))
    },
    sameRaw: (a, b) => (a === null || a === undefined ? 'null' : String(Number(a) >>> 0)) === (b === null || b === undefined ? 'null' : String(Number(b) >>> 0)),
    profiles: NO_PROFILE
  } as TweakDef & { entries: RegEntry[] }
]

export const TWEAKS: TweakDef[] = [...CORE_TWEAKS, ...ADVANCED_TWEAKS]

const BY_ID = new Map(TWEAKS.map((t) => [t.id, t]))

// ---------------------------------------------------------------------------
// Leitura do estado real
// ---------------------------------------------------------------------------

const POWER_TWEAKS = TWEAKS.filter((t) => 'setting' in (t as object)) as (TweakDef & { setting: PowerSetting })[]

function registryEntries(): { id: string; key: string; name: string }[] {
  const list: { key: string; name: string }[] = [HAGS, DVR_POLICY]
  for (const t of TWEAKS) for (const e of (t as { entries?: RegEntry[] }).entries ?? []) list.push(e)
  return [...new Map(list.map((e) => [regId(e), { id: regId(e), key: e.key, name: e.name }])).values()]
}

const EXTRA_SCRIPT = `
$t = Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\DiskCleanup\\' -TaskName 'SilentCleanup' -ErrorAction SilentlyContinue
$c = $null
if ($in.cortana) { $c = (Test-Path (Join-Path $env:SystemRoot 'SystemApps\\Microsoft.Windows.Cortana_cw5n1h2txyewy')) -or [bool](Get-AppxPackage -Name 'Microsoft.549981C3F5F10' -ErrorAction SilentlyContinue) }
[pscustomobject]@{ silentCleanup = if ($t) { [string]$t.State } else { $null }; cortana = $c } | ConvertTo-Json -Compress`

/** A presença da Cortana só muda com instalação/remoção do componente: consultada uma vez por execução do aplicativo. */
let cortanaPresent: boolean | null = null

async function readExtra(): Promise<SnapshotExtra | undefined> {
  const r = await runPowerShellWith<{ silentCleanup: string | null; cortana: boolean | null }>(EXTRA_SCRIPT, { cortana: cortanaPresent === null }, { timeoutMs: 30_000 }).catch(() => null)
  if (!r) return undefined
  if (cortanaPresent === null && typeof r.cortana === 'boolean') cortanaPresent = r.cortana
  return { silentCleanup: typeof r.silentCleanup === 'string' ? r.silentCleanup : null, cortana: cortanaPresent ?? true }
}

export async function takeSnapshot(): Promise<Snapshot> {
  const power = await getPowerState()
  const ctx: TweakContext = { build: power.build, hasBattery: power.hasBattery, schemes: power.schemes }
  const scheme = power.active?.guid ?? null
  const [reg, pcfg, extra] = await Promise.all([
    readValues(registryEntries()),
    scheme ? readPowerSettings(POWER_TWEAKS.map((t) => ({ id: t.id, scheme, sub: t.setting.sub, setting: t.setting.setting }))) : Promise.resolve(new Map<string, number | null>()),
    readExtra()
  ])
  return { ctx, reg, power: pcfg, extra }
}

const baseline = new JsonStore<Record<string, { value: string; at: string }>>('tweaks-baseline.json', (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, { value: string; at: string }>) : {}))

export interface TweakState {
  id: string
  name: string
  description: string
  icon: string
  category: TweakCategory
  control: 'toggle' | 'select'
  options: { value: string; label: string }[]
  current: string | null
  currentLabel: string
  unavailable: string | null
  elevated: boolean
  needsRestart: boolean
  note: string | null
  profiles: { default: string | null; ideal: string | null; max: string | null }
}

function label(t: TweakDef, s: Snapshot, value: string | null): string {
  if (value === null) return 'Não disponível'
  if (value.startsWith('custom:')) return `Personalizado (${value.slice(7)})`
  return t.options(s.ctx).find((o) => o.value === value)?.label ?? value
}

export function describe(s: Snapshot, base: Record<string, { value: string }>): TweakState[] {
  return TWEAKS.map((t) => {
    const unavailable = t.unavailable?.(s) ?? null
    const current = unavailable ? null : t.read(s)
    const p = unavailable ? { ideal: null, max: null } : t.profiles(s.ctx, s)
    const options = t.options(s.ctx).map((o) => o.value)
    const valid = (v: string | null | undefined) => (v && options.includes(v) ? v : null)
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      control: t.control,
      options: t.options(s.ctx),
      current,
      currentLabel: unavailable ? 'Indisponível' : label(t, s, current),
      unavailable,
      elevated: !!t.elevated,
      needsRestart: !!t.needsRestart,
      note: t.note ?? null,
      profiles: {
        default: unavailable ? null : valid(base[t.id]?.value) ?? valid(current),
        // Sem recomendação para o perfil: mantém o valor atual.
        ideal: valid(p.ideal) ?? valid(current),
        max: valid(p.max) ?? valid(p.ideal) ?? valid(current)
      }
    }
  })
}

/** Registra o estado-base (primeira leitura de cada ajuste) usado pelo perfil Padrão. */
function recordBaseline(s: Snapshot): Record<string, { value: string; at: string }> {
  const base = baseline.read()
  let changed = false
  for (const t of TWEAKS) {
    if (base[t.id] || t.unavailable?.(s)) continue
    const v = t.read(s)
    if (v && !v.startsWith('custom:')) {
      base[t.id] = { value: v, at: new Date().toISOString() }
      changed = true
    }
  }
  if (changed) baseline.write(base)
  return base
}

defineQuery({
  id: 'tweaks.catalog',
  module: 'power',
  parse: noParams,
  async run() {
    const s = await takeSnapshot()
    const base = recordBaseline(s)
    const baseAt = Object.values(base).map((b) => b.at).sort()[0] ?? null
    return { tweaks: describe(s, base), baselineAt: baseAt, readAt: new Date().toISOString(), hasBattery: s.ctx.hasBattery, build: s.ctx.build }
  }
})

// ---------------------------------------------------------------------------
// Aplicar ajustes selecionados (lote)
// ---------------------------------------------------------------------------

export function parseChanges(raw: unknown): Record<string, string> {
  const p = obj(raw, ['changes'])
  const c = p.changes
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new AppFailure('invalid-input', 'Lista de ajustes inválida.')
  const entries = Object.entries(c as Record<string, unknown>)
  if (entries.length === 0 || entries.length > TWEAKS.length) throw new AppFailure('invalid-input', 'Escolha pelo menos um ajuste.')
  const out: Record<string, string> = {}
  for (const [id, v] of entries) {
    if (!BY_ID.has(id)) throw new AppFailure('invalid-input', `Ajuste desconhecido: ${id}.`)
    out[id] = str(v, id, 60, /^[0-9a-z-]+$/i)
  }
  return out
}

interface Plan {
  apply: { t: TweakDef; from: string | null; to: string }[]
  already: string[]
  skipped: string[]
}

export function planChanges(s: Snapshot, changes: Record<string, string>): Plan {
  const plan: Plan = { apply: [], already: [], skipped: [] }
  for (const [id, to] of Object.entries(changes)) {
    const t = BY_ID.get(id)!
    const reason = t.unavailable?.(s)
    if (reason) {
      plan.skipped.push(`${t.name}: ${reason}`)
      continue
    }
    if (!t.options(s.ctx).some((o) => o.value === to)) {
      plan.skipped.push(`${t.name}: valor não suportado neste computador.`)
      continue
    }
    const from = t.read(s)
    if (from === to) plan.already.push(t.name)
    else plan.apply.push({ t, from, to })
  }
  plan.apply.sort((a, b) => a.t.order - b.t.order)
  return plan
}

interface AppliedItem {
  id: string
  name: string
  before: unknown
  after: unknown
  fromLabel: string
  toLabel: string
}

defineAction<{ changes: Record<string, string> }, { items: AppliedItem[] }>({
  id: 'tweaks.apply',
  module: 'power',
  title: 'Aplicar ajustes selecionados',
  description: 'Aplica somente os ajustes pendentes escolhidos, confere cada resultado e guarda os valores anteriores.',
  risk: 'low',
  reversible: true,
  requiresElevation: (p) => Object.keys(p.changes).some((id) => BY_ID.get(id)?.elevated),
  exclusive: 'tweaks',
  parse: (raw) => ({ changes: parseChanges(raw) }),
  async preview({ changes }) {
    const s = await takeSnapshot()
    const plan = planChanges(s, changes)
    return {
      summary: `${plan.apply.length} ajuste(s) a alterar${plan.already.length ? `, ${plan.already.length} já configurado(s)` : ''}.`,
      changes: plan.apply.map((x) => ({ target: x.t.name, current: label(x.t, s, x.from), intended: label(x.t, s, x.to) })),
      warnings: [
        ...plan.apply.filter((x) => x.t.note).map((x) => `${x.t.name}: ${x.t.note}`),
        ...plan.apply.filter((x) => x.t.needsRestart).map((x) => `${x.t.name}: pode exigir reiniciar o Windows para valer (o JK Optimize nunca reinicia o computador sozinho).`),
        ...(plan.apply.some((x) => x.t.elevated) ? ['Alguns ajustes exigem administrador: o Windows pedirá a permissão uma única vez. Se você recusar, esses ajustes não são aplicados e os demais continuam.'] : []),
        ...plan.already.map((n) => `${n}: já está configurado.`),
        ...plan.skipped
      ],
      blocked: plan.apply.length === 0 ? (plan.already.length ? 'Os ajustes selecionados já estão configurados.' : 'Nenhum ajuste selecionado pode ser aplicado neste computador.') : null
    }
  },
  async execute({ changes }, ctx) {
    ctx.progress('Verificando configurações', 0, null, { stage: 'verifying' })
    let s = await takeSnapshot()
    const plan = planChanges(s, changes)
    const done: AppliedItem[] = []
    const rows: { label: string; value: string; tone: 'ok' | 'warn' | 'error' }[] = []
    // Itens de administrador gravam todos juntos no início: o estado anterior deles é lido antes. Os demais leem o estado
    // imediatamente antes da própria gravação (configurações de energia pertencem ao plano ativo naquele momento).
    const befores = new Map(plan.apply.filter((x) => x.t.elevOps).map((x) => [x.t.id, x.t.raw(s)]))
    const total = plan.apply.length
    const item = (x: { t: TweakDef }, state: 'running' | 'ok' | 'error' | 'skipped', index: number, message?: string) =>
      ctx.progress(`${x.t.name}…`, index, total, { stage: 'item', id: x.t.id, name: x.t.name, state, message })

    // Todos os ajustes de administrador entram num único lote: um só pedido do Windows (UAC).
    const elevItems = plan.apply.filter((x) => x.t.elevOps)
    const elevErrors = new Map<string, string>()
    if (elevItems.length && !ctx.signal.aborted) {
      ctx.progress('Aguardando permissão de administrador…', 0, total, { stage: 'elevating' })
      const ops: ElevOp[] = []
      const owners: string[] = []
      for (const x of elevItems) for (const op of x.t.elevOps!(x.to, s)) (ops.push(op), owners.push(x.t.id))
      try {
        const results = await runElevatedOps(ops, { signal: ctx.signal })
        results.forEach((r, i) => !r.ok && !elevErrors.has(owners[i]) && elevErrors.set(owners[i], r.error ?? 'o Windows recusou a operação'))
      } catch (error) {
        for (const x of elevItems) elevErrors.set(x.t.id, (error as Error).message)
      }
      s = await takeSnapshot()
    }

    for (const [i, x] of plan.apply.entries()) {
      if (ctx.signal.aborted) {
        rows.push({ label: x.t.name, value: 'Cancelado antes de aplicar', tone: 'warn' })
        item(x, 'skipped', i + 1, 'Cancelado')
        continue
      }
      item(x, 'running', i)
      const before = x.t.elevOps ? befores.get(x.t.id) : x.t.raw(s)
      try {
        if (x.t.elevOps) {
          const why = elevErrors.get(x.t.id)
          if (why) throw new Error(why)
        } else {
          await x.t.write(x.to, s)
          s = await takeSnapshot()
        }
        const now = x.t.read(s)
        if (now !== x.to) throw new Error(`o Windows mostra "${label(x.t, s, now)}" depois da gravação${x.t.elevOps ? ' (o Windows ou uma política pode ter bloqueado a alteração)' : ''}`)
        done.push({ id: x.t.id, name: x.t.name, before, after: x.t.raw(s), fromLabel: label(x.t, s, x.from), toLabel: label(x.t, s, x.to) })
        rows.push({ label: x.t.name, value: `${label(x.t, s, x.from)} → ${label(x.t, s, x.to)} (conferido)${x.t.note ? ` · ${x.t.note}` : ''}`, tone: 'ok' })
        item(x, 'ok', i + 1, `${label(x.t, s, x.from)} → ${label(x.t, s, x.to)}`)
      } catch (error) {
        rows.push({ label: x.t.name, value: `Falhou: ${(error as Error).message}`, tone: 'error' })
        item(x, 'error', i + 1, (error as Error).message)
        log.warn('power', `Ajuste "${x.t.name}" falhou: ${(error as Error).message}`)
      }
    }
    const restartNames = done.map((d) => BY_ID.get(d.id)).filter((t): t is TweakDef => !!t?.needsRestart).map((t) => t.name)
    if (restartNames.length) rows.push({ label: 'Reinicialização necessária', value: `${restartNames.join(', ')}. O JK Optimize não reinicia o computador sozinho.`, tone: 'warn' })
    ctx.progress('Conferindo resultados', plan.apply.length, plan.apply.length, { stage: 'checking' })
    for (const n of plan.already) rows.push({ label: n, value: 'Já configurado', tone: 'ok' })
    for (const n of plan.skipped) rows.push({ label: n.split(':')[0], value: n.split(':').slice(1).join(':').trim(), tone: 'warn' })
    const failed = plan.apply.length - done.length
    return {
      ok: failed === 0 && done.length > 0,
      verified: true,
      summary:
        failed === 0
          ? `${done.length} ajuste(s) aplicado(s) e conferido(s).${restartNames.length ? ` Reinicialização necessária para: ${restartNames.join(', ')}.` : ''}`
          : ctx.signal.aborted
            ? `${done.length} de ${plan.apply.length} ajuste(s) aplicados; ${failed} não aplicado(s) porque a operação foi cancelada.`
            : `${done.length} de ${plan.apply.length} ajuste(s) aplicados; ${failed} falharam (veja Detalhes).`,
      sections: [{ title: 'Ajustes', rows }],
      change: done.length
        ? {
            before: { items: done },
            after: done.map((d) => ({ id: d.id, raw: d.after })),
            summaryBefore: done.map((d) => `${d.name}: ${d.fromLabel}`).join('; '),
            summaryAfter: done.map((d) => `${d.name}: ${d.toLabel}`).join('; ')
          }
        : undefined
    }
  },
  async revert(before, _after, ctx) {
    const restored: string[] = []
    const preserved: string[] = []
    const failed: string[] = []
    let s = await takeSnapshot()
    // Ordem inversa da aplicação (o plano de energia por último).
    const todo: { t: TweakDef; item: AppliedItem }[] = []
    for (const item of [...before.items].reverse()) {
      const t = BY_ID.get(item.id)
      if (!t) {
        failed.push(`${item.name}: ajuste desconhecido nesta versão`)
        continue
      }
      const current = t.raw(s)
      if (!t.sameRaw(current, item.after) && !ctx.force) {
        preserved.push(item.name)
        continue
      }
      todo.push({ t, item })
    }
    // Restaurações de administrador num único lote (um só pedido do Windows).
    const elevTodo = todo.filter((x) => x.t.elevRestore)
    const elevErrors = new Map<string, string>()
    if (elevTodo.length) {
      const ops: ElevOp[] = []
      const owners: string[] = []
      for (const x of elevTodo) for (const op of x.t.elevRestore!(x.item.before, s)) (ops.push(op), owners.push(x.t.id))
      if (ops.length) {
        try {
          const results = await runElevatedOps(ops, { signal: ctx.signal })
          results.forEach((r, i) => !r.ok && !elevErrors.has(owners[i]) && elevErrors.set(owners[i], r.error ?? 'o Windows recusou a operação'))
        } catch (error) {
          for (const x of elevTodo) elevErrors.set(x.t.id, (error as Error).message)
        }
      }
      s = await takeSnapshot()
    }
    for (const { t, item } of todo) {
      try {
        if (!t.elevRestore) {
          await t.restoreRaw(item.before, s)
          s = await takeSnapshot()
        }
        if (!t.sameRaw(t.raw(s), item.before)) throw new Error(elevErrors.get(t.id) ?? 'o valor lido depois não confere com o original')
        restored.push(item.name)
      } catch (error) {
        failed.push(`${item.name}: ${(error as Error).message}`)
      }
    }
    if (restored.length === 0 && failed.length === 0 && preserved.length > 0) {
      throw new AppFailure('state-changed', `Alterados depois por outro programa ou manualmente; configuração atual preservada: ${preserved.join(', ')}.`)
    }
    if (failed.length) throw new AppFailure('revert-failed', `Restaurados: ${restored.join(', ') || 'nenhum'}. Falharam: ${failed.join('; ')}.`)
    return `Restaurados: ${restored.join(', ')}.${preserved.length ? ` Preservados (alterados depois): ${preserved.join(', ')}.` : ''}`
  }
})

// ---------------------------------------------------------------------------
// Desativar todos os ajustes: reverte as alterações reversíveis feitas pelo app
// ---------------------------------------------------------------------------

/** Alterações ativas e reversíveis do diário, da mais recente para a mais antiga. */
export function activeChanges() {
  return listChanges()
    .filter((c) => c.reversible && c.status !== 'reverted')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

defineAction<Record<string, never>, never>({
  id: 'tweaks.restoreAll',
  module: 'power',
  title: 'Desativar todos os ajustes',
  description: 'Restaura os valores originais de todas as alterações reversíveis feitas pelo JK Optimize, da mais recente para a mais antiga.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'É a própria restauração; para voltar, aplique os ajustes novamente.',
  requiresElevation: false,
  exclusive: 'tweaks-restore',
  parse: noParams,
  async preview() {
    const list = activeChanges()
    return {
      summary: `${list.length} alteração(ões) do JK Optimize serão restauradas.`,
      changes: list.map((c) => ({ target: c.title, current: c.summaryAfter, intended: c.summaryBefore })),
      warnings: [
        'Alterações modificadas depois por você ou por outro programa são preservadas e informadas.',
        'Serviços, Windows Defender, firewall, atualizações e drivers não são desativados por esta ação.'
      ],
      blocked: list.length === 0 ? 'Nenhum ajuste aplicado pelo JK Optimize está ativo.' : null
    }
  },
  async execute(_p, ctx) {
    const list = activeChanges()
    const rows: { label: string; value: string; tone: 'ok' | 'warn' | 'error' }[] = []
    let restored = 0
    let preserved = 0
    let failed = 0
    for (const [i, c] of list.entries()) {
      if (ctx.signal.aborted) {
        rows.push({ label: c.title, value: 'Não processado (cancelado)', tone: 'warn' })
        continue
      }
      ctx.progress(`${c.title}…`, i, list.length)
      try {
        const rec = await revertChange(c.id, false)
        if (rec.revertSummary?.includes('Preservados')) {
          // Parte foi restaurada e parte foi alterada depois por fora: a parte externa é mantida.
          preserved++
          rows.push({ label: c.title, value: rec.revertSummary, tone: 'warn' })
        } else {
          restored++
          rows.push({ label: c.title, value: `Restaurado: ${rec.summaryBefore}`, tone: 'ok' })
        }
      } catch (error) {
        const e = error as AppFailure
        if (e.code === 'state-changed') {
          preserved++
          rows.push({ label: c.title, value: `Preservado: ${e.message}`, tone: 'warn' })
        } else {
          failed++
          rows.push({ label: c.title, value: `Falhou: ${e.message}`, tone: 'error' })
        }
      }
    }
    const parts = [`${restored} restaurada(s)`]
    if (preserved) parts.push(`${preserved} preservada(s) por divergência`)
    if (failed) parts.push(`${failed} com falha`)
    return {
      ok: failed === 0 && preserved === 0 && restored === list.length,
      verified: true,
      summary: `Ajustes desativados: ${parts.join(', ')}.`,
      sections: [{ title: 'Restauração', rows }]
    }
  }
})

// ---------------------------------------------------------------------------
// Meus ajustes: favoritos e perfis personalizados (somente valores do catálogo)
// ---------------------------------------------------------------------------

interface MyProfile {
  id: string
  name: string
  values: Record<string, string>
  createdAt: string
}

interface MyTweaks {
  favorites: string[]
  profiles: MyProfile[]
}

const PROFILE_NAME = /^[\p{L}\p{N} .,_()+-]{1,40}$/u

export function parseMyTweaks(raw: unknown): MyTweaks {
  const r = (raw ?? {}) as Partial<MyTweaks>
  const favorites = Array.isArray(r.favorites) ? r.favorites.filter((f) => typeof f === 'string' && BY_ID.has(f)) : []
  const profiles = Array.isArray(r.profiles)
    ? r.profiles
        .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && PROFILE_NAME.test(p.name) && p.values && typeof p.values === 'object')
        .map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
          // Só ajustes conhecidos e valores no formato permitido; o resto é descartado.
          values: Object.fromEntries(Object.entries(p.values).filter(([k, v]) => BY_ID.has(k) && typeof v === 'string' && /^[0-9a-z-]{1,60}$/i.test(v)))
        }))
        .slice(0, 30)
    : []
  return { favorites: [...new Set(favorites)], profiles }
}

const mine = new JsonStore<MyTweaks>('tweaks-mine.json', (raw) => parseMyTweaks(raw))

defineQuery({
  id: 'tweaks.mine',
  module: 'power',
  parse: noParams,
  async run() {
    const data = mine.read()
    const s = await takeSnapshot()
    const states = new Map(describe(s, baseline.read()).map((t) => [t.id, t]))
    return {
      favorites: data.favorites,
      profiles: data.profiles.map((p) => ({
        ...p,
        divergent: Object.entries(p.values)
          .map(([id, v]) => ({ id, name: states.get(id)?.name ?? id, saved: v, current: states.get(id)?.current ?? null, unavailable: states.get(id)?.unavailable ?? null }))
          .filter((d) => d.saved !== d.current)
      }))
    }
  }
})

defineQuery({
  id: 'tweaks.mine.favorites',
  module: 'power',
  parse: (raw) => ({ favorites: strList(obj(raw, ['favorites']).favorites, 'favoritos', TWEAKS.length, 40, /^[A-Za-z]+$/) }),
  async run({ favorites }) {
    const data = mine.read()
    return mine.write({ ...data, favorites: favorites.filter((f) => BY_ID.has(f)) }).favorites
  }
})

defineQuery({
  id: 'tweaks.mine.saveProfile',
  module: 'power',
  parse(raw) {
    const p = obj(raw, ['id', 'name', 'changes'])
    return {
      id: p.id === undefined ? null : str(p.id, 'perfil', 40, /^[a-z0-9-]+$/),
      name: str(p.name, 'nome', 40, PROFILE_NAME),
      values: parseChanges({ changes: p.changes })
    }
  },
  async run({ id, name, values }) {
    const data = mine.read()
    const profile: MyProfile = { id: id ?? crypto.randomUUID(), name, values, createdAt: new Date().toISOString() }
    const profiles = [profile, ...data.profiles.filter((p) => p.id !== profile.id)].slice(0, 30)
    mine.write({ ...data, profiles })
    log.info('power', `Perfil personalizado "${name}" salvo com ${Object.keys(values).length} ajuste(s).`)
    return profile
  }
})

defineQuery({
  id: 'tweaks.mine.deleteProfile',
  module: 'power',
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'perfil', 40, /^[a-z0-9-]+$/) }),
  async run({ id }) {
    const data = mine.read()
    mine.write({ ...data, profiles: data.profiles.filter((p) => p.id !== id) })
    return true
  }
})
