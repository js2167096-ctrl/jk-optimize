// Ícones de marca (desenho simplificado) e painéis de identidade reutilizados no Início e em Suporte.
import { ArrowRight } from 'lucide-react'
import { SOCIAL_LINKS } from '@shared/constants/links'
import { cx, Emblem } from './ui'

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M19.3 5.3A16.6 16.6 0 0 0 15.2 4l-.5 1a15.4 15.4 0 0 0-5.4 0L8.8 4a16.6 16.6 0 0 0-4.1 1.3C2.1 9.2 1.4 13 1.7 16.7a16.7 16.7 0 0 0 5 2.5l1.1-1.7a10.8 10.8 0 0 1-1.7-.8l.4-.3a11.9 11.9 0 0 0 11 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.7a16.6 16.6 0 0 0 5-2.5c.4-4.3-.7-8-2.9-11.4ZM8.7 14.4c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  )
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M16.6 3c.4 2 1.7 3.4 3.9 3.6v3a7 7 0 0 1-3.9-1.2v6.2a5.7 5.7 0 1 1-5.7-5.7l.9.1v3.1a2.6 2.6 0 1 0 1.8 2.5V3h3Z" />
    </svg>
  )
}

function YouTubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12a31 31 0 0 0 .4 3.8 3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1c.3-1.3.4-2.5.4-3.8s-.1-2.5-.4-3.8ZM10 15.1V8.9l5.2 3.1L10 15.1Z" />
    </svg>
  )
}

const SOCIALS = [
  { id: 'discord' as const, name: 'Discord', description: 'Comunidade', icon: DiscordIcon },
  { id: 'tiktok' as const, name: 'TikTok', description: 'Novidades', icon: TikTokIcon },
  { id: 'youtube' as const, name: 'YouTube', description: 'Tutoriais', icon: YouTubeIcon }
]

export function SocialPanel() {
  // Só aparece quando há pelo menos uma URL configurada; nunca exibe link inventado.
  if (SOCIALS.every(({ id }) => !SOCIAL_LINKS[id])) return null
  return (
    <section className="rounded-card border border-line bg-surface p-5" data-panel-social>
      <h2 className="text-[15px] font-semibold text-fg">Acesse Nossas Redes</h2>
      <p className="mt-0.5 text-[12px] text-muted">Fique por dentro de tudo!</p>
      <div className="mt-4 space-y-2.5">
        {SOCIALS.filter(({ id }) => SOCIAL_LINKS[id]).map(({ id, name, description, icon: Icon }) => {
          const url = SOCIAL_LINKS[id]
          const body = (
            <>
              <span className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-line-strong bg-surface-2 text-fg group-hover:text-performance">
                <Icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-fg">{name}</span>
                <span className="block text-[12px] text-muted">{url ? description : 'Link ainda não configurado'}</span>
              </span>
              <ArrowRight className={cx('size-4 shrink-0', url ? 'text-performance' : 'text-subtle')} />
            </>
          )
          const cls = 'group flex items-center gap-3 rounded-[10px] border border-line bg-bg/40 px-3 py-2.5 transition-colors'
          return url ? (
            <a key={id} href={url} target="_blank" rel="noreferrer" className={cx(cls, 'hover:border-performance/40 hover:bg-performance/5')}>
              {body}
            </a>
          ) : (
            <div key={id} className={cx(cls, 'cursor-not-allowed opacity-60')} aria-disabled title="Link ainda não configurado">
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function IdentityPanel() {
  return (
    <section className="relative overflow-hidden rounded-card border border-line bg-gradient-to-b from-surface to-bg px-5 py-5 text-center" data-brand-panel>
      <Emblem brand="panel" className="mx-auto size-24" />
      <p className="mt-1 text-[16px] font-black tracking-[0.18em]">
        <span className="bg-gradient-to-b from-accent-hi to-performance bg-clip-text text-transparent">JK</span>{' '}
        <span className="bg-gradient-to-b from-silver-hi to-silver bg-clip-text text-transparent">OPTIMIZE</span>
      </p>
      <p className="mt-1.5 text-[10px] font-semibold tracking-[0.26em] text-muted">MAIS DESEMPENHO, SEM LIMITES.</p>
    </section>
  )
}
