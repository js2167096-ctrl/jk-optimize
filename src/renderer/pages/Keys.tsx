import { useState } from 'react'
import { ArrowRight, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react'
import { formatDateTime } from '@shared/format'
import { useApp } from '../hooks/useApp'
import { api, call, errorMessage } from '../services/api'
import { Badge, Button, Card, CopyButton, InfoRow, Notice, PageHeader } from '../components/ui'
import { ConfirmDialog } from '../components/ConfirmDialog'

export function KeysPage() {
  const { access, info, setAccess, navigate } = useApp()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <PageHeader icon={KeyRound} accent="neutral" title="Chaves" description="Ativação deste computador e gerenciamento de chaves." />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Ativação deste computador" icon={ShieldCheck} accent="optimize">
          {access.kind === 'active' && (
            <>
              <InfoRow label="Estado" value={<Badge tone="ok">Ativado</Badge>} />
              <InfoRow label="ID da chave" value={access.license.id} mono />
              <InfoRow label="Emitida em" value={formatDateTime(access.license.issuedAt)} />
              <InfoRow label="Expira em" value={access.license.expiresAt ? formatDateTime(access.license.expiresAt) : 'Sem expiração'} />
              <InfoRow label="Vínculo" value={access.license.machineBound ? 'Este computador' : 'Qualquer computador'} />
              <div className="mt-4">
                <Button variant="danger" onClick={() => setConfirm(true)}>
                  Desativar neste computador
                </Button>
              </div>
            </>
          )}
          {access.kind === 'owner' && (
            <Notice tone="info" title="Sessão do proprietário">
              Este computador está liberado pela chave do proprietário e não precisa de chave de ativação.
            </Notice>
          )}
          {error && (
            <div className="mt-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
        </Card>

        <Card title="Identificação do computador" icon={Fingerprint}>
          <p className="text-[13px] text-muted">
            Envie este ID ao proprietário para receber uma chave vinculada a este computador. Ele é derivado do identificador do
            Windows com hash e não revela dados pessoais.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-control border border-line bg-elevated px-3 py-2">
            <code className="selectable font-mono text-[13px] text-fg">{info.machineId ?? 'Indisponível'}</code>
            {info.machineId && <CopyButton text={info.machineId} />}
          </div>
        </Card>
      </div>

      <Card className="mt-4" title="Gerenciamento de chaves" icon={KeyRound} accent="alert">
        {access.kind === 'owner' ? (
          <button type="button" onClick={() => navigate('admin')} className="flex items-center gap-1.5 text-[13px] text-alert hover:underline">
            Gerar e administrar chaves em Administração <ArrowRight className="size-3.5" />
          </button>
        ) : (
          <p className="text-[13px] text-muted">Disponível somente na sessão do proprietário.</p>
        )}
      </Card>

      <ConfirmDialog
        open={confirm}
        title="Desativar o JK Optimize?"
        confirmLabel="Desativar"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          call(api.license.deactivate())
            .then(setAccess)
            .catch((e) => setError(errorMessage(e)))
        }}
      >
        A chave será removida deste computador. Para voltar a usar o aplicativo será necessário informá-la novamente.
      </ConfirmDialog>
    </>
  )
}
