// BIOS e hardware: leitura somente de consulta do firmware, memória, virtualização, Secure Boot e TPM, com recomendações derivadas dos dados.
import { defineQuery } from '../ops/registry'
import { noParams } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson } from '../services/powershell'

const SCRIPT = `
function Safe($b) { try { & $b } catch { $null } }
$bios = Safe { Get-CimInstance Win32_BIOS | Select-Object -First 1 }
$board = Safe { Get-CimInstance Win32_BaseBoard | Select-Object -First 1 }
$cs = Safe { Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 }
$cpu = Safe { Get-CimInstance Win32_Processor | Select-Object -First 1 }
$mem = @(Safe { Get-CimInstance Win32_PhysicalMemory })
$fw = Safe { $t = (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name PEFirmwareType -ErrorAction Stop).PEFirmwareType; if ($t -in 1, 2) { [int]$t } else { $null } }
if ($null -eq $fw) { $fw = switch ($env:firmware_type) { 'UEFI' { 2 } 'Legacy' { 1 } default { $null } } }
$sb = Safe { [int](Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State' -ErrorAction Stop).UEFISecureBootEnabled }
$tpm = Safe { Get-CimInstance -Namespace 'root\\cimv2\\Security\\MicrosoftTpm' -ClassName Win32_Tpm -ErrorAction Stop | Select-Object -First 1 }
$gpu = @(Safe { Get-CimInstance Win32_VideoController })
$disks = @(Safe { Get-PhysicalDisk | Select-Object FriendlyName, MediaType, BusType, Size })
[pscustomobject]@{
  bios = if ($bios) { [pscustomobject]@{ vendor = [string]$bios.Manufacturer; version = [string]$bios.SMBIOSBIOSVersion; date = if ($bios.ReleaseDate) { ([datetime]$bios.ReleaseDate).ToString('yyyy-MM-dd') } else { $null } } } else { $null }
  board = if ($board) { [pscustomobject]@{ vendor = [string]$board.Manufacturer; product = [string]$board.Product } } else { $null }
  system = if ($cs) { [pscustomobject]@{ model = [string]$cs.Model; hypervisor = [bool]$cs.HypervisorPresent; ram = [double]$cs.TotalPhysicalMemory } } else { $null }
  cpu = if ($cpu) { [pscustomobject]@{ name = [string]$cpu.Name; virt = $cpu.VirtualizationFirmwareEnabled; slat = $cpu.SecondLevelAddressTranslationExtensions; cores = [int]$cpu.NumberOfCores; threads = [int]$cpu.NumberOfLogicalProcessors } } else { $null }
  memory = @($mem | ForEach-Object { [pscustomobject]@{ gb = [math]::Round($_.Capacity / 1GB, 1); speed = $_.Speed; configured = $_.ConfiguredClockSpeed; slot = [string]$_.DeviceLocator; maker = [string]$_.Manufacturer } })
  firmware = $fw
  secureBoot = $sb
  tpm = if ($tpm) { [pscustomobject]@{ present = $true; enabled = $tpm.IsEnabled_InitialValue; activated = $tpm.IsActivated_InitialValue; version = [string]$tpm.SpecVersion } } else { $null }
  gpus = @($gpu | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; driver = [string]$_.DriverVersion } })
  disks = @($disks | ForEach-Object { [pscustomobject]@{ name = [string]$_.FriendlyName; media = [string]$_.MediaType; bus = [string]$_.BusType; gb = [math]::Round($_.Size / 1GB, 0) } })
} | ConvertTo-Json -Depth 5 -Compress`

export interface BiosAdvice {
  id: string
  severity: 'info' | 'warn'
  title: string
  evidence: string
  steps: string
}

const ENTER_BIOS = 'Reinicie o computador e pressione a tecla de acesso à BIOS/UEFI (geralmente Delete, F2, F10 ou F12; veja o logotipo do fabricante). Também é possível usar Configurações → Sistema → Recuperação → Inicialização avançada → Configurações de Firmware UEFI.'

export function adviseBios(d: {
  firmware: number | null
  secureBoot: number | null
  tpm: { present: boolean; enabled: unknown; version: string | null } | null
  cpuVirt: boolean | null
  hypervisor: boolean
  memory: { gb: number; speed: number | null; configured: number | null }[]
}): BiosAdvice[] {
  const out: BiosAdvice[] = []
  const speeds = d.memory.filter((m) => m.speed && m.configured)
  const slow = speeds.find((m) => (m.configured as number) + 100 < (m.speed as number))
  if (slow) out.push({ id: 'xmp', severity: 'info', title: 'Memória abaixo da velocidade nominal', evidence: `Módulo de ${slow.speed} MT/s rodando a ${slow.configured} MT/s.`, steps: `Se a placa-mãe e a memória oferecem perfil XMP/EXPO/DOCP, ativá-lo na BIOS pode usar a velocidade nominal. É uma opção do fabricante e deve ser testada para estabilidade. ${ENTER_BIOS}` })
  if (d.memory.length === 1) out.push({ id: 'channel', severity: 'info', title: 'Apenas um módulo de memória', evidence: 'Foi detectado um único módulo.', steps: 'Dois módulos iguais em canais corretos (dual channel) costumam dar mais largura de banda, principalmente com GPU integrada. Consulte o manual da placa-mãe para os encaixes.' })
  if (d.cpuVirt === false && !d.hypervisor) out.push({ id: 'virt', severity: 'info', title: 'Virtualização desativada no firmware', evidence: 'O processador informa virtualização desativada e não há hipervisor ativo.', steps: `Necessária para emuladores Android e máquinas virtuais. Ative SVM Mode (AMD) ou Intel VT-x na BIOS. ${ENTER_BIOS}` })
  if (d.firmware === 1) out.push({ id: 'legacy', severity: 'warn', title: 'Inicialização em modo BIOS legado', evidence: 'O Windows iniciou em modo legado (não UEFI).', steps: 'Secure Boot e o Windows 11 exigem UEFI. Converter exige disco GPT (ferramenta MBR2GPT da Microsoft) e mudança na BIOS; faça backup antes.' })
  if (d.firmware === 2 && d.secureBoot === 0) out.push({ id: 'secureboot', severity: 'info', title: 'Secure Boot desativado', evidence: 'O Windows informa Secure Boot desligado.', steps: `Alguns jogos com antitrapaça exigem Secure Boot (ex.: Valorant no Windows 11). Ative na BIOS, na seção Boot/Security. ${ENTER_BIOS}` })
  if (!d.tpm) out.push({ id: 'tpm', severity: 'info', title: 'TPM não lido', evidence: 'A leitura do TPM exige administrador ou o recurso não existe.', steps: 'Verifique em Windows Security → Segurança do dispositivo. Se ausente, procure fTPM/PTT/Security Device na BIOS.' })
  return out
}

defineQuery({
  id: 'bios.report',
  module: 'performance',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<Record<string, unknown>>(SCRIPT, { timeoutMs: 40_000 })
    const g = (o: unknown) => (o && typeof o === 'object' ? (o as Record<string, unknown>) : null)
    const bios = g(r?.bios)
    const board = g(r?.board)
    const sys = g(r?.system)
    const cpu = g(r?.cpu)
    const tpm = g(r?.tpm)
    const memory = asArray(r?.memory).map((m) => {
      const x = m as Record<string, unknown>
      return { gb: asNumber(x.gb) ?? 0, speed: asNumber(x.speed), configured: asNumber(x.configured), slot: asString(x.slot), maker: asString(x.maker) }
    })
    const firmware = asNumber(r?.firmware)
    const secureBoot = asNumber(r?.secureBoot)
    const info = {
      bios: bios ? { vendor: asString(bios.vendor), version: asString(bios.version), date: asString(bios.date) } : null,
      board: board ? { vendor: asString(board.vendor), product: asString(board.product) } : null,
      system: sys ? { model: asString(sys.model), hypervisor: sys.hypervisor === true, ramBytes: asNumber(sys.ram) } : null,
      cpu: cpu ? { name: asString(cpu.name), virtualization: typeof cpu.virt === 'boolean' ? cpu.virt : null, slat: typeof cpu.slat === 'boolean' ? cpu.slat : null, cores: asNumber(cpu.cores), threads: asNumber(cpu.threads) } : null,
      memory,
      firmwareType: firmware === 2 ? 'UEFI' : firmware === 1 ? 'BIOS legado' : null,
      secureBoot: secureBoot === 1 ? 'ativado' : secureBoot === 0 ? 'desativado' : null,
      tpm: tpm ? { present: true, enabled: tpm.enabled === true, activated: tpm.activated === true, version: asString(tpm.version) } : null,
      gpus: asArray(r?.gpus).map((x) => x as { name: string; driver: string }),
      disks: asArray(r?.disks).map((x) => x as { name: string; media: string; bus: string; gb: number })
    }
    return {
      ...info,
      advice: adviseBios({ firmware, secureBoot, tpm: info.tpm ? { present: true, enabled: info.tpm.enabled, version: info.tpm.version } : null, cpuVirt: info.cpu?.virtualization ?? null, hypervisor: info.system?.hypervisor ?? false, memory }),
      readAt: new Date().toISOString(),
      note: 'Somente leitura. O JK Optimize não altera BIOS/UEFI, voltagens, frequências nem limites térmicos.'
    }
  }
})
