import {
  Activity,
  AppWindow,
  Boxes,
  Cpu,
  Eraser,
  Gamepad2,
  History,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  MemoryStick,
  MousePointer2,
  Palette,
  PackageMinus,
  RefreshCcw,
  ServerCog,
  Settings,
  ShieldCheck,
  SquareTerminal,
  UserCog,
  Wifi,
  Zap,
  type LucideIcon
} from 'lucide-react'

export type Accent = 'performance' | 'optimize' | 'advanced' | 'alert' | 'diagnostic' | 'neutral'

export type PageId =
  | 'dashboard'
  | 'fps'
  | 'inputlag'
  | 'games'
  | 'tuneapps'
  | 'memory'
  | 'network'
  | 'bios'
  | 'cleanup'
  | 'deploy'
  | 'updates'
  | 'progress'
  | 'personalize'
  | 'services'
  | 'processes'
  | 'profiles'
  | 'history'
  | 'apps'
  | 'executor'
  | 'keys'
  | 'admin'
  | 'settings'
  | 'support'

export interface NavItem {
  id: PageId
  label: string
  icon: LucideIcon
  accent: Accent
  ownerOnly?: boolean
}

export interface NavGroup {
  id: string
  title: string | null
  items: NavItem[]
}

/** Menu lateral: Início, Otimização, Sistema, Extras e, no rodapé, Configurações e Suporte (nesta ordem). */
export const NAV_GROUPS: NavGroup[] = [
  { id: 'start', title: 'Início', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, accent: 'performance' }] },
  {
    id: 'optimization',
    title: 'Otimização',
    items: [
      { id: 'fps', label: 'FPS Boost', icon: Zap, accent: 'performance' },
      { id: 'inputlag', label: 'Input Lag', icon: MousePointer2, accent: 'performance' },
      { id: 'games', label: 'Jogos', icon: Gamepad2, accent: 'advanced' },
      { id: 'tuneapps', label: 'Apps', icon: Boxes, accent: 'optimize' },
      { id: 'memory', label: 'Memória', icon: MemoryStick, accent: 'diagnostic' },
      { id: 'network', label: 'Redes', icon: Wifi, accent: 'diagnostic' },
      { id: 'bios', label: 'BIOS', icon: Cpu, accent: 'advanced' }
    ]
  },
  {
    id: 'system',
    title: 'Sistema',
    items: [
      { id: 'cleanup', label: 'Limpeza', icon: Eraser, accent: 'optimize' },
      { id: 'deploy', label: 'Deploy', icon: PackageMinus, accent: 'advanced' },
      { id: 'updates', label: 'Atualizações', icon: RefreshCcw, accent: 'diagnostic' },
      { id: 'progress', label: 'Progresso', icon: ListChecks, accent: 'performance' },
      { id: 'personalize', label: 'Personalização', icon: Palette, accent: 'advanced' }
    ]
  },
  {
    id: 'extras',
    title: 'Extras',
    items: [
      { id: 'services', label: 'Serviços', icon: ServerCog, accent: 'advanced' },
      { id: 'processes', label: 'Processos', icon: Activity, accent: 'diagnostic' },
      { id: 'profiles', label: 'Perfis', icon: UserCog, accent: 'optimize' },
      { id: 'history', label: 'Histórico e Restauração', icon: History, accent: 'neutral' },
      { id: 'apps', label: 'Aplicativos', icon: AppWindow, accent: 'optimize' },
      { id: 'executor', label: 'Executor', icon: SquareTerminal, accent: 'advanced' },
      { id: 'keys', label: 'Chaves', icon: KeyRound, accent: 'neutral' },
      { id: 'admin', label: 'Administração', icon: ShieldCheck, accent: 'alert', ownerOnly: true }
    ]
  },
  {
    id: 'bottom',
    title: null,
    items: [
      { id: 'settings', label: 'Configurações', icon: Settings, accent: 'neutral' },
      { id: 'support', label: 'Suporte', icon: LifeBuoy, accent: 'neutral' }
    ]
  }
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

/** Classes completas por destaque (o Tailwind só gera classes escritas literalmente). */
export const ACCENT_CLASSES: Record<Accent, { text: string; soft: string; border: string; solid: string }> = {
  performance: { text: 'text-performance', soft: 'bg-performance/10', border: 'border-performance/30', solid: 'bg-performance' },
  optimize: { text: 'text-optimize', soft: 'bg-optimize/10', border: 'border-optimize/30', solid: 'bg-optimize' },
  advanced: { text: 'text-advanced', soft: 'bg-advanced/10', border: 'border-advanced/30', solid: 'bg-advanced' },
  alert: { text: 'text-alert', soft: 'bg-alert/10', border: 'border-alert/30', solid: 'bg-alert' },
  diagnostic: { text: 'text-diagnostic', soft: 'bg-diagnostic/10', border: 'border-diagnostic/30', solid: 'bg-diagnostic' },
  neutral: { text: 'text-muted', soft: 'bg-surface-3/60', border: 'border-line-strong', solid: 'bg-muted' }
}
