import { useState } from 'react'
import { CloudDownload, FolderOpen, Search } from 'lucide-react'
import { formatDateTime } from '@shared/format'
import { useQuery } from '../hooks/useQuery'
import { query } from '../services/ops'
import { errorMessage } from '../services/api'
import { useAction } from './ActionRunner'
import { Button, Card, InfoRow, Notice, TextField } from './ui'
import { Mono, QueryView } from './kit'

interface Status {
  current: string
  packaged: boolean
  source: { type: 'url' | 'folder'; value: string } | null
  lastCheck: { at: string; result: string } | null
}

export function UpdaterCard() {
  const status = useQuery<Status>('updater.status')
  const runAction = useAction()
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null)
  const [checking, setChecking] = useState(false)

  const setSource = (params: unknown) =>
    query('updater.source.set', params)
      .then(() => {
        setMsg(null)
        status.reload()
      })
      .catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))

  return (
    <Card title="Atualizações" icon={CloudDownload} accent="performance">
      <QueryView state={status}>
        {(s) => (
          <div className="space-y-3">
            <InfoRow label="Versão instalada" value={<Mono>{s.current}</Mono>} />
            <InfoRow label="Fonte configurada" value={s.source ? <Mono>{s.source.value}</Mono> : 'Nenhuma'} />
            {s.lastCheck && <InfoRow label="Última verificação" value={`${formatDateTime(s.lastCheck.at)} — ${s.lastCheck.result}`} />}
            <p className="text-[12px] text-subtle">
              O app só instala uma atualização se o manifesto estiver assinado pela chave do proprietário e o instalador tiver o tamanho e o SHA-512 informados. Não há servidor padrão:
              configure uma URL HTTPS do arquivo jk-update.json ou uma pasta local/de rede.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-64 flex-1">
                <TextField label="URL do manifesto (HTTPS)" placeholder="https://…/jk-update.json" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
              </div>
              <Button disabled={!url} onClick={() => void setSource({ type: 'url', url })}>
                Usar URL
              </Button>
              <Button icon={FolderOpen} onClick={() => void setSource({ type: 'folder' })}>
                Usar pasta
              </Button>
              {s.source && (
                <Button variant="ghost" onClick={() => void setSource({ type: 'none' })}>
                  Remover fonte
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                icon={Search}
                loading={checking}
                disabled={!s.source}
                onClick={() => {
                  setChecking(true)
                  query<{ available: boolean; result: string }>('updater.check')
                    .then((r) => setMsg({ tone: r.available ? 'ok' : 'info', text: r.result }))
                    .catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))
                    .finally(() => {
                      setChecking(false)
                      status.reload()
                    })
                }}
              >
                Verificar agora
              </Button>
              <Button variant="primary" disabled={!s.source} onClick={() => void runAction('updater.install', {})}>
                Instalar atualização
              </Button>
            </div>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          </div>
        )}
      </QueryView>
    </Card>
  )
}
