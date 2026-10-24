// Limpeza ampliada do Windows (Otimização 2): temporários do usuário e do sistema, Prefetch (com verificação de
// compatibilidade), logs elegíveis, relatórios de erro, cache de miniaturas do Explorador e cache da Internet.
// Cada alvo é uma lista fixa de pastas; só arquivos comuns são apagados (nunca links), arquivos em uso são
// ignorados, e o espaço liberado é MEDIDO pelo espaço livre da unidade antes e depois. Nada vai para a Lixeira.
import { execFile } from 'node:child_process'
import { existsSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { formatBytes } from '@shared/format'
import type { TaskDetailSection } from '@shared/types'
import { defineAction, defineQuery } from '../ops/registry'
import { int, obj, strList } from '../ops/params'
import { AppFailure } from '../security/validate'
import { runElevated } from '../services/elevated'
import { deleteFilesSafely, mergeScans, scanFiles, userTempPaths, type ScanResult } from './fsutil'

export interface ExtraTarget {
  id: string
  label: string
  description: string
  group: 'Temporários' | 'Logs e relatórios' | 'Caches'
  paths: string[]
  needsAdmin: boolean
  /** Filtro por nome do arquivo (null = todos os arquivos comuns da pasta). */
  match: RegExp | null
  /** Idade mínima padrão em horas (protege arquivos em uso). */
  minAgeHours: number
  /** Efeito a informar antes de executar. */
  effect: string
}

const env = (n: string) => process.env[n] ?? ''

export function extraTargets(): ExtraTarget[] {
  const sys = env('SystemRoot') || 'C:\\Windows'
  const local = env('LOCALAPPDATA')
  const pd = env('ProgramData') || 'C:\\ProgramData'
  const user = userTempPaths()
  return [
    {
      id: 'temp-user',
      label: 'Temporários do usuário',
      description: 'Pastas %TEMP% e %TMP% do usuário atual.',
      group: 'Temporários',
      paths: user,
      needsAdmin: false,
      match: null,
      minAgeHours: 1,
      effect: 'Programas abertos podem recriar arquivos temporários; arquivos em uso são ignorados.'
    },
    {
      id: 'temp-system',
      label: 'Temporários do sistema (C:\\Windows\\Temp)',
      description: 'Arquivos temporários que o Windows e instaladores deixam em C:\\Windows\\Temp.',
      group: 'Temporários',
      paths: [join(sys, 'Temp')],
      needsAdmin: true,
      match: null,
      minAgeHours: 1,
      effect: 'Exige administrador. Arquivos de instalações em andamento são ignorados por estarem em uso.'
    },
    {
      id: 'prefetch',
      label: 'Prefetch do Windows',
      description: 'Arquivos que aceleram a abertura de programas já usados.',
      group: 'Temporários',
      paths: [join(sys, 'Prefetch')],
      needsAdmin: true,
      match: /\.pf$/i,
      minAgeHours: 0,
      effect: 'O Windows recria os arquivos .pf; as primeiras aberturas de programas podem ficar um pouco mais lentas. Só aparece quando o Prefetch está ativo.'
    },
    {
      id: 'logs-user',
      label: 'Relatórios de erro e despejos do usuário',
      description: 'Relatórios do Relatório de Erros do Windows (ReportArchive/ReportQueue) e CrashDumps do usuário.',
      group: 'Logs e relatórios',
      paths: local ? [join(local, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), join(local, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), join(local, 'CrashDumps')] : [],
      needsAdmin: false,
      match: null,
      minAgeHours: 24,
      effect: 'Perde-se o histórico de falhas para diagnóstico; os programas continuam funcionando.'
    },
    {
      id: 'logs-system',
      label: 'Relatórios de erro e logs do sistema',
      description: 'WER do sistema (ProgramData) e logs/cabinets antigos do CBS (C:\\Windows\\Logs\\CBS).',
      group: 'Logs e relatórios',
      paths: [join(pd, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), join(pd, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), join(sys, 'Logs', 'CBS')],
      needsAdmin: true,
      match: /\.(wer|log|cab|dmp|etl|txt|hdmp|mdmp)$/i,
      minAgeHours: 24,
      effect: 'Exige administrador. Logs do CBS servem para diagnosticar falhas de atualização; só arquivos com mais de 24 h são removidos.'
    },
    {
      id: 'explorer-cache',
      label: 'Cache de miniaturas e ícones do Explorador',
      description: 'thumbcache_*.db e iconcache_*.db em %LOCALAPPDATA%\\Microsoft\\Windows\\Explorer.',
      group: 'Caches',
      paths: local ? [join(local, 'Microsoft', 'Windows', 'Explorer')] : [],
      needsAdmin: false,
      match: /^(thumbcache|iconcache)_.*\.db$/i,
      minAgeHours: 0,
      effect: 'O Explorador recria os caches: a primeira abertura de pastas com imagens/vídeos fica mais lenta. Arquivos em uso pelo Explorador são ignorados.'
    },
    {
      id: 'update-download',
      label: 'Arquivos baixados do Windows Update',
      description: 'Pacotes já baixados em C:\Windows\SoftwareDistribution\Download (o Windows baixa de novo se precisar).',
      group: 'Caches',
      paths: [join(sys, 'SoftwareDistribution', 'Download')],
      needsAdmin: true,
      match: null,
      minAgeHours: 24,
      effect: 'Exige administrador. Atualizações pendentes podem ser baixadas novamente; arquivos em uso são ignorados.'
    },
    {
      id: 'browser-chromium',
      label: 'Caches do Chrome, Edge e Brave (somente cache)',
      description: 'Pastas Cache e Code Cache do perfil padrão. Cookies, senhas, histórico e logins NÃO são tocados.',
      group: 'Caches',
      paths: local
        ? ['Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser'].flatMap((b) => [join(local, b, 'User Data', 'Default', 'Cache'), join(local, b, 'User Data', 'Default', 'Code Cache')])
        : [],
      needsAdmin: false,
      match: null,
      minAgeHours: 1,
      effect: 'Feche o navegador antes: arquivos em uso são ignorados. Sites podem carregar mais devagar na primeira visita.'
    },
    {
      id: 'inet-cache',
      label: 'Cache da Internet (INetCache)',
      description: 'Arquivos de internet em cache usados pelo Windows e por componentes do navegador clássico.',
      group: 'Caches',
      paths: local ? [join(local, 'Microsoft', 'Windows', 'INetCache')] : [],
      needsAdmin: false,
      match: null,
      minAgeHours: 1,
      effect: 'Páginas e imagens em cache serão baixadas de novo quando necessárias.'
    }
  ]
}

const REG_PREFETCH = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters'

/** Valor EnablePrefetcher (0 = desativado) ou null quando não foi possível ler. */
function readPrefetcher(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', REG_PREFETCH, '/v', 'EnablePrefetcher'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const m = /EnablePrefetcher\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout))
      resolve(err || !m ? null : parseInt(m[1], 16))
    })
  })
}

/** Motivo pelo qual o alvo não pode ser limpo neste computador (null = disponível). */
export async function targetUnavailable(t: ExtraTarget): Promise<string | null> {
  if (t.paths.length === 0) return 'Pasta não encontrada neste computador.'
  if (t.id === 'prefetch') {
    const v = await readPrefetcher()
    if (v === 0) return 'O Prefetch está desativado neste Windows (EnablePrefetcher=0); não há o que limpar.'
    if (!existsSync(t.paths[0])) return 'A pasta Prefetch não existe neste computador.'
  }
  if (!t.paths.some((p) => existsSync(p))) return 'Nenhuma das pastas existe neste computador.'
  return null
}

function driveFree(path: string): number | null {
  try {
    const s = statfsSync(path)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

async function scanTarget(t: ExtraTarget, signal: AbortSignal, minAgeHours: number): Promise<ScanResult & { inaccessibleRoots: number }> {
  const scans: ScanResult[] = []
  let inaccessibleRoots = 0
  for (const p of t.paths) {
    if (!existsSync(p)) continue
    const s = await scanFiles(p, { maxEntries: 300_000, maxMs: 30_000, minAgeMs: minAgeHours * 3_600_000, signal })
    if (s.inaccessible.includes(p)) inaccessibleRoots++
    scans.push(s)
  }
  const merged = mergeScans(scans)
  if (t.match) {
    const files = merged.files.filter((f) => t.match!.test(f.path.slice(Math.max(f.path.lastIndexOf('\\'), f.path.lastIndexOf('/')) + 1)))
    return { ...merged, files, totalBytes: files.reduce((a, f) => a + f.size, 0), inaccessibleRoots }
  }
  return { ...merged, inaccessibleRoots }
}

defineQuery({
  id: 'cleanup.extra.scan',
  module: 'cleanup',
  parse: (raw) => ({ targets: raw === undefined ? [] : strList(obj(raw, ['targets']).targets ?? [], 'alvos', 20, 40, /^[a-z-]+$/) }),
  async run({ targets }, ctx) {
    const list = extraTargets().filter((t) => targets.length === 0 || targets.includes(t.id))
    const out = []
    for (const [i, t] of list.entries()) {
      ctx.progress(`Analisando ${t.label}`, i, list.length)
      const unavailable = await targetUnavailable(t)
      const scan = unavailable ? null : await scanTarget(t, ctx.signal, t.minAgeHours)
      out.push({
        id: t.id,
        label: t.label,
        description: t.description,
        group: t.group,
        needsAdmin: t.needsAdmin,
        effect: t.effect,
        unavailable,
        paths: t.paths,
        files: scan?.files.length ?? 0,
        bytes: scan?.totalBytes ?? 0,
        // Sem administrador, parte de algumas pastas não pode ser lida: o tamanho real pode ser maior.
        partial: !!scan && (scan.inaccessible.length > 0 || scan.partial),
        minAgeHours: t.minAgeHours
      })
    }
    return { targets: out, free: driveFree(env('SystemDrive') ? env('SystemDrive') + '\\' : 'C:\\') }
  }
})

// Script elevado: enumera e remove arquivos comuns dentro de raízes permitidas (Windows\Temp, Prefetch,
// Logs\CBS e WER do ProgramData). Não segue links, ignora arquivos em uso e respeita o filtro de extensão.
const ELEVATED_CLEAN = `
$sys = [IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\\')
$pd = [IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\\')
$allowed = @("$sys\\Temp", "$sys\\Prefetch", "$sys\\Logs\\CBS", "$sys\\SoftwareDistribution\\Download", "$pd\\Microsoft\\Windows\\WER\\ReportArchive", "$pd\\Microsoft\\Windows\\WER\\ReportQueue")
$cutoff = (Get-Date).AddHours(-[double]$in.minAgeHours)
$rx = if ($in.pattern) { [regex]::new([string]$in.pattern, 'IgnoreCase') } else { $null }
$deleted = 0; $bytes = 0; $locked = 0; $skipped = 0
foreach ($r in @($in.roots)) {
  $root = [IO.Path]::GetFullPath([string]$r).TrimEnd('\\')
  if ($allowed -notcontains $root) { $skipped++; continue }
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { $skipped++; return }
      if (-not $_.FullName.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)) { $skipped++; return }
      if ($_.LastWriteTime -gt $cutoff) { $skipped++; return }
      if ($rx -and -not $rx.IsMatch($_.Name)) { return }
      $size = $_.Length
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
      $deleted++; $bytes += $size
    } catch { $locked++ }
  }
}
Out-Result ([pscustomobject]@{ deleted = $deleted; bytes = $bytes; locked = $locked; skipped = $skipped })
exit 0`

interface ExtraParams {
  targets: string[]
  minAgeHours: number | null
}

function parseExtra(raw: unknown): ExtraParams {
  const p = obj(raw, ['targets', 'minAgeHours'])
  const targets = [...new Set(strList(p.targets, 'alvos', 20, 40, /^[a-z-]+$/))]
  const known = new Set(extraTargets().map((t) => t.id))
  if (targets.length === 0 || targets.some((t) => !known.has(t))) throw new AppFailure('invalid-input', 'Escolha pelo menos um alvo de limpeza válido.')
  return { targets, minAgeHours: p.minAgeHours === undefined ? null : int(p.minAgeHours, 'idade mínima (horas)', 0, 720) }
}

const patternOf = (t: ExtraTarget) => (t.match ? t.match.source : null)

defineAction<ExtraParams, never>({
  id: 'cleanup.extra.clean',
  module: 'cleanup',
  title: 'Limpeza consolidada do Windows',
  description: 'Remove arquivos temporários, logs elegíveis e caches dos alvos escolhidos e mede o espaço realmente liberado.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Os arquivos apagados não vão para a Lixeira e não podem ser restaurados.',
  requiresElevation: (p) => extraTargets().some((t) => p.targets.includes(t.id) && t.needsAdmin),
  exclusive: 'cleanup',
  parse: parseExtra,
  async preview(params, ctx) {
    const chosen = extraTargets().filter((t) => params.targets.includes(t.id))
    const changes = []
    const warnings: string[] = []
    let count = 0
    for (const t of chosen) {
      const unavailable = await targetUnavailable(t)
      if (unavailable) {
        warnings.push(`${t.label}: ${unavailable}`)
        continue
      }
      const scan = await scanTarget(t, ctx.signal, params.minAgeHours ?? t.minAgeHours)
      count += scan.files.length
      changes.push({ target: t.label, current: `${scan.files.length.toLocaleString('pt-BR')} arquivos · ${formatBytes(scan.totalBytes)}${t.needsAdmin ? ' (visível sem administrador)' : ''}`, intended: 'Elegíveis removidos' })
      warnings.push(`${t.label}: ${t.effect}`)
    }
    warnings.push('Arquivos em uso, recentes, links e junctions são ignorados. Nada vai para a Lixeira: a exclusão não pode ser desfeita.')
    const admin = chosen.some((t) => t.needsAdmin)
    if (admin) warnings.push('Alvos do sistema exigem administrador: o Windows pedirá permissão uma única vez. Se você recusar, a limpeza do sistema é cancelada.')
    return {
      summary: `${chosen.length} alvo(s) selecionado(s).`,
      changes,
      warnings,
      blocked: changes.length === 0 ? 'Nenhum dos alvos escolhidos está disponível neste computador.' : count === 0 && !admin ? 'Nenhum arquivo elegível encontrado.' : null
    }
  },
  async execute(params, ctx) {
    const chosen = extraTargets().filter((t) => params.targets.includes(t.id))
    const drive = (env('SystemDrive') || 'C:') + '\\'
    const freeBefore = driveFree(drive)
    const sections: TaskDetailSection[] = []
    let freed = 0
    let deleted = 0
    let failed = 0
    const total = chosen.length
    for (const [i, t] of chosen.entries()) {
      const emit = (state: 'running' | 'ok' | 'error' | 'skipped', message?: string) => ctx.progress(`${t.label}…`, state === 'running' ? i : i + 1, total, { stage: 'item', id: t.id, name: t.label, state, message })
      if (ctx.signal.aborted) {
        emit('skipped', 'Cancelado')
        sections.push({ title: t.label, rows: [{ label: 'Resultado', value: 'Não processado (cancelado)', tone: 'warn' }] })
        continue
      }
      emit('running')
      const unavailable = await targetUnavailable(t)
      if (unavailable) {
        emit('skipped', unavailable)
        sections.push({ title: t.label, rows: [{ label: 'Ignorado', value: unavailable, tone: 'warn' }] })
        continue
      }
      const minAge = params.minAgeHours ?? t.minAgeHours
      try {
        if (t.needsAdmin) {
          const { output } = await runElevated<{ deleted: number; bytes: number; locked: number; skipped: number }>(
            ELEVATED_CLEAN,
            { roots: t.paths, minAgeHours: minAge, pattern: patternOf(t) },
            { timeoutMs: 15 * 60_000, signal: ctx.signal }
          )
          const r = output ?? { deleted: 0, bytes: 0, locked: 0, skipped: 0 }
          freed += r.bytes
          deleted += r.deleted
          emit('ok', `${r.deleted.toLocaleString('pt-BR')} arquivos · ${formatBytes(r.bytes)}`)
          sections.push({
            title: t.label,
            rows: [
              { label: 'Removidos', value: `${r.deleted.toLocaleString('pt-BR')} arquivos · ${formatBytes(r.bytes)}`, tone: 'ok' },
              { label: 'Em uso ou bloqueados (ignorados)', value: String(r.locked) },
              { label: 'Recentes/links (ignorados)', value: String(r.skipped) }
            ]
          })
        } else {
          const scan = await scanTarget(t, ctx.signal, minAge)
          const report = await deleteFilesSafely(scan.files, t.paths, { signal: ctx.signal, minAgeMs: minAge * 3_600_000 })
          freed += report.bytesFreed
          deleted += report.deleted
          emit('ok', `${report.deleted.toLocaleString('pt-BR')} arquivos · ${formatBytes(report.bytesFreed)}`)
          sections.push({
            title: t.label,
            rows: [
              { label: 'Removidos', value: `${report.deleted.toLocaleString('pt-BR')} arquivos · ${formatBytes(report.bytesFreed)}`, tone: 'ok' },
              { label: 'Em uso (ignorados)', value: String(report.skippedLocked) },
              { label: 'Sem permissão (ignorados)', value: String(report.skippedDenied), tone: report.skippedDenied ? 'warn' : 'neutral' },
              ...report.errors.slice(0, 3).map((e) => ({ label: 'Erro', value: e, tone: 'error' as const }))
            ]
          })
        }
      } catch (error) {
        failed++
        emit('error', (error as Error).message)
        sections.push({ title: t.label, rows: [{ label: 'Falhou', value: (error as Error).message, tone: 'error' }] })
      }
    }
    const freeAfter = driveFree(drive)
    const measured = freeBefore !== null && freeAfter !== null ? freeAfter - freeBefore : null
    sections.push({
      title: 'Espaço liberado',
      rows: [
        { label: 'Soma dos arquivos removidos', value: formatBytes(freed) },
        { label: `Espaço livre em ${drive} (medido)`, value: measured === null ? 'indisponível' : `${formatBytes(freeBefore!)} → ${formatBytes(freeAfter!)} (${measured >= 0 ? '+' : '−'}${formatBytes(Math.abs(measured))})` }
      ]
    })
    return {
      ok: failed === 0,
      verified: true,
      summary: `${deleted.toLocaleString('pt-BR')} arquivos removidos (${formatBytes(freed)}); espaço livre medido ${measured === null ? 'indisponível' : `${measured >= 0 ? '+' : '−'}${formatBytes(Math.abs(measured))}`}.${failed ? ` ${failed} alvo(s) falharam.` : ''}`,
      sections
    }
  }
})
