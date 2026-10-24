import { useState } from 'react'
import { Cloud, Lock, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { useApp } from '../hooks/useApp'
import { api, call, errorMessage } from '../services/api'
import { Badge, Button, Card, InfoRow, Notice, PageHeader, SoonBadge } from '../components/ui'
import { KeyManager } from '../components/KeyManager'
import { useQuery } from '../hooks/useQuery'
import { query } from '../services/ops'
import { formatDateTime } from '@shared/format'

interface AuthorityStatus {
  url: string | null
  configured: boolean
  lastSuccess: string | null
  lastAttempt: string | null
  lastError: string | null
  revokedCount: number
  graceDays: number
}

const OUTCOME: Record<string, string> = {
  accepted: 'Lista de revogação verificada e atualizada.',
  invalid: 'A lista publicada tem assinatura ou formato inválido e foi ignorada.',
  rollback: 'A lista publicada é mais antiga que a já aceita e foi ignorada.',
  unreachable: 'Sem conexão com a autoridade. Nada foi bloqueado.',
  unconfigured: 'Autoridade não configurada.'
}

function LicensingCard() {
  const status = useQuery<AuthorityStatus>('license.authority.status')
  const [checking, setChecking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const s = status.data
  return (
    <Card title="Licenciamento" icon={Cloud} accent="performance">
      <InfoRow label="Verificação local" value="Offline, por assinatura Ed25519" />
      <InfoRow label="Autoridade de revogação" value={s?.configured ? <Badge tone="ok">Configurada</Badge> : <Badge>Não configurada</Badge>} />
      {s?.configured && (
        <>
          <InfoRow label="Última verificação válida" value={s.lastSuccess ? formatDateTime(s.lastSuccess) : 'nunca'} />
          <InfoRow label="Chaves revogadas na lista" value={s.revokedCount} />
          {s.lastError && <InfoRow label="Última falha de rede" value={s.lastError} />}
        </>
      )}
      <p className="mt-3 text-[12px] text-subtle">
        {s?.configured
          ? `O app consulta a lista assinada ao abrir e a cada 10 min. Falha de rede não bloqueia ninguém; sem verificação por ${s.graceDays} dias, a ativação passa a exigir conexão.`
          : 'Sem autoridade, revogações só chegam aos outros computadores em novas versões. Configure com "npm run owner:autoridade -- <url https>" e publique a lista exportada em "Chaves emitidas".'}
      </p>
      {s?.configured && (
        <Button
          className="mt-3"
          variant="ghost"
          loading={checking}
          onClick={() => {
            setChecking(true)
            query<{ outcome: string }>('license.authority.check')
              .then((r) => setMsg(OUTCOME[r.outcome] ?? r.outcome))
              .catch((e) => setMsg(errorMessage(e)))
              .finally(() => {
                setChecking(false)
                status.reload()
              })
          }}
        >
          Verificar agora
        </Button>
      )}
      {msg && <p className="mt-2 text-[12px] text-muted">{msg}</p>}
    </Card>
  )
}

export function AdminPage() {
  const { access, setAccess } = useApp()
  const [error, setError] = useState<string | null>(null)

  if (access.kind !== 'owner') {
    return <Notice tone="error" title="Acesso restrito">Esta seção é exclusiva do proprietário.</Notice>
  }

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        accent="alert"
        title="Administração"
        description="Área restrita ao proprietário. Cada operação é autorizada no processo principal."
        action={
          <Button
            icon={Lock}
            onClick={() =>
              call(api.owner.lock())
                .then(setAccess)
                .catch((e) => setError(errorMessage(e)))
            }
          >
            Bloquear sessão
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card title="Sessão" icon={ShieldCheck} accent="alert">
          <InfoRow label="Estado" value={<Badge tone="warn">Desbloqueada</Badge>} />
          <InfoRow label="Prova de identidade" value="Chave privada Ed25519 + senha" />
          <InfoRow label="Chave em disco" value="Cifrada (scrypt + AES-256-GCM)" />
          <InfoRow label="Neste computador" value="Abre direto (protegido pelo Windows)" />
          <p className="mt-3 text-[12px] text-subtle">"Bloquear sessão" faz o app voltar a pedir a senha na próxima abertura.</p>
        </Card>
        <LicensingCard />
        <Card title="Configurações avançadas" icon={SlidersHorizontal} accent="advanced" action={<SoonBadge />}>
          <p className="text-[13px] text-muted">Espaço reservado para políticas do executor, distribuição de atualizações e validação remota.</p>
        </Card>
      </div>

      <KeyManager />
    </>
  )
}
