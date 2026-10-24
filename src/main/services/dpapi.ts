// Cifra dados com a proteção de dados do Windows (DPAPI, escopo do usuário atual).
// Só a mesma conta do Windows, no mesmo computador, consegue decifrar.
// Os dados passam pela entrada padrão em base64; os scripts são fixos.
import { runPowerShell } from './powershell'

const ENTROPY = "[Text.Encoding]::UTF8.GetBytes('jk-optimize-owner-session')"

const PROTECT = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,${ENTROPY},'CurrentUser'))`

const UNPROTECT = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,${ENTROPY},'CurrentUser'))`

export async function protectForCurrentUser(data: Buffer): Promise<Buffer> {
  return Buffer.from((await runPowerShell(PROTECT, 15_000, data.toString('base64'))).trim(), 'base64')
}

export async function unprotectForCurrentUser(data: Buffer): Promise<Buffer> {
  return Buffer.from((await runPowerShell(UNPROTECT, 15_000, data.toString('base64'))).trim(), 'base64')
}
