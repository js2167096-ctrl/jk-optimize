// Redes: comparação de servidores DNS com várias amostras e troca do DNS de um adaptador (com backup, verificação e reversão).
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { int, obj, oneOf, str } from '../ops/params'
import { asArray, asNumber, asString, runPowerShellJson, runPowerShellWith } from '../services/powershell'
import { runElevatedOps } from './elevops'

/** Provedores oferecidos (endereços públicos documentados pelos próprios provedores). */
export const DNS_PROVIDERS = {
  cloudflare: { label: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  google: { label: 'Google Public DNS', servers: ['8.8.8.8', '8.8.4.4'] },
  quad9: { label: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
  opendns: { label: 'OpenDNS', servers: ['208.67.222.222', '208.67.220.220'] }
} as const
type ProviderId = keyof typeof DNS_PROVIDERS

const SAMPLE_NAMES = ['www.google.com', 'www.microsoft.com', 'www.cloudflare.com', 'store.steampowered.com', 'www.youtube.com']

const COMPARE = `
$names = @($in.names | ForEach-Object { [string]$_ })
$rounds = [int]$in.rounds
$out = @()
foreach ($t in @($in.targets)) {
  $times = New-Object System.Collections.Generic.List[double]
  $fail = 0
  for ($r = 0; $r -lt $rounds; $r++) {
    foreach ($n in $names) {
      $sw = [Diagnostics.Stopwatch]::StartNew()
      try {
        if ($t.server) { Resolve-DnsName -Name $n -Server ([string]$t.server) -Type A -DnsOnly -QuickTimeout -ErrorAction Stop | Out-Null }
        else { Resolve-DnsName -Name $n -Type A -DnsOnly -QuickTimeout -ErrorAction Stop | Out-Null }
        $times.Add($sw.Elapsed.TotalMilliseconds)
      } catch { $fail++ }
    }
  }
  $sorted = @($times | Sort-Object)
  $out += [pscustomobject]@{ id = [string]$t.id; label = [string]$t.label; server = [string]$t.server; ok = $sorted.Count; fail = $fail
    median = if ($sorted.Count) { [math]::Round($sorted[[int][math]::Floor(($sorted.Count - 1) / 2)], 1) } else { $null }
    min = if ($sorted.Count) { [math]::Round($sorted[0], 1) } else { $null }
    max = if ($sorted.Count) { [math]::Round($sorted[$sorted.Count - 1], 1) } else { $null }
    avg = if ($sorted.Count) { [math]::Round((($sorted | Measure-Object -Average).Average), 1) } else { $null } }
}
$out | ConvertTo-Json -Depth 3 -Compress`

export interface DnsResult {
  id: string
  label: string
  server: string
  ok: number
  fail: number
  median: number | null
  min: number | null
  max: number | null
  avg: number | null
}

defineQuery({
  id: 'network.dns.compare',
  module: 'network',
  parse: (raw) => ({ rounds: int(obj(raw, ['rounds']).rounds, 'rodadas', 1, 8, 3) }),
  async run({ rounds }, ctx) {
    ctx.progress('Medindo o DNS atual e os provedores…')
    const targets = [{ id: 'current', label: 'DNS atual do Windows', server: '' }, ...(Object.entries(DNS_PROVIDERS) as [ProviderId, (typeof DNS_PROVIDERS)[ProviderId]][]).map(([id, p]) => ({ id, label: p.label, server: p.servers[0] }))]
    const raw = await runPowerShellWith<unknown>(COMPARE, { names: SAMPLE_NAMES, rounds, targets }, { timeoutMs: 120_000 })
    const results = asArray(raw).map((r) => {
      const x = r as Record<string, unknown>
      return { id: String(x.id), label: String(x.label), server: String(x.server ?? ''), ok: asNumber(x.ok) ?? 0, fail: asNumber(x.fail) ?? 0, median: asNumber(x.median), min: asNumber(x.min), max: asNumber(x.max), avg: asNumber(x.avg) } satisfies DnsResult
    })
    return { results, samplesPerServer: rounds * SAMPLE_NAMES.length, names: SAMPLE_NAMES, at: new Date().toISOString(), note: 'Mede só a resolução de nomes (DNS). Não é o ping até o servidor do jogo. Provedores com cache quente aparecem mais rápidos nas repetições.' }
  }
})

const READ_DNS = `
$ad = Get-NetAdapter -Name $in.alias -ErrorAction Stop
$guid = [string]$ad.InterfaceGuid
$ns = ''
try { $ns = [string](Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\' + $guid) -ErrorAction Stop).NameServer } catch {}
$addr = @(Get-DnsClientServerAddress -InterfaceAlias $in.alias -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object { $_.ServerAddresses })
[pscustomobject]@{ status = [string]$ad.Status; virtual = [bool]$ad.Virtual; automatic = [string]::IsNullOrWhiteSpace($ns); servers = @($addr) } | ConvertTo-Json -Compress`

interface DnsState {
  status: string
  virtual: boolean
  automatic: boolean
  servers: string[]
}

async function readDns(alias: string): Promise<DnsState> {
  const r = await runPowerShellWith<Record<string, unknown>>(READ_DNS, { alias }, { timeoutMs: 20_000 })
  if (!r) throw new AppFailure('dns-read', 'Não foi possível ler o DNS do adaptador.')
  return { status: String(r.status), virtual: r.virtual === true, automatic: r.automatic === true, servers: asArray(r.servers).map(String) }
}

const ALIAS = /^[\p{L}\p{N} ._()-]{1,64}$/u
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

interface DnsBackup {
  alias: string
  automatic: boolean
  servers: string[]
}

defineAction<{ alias: string; provider: ProviderId | 'auto' }, DnsBackup>({
  id: 'network.dns.set',
  module: 'network',
  title: 'Alterar servidor DNS do adaptador',
  description: 'Define o DNS IPv4 de um adaptador para um provedor conhecido (ou volta ao automático), com backup do estado anterior e verificação.',
  risk: 'medium',
  reversible: true,
  requiresElevation: true,
  exclusive: 'dns',
  parse(raw) {
    const p = obj(raw, ['alias', 'provider'])
    return { alias: str(p.alias, 'adaptador', 64, ALIAS), provider: oneOf(p.provider, 'provedor', ['auto', ...Object.keys(DNS_PROVIDERS)] as (ProviderId | 'auto')[]) }
  },
  async preview({ alias, provider }) {
    const st = await readDns(alias)
    const intended = provider === 'auto' ? 'Automático (DHCP)' : DNS_PROVIDERS[provider].servers.join(', ')
    const wanted = provider === 'auto' ? null : [...DNS_PROVIDERS[provider].servers]
    return {
      summary: `DNS de "${alias}" → ${provider === 'auto' ? 'automático' : DNS_PROVIDERS[provider].label}`,
      changes: [{ target: `DNS IPv4 de ${alias}`, current: `${st.automatic ? 'Automático' : 'Manual'}: ${st.servers.join(', ') || '—'}`, intended }],
      warnings: ['A mudança pede administrador e afeta só este adaptador (IPv4).', 'Não reduz o ping dos jogos: só altera a resolução de nomes.'],
      blocked: st.status !== 'Up' ? 'O adaptador não está conectado.' : st.virtual ? 'Adaptador virtual não é alterado.' : wanted && !st.automatic && same(st.servers, wanted) ? 'Este DNS já está configurado.' : provider === 'auto' && st.automatic ? 'O adaptador já usa DNS automático.' : null
    }
  },
  async execute({ alias, provider }) {
    const before = await readDns(alias)
    const servers = provider === 'auto' ? null : [...DNS_PROVIDERS[provider].servers]
    const [res] = await runElevatedOps([{ k: 'dns', alias, servers }])
    if (!res.ok) throw new AppFailure('dns-failed', `O Windows recusou a alteração: ${res.error ?? 'erro desconhecido'}`)
    const after = await readDns(alias)
    const verified = servers ? same(after.servers, servers) : after.automatic
    if (!verified) throw new AppFailure('dns-verify', `A conferência falhou: o adaptador mostra ${after.servers.join(', ') || 'DNS automático'}.`)
    return {
      ok: true,
      verified: true,
      summary: `DNS de "${alias}" conferido: ${servers ? servers.join(', ') : 'automático'}.`,
      change: {
        before: { alias, automatic: before.automatic, servers: before.servers },
        after: { alias, servers },
        summaryBefore: `${before.automatic ? 'Automático' : 'Manual'}: ${before.servers.join(', ') || '—'}`,
        summaryAfter: servers ? servers.join(', ') : 'Automático'
      }
    }
  },
  async revert(before, after, ctx) {
    const now = await readDns(before.alias)
    const expected = (after as { servers: string[] | null }).servers
    const unchanged = expected ? same(now.servers, expected) : now.automatic
    if (!unchanged && !ctx.force) throw new AppFailure('state-changed', 'O DNS deste adaptador mudou depois da alteração. Use "forçar" para restaurar mesmo assim.')
    const servers = before.automatic || before.servers.length === 0 ? null : before.servers
    const [res] = await runElevatedOps([{ k: 'dns', alias: before.alias, servers }])
    if (!res.ok) throw new AppFailure('dns-failed', `O Windows recusou a restauração: ${res.error ?? 'erro desconhecido'}`)
    const check = await readDns(before.alias)
    if (servers ? !same(check.servers, servers) : !check.automatic) throw new AppFailure('dns-verify', 'A conferência da restauração falhou.')
    return `DNS de "${before.alias}" restaurado: ${servers ? servers.join(', ') : 'automático'}.`
  }
})

// Diagnóstico básico de conectividade: gateway, DNS e internet, cada um medido separadamente.
const CONNECTIVITY = `
$gw = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1 | ForEach-Object { $_.NextHop })
$res = [ordered]@{ gateway = $null; gatewayMs = $null; gatewayLoss = $null; internetMs = $null; internetLoss = $null; dnsOk = $false; dnsMs = $null }
if ($gw.Count -and $gw[0] -and $gw[0] -ne '0.0.0.0') {
  $res.gateway = [string]$gw[0]
  $p = @(Test-Connection -ComputerName $gw[0] -Count 4 -ErrorAction SilentlyContinue)
  $res.gatewayLoss = [math]::Round((4 - $p.Count) * 25, 0)
  if ($p.Count) { $res.gatewayMs = [math]::Round((($p | Measure-Object -Property ResponseTime -Average).Average), 1) }
}
$p2 = @(Test-Connection -ComputerName '1.1.1.1' -Count 4 -ErrorAction SilentlyContinue)
$res.internetLoss = [math]::Round((4 - $p2.Count) * 25, 0)
if ($p2.Count) { $res.internetMs = [math]::Round((($p2 | Measure-Object -Property ResponseTime -Average).Average), 1) }
$sw = [Diagnostics.Stopwatch]::StartNew()
try { Resolve-DnsName -Name 'www.microsoft.com' -Type A -DnsOnly -ErrorAction Stop | Out-Null; $res.dnsOk = $true; $res.dnsMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) } catch {}
[pscustomobject]$res | ConvertTo-Json -Compress`

defineQuery({
  id: 'network.connectivity',
  module: 'network',
  parse: (raw) => {
    obj(raw, [])
    return {}
  },
  async run() {
    const r = await runPowerShellJson<Record<string, unknown>>(CONNECTIVITY, { timeoutMs: 40_000 })
    if (!r) throw new AppFailure('connectivity', 'Não foi possível executar o diagnóstico de conectividade.')
    return { gateway: asString(r.gateway), gatewayMs: asNumber(r.gatewayMs), gatewayLoss: asNumber(r.gatewayLoss), internetMs: asNumber(r.internetMs), internetLoss: asNumber(r.internetLoss), dnsOk: r.dnsOk === true, dnsMs: asNumber(r.dnsMs), at: new Date().toISOString() }
  }
})
