import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { Check, CircleAlert, CircleCheck, Copy, Info, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react'
import { ACCENT_CLASSES, type Accent } from '../navigation'
import emblemBaseUrl from '../assets/brand/jk-emblem-base.png'
import emblemGlowUrl from '../assets/brand/jk-emblem-glow.png'
import emblemSmallBaseUrl from '../assets/brand/jk-emblem-128-base.png'
import emblemSmallGlowUrl from '../assets/brand/jk-emblem-128-glow.png'

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------

export function Card({
  title,
  icon: Icon,
  accent = 'neutral',
  action,
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  title?: ReactNode
  icon?: LucideIcon
  accent?: Accent
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section {...rest} className={cx('rounded-card border border-line bg-surface p-5', className)}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && (
              <span className={cx('grid size-7 shrink-0 place-items-center rounded-control', ACCENT_CLASSES[accent].soft)}>
                <Icon className={cx('size-4', ACCENT_CLASSES[accent].text)} />
              </span>
            )}
            <h2 className="truncate text-[13px] font-semibold tracking-wide text-fg">{title}</h2>
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageHeader({
  title,
  description,
  icon: Icon,
  accent,
  action
}: {
  title: string
  description: string
  icon: LucideIcon
  accent: Accent
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3.5">
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-card border', ACCENT_CLASSES[accent].soft, ACCENT_CLASSES[accent].border)}>
          <Icon className={cx('size-5', ACCENT_CLASSES[accent].text)} />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-fg">{title}</h1>
          <p className="mt-0.5 text-[13px] text-muted">{description}</p>
        </div>
      </div>
      {action}
    </div>
  )
}

// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-btn text-on-accent shadow-[var(--jk-glow)] hover:brightness-110',
  secondary: 'border border-line-strong bg-surface-2 text-fg hover:bg-surface-3',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20'
}

export function Button({
  variant = 'secondary',
  icon: Icon,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'no-drag inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className
      )}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : Icon && <Icon className="size-4" />}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'soon'

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'border-line-strong bg-surface-2 text-muted',
  ok: 'border-optimize/30 bg-optimize/10 text-optimize',
  warn: 'border-alert/30 bg-alert/10 text-alert',
  error: 'border-danger/30 bg-danger/10 text-danger',
  info: 'border-info/30 bg-info/10 text-info',
  soon: 'border-diagnostic/25 bg-diagnostic/10 text-diagnostic'
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap', BADGE_TONES[tone])}>
      {children}
    </span>
  )
}

export function SoonBadge() {
  return <Badge tone="soon">Em breve</Badge>
}

export function StatusDot({ tone }: { tone: Tone }) {
  const color = { neutral: 'bg-subtle', ok: 'bg-optimize', warn: 'bg-alert', error: 'bg-danger', info: 'bg-info', soon: 'bg-diagnostic' }[tone]
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', color)} />
}

// ---------------------------------------------------------------------------

const NOTICE_STYLES = {
  info: { box: 'border-info/25 bg-info/5', icon: Info, color: 'text-info' },
  ok: { box: 'border-optimize/25 bg-optimize/5', icon: CircleCheck, color: 'text-optimize' },
  warn: { box: 'border-alert/25 bg-alert/5', icon: TriangleAlert, color: 'text-alert' },
  error: { box: 'border-danger/25 bg-danger/5', icon: CircleAlert, color: 'text-danger' }
}

export function Notice({ tone = 'info', title, children }: { tone?: keyof typeof NOTICE_STYLES; title?: string; children?: ReactNode }) {
  const style = NOTICE_STYLES[tone]
  const Icon = style.icon
  return (
    <div className={cx('flex gap-3 rounded-card border px-4 py-3 text-[13px]', style.box)}>
      <Icon className={cx('mt-0.5 size-4 shrink-0', style.color)} />
      <div className="min-w-0 text-muted">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function ProgressBar({ value, accent = 'performance' }: { value: number | null; accent?: Accent }) {
  const pct = value === null ? 0 : Math.min(100, Math.max(0, value))
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
      <div className={cx('h-full w-full origin-left rounded-full transition-transform duration-500', ACCENT_CLASSES[accent].solid)} style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <LoaderCircle className="size-4 animate-spin" />
      {label}
    </div>
  )
}

export function InfoRow({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line py-2 last:border-0">
      <span className="shrink-0 text-[13px] text-muted">{label}</span>
      <span className={cx('selectable min-w-0 text-right text-[13px] break-words text-fg', mono && 'font-mono text-[12px]')}>{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function TextField({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted">{label}</span>
      <input
        {...rest}
        className="no-drag h-9 w-full rounded-control border border-line-strong bg-elevated px-3 text-[13px] text-fg placeholder:text-subtle focus:border-performance/60 focus:outline-none"
      />
      {hint && <span className="mt-1 block text-[11px] text-subtle">{hint}</span>}
    </label>
  )
}

/** Interruptor único do aplicativo. `text` exibe o rótulo ao lado; `label` é sempre o nome acessível. */
export function Toggle({ checked, onChange, disabled, label, text }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; text?: ReactNode }) {
  const sw = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'no-drag relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'border-performance/60 bg-performance shadow-[var(--jk-glow)]' : 'border-line-strong bg-surface-3'
      )}
    >
      <span className={cx('absolute top-[3px] size-3 rounded-full bg-white transition-[left]', checked ? 'left-[19px]' : 'left-[3px]')} />
    </button>
  )
  if (!text) return sw
  return (
    <span className="inline-flex items-center gap-2.5 text-[13px] text-muted">
      {sw}
      {text}
    </span>
  )
}

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="secondary"
      icon={copied ? Check : Copy}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? 'Copiado' : label}
    </Button>
  )
}

/**
 * Emblema oficial em duas camadas com transparência real: a base (personagem e máscara escuros, cor fixa) e o
 * brilho (olhos, contornos e luz externa), que acompanha o tema pelo filtro --jk-logo-filter. Nenhuma tonalização
 * é aplicada ao personagem. A imagem completa original continua em assets/brand/jk-emblem.png (ícone do app).
 */
export function Emblem({ small, brand, alt = '', className, enter, hover }: { small?: boolean; brand: 'emblem' | 'mark' | 'topbar' | 'panel'; alt?: string; className?: string; enter?: boolean; hover?: boolean }) {
  const px = small ? 128 : 768
  return (
    <span className={cx('relative inline-block aspect-square shrink-0 select-none', enter && 'emblem-enter', hover && 'emblem-hover', className)}>
      <img src={small ? emblemSmallBaseUrl : emblemBaseUrl} alt={alt} width={px} height={px} draggable={false} data-brand={brand} className="block size-full" />
      <img src={small ? emblemSmallGlowUrl : emblemGlowUrl} alt="" width={px} height={px} draggable={false} data-brand-glow={brand} className="emblem-glow absolute inset-0 block size-full" />
    </span>
  )
}

/**
 * Identidade do JK Optimize: emblema oficial (scripts/gerar-logo.ps1, a partir da imagem original, que não é alterada)
 * com o nome em texto nas cores da marca (azul elétrico e prata).
 * - lg: emblema grande sobre o nome, para telas de entrada, carregamento e aplicação;
 * - md: emblema pequeno ao lado do nome, para o menu lateral.
 * O emblema tem transparência real, então se funde a qualquer fundo escuro.
 */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const nome = (grande: boolean) => (
    <span className={grande ? 'text-[30px] leading-none font-black tracking-tight' : 'text-[16px] font-bold tracking-tight'} aria-label="JK Optimize">
      <span className="bg-gradient-to-b from-accent-hi to-performance bg-clip-text text-transparent">JK</span>{' '}
      <span className="bg-gradient-to-b from-silver-hi to-silver bg-clip-text text-transparent">Optimize</span>
    </span>
  )
  if (size === 'lg') {
    return (
      <div className="flex flex-col items-center gap-3">
        <Emblem brand="emblem" enter className="size-36" />
        {nome(true)}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5">
      <Emblem small brand="mark" className="size-10" />
      {nome(false)}
    </div>
  )
}

export const BrandMark = Wordmark

// Ícones dos aplicativos do catálogo: arquivos locais em assets/apps/<id>.svg|png|webp (quando existirem); sem arquivo,
// um monograma consistente com o nome (nunca um ícone de outra marca).
const APP_ICONS = import.meta.glob('../assets/apps/*.{svg,png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const iconFor = (id: string) => Object.entries(APP_ICONS).find(([path]) => path.replace(/^.*\//, '').replace(/\.[a-z]+$/, '') === id)?.[1]

export function AppIcon({ id, name }: { id: string; name: string }) {
  const src = iconFor(id)
  const initials = name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return src ? (
    <img src={src} alt={`Ícone do ${name}`} width={36} height={36} draggable={false} data-app-icon={id} data-icon-kind="official" className="size-9 shrink-0 rounded-control object-contain" />
  ) : (
    <span role="img" aria-label={`Ícone do ${name}`} data-app-icon={id} data-icon-kind="fallback" className="grid size-9 shrink-0 place-items-center rounded-control border border-line-strong bg-surface-2 text-[12px] font-semibold text-accent-hi">
      {initials}
    </span>
  )
}
