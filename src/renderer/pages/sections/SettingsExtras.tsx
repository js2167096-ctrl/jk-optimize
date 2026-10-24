// Complementos de Configurações: conta, segurança (consulta), ponto de restauração, relatório do sistema, histórico e monitoramento.
import { useState } from 'react'
import { ClipboardList, History, LifeBuoy, ShieldCheck, TrendingUp, User } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Button, Card, CopyButton, InfoRow, Notice } from '../../components/ui'
import { QueryView } from '../../components/kit'
import { useAction } from '../../components/ActionRunner'
import { useApp } from '../../hooks/useApp'
import { useQuery } from '../../hooks/useQuery'
import { query } from '../../services/ops'
import { errorMessage } from '../../services/api'
import { MonitoringPage } from '../Monitoring'
import { SecurityStatus } from '../optimization/Windows2'

interface Restore { frequencyMinutes: number; disabledByPolicy: boolean; points: { seq: number; desc: string; time: string }[] | null; pointsError: string | null }

export function SettingsExtras() {
  const { access, info, navigate } = useApp()
  const run = useAction()
  const rp = useQuery<Restore>('windows.restorepoint.status')
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const build = async () => {
    setBusy(true)
    setErr(null)
    try {
      const [cpu, gpu, vols, power] = await Promise.all([
        query<{ name: string; cores: number | null; threads: number }[]>('perf.cpu.info'),
        query<{ gpus: { name: string; driverVersion: string | null }[] }>('gpu.detect'),
        query<{ letter: string; fs: string; size: number; free: number; media: string }[]>('disk.volumes'),
        query<{ active: { name: string } | null }>('power.plans')
      ])
      const ram = await query<{ sample: { totalBytes: number | null; availableBytes: number | null } | null }>('perf.snapshot').then((r) => (r as unknown as { sample: { memory: { totalBytes: number | null; availableBytes: number | null } } | null }).sample?.memory ?? null)
      setReport(
        [
          `JK Optimize ${info.appVersion} (${info.isPackaged ? 'instalado' : 'desenvolvimento'})`,
          `Gerado em ${new Date().toLocaleString('pt-BR')}`,
          `CPU: ${cpu[0]?.name ?? '—'} (${cpu[0]?.cores ?? '?'} núcleos / ${cpu[0]?.threads ?? '?'} threads)`,
          `RAM: ${ram?.totalBytes ? formatBytes(ram.totalBytes) : '—'} (disponível ${ram?.availableBytes ? formatBytes(ram.availableBytes) : '—'})`,
          ...gpu.gpus.map((g, i) => `GPU ${i + 1}: ${g.name} · driver ${g.driverVersion ?? '—'}`),
          ...vols.map((v) => `Volume ${v.letter}: ${v.fs} · ${v.media || 'tipo ?'} · ${formatBytes(v.free)} livres de ${formatBytes(v.size)}`),
          `Plano de energia: ${power.active?.name ?? '—'}`
        ].join('\n')
      )
    } catch (e) {
      setErr(errorMessage(e))
    }
    setBusy(false)
  }

  return (
    <div className="mt-4 space-y-4">
      <Card title="Conta e licença" icon={User} accent="neutral">
        <InfoRow label="Acesso" value={access.kind === 'owner' ? 'Sessão do proprietário' : access.kind === 'active' ? 'Ativado' : access.kind} />
        <InfoRow label="Versão" value={info.appVersion} mono />
        <p className="mt-2 text-[12px] text-subtle">Chaves e ativação ficam em Extras → Chaves.</p>
      </Card>
      <Card title="Segurança do Windows (consulta)" icon={ShieldCheck} accent="alert">
        <SecurityStatus />
      </Card>
      <Card title="Ponto de restauração do Windows" icon={History} accent="optimize" action={<Button variant="primary" onClick={() => void run('windows.restorepoint.create', { description: 'JK Optimize' }).then(rp.reload)} data-restorepoint-create>Criar ponto agora</Button>}>
        <QueryView state={rp}>
          {(r) => (
            <div data-restorepoint>
              <InfoRow label="Intervalo mínimo entre pontos" value={`${r.frequencyMinutes} min`} />
              {r.disabledByPolicy && <Notice tone="warn">A proteção do sistema está desativada por política: pontos não podem ser criados.</Notice>}
              {r.points ? r.points.slice(0, 5).map((p) => <InfoRow key={p.seq} label={p.time} value={p.desc} />) : <p className="text-[12px] text-subtle">{r.pointsError}</p>}
            </div>
          )}
        </QueryView>
      </Card>
      <Card title="Relatório do sistema" icon={ClipboardList} accent="diagnostic" action={<Button onClick={() => void build()} loading={busy} data-report-build>Gerar relatório</Button>}>
        {err && <Notice tone="error" title="Não foi possível gerar o relatório">{err}</Notice>}
        {report ? (
          <>
            <pre className="max-h-64 overflow-auto rounded-control border border-line bg-elevated p-3 text-[12px] whitespace-pre-wrap text-muted" data-report-text>{report}</pre>
            <div className="mt-2"><CopyButton text={report} label="Copiar relatório" /></div>
          </>
        ) : (
          <p className="text-[13px] text-subtle">Reúne apenas dados lidos agora do computador; nada pessoal é incluído.</p>
        )}
      </Card>
      <Card title="Histórico e restauração de alterações" icon={LifeBuoy} accent="neutral">
        <p className="text-[13px] text-muted">Veja tudo o que foi alterado, reverta itens individualmente ou desfaça em conjunto os ajustes reversíveis.</p>
        <Button className="mt-3" onClick={() => navigate('history')}>Abrir Histórico e Restauração</Button>
      </Card>
      <Card title="Monitoramento: overlay, alertas e histórico" icon={TrendingUp} accent="diagnostic">
        <MonitoringPage embedded />
      </Card>
    </div>
  )
}
