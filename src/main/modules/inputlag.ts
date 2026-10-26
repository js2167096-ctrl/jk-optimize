// Input Lag: configurações reais de mouse, teclado e monitor lidas do Windows (somente consulta).
import { defineQuery } from '../ops/registry'
import { noParams } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson } from '../services/powershell'

// Atenção: dentro de um template literal, "\C" vira "C". Barras de caminhos do Windows precisam ser escritas "\\".
export const SCRIPT = `
$m = Get-ItemProperty 'HKCU:\\Control Panel\\Mouse' -ErrorAction SilentlyContinue
$k = Get-ItemProperty 'HKCU:\\Control Panel\\Keyboard' -ErrorAction SilentlyContinue
$v = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.CurrentHorizontalResolution })
$mon = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue).Count
[pscustomobject]@{
  mouse = if ($m) { [pscustomobject]@{ speed = [string]$m.MouseSpeed; t1 = [string]$m.MouseThreshold1; t2 = [string]$m.MouseThreshold2; sensitivity = [string]$m.MouseSensitivity } } else { $null }
  keyboard = if ($k) { [pscustomobject]@{ delay = [string]$k.KeyboardDelay; rate = [string]$k.KeyboardSpeed } } else { $null }
  displays = @($v | ForEach-Object { [pscustomobject]@{ adapter = [string]$_.Name; width = $_.CurrentHorizontalResolution; height = $_.CurrentVerticalResolution; hz = $_.CurrentRefreshRate } })
  monitors = $mon
} | ConvertTo-Json -Depth 4 -Compress`

/** O registro devolve números como texto ("10"); valores ausentes ou não numéricos viram null. Exportada para testes. */
export function numberFromText(value: unknown): number | null {
  const text = asString(value)
  if (text === null || !/^-?\d+$/.test(text)) return null
  return Number(text)
}

/** Aceleração do ponteiro: true/false só quando os três valores foram lidos; null se o Windows não os informou. Exportada para testes. */
export function mouseAcceleration(mouse: Record<string, unknown>): boolean | null {
  const values = [asString(mouse.speed), asString(mouse.t1), asString(mouse.t2)]
  if (values.some((v) => v === null || v === '')) return null
  return values.some((v) => v !== '0')
}

defineQuery({
  id: 'inputlag.report',
  module: 'performance',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<Record<string, unknown>>(SCRIPT, { timeoutMs: 30_000 })
    const mouse = (r?.mouse ?? {}) as Record<string, unknown>
    const kb = (r?.keyboard ?? {}) as Record<string, unknown>
    return {
      mouse: {
        acceleration: mouseAcceleration(mouse),
        speed: asString(mouse.speed),
        threshold1: asString(mouse.t1),
        threshold2: asString(mouse.t2),
        sensitivity: numberFromText(mouse.sensitivity)
      },
      keyboard: { delay: numberFromText(kb.delay), rate: numberFromText(kb.rate) },
      displays: asArray(r?.displays).map((d) => {
        const x = d as Record<string, unknown>
        return { adapter: String(x.adapter), width: asNumber(x.width), height: asNumber(x.height), hz: asNumber(x.hz) }
      }),
      readAt: new Date().toISOString()
    }
  }
})
