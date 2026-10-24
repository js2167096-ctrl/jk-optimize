// BIOS: diagnóstico somente leitura de firmware e hardware, com recomendações geradas dos dados detectados.
import { Cpu } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, Card, InfoRow, Notice, PageHeader } from '../../components/ui'
import { QueryView, RefreshButton } from '../../components/kit'
import { useQuery } from '../../hooks/useQuery'

interface Report {
  bios: { vendor: string | null; version: string | null; date: string | null } | null
  board: { vendor: string | null; product: string | null } | null
  system: { model: string | null; hypervisor: boolean; ramBytes: number | null } | null
  cpu: { name: string | null; virtualization: boolean | null; slat: boolean | null; cores: number | null; threads: number | null } | null
  memory: { gb: number; speed: number | null; configured: number | null; slot: string | null; maker: string | null }[]
  firmwareType: string | null
  secureBoot: string | null
  tpm: { present: boolean; enabled: boolean; activated: boolean; version: string | null } | null
  gpus: { name: string; driver: string }[]
  disks: { name: string; media: string; bus: string; gb: number }[]
  advice: { id: string; severity: 'info' | 'warn'; title: string; evidence: string; steps: string }[]
  note: string
}

const yn = (v: boolean | null) => (v === null ? 'não informado' : v ? 'Sim' : 'Não')

export function BiosPage() {
  const rep = useQuery<Report>('bios.report')
  return (
    <>
      <PageHeader icon={Cpu} accent="advanced" title="BIOS" description="System & BIOS Advisor: lê firmware e hardware e explica o que pode ser ajustado na BIOS/UEFI. O JK Optimize não altera firmware." action={<RefreshButton onClick={rep.reload} loading={rep.loading} />} />
      <QueryView state={rep} loadingLabel="Lendo firmware e hardware…">
        {(r) => (
          <div className="space-y-4" data-bios-report>
            <Card title="Recomendações" icon={Cpu} accent="advanced">
              {r.advice.length === 0 ? (
                <p className="text-[13px] text-muted">Nenhuma recomendação para os dados lidos.</p>
              ) : (
                <div className="space-y-2.5">
                  {r.advice.map((a) => (
                    <div key={a.id} className="rounded-control border border-line p-3 text-[12.5px]" data-advice={a.id}>
                      <p className="flex items-center gap-2 font-medium text-fg"><Badge tone={a.severity === 'warn' ? 'warn' : 'info'}>{a.severity === 'warn' ? 'Atenção' : 'Sugestão'}</Badge>{a.title}</p>
                      <p className="mt-1 text-muted">{a.evidence}</p>
                      <p className="mt-1 text-subtle">{a.steps}</p>
                    </div>
                  ))}
                </div>
              )}
              <Notice tone="info">{r.note}</Notice>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Firmware e placa-mãe" icon={Cpu} accent="diagnostic">
                <InfoRow label="BIOS" value={r.bios ? `${r.bios.vendor ?? ''} ${r.bios.version ?? ''}` : '—'} />
                <InfoRow label="Data da BIOS" value={r.bios?.date ?? '—'} />
                <InfoRow label="Placa-mãe" value={r.board ? `${r.board.vendor ?? ''} ${r.board.product ?? ''}` : '—'} />
                <InfoRow label="Modelo do sistema" value={r.system?.model ?? '—'} />
                <InfoRow label="Modo de inicialização" value={r.firmwareType ?? 'não informado'} />
                <InfoRow label="Secure Boot" value={r.secureBoot ?? 'não informado'} />
                <InfoRow label="TPM" value={r.tpm ? `Presente · ${r.tpm.enabled ? 'habilitado' : 'desabilitado'}${r.tpm.version ? ` · ${r.tpm.version.split(',')[0]}` : ''}` : 'não lido (exige administrador ou não existe)'} />
              </Card>
              <Card title="Processador e virtualização" icon={Cpu} accent="diagnostic">
                <InfoRow label="CPU" value={r.cpu?.name ?? '—'} />
                <InfoRow label="Núcleos / threads" value={r.cpu ? `${r.cpu.cores ?? '?'} / ${r.cpu.threads ?? '?'}` : '—'} />
                <InfoRow label="Virtualização no firmware" value={yn(r.cpu?.virtualization ?? null)} />
                <InfoRow label="Hipervisor ativo" value={yn(r.system?.hypervisor ?? null)} />
                <InfoRow label="SLAT" value={yn(r.cpu?.slat ?? null)} />
              </Card>
              <Card title="Memória" icon={Cpu} accent="diagnostic">
                <InfoRow label="Total" value={r.system?.ramBytes ? formatBytes(r.system.ramBytes) : '—'} />
                {r.memory.map((m, i) => <InfoRow key={i} label={m.slot ?? `Módulo ${i + 1}`} value={`${m.gb} GB · ${m.speed ?? '?'} MT/s nominal · ${m.configured ?? '?'} MT/s em uso${m.maker ? ` · ${m.maker}` : ''}`} />)}
              </Card>
              <Card title="Vídeo e armazenamento" icon={Cpu} accent="diagnostic">
                {r.gpus.map((g, i) => <InfoRow key={i} label={`GPU ${i + 1}`} value={`${g.name} · driver ${g.driver}`} />)}
                {r.disks.map((d, i) => <InfoRow key={i} label={`Disco ${i + 1}`} value={`${d.name} · ${d.media} · ${d.bus} · ${d.gb} GB`} />)}
              </Card>
            </div>
          </div>
        )}
      </QueryView>
    </>
  )
}
