// Input Lag: configurações reais de entrada e vídeo, carga de CPU/GPU e ajustes compatíveis. Não mede latência física.
import { MousePointer2 } from 'lucide-react'
import { Badge, Card, InfoRow, Notice, PageHeader } from '../../components/ui'
import { Metric, QueryView, RefreshButton } from '../../components/kit'
import { usePerf, maxGpu } from '../../hooks/usePerf'
import { useQuery } from '../../hooks/useQuery'
import { TweakPanel } from '../optimization/Windows2'
import { useApp } from '../../hooks/useApp'
import { Button } from '../../components/ui'

interface Report {
  mouse: { acceleration: boolean | null; speed: string | null; threshold1: string | null; threshold2: string | null; sensitivity: number | null }
  keyboard: { delay: number | null; rate: number | null }
  displays: { adapter: string; width: number | null; height: number | null; hz: number | null }[]
  readAt: string
}

export function InputLagPage() {
  const rep = useQuery<Report>('inputlag.report')
  const perf = usePerf(2)
  const { navigate } = useApp()
  const s = perf.sample
  const gpu = maxGpu(s)
  return (
    <>
      <PageHeader icon={MousePointer2} accent="performance" title="Input Lag" description="Configurações de mouse, teclado e vídeo lidas do Windows, mais carga de CPU/GPU. O app não mede a latência física: uso de CPU e FPS não são latência." action={<RefreshButton onClick={rep.reload} loading={rep.loading} />} />
      <div className="space-y-4">
        <Card title="Entrada e vídeo (estado atual)" icon={MousePointer2} accent="performance">
          <QueryView state={rep}>
            {(r) => (
              <div className="grid gap-x-8 md:grid-cols-2" data-inputlag-report>
                <InfoRow label="Aceleração do ponteiro" value={r.mouse.acceleration === null ? <Badge tone="info">Não foi possível ler</Badge> : <Badge tone={r.mouse.acceleration ? 'warn' : 'ok'}>{r.mouse.acceleration ? 'Ativada ("Aprimorar precisão do ponteiro")' : 'Desativada'}</Badge>} />
                <InfoRow label="Velocidade do ponteiro (1–20)" value={r.mouse.sensitivity ?? '—'} />
                <InfoRow label="Atraso do teclado (0–3)" value={r.keyboard.delay ?? '—'} />
                <InfoRow label="Taxa de repetição (0–31)" value={r.keyboard.rate ?? '—'} />
                {r.displays.map((d, i) => (
                  <InfoRow key={i} label={`Vídeo: ${d.adapter}`} value={d.width && d.hz ? `${d.width}×${d.height} @ ${d.hz} Hz` : '—'} />
                ))}
              </div>
            )}
          </QueryView>
          <p className="mt-3 text-[12px] text-subtle">A taxa de atualização atual é a informada pelo driver. Se o monitor suporta mais Hz, escolha em Configurações do Windows → Sistema → Vídeo; o app não força modos de vídeo.</p>
        </Card>
        <Card title="Carga atual do sistema (telemetria)" icon={MousePointer2} accent="diagnostic">
          <div className="grid gap-4 md:grid-cols-3">
            <Metric label="CPU" value={s?.cpu.totalPct != null ? `${Math.round(s.cpu.totalPct)}%` : '—'} hint="Carga alta e constante pode aumentar o atraso de resposta" />
            <Metric label="GPU" value={gpu != null ? `${Math.round(gpu)}%` : '—'} hint="Carga perto de 100% enfileira quadros" />
            <Metric label="Processos em segundo plano" value={s?.topCpu.filter((p) => p.cpuPct >= 2).length ?? '—'} hint="Com 2% de CPU ou mais" />
          </div>
          <Notice tone="info" title="Frametime e latência de rede">Irregularidade de quadros (frametime) só existe quando uma medição com PresentMon está configurada e um jogo está em teste (página Jogos). A latência de rede é outra métrica: veja a página Redes.</Notice>
          <Button className="mt-3" variant="ghost" onClick={() => navigate('network')}>Abrir Redes</Button>
        </Card>
        <Card title="Ajustes compatíveis" icon={MousePointer2} accent="optimize">
          <TweakPanel ids={['mouseAccel', 'kbDelay', 'kbSpeed', 'usbSuspend', 'gameMode', 'hags']} />
        </Card>
      </div>
    </>
  )
}
