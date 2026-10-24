import { useState, type ReactNode } from 'react'
import { THEMES } from '@shared/constants/themes'
import { Gauge, Info, MonitorCog, Power, Settings, Trash2 } from 'lucide-react'
import type { Settings as SettingsType } from '@shared/types'
import { useApp } from '../hooks/useApp'
import { api, call, errorMessage } from '../services/api'
import { Button, Card, InfoRow, Notice, PageHeader, Toggle } from '../components/ui'
import { UpdaterCard } from '../components/UpdaterCard'
import { SettingsExtras } from './sections/SettingsExtras'

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-0">
      <div>
        <p className="text-[13px] text-fg">{title}</p>
        <p className="mt-0.5 text-[12px] text-subtle">{description}</p>
      </div>
      {children}
    </div>
  )
}

export function SettingsPage() {
  const { settings, setSettings, info } = useApp()
  const [error, setError] = useState<string | null>(null)

  const update = (patch: Partial<SettingsType>) => {
    setError(null)
    call(api.settings.update(patch))
      .then(setSettings)
      .catch((e) => setError(errorMessage(e)))
  }

  return (
    <>
      <PageHeader icon={Settings} accent="neutral" title="Configurações" description="Preferências locais do JK Optimize." />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Inicialização" icon={Power} accent="performance">
          <SettingRow
            title="Iniciar com o Windows"
            description={info.isPackaged ? 'Abre o JK Optimize ao entrar no Windows.' : 'Salvo agora; aplicado apenas na versão instalada.'}
          >
            <Toggle label="Iniciar com o Windows" checked={settings.launchAtStartup} onChange={(v) => update({ launchAtStartup: v })} />
          </SettingRow>
        </Card>

        <Card title="Interface" icon={MonitorCog} accent="advanced">
          <SettingRow title="Reduzir animações" description="Desativa transições e animações da interface.">
            <Toggle label="Reduzir animações" checked={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
          </SettingRow>
          <SettingRow title="Cor do painel" description="Sete temas escuros. A troca é imediata (inclusive o brilho da logo) e fica salva.">
            <div className="flex items-center gap-3">
              <span className="size-4 rounded-full border border-line-strong" style={{ background: 'var(--jk-accent)' }} aria-hidden />
              <select
                aria-label="Tema"
                data-setting="theme"
                value={settings.theme}
                onChange={(e) => update({ theme: e.target.value as SettingsType['theme'] })}
                className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-[13px] text-fg"
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </SettingRow>
          <SettingRow title="Atualização das métricas" description="Intervalo de leitura de CPU e memória no Dashboard.">
            <select
              value={settings.metricsIntervalSeconds}
              onChange={(e) => update({ metricsIntervalSeconds: Number(e.target.value) as SettingsType['metricsIntervalSeconds'] })}
              className="h-8 rounded-control border border-line-strong bg-elevated px-2 text-[13px] text-fg"
            >
              <option value={1}>1 segundo</option>
              <option value={2}>2 segundos</option>
              <option value={5}>5 segundos</option>
            </select>
          </SettingRow>
        </Card>

        <Card title="Desempenho" icon={Gauge} accent="optimize">
          <p className="text-[13px] text-muted">
            O intervalo das métricas acima também define a frequência do monitor de desempenho. Overlay, alertas e histórico de monitoramento ficam mais abaixo nesta página.
          </p>
        </Card>

        <Card title="Sobre" icon={Info}>
          <InfoRow label="Aplicativo" value="JK Optimize" />
          <InfoRow label="Versão" value={info.appVersion} mono />
          <InfoRow label="Modo" value={info.isPackaged ? 'Instalado' : 'Desenvolvimento'} />
        </Card>
      </div>

      <div className="mt-4">
        <UpdaterCard />
      </div>

      <SettingsExtras />

      <Card className="mt-4" title="Dados locais" icon={Trash2} accent="alert">
        <SettingRow
          title="Limpar dados locais"
          description="Remove ativação, configurações, histórico e chaves deste computador. Uma confirmação será exibida."
        >
          <Button
            variant="danger"
            icon={Trash2}
            onClick={() => {
              setError(null)
              call(api.settings.clearLocalData()).catch((e) => {
                if ((e as { code?: string }).code !== 'cancelled') setError(errorMessage(e))
              })
            }}
          >
            Limpar dados
          </Button>
        </SettingRow>
      </Card>
    </>
  )
}
