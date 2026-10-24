import { useState } from 'react'
import { Ban, Download, KeyRound, Plus } from 'lucide-react'
import type { IssuedKey } from '@shared/types'
import { formatDateTime } from '@shared/format'
import { MAX_KEY_LABEL_LENGTH } from '@shared/constants/app'
import { useAsync } from '../hooks/useAsync'
import { api, call, errorMessage } from '../services/api'
import { Badge, Button, Card, CopyButton, Notice, TextField } from './ui'
import { ConfirmDialog } from './ConfirmDialog'

const VALIDITY_OPTIONS = [
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: '365', label: '1 ano' },
  { value: 'none', label: 'Sem expiração' }
]

function keyStatus(key: IssuedKey): { tone: 'ok' | 'error' | 'warn'; label: string } {
  if (key.status === 'revoked') return { tone: 'error', label: 'Revogada' }
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return { tone: 'warn', label: 'Expirada' }
  return { tone: 'ok', label: 'Ativa' }
}

/** Emissão e gerenciamento de chaves. A autorização é verificada no processo principal. */
export function KeyManager() {
  const keys = useAsync(() => call(api.keys.list()))
  const [label, setLabel] = useState('')
  const [validity, setValidity] = useState('30')
  const [machineId, setMachineId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<IssuedKey | null>(null)
  const [toRevoke, setToRevoke] = useState<IssuedKey | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const key = await call(
        api.keys.generate({
          label,
          validDays: validity === 'none' ? null : Number(validity),
          machineId: machineId.trim() || null
        })
      )
      setCreated(key)
      setLabel('')
      setMachineId('')
      keys.reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Gerar nova chave" icon={Plus} accent="optimize">
        <form
          className="grid gap-4 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            void generate()
          }}
        >
          <TextField label="Descrição" placeholder="Ex.: Cliente João" maxLength={MAX_KEY_LABEL_LENGTH} value={label} onChange={(e) => setLabel(e.target.value)} />
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-muted">Validade</span>
            <select
              value={validity}
              onChange={(e) => setValidity(e.target.value)}
              className="h-9 w-full rounded-control border border-line-strong bg-elevated px-3 text-[13px] text-fg"
            >
              {VALIDITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="ID do computador (opcional)"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            value={machineId}
            onChange={(e) => setMachineId(e.target.value)}
            hint="Vincula a chave a um único computador."
          />
          <div className="md:col-span-3">
            <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!label.trim()}>
              Gerar chave
            </Button>
          </div>
        </form>
        {error && (
          <div className="mt-4">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {created && (
          <div className="mt-4 space-y-2 rounded-control border border-optimize/30 bg-optimize/5 p-4">
            <p className="text-[13px] font-medium text-fg">Chave gerada para "{created.label}"</p>
            <code className="selectable block rounded-control border border-line bg-elevated p-3 font-mono text-[11px] break-all text-fg">{created.token}</code>
            <CopyButton text={created.token} label="Copiar chave" />
          </div>
        )}
      </Card>

      <Card
        title="Chaves emitidas"
        icon={KeyRound}
        action={
          <Button
            variant="ghost"
            icon={Download}
            onClick={() => {
              setExportMsg(null)
              call(api.keys.exportRevocations())
                .then((r) => r.path && setExportMsg(`Lista com ${r.count} chave(s) revogada(s) salva em ${r.path}.`))
                .catch((e) => setExportMsg(errorMessage(e)))
            }}
          >
            Exportar revogações
          </Button>
        }
      >
        {exportMsg && (
          <div className="mb-4">
            <Notice tone="info">
              {exportMsg} A lista é assinada com a sua chave. Publique-a no endereço HTTPS da autoridade de licenças (veja "Licenciamento") para que os outros computadores bloqueiem a chave na próxima verificação.
            </Notice>
          </div>
        )}
        {keys.error && <Notice tone="error">{keys.error}</Notice>}
        {keys.data?.length === 0 && <p className="text-[13px] text-subtle">Nenhuma chave emitida ainda.</p>}
        {keys.data && keys.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-subtle">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">Descrição</th>
                  <th className="py-2 pr-3 font-medium">ID</th>
                  <th className="py-2 pr-3 font-medium">Criada</th>
                  <th className="py-2 pr-3 font-medium">Expira</th>
                  <th className="py-2 pr-3 font-medium">Vínculo</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {keys.data.map((key) => {
                  const status = keyStatus(key)
                  return (
                    <tr key={key.id} className="border-b border-line last:border-0">
                      <td className="py-2.5 pr-3 text-fg">{key.label}</td>
                      <td className="selectable py-2.5 pr-3 font-mono text-[11px] text-muted">{key.id}</td>
                      <td className="py-2.5 pr-3 text-muted">{formatDateTime(key.createdAt)}</td>
                      <td className="py-2.5 pr-3 text-muted">{key.expiresAt ? formatDateTime(key.expiresAt) : 'Nunca'}</td>
                      <td className="py-2.5 pr-3 text-muted">{key.machineId ? 'Computador' : 'Livre'}</td>
                      <td className="py-2.5 pr-3">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        <CopyButton text={key.token} />{' '}
                        {key.status !== 'revoked' && (
                          <Button variant="danger" icon={Ban} onClick={() => setToRevoke(key)}>
                            Revogar
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={toRevoke !== null}
        title="Revogar chave?"
        confirmLabel="Revogar"
        danger
        onCancel={() => setToRevoke(null)}
        onConfirm={() => {
          const key = toRevoke
          setToRevoke(null)
          if (key) void call(api.keys.revoke(key.id)).then(keys.reload, (e) => setError(errorMessage(e)))
        }}
      >
        A chave "{toRevoke?.label}" deixa de valer neste computador imediatamente. Em outros computadores, a revogação vale após
        distribuir a lista de revogação em uma nova versão.
      </ConfirmDialog>
    </div>
  )
}
