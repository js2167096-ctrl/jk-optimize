// Input Lag: configurações reais de mouse, teclado e monitor lidas do Windows (somente consulta).
import { defineQuery } from '../ops/registry'
import { noParams } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson } from '../services/powershell'

const SCRIPT = `
$m = Get-ItemProperty 'HKCU:\Control Panel\Mouse' -ErrorAction SilentlyContinue
$k = Get-ItemProperty 'HKCU:\Control Panel\Keyboard' -ErrorAction SilentlyContinue
$v = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.CurrentHorizontalResolution })
$mon = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorBasicDisplayParams -ErrorAction SilentlyContinue).Count
[pscustomobject]@{
  mouse = [pscustomobject]@{ speed = [string]$m.MouseSpeed; t1 = [string]$m.MouseThreshold1; t2 = [string]$m.MouseThreshold2; sensitivity = [string]$m.MouseSensitivity }
  keyboard = [pscustomobject]@{ delay = [string]$k.KeyboardDelay; rate = [string]$k.KeyboardSpeed }
  displays = @($v | ForEach-Object { [pscustomobject]@{ adapter = [string]$_.Name; width = $_.CurrentHorizontalResolution; height = $_.CurrentVerticalResolution; hz = $_.CurrentRefreshRate } })
  monitors = $mon
} | ConvertTo-Json -Depth 4 -Compress`

defineQuery({
  id: 'inputlag.report',
  module: 'performance',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<Record<string, unknown>>(SCRIPT, { timeoutMs: 30_000 })
    const mouse = (r?.mouse ?? {}) as Record<string, unknown>
    const kb = (r?.keyboard ?? {}) as Record<string, unknown>
    const accel = asString(mouse.speed) !== '0' || asString(mouse.t1) !== '0' || asString(mouse.t2) !== '0'
    return {
      mouse: { acceleration: accel, speed: asString(mouse.speed), threshold1: asString(mouse.t1), threshold2: asString(mouse.t2), sensitivity: asNumber(mouse.sensitivity) },
      keyboard: { delay: asNumber(kb.delay), rate: asNumber(kb.rate) },
      displays: asArray(r?.displays).map((d) => {
        const x = d as Record<string, unknown>
        return { adapter: String(x.adapter), width: asNumber(x.width), height: asNumber(x.height), hz: asNumber(x.hz) }
      }),
      readAt: new Date().toISOString()
    }
  }
})
