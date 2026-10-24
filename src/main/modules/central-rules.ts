// Regras puras da Central de Otimização (sem Electron), para teste unitário.
import type { ServiceRow } from './services'

export type Mode = 'Automatic' | 'AutomaticDelayed' | 'Manual' | 'Disabled'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'microsoft' | 'other'

/** Fabricante pelo identificador PCI (VEN_xxxx), com o nome como reserva. Exportada para testes. */
export function gpuVendor(pnp: string | null, name: string, maker: string | null): GpuVendor {
  const ven = /VEN_([0-9A-F]{4})/i.exec(pnp ?? '')?.[1]?.toUpperCase()
  if (ven === '10DE') return 'nvidia'
  if (ven === '1002' || ven === '1022') return 'amd'
  if (ven === '8086') return 'intel'
  if (ven === '1414') return 'microsoft'
  const text = `${name} ${maker ?? ''}`.toLowerCase()
  if (/nvidia|geforce|quadro/.test(text)) return 'nvidia'
  if (/\bamd\b|radeon|advanced micro/.test(text)) return 'amd'
  if (/intel/.test(text)) return 'intel'
  if (/microsoft|basic (display|render)/.test(text)) return 'microsoft'
  return 'other'
}

/** Integrada ou dedicada, com a base da conclusão. Exportada para testes. */
export function gpuKind(vendor: GpuVendor, name: string): { kind: 'integrated' | 'dedicated' | 'unknown'; basis: string } {
  if (vendor === 'microsoft') return { kind: 'unknown', basis: 'Adaptador básico do Windows (sem driver do fabricante).' }
  if (vendor === 'nvidia') return { kind: 'dedicated', basis: 'GPUs NVIDIA para PC são dedicadas.' }
  if (vendor === 'intel') return /\barc\b/i.test(name) ? { kind: 'dedicated', basis: 'Intel Arc é dedicada.' } : { kind: 'integrated', basis: 'Gráficos Intel sem "Arc" são integrados ao processador.' }
  if (vendor === 'amd') {
    return /radeon\(tm\) graphics$|radeon graphics$|radeon\(tm\) (rx )?vega \d+ graphics|radeon \d{3}m\b|radeon\(tm\) \d{3}m\b/i.test(name.trim())
      ? { kind: 'integrated', basis: 'Nome típico de gráficos integrados Radeon (APU).' }
      : { kind: 'dedicated', basis: 'Radeon com nome de placa dedicada.' }
  }
  return { kind: 'unknown', basis: 'Fabricante não reconhecido.' }
}


/** Compara um perfil salvo com os serviços deste computador. Exportada para testes. */
export function compareProfile(items: { name: string; mode: Mode }[], local: Pick<ServiceRow, 'name' | 'startMode' | 'delayed' | 'modifiable' | 'protectedReason'>[]) {
  const by = new Map(local.map((r) => [r.name.toLowerCase(), r]))
  return items.map((it) => {
    const row = by.get(it.name.toLowerCase())
    if (!row) return { name: it.name, wanted: it.mode, status: 'missing' as const, current: null }
    const current: Mode = row.startMode === 'Auto' ? (row.delayed ? 'AutomaticDelayed' : 'Automatic') : row.startMode === 'Disabled' ? 'Disabled' : 'Manual'
    if (!row.modifiable) return { name: it.name, wanted: it.mode, status: 'protected' as const, current }
    return { name: it.name, wanted: it.mode, status: current === it.mode ? ('same' as const) : ('differs' as const), current }
  })
}


/** Tarefas do próprio Windows (\Microsoft\Windows\...) e de segurança nunca são alteradas. Exportada para testes. */
export function taskProtection(path: string, name: string): string | null {
  if (/^\\Microsoft\\Windows\\/i.test(path)) return 'Tarefa de manutenção do próprio Windows: não é alterada pelo JK Optimize.'
  if (/defender|antivirus|security|windowsupdate|update orchestrator/i.test(`${path}${name}`) && /microsoft/i.test(path)) return 'Tarefa de segurança ou atualização do Windows.'
  return null
}


/** Recursos que o JK Optimize não altera: componentes de segurança e do próprio sistema. */
export function featureProtection(name: string): string | null {
  if (/^Windows-Defender/i.test(name)) return 'Componente de segurança do Windows.'
  if (/^(NetFx4|MicrosoftWindowsPowerShell|SearchEngine)/i.test(name)) return 'Componente usado pelo próprio sistema.'
  return null
}


/** Máscara válida: pelo menos um núcleo e nenhum bit além dos núcleos lógicos existentes. Exportada para testes. */
export function validAffinityMask(mask: number, logicalCores: number): boolean {
  if (!Number.isInteger(mask) || mask < 1 || logicalCores < 1 || logicalCores > 30) return false
  return mask < 2 ** logicalCores
}

