// Perfis: perfis de Windows para jogos (plano de energia, Modo de Jogo etc.) e perfis personalizados de ajustes do catálogo.
import { useState } from 'react'
import { UserCog } from 'lucide-react'
import { Badge, Button, Card, Notice, PageHeader } from '../../components/ui'
import { QueryView } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'
import { query } from '../../services/ops'
import { errorMessage } from '../../services/api'

interface PlanItem { id: string; label: string; current: string | null; intended: string | null; blocked?: string | null; changes?: boolean }
interface Mine { favorites: string[]; profiles: { id: string; name: string; values: Record<string, string>; createdAt: string; divergent: { id: string; name: string; saved: string; current: string | null; unavailable: string | null }[] }[] }
interface Catalog { tweaks: { id: string; name: string; current: string; options: { value: string }[]; unavailable: string | null }[] }

const PROFILES: [string, string, string][] = [
  ['performance', 'Desempenho', 'Plano de maior desempenho disponível, Modo de Jogo ligado, gravação em segundo plano e transparência desligadas.'],
  ['balanced', 'Equilibrado', 'Plano Equilibrado com Modo de Jogo ligado.'],
  ['quality', 'Qualidade', 'Alto desempenho sem desativar efeitos visuais.']
]

export function ProfilesPage() {
  const run = useAction()
  const mine = useQuery<Mine>('tweaks.mine')
  const [plan, setPlan] = useState<{ id: string; items: PlanItem[] } | null>(null)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const showPlan = (id: string) => query<PlanItem[]>('profiles.windows.plan', { profile: id }).then((items) => setPlan({ id, items })).catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))
  const capture = async () => {
    try {
      const cat = await query<Catalog>('tweaks.catalog')
      const values = Object.fromEntries(cat.tweaks.filter((t) => !t.unavailable && t.options.some((o) => o.value === t.current)).map((t) => [t.id, t.current]))
      await query('tweaks.mine.saveProfile', { name, changes: values })
      setName('')
      setMsg({ tone: 'ok', text: `Perfil "${name}" salvo com ${Object.keys(values).length} ajustes do estado atual.` })
      mine.reload()
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    }
  }
  return (
    <>
      <PageHeader icon={UserCog} accent="optimize" title="Perfis" description="Perfis de Windows e perfis personalizados. Cada aplicação mostra o que muda, confere o resultado e pode ser desfeita no Histórico." />
      {msg && <div className="mb-3"><Notice tone={msg.tone === 'ok' ? 'info' : 'error'}>{msg.text}</Notice></div>}
      <div className="space-y-4">
        <Card title="Perfis de Windows para jogos" icon={UserCog} accent="performance">
          <div className="grid gap-3 md:grid-cols-3">
            {PROFILES.map(([id, label, desc]) => (
              <div key={id} className="rounded-control border border-line p-3" data-win-profile={id}>
                <p className="text-[13px] font-medium text-fg">{label}</p>
                <p className="mt-1 text-[12px] text-muted">{desc}</p>
                <div className="mt-2 flex gap-2">
                  <Button onClick={() => void showPlan(id)}>Ver plano</Button>
                  <Button variant="primary" onClick={() => void run('profiles.windows.apply', { profile: id })}>Aplicar</Button>
                </div>
              </div>
            ))}
          </div>
          {plan && (
            <div className="mt-3 rounded-control border border-line p-3 text-[12.5px]" data-profile-plan>
              <p className="mb-1 font-medium text-fg">Plano de “{PROFILES.find((p) => p[0] === plan.id)?.[1]}” neste computador</p>
              {plan.items.map((i) => <p key={i.id} className="text-muted">{i.label}: {i.current ?? '—'} → {i.intended ?? '—'} {i.blocked && <Badge tone="warn">{i.blocked}</Badge>}</p>)}
            </div>
          )}
        </Card>
        <Card title="Perfis personalizados" icon={UserCog} accent="optimize">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do perfil" aria-label="Nome do perfil" maxLength={40} className="no-drag h-9 w-64 rounded-control border border-line-strong bg-elevated px-2 text-[13px] text-fg" />
            <Button variant="primary" disabled={name.trim().length < 2} onClick={() => void capture()} data-profile-save>Salvar estado atual como perfil</Button>
          </div>
          <QueryView state={mine} empty={(d) => d.profiles.length === 0}>
            {(d) => (
              <div className="space-y-2">
                {d.profiles.map((p) => (
                  <div key={p.id} className="rounded-control border border-line p-3 text-[12.5px]" data-custom-profile={p.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-fg">{p.name} <span className="text-subtle">· {Object.keys(p.values).length} ajustes · {new Date(p.createdAt).toLocaleDateString('pt-BR')}</span></span>
                      <span className="flex gap-2">
                        <Button variant="primary" onClick={() => void run('tweaks.apply', { changes: p.values })}>Aplicar</Button>
                        <Button variant="ghost" onClick={() => void query('tweaks.mine.deleteProfile', { id: p.id }).then(mine.reload)}>Excluir</Button>
                      </span>
                    </div>
                    {p.divergent.length > 0 && <p className="mt-1 text-subtle">{p.divergent.length} ajuste(s) diferem do estado atual; indisponíveis neste PC são ignorados na aplicação.</p>}
                  </div>
                ))}
              </div>
            )}
          </QueryView>
        </Card>
      </div>
    </>
  )
}
