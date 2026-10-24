import { useState } from 'react'
import { Lock } from 'lucide-react'
import { GateLayout } from '../../layouts/GateLayout'
import { Button, Card, Notice, TextField, Wordmark } from '../../components/ui'
import { useApp } from '../../hooks/useApp'
import { api, call, errorMessage } from '../../services/api'

export function OwnerUnlock() {
  const { setAccess } = useApp()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <GateLayout>
      <div className="mb-6 flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card title="Desbloquear sessão do proprietário" icon={Lock} accent="alert">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            call(api.owner.unlock(passphrase))
              .then(setAccess)
              .catch((err) => setError(errorMessage(err)))
              .finally(() => setBusy(false))
          }}
        >
          <p className="text-[13px] text-muted">Informe a senha uma única vez. Depois disso, este computador abre o painel direto, sem pedir senha.</p>
          <TextField label="Senha" type="password" autoFocus autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!passphrase}>
            Desbloquear
          </Button>
        </form>
      </Card>
      <div className="mt-4 text-center">
        <button
          type="button"
          className="text-[12px] text-subtle hover:text-muted"
          onClick={() => void api.settings.clearLocalData()}
        >
          Remover dados locais deste computador
        </button>
      </div>
    </GateLayout>
  )
}
