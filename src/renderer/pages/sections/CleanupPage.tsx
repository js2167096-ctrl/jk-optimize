// Limpeza: análise antes de apagar, categorias separadas, confirmação e espaço liberado medido pela unidade.
import { useState } from 'react'
import { Eraser, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Button, Card, Notice, PageHeader } from '../../components/ui'
import { QueryView, RefreshButton, Tabs } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useQuery } from '../../hooks/useQuery'
import { WindowsCleanup, WithBatch } from '../optimization/Windows2'

type Tab = 'windows' | 'shaders' | 'recycle'

interface Shader { id: string; label: string; vendor: string; confirmed: boolean; files: number; bytes: number; partial: boolean }

export function CleanupPage() {
  const [tab, setTab] = useState<Tab>('windows')
  return (
    <>
      <PageHeader icon={Eraser} accent="optimize" title="Limpeza" description="Advanced Windows Cleanup: analisa, estima o espaço, pede confirmação e mede o que foi realmente liberado. Arquivos apagados não vão para a Lixeira e não podem ser restaurados." />
      <Tabs value={tab} onChange={setTab} accent="optimize" tabs={[{ id: 'windows', label: 'Windows (temporários, logs, caches)' }, { id: 'shaders', label: 'Caches de shaders' }, { id: 'recycle', label: 'Lixeira' }]} />
      <div data-cleanup-tab={tab}>
        {tab === 'windows' && <WithBatch>{(batch) => <WindowsCleanup batch={batch} />}</WithBatch>}
        {tab === 'shaders' && <Shaders />}
        {tab === 'recycle' && <Recycle />}
      </div>
    </>
  )
}

function Shaders() {
  const list = useQuery<Shader[]>('cleanup.shaders.scan')
  const run = useAction()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  return (
    <Card title="Caches de shaders da GPU instalada" icon={Eraser} accent="optimize" action={<div className="flex gap-2"><RefreshButton onClick={list.reload} loading={list.loading} /><Button variant="primary" disabled={picked.size === 0} onClick={() => void run('cleanup.shaders.clean', { ids: [...picked] }).then(() => { setPicked(new Set()); list.reload() })} data-shader-clean>Limpar selecionados ({picked.size})</Button></div>}>
      <QueryView state={list} loadingLabel="Analisando caches (somente leitura)…" empty={(d) => d.length === 0}>
        {(rows) => (
          <div className="space-y-2">
            {rows.map((s) => (
              <label key={s.id} className="flex items-center justify-between gap-3 rounded-control border border-line p-3 text-[13px]">
                <span className="flex items-center gap-2 text-fg">
                  <input type="checkbox" className="size-4" disabled={!s.confirmed} checked={picked.has(s.id)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n })} />
                  {s.label}
                </span>
                <span className="flex items-center gap-2 text-muted">{s.files.toLocaleString('pt-BR')} arquivos · {formatBytes(s.bytes)}{s.partial ? '+' : ''}{!s.confirmed && <Badge tone="neutral">GPU {s.vendor} não detectada</Badge>}</span>
              </label>
            ))}
            <p className="text-[12px] text-subtle">Os jogos e drivers recriam esses caches; o primeiro carregamento depois da limpeza pode ser mais lento.</p>
          </div>
        )}
      </QueryView>
    </Card>
  )
}

function Recycle() {
  const st = useQuery<{ items: number; bytes: number }>('cleanup.recycle.scan')
  const run = useAction()
  return (
    <Card title="Lixeira" icon={Trash2} accent="alert" action={<Button variant="danger" disabled={!st.data || st.data.items === 0} onClick={() => void run('cleanup.recycle.empty', {}).then(st.reload)} data-recycle-empty>Esvaziar Lixeira</Button>}>
      <QueryView state={st}>{(s) => <p className="text-[13px] text-muted" data-recycle-state>{s.items.toLocaleString('pt-BR')} itens · {formatBytes(s.bytes)}</p>}</QueryView>
      <Notice tone="warn" title="Operação separada e irreversível">Esvaziar a Lixeira apaga em definitivo; por isso nunca é feito junto com outras limpezas.</Notice>
    </Card>
  )
}
