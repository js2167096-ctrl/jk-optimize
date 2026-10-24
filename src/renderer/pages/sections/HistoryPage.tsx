// Histórico e Restauração: alterações registradas, reversão individual com conferência do estado atual e reversão global confirmada.
import { useState } from 'react'
import { History, Undo2 } from 'lucide-react'
import type { ChangeRecord } from '@shared/types/ops'
import { Badge, Button, Card, Notice, PageHeader } from '../../components/ui'
import { DataTable, QueryView, RefreshButton } from '../../components/kit'
import { useAsync } from '../../hooks/useAsync'
import { ops } from '../../services/ops'
import { errorMessage } from '../../services/api'

const STATUS: Record<string, { tone: 'ok' | 'neutral' | 'error'; label: string }> = { applied: { tone: 'ok', label: 'Aplicada' }, reverted: { tone: 'neutral', label: 'Revertida' }, 'revert-failed': { tone: 'error', label: 'Falha ao reverter' } }

interface Outcome { id: string; title: string; ok: boolean; message: string }

export function HistoryPage() {
  const list = useAsync(() => ops.changes(), [])
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [results, setResults] = useState<Outcome[] | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = [...(list.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const revertible = rows.filter((c) => c.reversible && c.status === 'applied')
  const irreversible = rows.filter((c) => !c.reversible).length

  const revertOne = async (c: ChangeRecord, force = false) => {
    try {
      await ops.revert(c.id, force)
      setMsg({ tone: 'info', text: `“${c.title}” restaurada e conferida.` })
    } catch (e) {
      const text = errorMessage(e)
      setMsg({ tone: 'error', text: `${text}${/mudou|state/i.test(text) ? ' Se quiser restaurar mesmo assim, use “Forçar”.' : ''}` })
    }
    list.reload()
  }

  const revertAll = async () => {
    setBusy(true)
    const out: Outcome[] = []
    for (const c of revertible) {
      try {
        await ops.revert(c.id, false)
        out.push({ id: c.id, title: c.title, ok: true, message: 'Restaurada e conferida.' })
      } catch (e) {
        out.push({ id: c.id, title: c.title, ok: false, message: errorMessage(e) })
      }
    }
    setResults(out)
    setConfirmAll(false)
    setBusy(false)
    list.reload()
  }

  return (
    <>
      <PageHeader icon={History} accent="neutral" title="Histórico e Restauração" description="Tudo o que o JK Optimize alterou: data, estado anterior e posterior, resultado conferido e disponibilidade de reversão. Antes de restaurar, o estado atual é consultado para não sobrescrever mudanças posteriores." action={<RefreshButton onClick={list.reload} loading={list.loading} />} />
      {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      <Card title="Desfazer ajustes reversíveis em conjunto" icon={Undo2} accent="alert" className="mb-4" action={<Button variant="danger" disabled={revertible.length === 0 || busy} onClick={() => setConfirmAll(true)} data-revert-all>Desfazer {revertible.length} alteração(ões)</Button>}>
        <p className="text-[12.5px] text-muted">Restaura os estados anteriores conhecidos das alterações reversíveis ainda aplicadas. {irreversible} operação(ões) irreversíveis (como arquivos apagados) ficam de fora e não podem ser recuperadas.</p>
        {confirmAll && (
          <div className="mt-3 rounded-control border border-alert/40 p-3 text-[12.5px]" data-revert-all-confirm>
            <p className="font-medium text-fg">Serão restauradas, da mais recente para a mais antiga:</p>
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-muted">{revertible.map((c) => <li key={c.id}>{new Date(c.createdAt).toLocaleString('pt-BR')} — {c.title}: {c.summaryAfter} → {c.summaryBefore}</li>)}</ul>
            <div className="mt-3 flex gap-2"><Button onClick={() => setConfirmAll(false)}>Cancelar</Button><Button variant="danger" loading={busy} onClick={() => void revertAll()} data-revert-all-go>Confirmar e restaurar</Button></div>
          </div>
        )}
        {results && (
          <div className="mt-3 text-[12.5px]" data-revert-all-result>
            <p className="font-medium text-fg">{results.filter((r) => r.ok).length} restaurada(s), {results.filter((r) => !r.ok).length} com falha.</p>
            <ul className="mt-1 space-y-0.5">{results.map((r) => <li key={r.id} className={r.ok ? 'text-muted' : 'text-alert'}>{r.title}: {r.message}</li>)}</ul>
          </div>
        )}
      </Card>
      <QueryView state={list} empty={(d) => d.length === 0}>
        {() => (
          <DataTable
            rows={rows}
            rowKey={(c) => c.id}
            search={(c) => `${c.title} ${c.actionId} ${c.summaryAfter}`}
            maxRows={200}
            columns={[
              { key: 'when', label: 'Quando', render: (c) => new Date(c.createdAt).toLocaleString('pt-BR'), sort: (c) => c.createdAt },
              { key: 'title', label: 'Operação', render: (c) => <span>{c.title}<span className="block text-[11px] text-subtle">{c.actionId}</span></span>, sort: (c) => c.title },
              { key: 'before', label: 'Antes → Depois', render: (c) => <span className="text-[12px]">{c.summaryBefore} → {c.summaryAfter}</span> },
              { key: 'st', label: 'Estado', render: (c) => <span title={c.revertError ?? ''}><Badge tone={STATUS[c.status]?.tone ?? 'neutral'}>{STATUS[c.status]?.label ?? c.status}</Badge></span> },
              {
                key: 'x',
                label: '',
                render: (c) =>
                  c.reversible && c.status !== 'reverted' ? (
                    <span className="flex gap-1"><Button variant="ghost" onClick={() => void revertOne(c)}>Reverter</Button>{c.status === 'revert-failed' && <Button variant="ghost" onClick={() => void revertOne(c, true)}>Forçar</Button>}</span>
                  ) : (
                    <span className="text-[11.5px] text-subtle">{c.reversible ? '—' : 'Irreversível'}</span>
                  )
              }
            ]}
          />
        )}
      </QueryView>
    </>
  )
}
