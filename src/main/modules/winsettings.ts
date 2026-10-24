// Leitura e gravação de valores do registro do USUÁRIO (HKCU) usados pelos perfis.
// Caminhos e nomes vêm de listas fixas no código; os dados entram por stdin em JSON.
import { asArray, runPowerShellWith } from '../services/powershell'

export type RegValue = number | string | null

const READ = `
$res = foreach ($s in $in.items) {
  $v = $null; $exists = $false
  try { $p = Get-ItemProperty -LiteralPath $s.key -Name $s.name -ErrorAction Stop; $v = $p.($s.name); $exists = $true } catch {}
  [pscustomobject]@{ id = $s.id; exists = $exists; value = $v }
}
@($res) | ConvertTo-Json -Compress`

export async function readValues(items: { id: string; key: string; name: string }[]): Promise<Map<string, RegValue>> {
  const raw = await runPowerShellWith<unknown>(READ, { items })
  const map = new Map<string, RegValue>()
  for (const r of asArray(raw)) {
    const row = r as { id: string; exists: boolean; value: unknown }
    map.set(row.id, !row.exists ? null : typeof row.value === 'number' || typeof row.value === 'string' ? row.value : String(row.value))
  }
  return map
}

const WRITE = `
if ($null -eq $in.data) { Remove-ItemProperty -LiteralPath $in.key -Name $in.name -ErrorAction SilentlyContinue }
else {
  if (-not (Test-Path -LiteralPath $in.key)) { New-Item -Path $in.key -Force | Out-Null }
  if ($in.type -eq 'DWord') { Set-ItemProperty -LiteralPath $in.key -Name $in.name -Value ([int]$in.data) -Type DWord }
  else { Set-ItemProperty -LiteralPath $in.key -Name $in.name -Value ([string]$in.data) -Type String }
}
$now = $null; try { $now = (Get-ItemProperty -LiteralPath $in.key -Name $in.name -ErrorAction Stop).($in.name) } catch {}
[pscustomobject]@{ now = $now } | ConvertTo-Json -Compress`

/** Grava (ou remove, com data=null) e devolve o valor lido de volta. */
export async function writeValue(key: string, name: string, type: 'DWord' | 'String', data: RegValue): Promise<RegValue> {
  const r = await runPowerShellWith<{ now: unknown }>(WRITE, { key, name, type, data })
  const now = r?.now
  return now === null || now === undefined ? null : typeof now === 'number' || typeof now === 'string' ? now : String(now)
}
