// Rede: latência, DNS, adaptadores, Wi-Fi, conexões e reinício de adaptador.
import { BrowserWindow, dialog } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { HOST, int, noParams, obj, oneOf, str } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson, streamPowerShell, withInput } from '../services/powershell'
import { runElevated } from '../services/elevated'
import { dataPath } from '../services/store'

// ---------------------------------------------------------------------------
// 8.1 / 8.7 Teste e relatório de latência
// ---------------------------------------------------------------------------

export interface LatencySample {
  t: number
  ms: number | null
  status: 'ok' | 'timeout' | 'error'
  detail: string | null
}

export interface LatencyStats {
  sent: number
  replies: number
  timeouts: number
  errors: number
  minMs: number | null
  avgMs: number | null
  maxMs: number | null
  p95Ms: number | null
  /** Variação média entre respostas consecutivas. */
  jitterMs: number | null
  timeoutPct: number
}

/** Estatísticas reais das amostras. Exportada para testes. */
export function latencyStats(samples: LatencySample[]): LatencyStats {
  const ok = samples.filter((s) => s.status === 'ok' && s.ms !== null).map((s) => s.ms as number)
  const sorted = [...ok].sort((a, b) => a - b)
  let jitter: number | null = null
  if (ok.length >= 2) {
    let sum = 0
    for (let i = 1; i < ok.length; i++) sum += Math.abs(ok[i] - ok[i - 1])
    jitter = Math.round((sum / (ok.length - 1)) * 10) / 10
  }
  const timeouts = samples.filter((s) => s.status === 'timeout').length
  return {
    sent: samples.length,
    replies: ok.length,
    timeouts,
    errors: samples.filter((s) => s.status === 'error').length,
    minMs: sorted[0] ?? null,
    avgMs: ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : null,
    maxMs: sorted.at(-1) ?? null,
    p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null,
    jitterMs: jitter,
    timeoutPct: samples.length ? Math.round((timeouts / samples.length) * 1000) / 10 : 0
  }
}

const PING_LOOP = withInput(`
$ping = New-Object System.Net.NetworkInformation.Ping
$end = (Get-Date).AddSeconds([int]$in.duration)
while ((Get-Date) -lt $end) {
  $t0 = Get-Date
  try {
    $r = $ping.Send([string]$in.host, [int]$in.timeout)
    $s = [string]$r.Status
    [pscustomobject]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ok = ($s -eq 'Success'); ms = if ($s -eq 'Success') { [int]$r.RoundtripTime } else { $null }; status = $s } | ConvertTo-Json -Compress
  } catch {
    [pscustomobject]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); ok = $false; ms = $null; status = 'Erro: ' + $_.Exception.InnerException.Message } | ConvertTo-Json -Compress
  }
  $wait = [int]$in.interval - ((Get-Date) - $t0).TotalMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}`)

const latencyDir = () => dataPath('network', 'latency')
const MAX_REPORTS = 50

interface LatencyReport {
  id: string
  host: string
  startedAt: string
  durationSec: number
  intervalMs: number
  cancelled: boolean
  stats: LatencyStats
  samples: LatencySample[]
}

defineQuery({
  id: 'network.latency.run',
  module: 'network',
  parse(raw) {
    const p = obj(raw, ['host', 'durationSec', 'intervalMs'])
    return {
      host: str(p.host, 'host', 253, HOST),
      durationSec: int(p.durationSec, 'duração (s)', 5, 300, 30),
      intervalMs: int(p.intervalMs, 'intervalo (ms)', 500, 5000, 1000)
    }
  },
  async run(params, ctx) {
    const samples: LatencySample[] = []
    const startedAt = new Date().toISOString()
    const total = Math.ceil((params.durationSec * 1000) / params.intervalMs)
    await streamPowerShell(
      PING_LOOP,
      (line) => {
        try {
          const r = JSON.parse(line) as { t: number; ok: boolean; ms: number | null; status: string }
          const sample: LatencySample = {
            t: r.t,
            ms: r.ok ? r.ms : null,
            status: r.ok ? 'ok' : r.status === 'TimedOut' ? 'timeout' : 'error',
            detail: r.ok ? null : r.status
          }
          samples.push(sample)
          ctx.progress(`${samples.length}/${total} amostras`, samples.length, total, sample)
        } catch {
          // linha não-JSON (aviso do PowerShell): ignorada
        }
      },
      {
        input: JSON.stringify({ host: params.host, duration: params.durationSec, interval: params.intervalMs, timeout: Math.min(2000, params.intervalMs * 2) }),
        signal: ctx.signal,
        timeoutMs: (params.durationSec + 15) * 1000
      }
    )
    const report: LatencyReport = {
      id: startedAt.replace(/[:.]/g, '-'),
      host: params.host,
      startedAt,
      durationSec: params.durationSec,
      intervalMs: params.intervalMs,
      cancelled: ctx.signal.aborted,
      stats: latencyStats(samples),
      samples
    }
    if (samples.length > 0) {
      mkdirSync(latencyDir(), { recursive: true })
      writeFileSync(join(latencyDir(), `${report.id}.json`), JSON.stringify(report), 'utf8')
      const files = readdirSync(latencyDir()).filter((f) => f.endsWith('.json')).sort()
      for (const old of files.slice(0, Math.max(0, files.length - MAX_REPORTS))) rmSync(join(latencyDir(), old), { force: true })
    }
    return report
  }
})

function readReport(id: string): LatencyReport {
  if (!/^[0-9TZ-]+$/.test(id)) throw new AppFailure('invalid-input', 'Relatório inválido.')
  const file = join(latencyDir(), `${id}.json`)
  if (!existsSync(file)) throw new AppFailure('not-found', 'Relatório não encontrado.')
  return JSON.parse(readFileSync(file, 'utf8')) as LatencyReport
}

defineQuery({
  id: 'network.latency.reports',
  module: 'network',
  parse: noParams,
  async run() {
    if (!existsSync(latencyDir())) return []
    return readdirSync(latencyDir())
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        try {
          const r = JSON.parse(readFileSync(join(latencyDir(), f), 'utf8')) as LatencyReport
          return { id: r.id, host: r.host, startedAt: r.startedAt, durationSec: r.durationSec, cancelled: r.cancelled, stats: r.stats }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
})

defineQuery({ id: 'network.latency.report', module: 'network', parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'relatório', 40) }), run: async ({ id }) => readReport(id) })

/** CSV com as amostras reais. Exportada para testes. */
export function latencyCsv(report: LatencyReport): string {
  const lines = ['timestamp_utc,host,status,latency_ms,detail']
  for (const s of report.samples) {
    lines.push([new Date(s.t).toISOString(), report.host, s.status, s.ms ?? '', (s.detail ?? '').replace(/[",\n]/g, ' ')].join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

defineQuery({
  id: 'network.latency.export',
  module: 'network',
  parse(raw) {
    const p = obj(raw, ['id', 'format'])
    return { id: str(p.id, 'relatório', 40), format: oneOf(p.format, 'formato', ['csv', 'json'] as const) }
  },
  async run({ id, format }) {
    const report = readReport(id)
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Exportar relatório de latência',
      defaultPath: `latencia-${report.host}-${report.id}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { saved: null }
    writeFileSync(picked.filePath, format === 'csv' ? latencyCsv(report) : JSON.stringify(report, null, 2), 'utf8')
    return { saved: picked.filePath }
  }
})

// ---------------------------------------------------------------------------
// 8.2 DNS
// ---------------------------------------------------------------------------

const DNS_DIAG = withInput(`
$servers = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { [pscustomobject]@{ iface = $_.InterfaceAlias; servers = @($_.ServerAddresses) } })
$sw = [Diagnostics.Stopwatch]::StartNew()
$answers = @(); $err = $null
try { $answers = @(Resolve-DnsName -Name $in.name -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { [pscustomobject]@{ type = [string]$_.Type; ip = $_.IPAddress; ttl = $_.TTL } }) } catch { $err = $_.Exception.Message }
$sw.Stop()
$cache = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count
[pscustomobject]@{ servers = $servers; answers = $answers; error = $err; ms = $sw.ElapsedMilliseconds; cache = $cache } | ConvertTo-Json -Depth 4 -Compress`)

defineQuery({
  id: 'network.dns.diagnose',
  module: 'network',
  parse: (raw) => ({ name: str(obj(raw, ['name']).name, 'nome', 253, HOST) }),
  async run({ name }) {
    const r = await runPowerShellJson<Record<string, unknown>>(DNS_DIAG, { input: JSON.stringify({ name }), timeoutMs: 30_000 })
    return {
      name,
      servers: asArray(r?.servers).map((s) => ({ iface: String((s as Record<string, unknown>).iface), servers: asArray((s as Record<string, unknown>).servers).map(String) })),
      answers: asArray(r?.answers).map((a) => a as { type: string; ip: string; ttl: number }),
      error: asString(r?.error),
      resolveMs: asNumber(r?.ms),
      cacheEntries: asNumber(r?.cache)
    }
  }
})

const FLUSH = `
$before = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count
$out = (ipconfig /flushdns) 2>&1 | Out-String
$code = $LASTEXITCODE
$after = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count
[pscustomobject]@{ code = $code; out = $out; before = $before; after = $after } | ConvertTo-Json -Compress`

defineAction<Record<string, never>, never>({
  id: 'network.dns.flush',
  module: 'network',
  title: 'Limpar cache DNS',
  description: 'Esvazia o cache de resolução de nomes do Windows (ipconfig /flushdns).',
  risk: 'low',
  reversible: false,
  irreversibleReason: 'O cache é reconstruído automaticamente conforme os sites são acessados; não há estado a restaurar.',
  requiresElevation: false,
  parse: noParams,
  async preview() {
    const r = await runPowerShellJson<{ count: number }>(`[pscustomobject]@{ count = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count } | ConvertTo-Json -Compress`)
    return {
      summary: `${r?.count ?? '?'} entradas no cache DNS.`,
      changes: [{ target: 'Cache DNS do Windows', current: `${r?.count ?? '?'} entradas`, intended: 'Vazio' }],
      warnings: ['A primeira visita a cada site depois disso pode demorar alguns milissegundos a mais.']
    }
  },
  async execute() {
    const r = await runPowerShellJson<{ code: number; out: string; before: number; after: number }>(FLUSH)
    if (!r || r.code !== 0) {
      throw new AppFailure('flush-failed', `ipconfig /flushdns falhou (código ${r?.code ?? '?'}). ${r?.out?.trim() ?? ''}`)
    }
    const verified = r.after <= Math.max(5, r.before * 0.2)
    return {
      ok: true,
      verified,
      summary: `Cache DNS limpo: ${r.before} → ${r.after} entradas${verified ? ' (conferido)' : ' (novas consultas já repovoaram parte do cache)'}.`
    }
  }
})

// ---------------------------------------------------------------------------
// 8.3 Adaptadores
// ---------------------------------------------------------------------------

const ADAPTERS = `
$errs = @()
$ad = @(); try { $ad = @(Get-NetAdapter -ErrorAction Stop) } catch { $errs += 'Get-NetAdapter: ' + $_.Exception.Message }
$cfg = @{}; try { foreach ($c in Get-NetIPConfiguration -ErrorAction Stop) { $cfg[[int]$c.InterfaceIndex] = $c } } catch { $errs += 'Get-NetIPConfiguration: ' + $_.Exception.Message }
$stats = @{}; try { foreach ($s in Get-NetAdapterStatistics -ErrorAction Stop) { $stats[$s.Name] = $s } } catch { $errs += 'Get-NetAdapterStatistics: ' + $_.Exception.Message }
$list = foreach ($a in $ad) {
  $c = $cfg[[int]$a.ifIndex]; $s = $stats[$a.Name]
  [pscustomobject]@{
    name = $a.Name; description = $a.InterfaceDescription; status = [string]$a.Status; linkSpeed = $a.LinkSpeed; mac = $a.MacAddress
    media = [string]$a.PhysicalMediaType; virtual = [bool]$a.Virtual; ifIndex = $a.ifIndex
    ipv4 = @($c.IPv4Address | ForEach-Object { $_.IPAddress + '/' + $_.PrefixLength })
    ipv6 = @($c.IPv6Address | ForEach-Object { $_.IPAddress })
    gateway = @($c.IPv4DefaultGateway | ForEach-Object { $_.NextHop })
    dns = @($c.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses } | Select-Object -Unique)
    rx = $s.ReceivedBytes; tx = $s.SentBytes; rxErr = $s.ReceivedPacketErrors; txErr = $s.OutboundPacketErrors; rxDisc = $s.ReceivedDiscardedPackets
  }
}
[pscustomobject]@{ adapters = @($list); errors = $errs } | ConvertTo-Json -Depth 4 -Compress`

export async function listAdapters() {
  const r = await runPowerShellJson<{ adapters: unknown; errors: unknown }>(ADAPTERS, { timeoutMs: 45_000 })
  return {
    adapters: asArray(r?.adapters).map((a) => {
      const x = a as Record<string, unknown>
      return {
        name: String(x.name),
        description: asString(x.description),
        status: String(x.status),
        linkSpeed: asString(x.linkSpeed),
        mac: asString(x.mac),
        media: asString(x.media),
        virtual: x.virtual === true,
        ipv4: asArray(x.ipv4).map(String),
        ipv6: asArray(x.ipv6).map(String),
        gateway: asArray(x.gateway).map(String),
        dns: asArray(x.dns).map(String),
        receivedBytes: asNumber(x.rx),
        sentBytes: asNumber(x.tx),
        receiveErrors: asNumber(x.rxErr),
        sendErrors: asNumber(x.txErr),
        receiveDiscarded: asNumber(x.rxDisc)
      }
    }),
    errors: asArray(r?.errors).map(String)
  }
}

defineQuery({ id: 'network.adapters', module: 'network', parse: noParams, run: () => listAdapters() })

// ---------------------------------------------------------------------------
// 8.4 Wi-Fi (netsh: documentado; nunca exibe senhas)
// ---------------------------------------------------------------------------

/** Interpreta `netsh wlan show interfaces` em português ou inglês. Exportada para testes. */
export function parseWlan(text: string) {
  const interfaces: Record<string, string>[] = []
  let current: Record<string, string> | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2,}([^:]+?)\s*:\s(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2].trim()
    if (/^(Nome|Name)$/i.test(key)) {
      current = {}
      interfaces.push(current)
    }
    if (current) current[key] = value
  }
  const pick = (i: Record<string, string>, ...keys: string[]) => {
    for (const k of Object.keys(i)) if (keys.some((x) => k.toLowerCase() === x.toLowerCase())) return i[k]
    return null
  }
  return interfaces.map((i) => ({
    name: pick(i, 'Nome', 'Name'),
    state: pick(i, 'Estado', 'State'),
    ssid: pick(i, 'SSID'),
    bssid: pick(i, 'BSSID', 'AP BSSID'),
    radio: pick(i, 'Tipo de rádio', 'Radio type'),
    band: pick(i, 'Banda', 'Band'),
    channel: pick(i, 'Canal', 'Channel'),
    signal: pick(i, 'Sinal', 'Signal'),
    receiveMbps: pick(i, 'Taxa de recepção (Mbps)', 'Receive rate (Mbps)'),
    transmitMbps: pick(i, 'Taxa de transmissão (Mbps)', 'Transmit rate (Mbps)'),
    authentication: pick(i, 'Autenticação', 'Authentication'),
    raw: Object.fromEntries(Object.entries(i).filter(([k]) => !/senha|password|key content|conteúdo da chave/i.test(k)))
  }))
}

defineQuery({
  id: 'network.wifi',
  module: 'network',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<{ out: string; code: number }>(
      `$o = (netsh wlan show interfaces) 2>&1 | Out-String; [pscustomobject]@{ out = $o; code = $LASTEXITCODE } | ConvertTo-Json -Compress`
    )
    if (!r || r.code !== 0) return { available: false, reason: (r?.out ?? '').trim() || 'Serviço de Wi-Fi (WLAN AutoConfig) indisponível ou sem adaptador sem fio.', interfaces: [] }
    const interfaces = parseWlan(r.out)
    return { available: interfaces.length > 0, reason: interfaces.length ? null : 'Nenhum adaptador Wi-Fi encontrado.', interfaces }
  }
})

// ---------------------------------------------------------------------------
// 8.5 Conexões
// ---------------------------------------------------------------------------

const CONNECTIONS = `
$names = @{}; foreach ($p in Get-Process) { $names[$p.Id] = $p.ProcessName }
$errs = @()
$tcp = @(); try { $tcp = @(Get-NetTCPConnection -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ proto = 'TCP'; la = $_.LocalAddress; lp = $_.LocalPort; ra = $_.RemoteAddress; rp = $_.RemotePort; state = [string]$_.State; pid = $_.OwningProcess; proc = $names[[int]$_.OwningProcess] } }) } catch { $errs += 'TCP: ' + $_.Exception.Message }
$udp = @(); try { $udp = @(Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ proto = 'UDP'; la = $_.LocalAddress; lp = $_.LocalPort; ra = $null; rp = $null; state = 'Escutando'; pid = $_.OwningProcess; proc = $names[[int]$_.OwningProcess] } }) } catch { $errs += 'UDP: ' + $_.Exception.Message }
[pscustomobject]@{ items = @($tcp + $udp); errors = $errs } | ConvertTo-Json -Depth 3 -Compress`

export function classifyAddress(ip: string | null): 'local' | 'private' | 'public' | null {
  if (!ip) return null
  if (/^(127\.|::1$|0\.0\.0\.0$|::$)/.test(ip)) return 'local'
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i.test(ip)) return 'private'
  return 'public'
}

defineQuery({
  id: 'network.connections',
  module: 'network',
  parse: noParams,
  async run() {
    const r = await runPowerShellJson<{ items: unknown; errors: unknown }>(CONNECTIONS, { timeoutMs: 45_000 })
    return {
      items: asArray(r?.items).map((c) => {
        const x = c as Record<string, unknown>
        const remote = asString(x.ra)
        return {
          protocol: String(x.proto),
          localAddress: String(x.la),
          localPort: asNumber(x.lp),
          remoteAddress: remote,
          remotePort: asNumber(x.rp),
          state: String(x.state),
          pid: asNumber(x.pid),
          process: asString(x.proc),
          scope: classifyAddress(remote) ?? classifyAddress(String(x.la))
        }
      }),
      errors: asArray(r?.errors).map(String)
    }
  }
})

// ---------------------------------------------------------------------------
// 8.6 Reinício de adaptador
// ---------------------------------------------------------------------------

const RESTART_ADAPTER = `
$a = Get-NetAdapter -Name $in.name -ErrorAction Stop
$before = [string]$a.Status
Restart-NetAdapter -Name $in.name -Confirm:$false -ErrorAction Stop
$status = $null
for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; $status = [string](Get-NetAdapter -Name $in.name).Status; if ($status -eq 'Up') { break } }
Out-Result ([pscustomobject]@{ before = $before; after = $status })
exit 0`

defineAction<{ name: string }, never>({
  id: 'network.adapter.restart',
  module: 'network',
  title: 'Reiniciar adaptador de rede',
  description: 'Desliga e religa um adaptador de rede (Restart-NetAdapter).',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'O reinício não altera configurações; não há estado a reverter. A conexão cai por alguns segundos.',
  requiresElevation: true,
  exclusive: 'network-adapter',
  parse: (raw) => ({ name: str(obj(raw, ['name']).name, 'adaptador', 256, /^[^"'`$;|&<>]+$/) }),
  async preview({ name }) {
    const { adapters } = await listAdapters()
    const a = adapters.find((x) => x.name === name)
    const isPrimary = !!a && a.gateway.length > 0 && a.status === 'Up'
    return {
      summary: a ? `${a.name} — ${a.description ?? ''}` : 'Adaptador não encontrado.',
      changes: a ? [{ target: a.name, current: a.status, intended: 'Reiniciado (volta a "Up" em alguns segundos)' }] : [],
      warnings: [
        'A conexão deste adaptador cairá temporariamente; downloads e partidas online podem ser interrompidos.',
        ...(isPrimary ? ['Este é o adaptador com a rota padrão: a internet ficará indisponível durante o reinício.'] : []),
        'Requer permissão de administrador.'
      ],
      blocked: a ? null : 'Este adaptador não existe.'
    }
  },
  async execute({ name }, ctx) {
    ctx.progress('Aguardando permissão de administrador…')
    const { output } = await runElevated<{ before: string; after: string }>(RESTART_ADAPTER, { name }, { timeoutMs: 90_000 })
    const up = output?.after === 'Up'
    return {
      ok: up || output?.before !== 'Up',
      verified: true,
      summary: `${name}: ${output?.before ?? '?'} → ${output?.after ?? '?'}${up ? ' (conferido)' : ''}.`
    }
  }
})
