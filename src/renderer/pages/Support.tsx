// Suporte: versão real, estado do aplicativo, onde encontrar o registro de operações, e redes.
import { LifeBuoy, ScrollText } from 'lucide-react'
import { useApp } from '../hooks/useApp'
import { Card, InfoRow, PageHeader, StatusDot } from '../components/ui'
import { IdentityPanel, SocialPanel } from '../components/brand'

export function SupportPage() {
  const { info, executor, access, navigate } = useApp()
  const links = [
    { label: 'Registro de operações', description: 'Logs do executor e das ações (sem senhas ou chaves).', icon: ScrollText, onClick: () => navigate('executor') }
  ]
  return (
    <>
      <PageHeader icon={LifeBuoy} accent="performance" title="Suporte" description="Informações para diagnóstico e canais oficiais do JK Optimize." />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(270px,30%)]">
        <div className="space-y-5">
          <Card title="Este aplicativo">
            <InfoRow label="Versão" value={info.appVersion} />
            <InfoRow label="Instalação" value={info.isPackaged ? 'Versão instalada' : 'Desenvolvimento'} />
            <InfoRow label="Acesso" value={access.kind === 'owner' ? 'Sessão do proprietário' : access.kind === 'active' ? 'Ativado' : access.kind} />
            <InfoRow
              label="Executor"
              value={
                <span className="flex items-center gap-2">
                  <StatusDot tone={executor.state === 'ready' ? 'ok' : executor.state === 'starting' ? 'info' : 'error'} />
                  {executor.state === 'ready' ? 'Ativo' : executor.state === 'starting' ? 'Iniciando' : 'Indisponível'}
                </span>
              }
            />
          </Card>
          <Card title="Antes de pedir ajuda">
            <div className="grid gap-3 md:grid-cols-3">
              {links.map(({ label, description, icon: Icon, onClick }) => (
                <button key={label} type="button" onClick={onClick} className="rounded-[10px] border border-line bg-bg/50 p-4 text-left transition-colors hover:border-performance/45 hover:bg-performance/[0.06]">
                  <Icon className="size-5 text-performance" />
                  <span className="mt-2 block text-[13px] font-semibold text-fg">{label}</span>
                  <span className="mt-1 block text-[12px] text-muted">{description}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <SocialPanel />
          <IdentityPanel />
        </div>
      </div>
    </>
  )
}
