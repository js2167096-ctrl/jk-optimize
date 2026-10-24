import { useState } from 'react'
import { FileKey, KeyRound } from 'lucide-react'
import type { ActivationProblem } from '@shared/types'
import { ACTIVATION_PROBLEM_TEXT } from '@shared/constants/app'
import { GateLayout } from '../../layouts/GateLayout'
import { Button, Card, CopyButton, Notice, TextField, Wordmark } from '../../components/ui'
import { useApp } from '../../hooks/useApp'
import { api, call, errorMessage } from '../../services/api'

export function Activation({ problem }: { problem: ActivationProblem | null }) {
  const { info, setAccess } = useApp()
  const [mode, setMode] = useState<'key' | 'owner'>('key')
  const [key, setKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <GateLayout>
      <div className="mb-6 flex justify-center">
        <Wordmark size="lg" />
      </div>

      {mode === 'key' ? (
        <Card title="Ativar o JK Optimize" icon={KeyRound} accent="performance">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(async () => setAccess(await call(api.license.activate(key))))
            }}
          >
            {problem && (
              <Notice tone="warn" title="Ativação necessária">
                {ACTIVATION_PROBLEM_TEXT[problem]}
              </Notice>
            )}
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-muted">Chave de ativação</span>
              <textarea
                value={key}
                onChange={(e) => setKey(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder="JKO1.…"
                className="w-full resize-none rounded-control border border-line-strong bg-elevated px-3 py-2 font-mono text-[12px] break-all text-fg placeholder:text-subtle focus:border-performance/60 focus:outline-none"
              />
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!key.trim()}>
              Ativar
            </Button>
          </form>

          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[12px] text-muted">ID deste computador (para chaves vinculadas):</p>
            <div className="mt-2 flex items-center justify-between gap-3">
              <code className="selectable font-mono text-[12px] text-fg">{info.machineId ?? 'Indisponível'}</code>
              {info.machineId && <CopyButton text={info.machineId} />}
            </div>
          </div>
        </Card>
      ) : (
        <Card title="Entrar como proprietário" icon={FileKey} accent="alert">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(async () => setAccess(await call(api.owner.importKey(passphrase))))
            }}
          >
            <p className="text-[13px] text-muted">
              Informe a senha definida no <code className="font-mono text-fg">npm run owner:init</code> e selecione o arquivo{' '}
              <code className="font-mono text-fg">.jkokey</code>. Isso é feito uma única vez: depois, este computador abre o painel
              direto.
            </p>
            <TextField
              label="Senha da chave do proprietário"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" variant="primary" className="w-full" icon={FileKey} loading={busy} disabled={!passphrase}>
              Selecionar arquivo e entrar
            </Button>
          </form>
        </Card>
      )}

      <div className="mt-4 text-center">
        <button
          type="button"
          className="text-[12px] text-subtle hover:text-muted"
          onClick={() => {
            setError(null)
            setMode(mode === 'key' ? 'owner' : 'key')
          }}
        >
          {mode === 'key' ? 'Sou o proprietário' : 'Voltar para ativação por chave'}
        </button>
      </div>
    </GateLayout>
  )
}
