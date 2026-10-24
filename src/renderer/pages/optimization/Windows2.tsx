// Otimização 2: ajustes avançados do Windows com estado real, confirmação, lote com tela de progresso,
// limpeza ampliada, plano de energia, scripts importantes, Booster Robusta e estado de segurança (somente consulta).
import { useMemo, useState, type ReactNode } from 'react'
import { Eraser, Power, ShieldCheck, Zap } from 'lucide-react'
import { WIN2_BOOSTER, WIN2_SCRIPTS, WIN2_SECTIONS, WIN2_TWEAKS, type Win2Script, type Win2Section } from '@shared/constants/windows2'
import { formatBytes } from '@shared/format'
import { useAction } from '../../components/ActionRunner'
import { OperationProgress, useBatch } from '../../components/OperationProgress'
import { Badge, Button, Card, cx, Notice, Spinner } from '../../components/ui'
import { QueryView, Tabs } from '../../components/kit'
import { useQuery } from '../../hooks/useQuery'
import { ops } from '../../services/ops'
import { CategoryHead, FunctionRow, StateBadge, useCatalog, type TweakState } from './parts'

const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e'
const HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

export function Windows2() {
  const [section, setSection] = useState<Win2Section>('basic')
  const batch = useBatch()
  return (
    <>
      <CategoryHead description="Ajustes avançados do Windows com estado lido do sistema, confirmação com os efeitos, conferência depois da gravação e reversão quando tecnicamente possível. Nada é promessa de ganho de desempenho: o que muda é informado e o resultado é conferido." />
      <div className="mb-4">
        <Tabs tabs={WIN2_SECTIONS.map((s) => ({ id: s.id, label: s.label }))} value={section} onChange={setSection} />
      </div>
      <div data-win2-section={section}>
        {section === 'basic' && <TweakSection ids={WIN2_TWEAKS.basic} batch={batch} />}
        {section === 'power' && <PowerPlans />}
        {section === 'cleanup' && <WindowsCleanup batch={batch} />}
        {section === 'disable' && <TweakSection ids={WIN2_TWEAKS.disable} batch={batch} />}
        {section === 'scripts' && <Scripts batch={batch} />}
        {section === 'booster' && <Booster batch={batch} />}
        {section === 'security' && <SecurityStatus />}
      </div>
      {batch.state && <OperationProgress state={batch.state} onClose={batch.close} />}
    </>
  )
}

type Batch = ReturnType<typeof useBatch>

/** Lista de ajustes do catálogo real com seleção em lote e tela de progresso própria. */
export function TweakPanel({ ids }: { ids: string[] }) {
  const batch = useBatch()
  return (
    <>
      <TweakSection ids={ids} batch={batch} />
      {batch.state && <OperationProgress state={batch.state} onClose={batch.close} />}
    </>
  )
}

/** Componentes de lote com tela de progresso própria (para páginas que não usam Windows2). */
export function WithBatch({ children }: { children: (batch: Batch) => ReactNode }) {
  const batch = useBatch()
  return (
    <>
      {children(batch)}
      {batch.state && <OperationProgress state={batch.state} onClose={batch.close} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Lista de ajustes com seleção em lote
// ---------------------------------------------------------------------------

/** Valor sugerido: o de "desativar" (off). Se o ajuste já está assim, a sugestão é o atual e nada é selecionado por engano. */
function suggested(t: TweakState): string {
  if (t.options.some((o) => o.value === 'off')) return 'off'
  return t.options.find((o) => o.value !== t.current)?.value ?? t.options[0]?.value ?? ''
}

export function TweakSection({ ids, batch }: { ids: string[]; batch: Batch }) {
  const catalog = useCatalog()
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const list = useMemo(() => (catalog.data ? ids.map((id) => catalog.data!.tweaks.find((t) => t.id === id)).filter((t): t is TweakState => !!t) : []), [catalog.data, ids])
  if (catalog.error) return <Notice tone="error" title="Não foi possível ler os ajustes">{catalog.error}</Notice>
  if (!catalog.data) return <Spinner label="Lendo o estado real do Windows…" />

  const valueOf = (t: TweakState) => picked[t.id] ?? suggested(t)
  const applicable = (t: TweakState) => !t.unavailable && !!valueOf(t) && valueOf(t) !== t.current
  const run = async (targets: TweakState[], title: string) => {
    const changes = Object.fromEntries(targets.map((t) => [t.id, valueOf(t)]))
    await batch.start({ title, actionId: 'tweaks.apply', params: { changes }, items: targets.map((t) => ({ id: t.id, name: t.name })) })
    setChecked(new Set())
    catalog.reload()
  }
  const selected = list.filter((t) => checked.has(t.id) && applicable(t))

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={selected.length === 0} onClick={() => void run(selected, 'Aplicando ajustes selecionados')} data-apply-selected>
          Aplicar selecionados ({selected.length})
        </Button>
        <Button onClick={() => setChecked(new Set(list.filter(applicable).map((t) => t.id)))}>Selecionar os aplicáveis</Button>
        <Button variant="ghost" onClick={() => setChecked(new Set())}>
          Limpar seleção
        </Button>
        <Button variant="ghost" onClick={catalog.reload} loading={catalog.loading}>
          Reler estado
        </Button>
      </div>
      {list.map((t) => (
        <FunctionRow
          key={t.id}
          name={
            <label className="flex items-center gap-2">
              <input type="checkbox" className="no-drag size-4 accent-[var(--jk-accent)]" disabled={!applicable(t)} checked={checked.has(t.id) && applicable(t)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(t.id) : n.delete(t.id); return n })} aria-label={`Selecionar ${t.name}`} data-pick={t.id} />
              {t.name}
            </label>
          }
          description={t.description}
          note={t.unavailable ?? t.note}
          badges={
            <>
              <Badge tone={t.unavailable ? 'error' : 'info'}>{t.unavailable ? 'Indisponível' : t.currentLabel}</Badge>
              {t.elevated && <Badge tone="warn">Administrador</Badge>}
              {t.needsRestart && <Badge tone="neutral">Pode exigir reinício</Badge>}
            </>
          }
        >
          <select
            aria-label={`Valor de ${t.name}`}
            disabled={!!t.unavailable}
            value={valueOf(t)}
            onChange={(e) => setPicked((p) => ({ ...p, [t.id]: e.target.value }))}
            className="no-drag h-9 rounded-control border border-line-strong bg-elevated px-2 text-[12.5px] text-fg disabled:opacity-40"
          >
            {t.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={!applicable(t)} onClick={() => void run([t], t.name)} data-apply={t.id}>
            Aplicar
          </Button>
        </FunctionRow>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plano de energia
// ---------------------------------------------------------------------------

interface PowerState {
  schemes: { guid: string; name: string; active: boolean; ultimate: boolean }[]
  active: { guid: string; name: string } | null
  hasBattery: boolean
}

const PLAN_EFFECTS: Record<string, string> = {
  balanced: 'Consumo e temperatura moderados: o processador acelera conforme a carga. É o plano recomendado pelo Windows para uso geral.',
  high: 'Mantém o processador mais disponível: tende a aumentar consumo e temperatura. O ganho de desempenho depende do jogo e do computador e não é garantido.',
  ultimate: 'Remove quase todas as economias de energia: maior consumo e calor, principalmente em notebooks. A proteção térmica do processador continua ativa.'
}

export function PowerPlans() {
  const plans = useQuery<PowerState>('power.plans')
  const run = useAction()
  const act = async (id: string, params: unknown) => {
    await run(id, params)
    plans.reload()
  }
  const restorePrevious = async () => {
    const list = await ops.changes()
    const last = list.filter((c) => c.actionId === 'power.plan.set' && c.status === 'applied' && c.reversible).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (!last) {
      await run('power.plan.set', { guid: BALANCED }, { message: 'Não há troca de plano registrada pelo JK Optimize. Ativar o plano Equilibrado?' })
    } else {
      try {
        await ops.revert(last.id, false)
      } catch {
        /* o Histórico mostra o motivo; a lista é recarregada abaixo */
      }
    }
    plans.reload()
  }
  return (
    <Card title="Plano de energia" icon={Power} accent="performance" action={<Button onClick={() => void restorePrevious()} data-restore-plan>Restaurar plano anterior</Button>}>
      <QueryView state={plans}>
        {(p) => {
          const bal = p.schemes.find((s) => s.guid === BALANCED)
          const high = p.schemes.find((s) => s.guid === HIGH)
          const ult = p.schemes.find((s) => s.ultimate)
          const row = (key: string, name: string, effect: string, s: PowerState['schemes'][number] | undefined, create?: boolean) => (
            <FunctionRow key={key} name={name} description={effect} badges={<StateBadge state={s ? (s.active ? 'Ativado' : 'Inativo') : 'Não existe neste computador'} />}>
              {s ? (
                <Button variant="primary" disabled={s.active} onClick={() => void act('power.plan.set', { guid: s.guid })}>
                  Aplicar
                </Button>
              ) : create ? (
                <Button onClick={() => void act('power.ultimate.enable', {})}>Criar e aplicar</Button>
              ) : null}
            </FunctionRow>
          )
          return (
            <div data-power-plans>
              <p className="mb-2 text-[13px] text-fg" data-power-active>
                Plano ativo: <strong>{p.active?.name ?? 'desconhecido'}</strong>
              </p>
              {row('bal', 'Equilibrado', PLAN_EFFECTS.balanced, bal)}
              {row('high', 'Alto desempenho', PLAN_EFFECTS.high, high)}
              {row('ult', 'Desempenho Máximo (Ultimate Performance)', PLAN_EFFECTS.ultimate, ult, true)}
              <p className="mt-3 text-[11.5px] text-subtle">Cada troca fica no Histórico; "Restaurar plano anterior" desfaz a última troca feita pelo JK Optimize. Efeitos em consumo e temperatura dependem do computador e não são medidos aqui.</p>
            </div>
          )
        }}
      </QueryView>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Limpeza Windows
// ---------------------------------------------------------------------------

interface ExtraScan {
  targets: { id: string; label: string; description: string; group: string; needsAdmin: boolean; effect: string; unavailable: string | null; files: number; bytes: number; partial: boolean }[]
  free: number | null
}

export function WindowsCleanup({ batch }: { batch: Batch }) {
  const scan = useQuery<ExtraScan>('cleanup.extra.scan', { targets: [] })
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const items = scan.data?.targets ?? []
  const chosen = items.filter((t) => checked.has(t.id) && !t.unavailable)
  const total = chosen.reduce((a, t) => a + t.bytes, 0)
  const clean = async (ids: string[], title: string) => {
    await batch.start({ title, actionId: 'cleanup.extra.clean', params: { targets: ids }, items: items.filter((t) => ids.includes(t.id)).map((t) => ({ id: t.id, name: t.label })) })
    scan.reload()
  }
  const groups = [...new Set(items.map((t) => t.group))]
  return (
    <div>
      <Card
        title="Limpeza consolidada"
        icon={Eraser}
        accent="optimize"
        action={
          <div className="flex gap-2">
            <Button onClick={() => setChecked(new Set(items.filter((t) => !t.unavailable && t.id !== 'prefetch').map((t) => t.id)))}>Selecionar seguros</Button>
            <Button variant="primary" disabled={chosen.length === 0} onClick={() => void clean(chosen.map((t) => t.id), 'Limpeza consolidada do Windows')} data-clean-selected>
              Executar limpeza ({chosen.length})
            </Button>
          </div>
        }
      >
        <QueryView state={scan} loadingLabel="Analisando as pastas (somente leitura)…">
          {() => (
            <div>
              {groups.map((g) => (
                <div key={g} className="mb-3">
                  <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-subtle uppercase">{g}</h4>
                  {items
                    .filter((t) => t.group === g)
                    .map((t) => (
                      <FunctionRow
                        key={t.id}
                        name={
                          <label className="flex items-center gap-2">
                            <input type="checkbox" className="no-drag size-4 accent-[var(--jk-accent)]" disabled={!!t.unavailable} checked={checked.has(t.id)} onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(t.id) : n.delete(t.id); return n })} aria-label={`Selecionar ${t.label}`} data-clean-pick={t.id} />
                            {t.label}
                          </label>
                        }
                        description={t.description}
                        note={t.unavailable ?? t.effect}
                        badges={
                          <>
                            <Badge tone={t.unavailable ? 'neutral' : 'info'}>{t.unavailable ? 'Indisponível' : `${t.files.toLocaleString('pt-BR')} arquivos · ${formatBytes(t.bytes)}${t.partial ? '+' : ''}`}</Badge>
                            {t.needsAdmin && <Badge tone="warn">Administrador</Badge>}
                          </>
                        }
                      />
                    ))}
                </div>
              ))}
              <p className="text-[12px] text-subtle">
                Selecionado: {formatBytes(total)}. {scan.data?.free != null && `Espaço livre atual: ${formatBytes(scan.data.free)}. `}O espaço realmente liberado é medido pelo espaço livre da unidade antes e depois. Arquivos apagados não vão para a Lixeira e não podem ser restaurados. O Prefetch não vem marcado de propósito.
              </p>
            </div>
          )}
        </QueryView>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scripts importantes
// ---------------------------------------------------------------------------

export function Scripts({ batch }: { batch: Batch }) {
  const catalog = useCatalog()
  const vols = useQuery<{ letter: string; op: string | null }[]>('disk.volumes')
  const names = useMemo(() => new Map((catalog.data?.tweaks ?? []).map((t) => [t.id, t.name])), [catalog.data])
  const state = (s: Win2Script) => {
    if (s.step.kind !== 'tweaks' || !catalog.data) return null
    const t = catalog.data.tweaks
    const parts = Object.entries(s.step.changes).map(([id, v]) => t.find((x) => x.id === id) && { id, v, tw: t.find((x) => x.id === id)! })
    const known = parts.filter((p): p is NonNullable<typeof p> => !!p)
    const usable = known.filter((p) => !p.tw.unavailable)
    if (usable.length === 0) return { label: 'Indisponível neste computador', tone: 'error' as const }
    return usable.every((p) => p.tw.current === p.v) ? { label: 'Já aplicado', tone: 'ok' as const } : { label: 'Pendente', tone: 'info' as const }
  }
  const go = async (s: Win2Script) => {
    if (s.step.kind === 'tweaks') {
      const ids = Object.keys(s.step.changes)
      await batch.start({ title: s.name, actionId: 'tweaks.apply', params: { changes: s.step.changes }, items: ids.map((id) => ({ id, name: names.get(id) ?? id })) })
      catalog.reload()
    } else if (s.step.kind === 'disk') {
      const all = (vols.data ?? []).filter((v) => v.op).map((v) => v.letter)
      const drives = s.step.drives === 'C' ? ['C'] : all
      await batch.start({ title: s.name, actionId: 'disk.optimize', params: { drives }, items: drives.map((d) => ({ id: d, name: `Unidade ${d}:` })) })
    } else {
      await batch.start({ title: s.name, actionId: s.step.actionId, params: s.step.params, items: [{ id: s.id, name: s.name }] })
    }
  }
  return (
    <div>
      <Notice tone="info" title="O que cada script faz de verdade">
        Cada item abaixo executa a operação equivalente com mecanismos do Windows (registro, políticas, serviços, powercfg, fsutil, Optimize-Volume). Nomes ambíguos mostram a interpretação adotada.
      </Notice>
      <div className="mt-3">
        {WIN2_SCRIPTS.map((s) => {
          const st = state(s)
          return (
            <FunctionRow key={s.id} name={s.name} description={s.does} note={s.ambiguity} badges={st && <Badge tone={st.tone}>{st.label}</Badge>}>
              <Button variant="primary" disabled={st?.label === 'Já aplicado' || st?.tone === 'error'} onClick={() => void go(s)} data-script={s.id}>
                Executar
              </Button>
            </FunctionRow>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booster Robusta
// ---------------------------------------------------------------------------

export function Booster({ batch }: { batch: Batch }) {
  const catalog = useCatalog()
  const [off, setOff] = useState<Set<string>>(new Set())
  if (catalog.error) return <Notice tone="error" title="Não foi possível ler os ajustes">{catalog.error}</Notice>
  if (!catalog.data) return <Spinner label="Lendo o estado real do Windows…" />
  const rows = WIN2_BOOSTER.map((b) => ({ b, t: catalog.data!.tweaks.find((x) => x.id === b.id) })).filter((r): r is { b: (typeof WIN2_BOOSTER)[number]; t: TweakState } => !!r.t)
  const state = (t: TweakState, value: string) => (t.unavailable ? 'unavailable' : t.current === value ? 'done' : 'pending')
  const selected = rows.filter((r) => !off.has(r.b.id) && state(r.t, r.b.value) === 'pending')
  const apply = async () => {
    await batch.start({
      title: 'Booster Robusta',
      actionId: 'tweaks.apply',
      params: { changes: Object.fromEntries(selected.map((r) => [r.b.id, r.b.value])) },
      items: selected.map((r) => ({ id: r.b.id, name: r.t.name }))
    })
    catalog.reload()
  }
  return (
    <div>
      <Notice tone="info" title="Perfil de aplicação em lote">
        Escolha quais ajustes entram, veja a lista de mudanças na confirmação e consulte o resultado de cada um. Tudo é reversível pelo Histórico. Nenhum ganho de FPS é prometido: meça antes e depois.
      </Notice>
      <div className="my-3 flex gap-2">
        <Button variant="primary" icon={Zap} disabled={selected.length === 0} onClick={() => void apply()} data-booster-apply>
          Aplicar Booster ({selected.length})
        </Button>
        <Button variant="ghost" onClick={() => setOff(new Set())}>
          Remarcar todos
        </Button>
      </div>
      {rows.map(({ b, t }) => {
        const st = state(t, b.value)
        return (
          <FunctionRow
            key={b.id}
            name={
              <label className="flex items-center gap-2">
                <input type="checkbox" className="no-drag size-4 accent-[var(--jk-accent)]" disabled={st !== 'pending'} checked={st === 'pending' && !off.has(b.id)} onChange={(e) => setOff((s) => { const n = new Set(s); e.target.checked ? n.delete(b.id) : n.add(b.id); return n })} aria-label={`Incluir ${t.name}`} data-booster-pick={b.id} />
                {t.name}
              </label>
            }
            description={b.why}
            note={t.unavailable ?? undefined}
            badges={<Badge tone={st === 'done' ? 'ok' : st === 'unavailable' ? 'error' : 'info'}>{st === 'done' ? 'Já aplicado' : st === 'unavailable' ? 'Indisponível' : `${t.currentLabel} → ${t.options.find((o) => o.value === b.value)?.label ?? b.value}`}</Badge>}
          />
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Segurança (somente consulta)
// ---------------------------------------------------------------------------

interface SecurityStatusData {
  rows: { id: string; name: string; state: 'ativo' | 'parcial' | 'desativado' | 'desconhecido'; summary: string; details: string[] }[]
  readAt: string
}

export function SecurityStatus() {
  const status = useQuery<SecurityStatusData>('security.status')
  return (
    <Card title="Estado de segurança do Windows" icon={ShieldCheck} accent="optimize" action={<Button onClick={status.reload} loading={status.loading}>Reler</Button>}>
      <QueryView state={status} loadingLabel="Consultando o Windows…">
        {(d) => (
          <div data-security-status>
            {d.rows.map((r) => (
              <FunctionRow key={r.id} name={r.name} description={r.summary} badges={<Badge tone={r.state === 'ativo' ? 'ok' : r.state === 'desativado' ? 'error' : r.state === 'parcial' ? 'warn' : 'neutral'}>{r.state === 'ativo' ? 'Ativo' : r.state === 'desativado' ? 'Desativado' : r.state === 'parcial' ? 'Parcial' : 'Desconhecido'}</Badge>}>
                <details className="text-[12px] text-subtle">
                  <summary className="cursor-pointer">Detalhes</summary>
                  <ul className={cx('selectable mt-1 space-y-0.5')}>
                    {r.details.map((x) => (
                      <li key={x}>• {x}</li>
                    ))}
                  </ul>
                </details>
              </FunctionRow>
            ))}
            <p className="mt-3 text-[12px] text-subtle">
              Somente consulta: o JK Optimize não desativa o Defender, o firewall, o SmartScreen nem o UAC. Se uma proteção estiver desligada ou definida por política da organização, o estado real é mostrado aqui sem alteração.
            </p>
          </div>
        )}
      </QueryView>
    </Card>
  )
}
