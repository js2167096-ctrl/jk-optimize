// Tela de carregamento oficial (referência: "Tela de Carregamento JK Optimize.png", mantida intacta em imagem referencia/).
// A base é uma cópia derivada da imagem aprovada SEM os elementos dinâmicos (barra, porcentagem, etapa e linha de estado);
// por cima, camadas de interface desenham os valores reais nas mesmas posições. A barra só avança quando uma etapa real
// da inicialização termina (src/shared/boot.ts); a porcentagem e o texto da etapa vêm dela. O estado do executor e da
// telemetria é lido do estado real, sem texto fixo.
import { RefreshCw } from 'lucide-react'
import { bootLabel, bootProgress, type BootStage } from '@shared/boot'
import type { ExecutorStatus } from '@shared/types'
import baseUrl from '../../assets/brand/carregamento-base.png'
import { usePerf } from '../../hooks/usePerf'
import { Button } from '../../components/ui'

const W = 1536 // largura e altura da imagem aprovada: as posições abaixo estão nesse sistema de coordenadas
const H = 1024
const x = (px: number) => `${(px / W) * 100}%`
const y = (px: number) => `${(px / H) * 100}%`
const u = (px: number) => `${(px / W) * 100}cqw`

function statusOf(executor: ExecutorStatus | null, hasSample: boolean): { dot: string; text: string } {
  const telemetry = hasSample ? 'telemetria em execução' : 'telemetria iniciando'
  if (!executor) return { dot: '#f2b134', text: 'Iniciando serviços locais' }
  if (executor.state === 'ready') return { dot: '#22d36b', text: `Executor ativo · ${telemetry}` }
  if (executor.state === 'starting') return { dot: '#f2b134', text: `Executor iniciando · ${telemetry}` }
  return { dot: '#ff5a6b', text: `Executor indisponível · ${telemetry}` }
}

export function Splash({
  done,
  executor,
  error,
  onRetry,
  leaving
}: {
  done: ReadonlySet<BootStage>
  executor: ExecutorStatus | null
  error?: string
  onRetry?: () => void
  /** true quando todas as etapas terminaram: a tela esmaece e o painel é liberado. */
  leaving?: boolean
}) {
  const perf = usePerf(1, 1)
  const pct = bootProgress(done)
  const st = error ? { dot: '#ff5a6b', text: 'Não foi possível iniciar' } : statusOf(executor, perf.sample !== null)
  const label = error ? error : bootLabel(done)

  return (
    <div
      data-splash
      data-splash-progress={pct}
      data-splash-leaving={leaving ? 'true' : 'false'}
      className="absolute inset-0 z-[70] overflow-hidden bg-[#03060d] transition-opacity duration-300 ease-out"
      style={{ containerType: 'size', opacity: leaving ? 0 : 1, transitionDelay: leaving ? '120ms' : '0ms', pointerEvents: leaving ? 'none' : 'auto' }}
    >
      <div className="drag absolute inset-x-0 top-0 z-10 h-10" />
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 'max(100cqw, 150cqh)', aspectRatio: '3 / 2', transform: 'translate(-50%, -50%)', containerType: 'inline-size' }}>
        <img src={baseUrl} alt="Tela de carregamento do JK Optimize" width={W} height={H} draggable={false} data-splash-bg className="absolute inset-0 size-full select-none" />

        {/* Linha de estado (ponto + texto), no lugar da linha assada na imagem original */}
        <span data-splash-dot className="absolute rounded-full" style={{ left: x(777), top: y(618), width: u(22), height: u(22), background: st.dot, boxShadow: `0 0 ${u(14)} ${st.dot}` }} />
        <p data-splash-status className="absolute m-0 whitespace-nowrap" style={{ left: x(817), top: y(629), transform: 'translateY(-50%)', fontSize: u(24), color: '#cdd6e6', lineHeight: 1 }}>
          {st.text}
        </p>

        {/* Barra de progresso real */}
        <div className="absolute rounded-full" style={{ left: x(197), top: y(775), width: u(999), height: u(20), border: `${u(1.5)} solid rgba(29, 99, 214, 0.75)`, background: 'rgba(4, 12, 28, 0.85)' }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progresso da inicialização">
          <div
            data-splash-fill
            className="h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%`, background: error ? 'linear-gradient(90deg,#a01626,#ff5a6b)' : 'linear-gradient(90deg,#0a58ff,#2f8bff)', boxShadow: error ? '0 0 18px rgba(255,90,107,.55)' : `0 0 ${u(18)} rgba(31,107,255,.8)` }}
          />
        </div>
        <p data-splash-percent className="absolute m-0 tabular-nums" style={{ left: x(1222), top: y(784), transform: 'translateY(-50%)', fontSize: u(26), color: '#4da3ff', lineHeight: 1 }}>
          {pct}%
        </p>
        <p data-splash-label className="absolute m-0 uppercase" style={{ left: x(200), top: y(820), transform: 'translateY(-50%)', fontSize: u(15), letterSpacing: '0.2em', color: error ? '#ff8a96' : '#6b82b3', lineHeight: 1, maxWidth: x(1000) }}>
          {label}
        </p>
        {error && onRetry && (
          <div className="absolute" style={{ left: x(197), top: y(858) }}>
            <Button icon={RefreshCw} onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
