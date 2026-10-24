import { useState, type ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react'
import { useApp } from '../hooks/useApp'
import { NAV_GROUPS, NAV_ITEMS, type PageId } from '../navigation'
import { Badge, BrandMark, cx, Emblem, StatusDot } from '../components/ui'

export function AppLayout({ page, children }: { page: PageId; children: ReactNode }) {
  const { access, info, executor, navigate } = useApp()
  const isOwner = access.kind === 'owner'
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('jko-sidebar') === 'collapsed'
    } catch {
      return false
    }
  })
  const toggle = (v: boolean) => {
    setCollapsed(v)
    try {
      localStorage.setItem('jko-sidebar', v ? 'collapsed' : 'expanded')
    } catch {
      /* preferência opcional */
    }
  }
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.ownerOnly || isOwner) }))
  const current = NAV_ITEMS.find((i) => i.id === page)
  const executorTone = executor.state === 'ready' ? 'ok' : executor.state === 'starting' ? 'info' : 'error'

  return (
    <div className="flex h-full">
      <aside className={cx('flex shrink-0 flex-col border-r border-line bg-elevated transition-[width] duration-200 ease-out', collapsed ? 'w-[68px]' : 'w-60')} data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
        <div className={cx('drag flex h-16 items-center', collapsed ? 'justify-center px-2' : 'justify-between pr-2 pl-5')}>
          {collapsed ? <Emblem small brand="mark" className="size-8" /> : <BrandMark />}
          {!collapsed && (
            <button type="button" aria-label="Recolher menu" data-sidebar-toggle onClick={() => toggle(true)} className="no-drag grid size-8 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg">
              <PanelLeftClose className="size-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button type="button" aria-label="Expandir menu" data-sidebar-toggle onClick={() => toggle(false)} className="no-drag mx-auto mb-1 grid size-8 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg">
            <PanelLeftOpen className="size-4" />
          </button>
        )}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {groups.map((group, gi) => (
            <div key={group.id} className={cx(gi > 0 && 'mt-2 border-t border-line/70 pt-2')} data-nav-group={group.id}>
              {group.title && !collapsed && <p className="px-3 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[0.14em] text-subtle uppercase">{group.title}</p>}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = item.id === page
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-nav={item.label}
                      title={collapsed ? item.label : undefined}
                      aria-label={item.label}
                      onClick={() => navigate(item.id)}
                      className={cx(
                        'no-drag group relative flex h-10 w-full items-center rounded-[10px] border text-[13px] font-medium transition-colors',
                        collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                        active
                          ? 'border-performance/40 bg-gradient-to-r from-performance/20 to-performance/[0.04] text-fg shadow-[0_0_20px_-10px_var(--jk-accent)]'
                          : 'border-transparent text-muted hover:bg-surface-2 hover:text-fg'
                      )}
                    >
                      {active && <span className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-performance shadow-[var(--jk-glow)]" />}
                      <Icon className={cx('size-[18px] shrink-0', active ? 'text-performance' : 'text-fg/80 group-hover:text-fg')} />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className={cx("space-y-2.5 border-t border-line py-4", collapsed ? "hidden" : "px-5")}>
          <div className="flex items-center gap-2">
            <span className="h-3 w-[3px] rounded-full bg-performance shadow-[var(--jk-glow)]" />
            <span className="text-[12px] font-semibold tracking-wide text-fg">JK Optimize</span>
          </div>
          <p className="text-[11px] text-subtle">Versão {info.appVersion}</p>
          {isOwner ? <Badge tone="warn">Sessão do proprietário</Badge> : <Badge tone="ok">Ativado</Badge>}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior: estado real do executor, configurações e espaço para os controles da janela. */}
        <header className="drag flex h-12 shrink-0 items-center justify-between gap-4 pr-[156px] pl-7">
          <div className="flex items-center gap-2 text-[12.5px]">
            <Emblem small brand="topbar" className="size-5" />
            <span className="text-subtle">JK Optimize</span>
            <span className="text-line-strong">/</span>
            <span className="font-medium text-fg">{current?.label}</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('executor')} className="no-drag flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-muted hover:text-fg">
              <StatusDot tone={executorTone} />
              Executor {executor.state === 'ready' ? 'ativo' : executor.state === 'starting' ? 'iniciando' : 'indisponível'}
            </button>
            <button
              type="button"
              aria-label="Configurações"
              onClick={() => navigate('settings')}
              className="no-drag grid size-8 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Settings className="size-4" />
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto border-t border-line/60">
          {/* Otimização e Início têm composição própria e ocupam a área inteira. */}
          <div
            key={page}
            className={cx(
              'animate-enter',
              page === 'dashboard' ? 'mx-auto max-w-[1500px] px-7 py-6' : 'mx-auto max-w-6xl px-8 py-7'
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
