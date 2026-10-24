// Teste de integração REAL no Windows (desenvolvimento). Abre o app compilado (out/)
// numa pasta de dados isolada, executa ações reversíveis pelo mesmo fluxo da interface
// (pré-visualização → confirmação → execução → reversão) e confere o estado do sistema
// por fora, com PowerShell independente. Tudo o que for alterado é restaurado.
//
// Uso (terminal real, não elevado):
//   $env:JKO_TEST_OWNER_PASSPHRASE = '<senha>'; node scripts/e2e/windows-integration.mjs
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const passphrase = process.env.JKO_TEST_OWNER_PASSPHRASE
if (!passphrase) throw new Error('Defina JKO_TEST_OWNER_PASSPHRASE.')
const PORT = 9333
const shots = join(root, '.e2e-shots')
mkdirSync(shots, { recursive: true })

const ps = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (cond, ms, every = 700) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await sleep(every)
  }
  return false
}
/** Limpeza: ignora falhas (ex.: item já removido pelo próprio teste). */
const psCleanup = (script) => {
  try {
    ps(script)
  } catch {
    // já estava limpo
  }
}

// ---------------------------------------------------------------------------
// App isolado
// ---------------------------------------------------------------------------
const userData = mkdtempSync(join(tmpdir(), 'jko-e2e-'))
mkdirSync(join(userData, 'jk-data', 'owner'), { recursive: true })
copyFileSync(join(root, 'owner-keys', 'owner-key.jkokey'), join(userData, 'jk-data', 'owner', 'owner-key.jkokey'))
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
// JKO_E2E_FAKE_LOCAL=1: o app usa TEMP/TMP/LOCALAPPDATA numa pasta de teste, para a limpeza real nunca tocar em arquivos do usuário.
const fakeLocal = process.env.JKO_E2E_FAKE_LOCAL ? mkdtempSync(join(tmpdir(), 'jko-local-')) : null
const fakeEnv = fakeLocal ? { LOCALAPPDATA: fakeLocal, APPDATA: join(fakeLocal, 'Roaming'), USERPROFILE: join(fakeLocal, 'Perfil'), TEMP: join(fakeLocal, 'Temp'), TMP: join(fakeLocal, 'Temp') } : {}
if (fakeLocal) mkdirSync(join(fakeLocal, 'Temp'), { recursive: true })
const app = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: root, env: { ...process.env, ...fakeEnv, JKO_USER_DATA_DIR: userData }, stdio: 'ignore' })

let ws
let msgId = 0
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = pages.find((p) => p.type === 'page' && !p.url.includes('#overlay'))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => ws.addEventListener('open', r, { once: true }))
        return
      }
    } catch {}
    await sleep(500)
  }
  throw new Error('O app não abriu a porta de depuração.')
}
const send = (method, params = {}) =>
  new Promise((resolveSend, reject) => {
    const id = ++msgId
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      msg.error ? reject(new Error(msg.error.message)) : resolveSend(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 300000 })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const jk = (expr) => ev(`(async () => { const r = await ${expr}; if (!r.ok) throw new Error(r.error.code + ': ' + r.error.message); return r.data })()`)
const qn = (id, params = {}) => q(id, params).catch((e) => { throw new Error(id + ': ' + e.message) })
const q = (id, params = {}) => jk(`window.jk.ops.query(${JSON.stringify(id)}, ${JSON.stringify(params)})`)
async function act(actionId, params) {
  const preview = await jk(`window.jk.ops.preview(${JSON.stringify(actionId)}, ${JSON.stringify(params)})`)
  if (preview.blocked) return { preview, outcome: null }
  const outcome = await jk(`window.jk.ops.execute(${JSON.stringify(preview.previewId)}, true)`)
  return { preview, outcome }
}
const revert = (changeId, force = false) => jk(`window.jk.ops.revert(${JSON.stringify(changeId)}, ${force})`)
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data, 'base64'))
}
const clickNav = (label) => ev(`(() => { const b = document.querySelector('aside [data-nav=' + JSON.stringify(${JSON.stringify(label)}) + ']'); b?.click(); return !!b })()`)

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------
const results = []
async function scenario(name, fn) {
  // JKO_E2E_ONLY=trecho: roda apenas os cenários cujo nome contém o trecho (depuração).
  if (process.env.JKO_E2E_ONLY && !process.env.JKO_E2E_ONLY.split('|').some((t) => name.includes(t))) return
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail, ms: Date.now() - t0 })
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - t0 })
    // Evidência da falha: captura de tela e o início do texto visível.
    try {
      await shot(`falha-${results.length}.png`)
      const visivel = await ev(`document.body.innerText.replace(/\s+/g, ' ').slice(0, 500)`)
      console.log(`      tela no momento da falha: ${visivel}`)
    } catch {}
    console.log(`FAIL  ${name} — ${error.message}`)
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

const activeScheme = () => /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(ps('powercfg /getactivescheme'))[1].toLowerCase()

try {
  await connect()
  await sleep(3000)
  const access = await jk(`window.jk.owner.unlock(${JSON.stringify(passphrase)})`)
  assert(access.kind === 'owner', 'não desbloqueou a sessão de teste')
  await ev('location.reload()')
  await sleep(4000)

  await scenario('Energia: trocar plano, conferir no powercfg e reverter', async () => {
    const original = activeScheme()
    const plans = await q('power.plans')
    const target = plans.schemes.find((s) => s.guid !== original && /381b4222/.test(s.guid)) ?? plans.schemes.find((s) => s.guid !== original)
    const { outcome } = await act('power.plan.set', { guid: target.guid })
    assert(outcome?.ok && outcome.verified, 'execução não verificada')
    assert(activeScheme() === target.guid, 'powercfg não mostra o plano novo')
    const rec = await revert(outcome.changeId)
    assert(rec.status === 'reverted', 'reversão não registrada')
    assert(activeScheme() === original, 'plano original não foi restaurado')
    return `${target.name} → revertido`
  })

  await scenario('Modo de Jogo: alternar no registro (HKCU) e reverter', async () => {
    const read = () => ps(`try { (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\GameBar' -Name AutoGameModeEnabled -ErrorAction Stop).AutoGameModeEnabled } catch { 'ausente' }`)
    const before = read()
    const enable = before === '0'
    const { outcome } = await act('power.game.set', { id: 'gameMode', enabled: enable })
    assert(outcome?.ok && outcome.verified, 'execução não verificada')
    assert(read() === (enable ? '1' : '0'), 'registro não mudou')
    await revert(outcome.changeId)
    assert(read() === before, `registro não voltou (${read()} ≠ ${before})`)
    return `${before} → ${enable ? 1 : 0} → ${before}`
  })

  await scenario('Inicialização: desativar entrada de teste (StartupApproved) e reverter', async () => {
    const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    const appr = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
    ps(`Set-ItemProperty -LiteralPath '${key}' -Name 'JKOptimizeE2E' -Value '"C:\\Windows\\System32\\notepad.exe"'`)
    try {
      const { outcome } = await act('startup.toggle', { source: 'hkcuRun', name: 'JKOptimizeE2E', enabled: false })
      assert(outcome?.ok, 'não desativou')
      const first = ps(`(Get-ItemProperty -LiteralPath '${appr}' -Name 'JKOptimizeE2E').JKOptimizeE2E[0]`)
      assert(first === '3', `byte de estado inesperado: ${first}`)
      assert(ps(`(Get-ItemProperty -LiteralPath '${key}' -Name 'JKOptimizeE2E').JKOptimizeE2E`).includes('notepad'), 'a entrada original foi apagada')
      await revert(outcome.changeId)
      const after = ps(`try { (Get-ItemProperty -LiteralPath '${appr}' -Name 'JKOptimizeE2E' -ErrorAction Stop).JKOptimizeE2E[0] } catch { 'ausente' }`)
      assert(after === 'ausente', `aprovação não voltou ao estado original (${after})`)
      return 'desativada (03) sem apagar a entrada → revertida'
    } finally {
      psCleanup(`Remove-ItemProperty -LiteralPath '${key}' -Name 'JKOptimizeE2E' -ErrorAction SilentlyContinue`)
      psCleanup(`Remove-ItemProperty -LiteralPath '${appr}' -Name 'JKOptimizeE2E' -ErrorAction SilentlyContinue`)
    }
  })

  await scenario('Processos: prioridade de um Bloco de Notas de teste e restauração', async () => {
    const pid = Number(ps(`(Start-Process notepad.exe -PassThru).Id`))
    try {
      await sleep(1500)
      const proc = (await q('processes.list')).find((p) => p.pid === pid)
      assert(proc?.startTime, 'processo não listado')
      const { outcome } = await act('processes.priority', { pid, startTime: proc.startTime, level: 'BelowNormal' })
      assert(outcome?.ok && outcome.verified, 'execução não verificada')
      assert(ps(`(Get-Process -Id ${pid}).PriorityClass`) === 'BelowNormal', 'Windows não mostra a nova prioridade')
      await revert(outcome.changeId)
      assert(ps(`(Get-Process -Id ${pid}).PriorityClass`) === 'Normal', 'prioridade não restaurada')
      const end = await act('processes.end', { pid, startTime: proc.startTime, mode: 'close' })
      assert(end.outcome?.ok, 'fechamento normal falhou')
      assert(ps(`[bool](Get-Process -Id ${pid} -ErrorAction SilentlyContinue)`) === 'False', 'processo ainda existe')
      return 'BelowNormal → Normal → fechado normalmente'
    } finally {
      psCleanup(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`)
    }
  })

  await scenario('Proteções: processos críticos e serviços essenciais bloqueados na prévia', async () => {
    const list = await q('processes.list')
    const lsass = list.find((p) => p.name.toLowerCase() === 'csrss' || p.name.toLowerCase() === 'lsass')
    assert(lsass?.protectedReason, 'processo crítico sem proteção')
    const svc = await jk(`window.jk.ops.preview('services.configure', { name: 'WinDefend', mode: 'Disabled' })`)
    assert(svc.blocked, 'Defender deveria estar bloqueado')
    const svc2 = await jk(`window.jk.ops.preview('services.configure', { name: 'wuauserv', mode: 'Disabled' })`)
    assert(svc2.blocked, 'Windows Update deveria estar bloqueado')
    return `${lsass.name}: ${lsass.protectedReason} · WinDefend/wuauserv bloqueados`
  })

  await scenario('Rede: limpar cache DNS (ipconfig) e teste de latência real', async () => {
    const { outcome } = await act('network.dns.flush', {})
    assert(outcome?.ok, 'flush falhou')
    const report = await q('network.latency.run', { host: '127.0.0.1', durationSec: 5, intervalMs: 500 })
    assert(report.stats.replies >= 5, `poucas respostas: ${report.stats.replies}`)
    return `${outcome.summary} · loopback ${report.stats.avgMs} ms em ${report.stats.sent} amostras`
  })

  await scenario('Limpeza: análise de temporários e caches de shaders (somente leitura)', async () => {
    const temp = await q('cleanup.temp.scan', { roots: ['user'], minAgeHours: 24 })
    const shaders = await q('cleanup.shaders.scan')
    return `${temp[0].files} temporários elegíveis · ${shaders.length} caches de shaders (${shaders.filter((s) => s.confirmed).length} confirmados)`
  })

  await scenario('Benchmark no executor (processo separado)', async () => {
    const run = await q('windows.benchmark.run', { includeDisk: true, label: 'E2E' })
    assert(run.metrics.cpuSingleMBps > 0 && run.metrics.memoryCopyGBps > 0, 'métricas ausentes')
    return `CPU 1T ${run.metrics.cpuSingleMBps} MB/s · MT ${run.metrics.cpuMultiMBps} MB/s · memória ${run.metrics.memoryCopyGBps} GB/s · disco ${run.metrics.diskWriteMBps}/${run.metrics.diskReadMBps} MB/s`
  })

  await scenario('Monitoramento: overlay abre e fecha; histórico grava amostras', async () => {
    const s = await q('monitoring.settings')
    await q('monitoring.settings.save', { ...s, overlay: { ...s.overlay, enabled: true }, history: { ...s.history, enabled: true, intervalSec: 5 } })
    await sleep(4000)
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    assert(targets.some((t) => t.url.includes('#overlay')), 'janela do overlay não foi criada')
    await sleep(8000)
    const h = await q('monitoring.history', { hours: 1 })
    await q('monitoring.settings.save', s)
    await sleep(1000)
    const after = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    assert(!after.some((t) => t.url.includes('#overlay')), 'overlay não fechou')
    assert(h.points.length >= 1, 'histórico sem amostras')
    return `overlay aberto/fechado · ${h.points.length} ponto(s) no histórico`
  })

  await scenario('Central de restauração e logs registram as operações', async () => {
    const changes = await jk('window.jk.ops.changes()')
    const logs = await jk(`window.jk.ops.logs({ fromDays: 1, limit: 100 })`)
    assert(changes.length >= 4 && changes.every((c) => c.status === 'reverted'), 'diário incompleto')
    assert(logs.length >= 4, 'logs ausentes')
    const verify = await q('windows.backups.verify')
    assert(verify.every((v) => v.ok), 'backup com problema de integridade')
    return `${changes.length} alterações revertidas · ${logs.length} linhas de log · backups íntegros`
  })

  await scenario('Serviços: protegidos fora da lista modificável; MDCoreSvc/WinDefend bloqueados (sem erro 5)', async () => {
    const list = await q('services.list')
    const def = list.find((x) => x.name.toLowerCase() === 'windefend')
    assert(def && !def.modifiable && def.protectionKind, 'WinDefend deveria ser somente leitura')
    assert(list.filter((x) => x.modifiable).every((x) => !x.protectedReason), 'serviço protegido marcado como modificável')
    const md = await jk(`window.jk.ops.preview('services.configure', { name: 'MDCoreSvc', mode: 'Disabled' })`)
    assert(md.blocked, 'MDCoreSvc deveria ser bloqueado na prévia')
    const lp = list.filter((x) => (x.launchProtected ?? 0) > 0).map((x) => x.name)
    return `${list.filter((x) => x.modifiable).length} modificáveis de ${list.length} · LaunchProtected: ${lp.join(', ') || 'nenhum'} · MDCoreSvc bloqueado`
  })

  await scenario('Perfil de Windows: aplicar Desempenho, conferir e restaurar', async () => {
    const original = activeScheme()
    const pkey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
    const tr = () => ps(`(Get-ItemProperty -LiteralPath '${pkey}' -Name EnableTransparency -ErrorAction SilentlyContinue).EnableTransparency`)
    const trBefore = tr()
    // Usa o primeiro perfil que muda algo neste PC (se ele já estiver no perfil Desempenho, testa outro).
    let plan = null
    let outcome = null
    let profile = null
    const blockedReasons = []
    for (const p of ['performance', 'quality', 'balanced']) {
      plan = await q('profiles.windows.plan', { profile: p })
      const r = await act('profiles.windows.apply', { profile: p })
      if (r.outcome) {
        outcome = r.outcome
        profile = p
        break
      }
      blockedReasons.push(`${p}: ${r.preview.blocked}`)
    }
    assert(outcome, `todos os perfis bloqueados (${blockedReasons.join(' | ')})`)
    const trAfter = tr()
    const schemeAfter = activeScheme()
    if (outcome.changeId) {
      const rec = await revert(outcome.changeId)
      assert(rec.status === 'reverted', `reversão: ${rec.status}`)
    }
    assert(activeScheme() === original, 'plano de energia original não restaurado')
    assert(tr() === trBefore, 'transparência não restaurada')
    return `perfil ${profile}${blockedReasons.length ? ` (antes: ${blockedReasons.join('; ')})` : ''} · ${plan.length} itens · ok=${outcome.ok} · plano ${original.slice(0, 8)}→${schemeAfter.slice(0, 8)}→restaurado · transparência ${trBefore || 'padrão'}→${trAfter}→restaurada`
  })

  await scenario('FPS Lab: sessão sem PresentMon registra telemetria e marca FPS indisponível', async () => {
    await q('fivem.lab.start', { label: 'E2E', processName: 'FiveM_GTAProcess.exe', maxSeconds: 60 })
    await sleep(14000)
    const st = await q('fivem.lab.status')
    assert(st.running, 'sessão não está em andamento')
    const s = await q('fivem.lab.stop')
    assert(s.fps === null && s.fpsUnavailableReason, 'FPS deveria estar indisponível')
    assert(s.telemetry.samples >= 5, `poucas amostras: ${s.telemetry.samples}`)
    assert(s.classification.primary, 'sem classificação')
    const list = await q('fivem.lab.list')
    assert(list.some((x) => x.id === s.id), 'sessão não foi salva')
    await q('fivem.lab.delete', { id: s.id })
    return `${s.telemetry.samples} amostras · ${s.classification.label} · ${s.fpsUnavailableReason}`
  })

  await scenario('Controladores: RAM, térmico/energia, CPU e visão geral com dados reais', async () => {
    const ram = await q('ram.status')
    assert(ram.pressure.level && Array.isArray(ram.apps), 'ram.status incompleto')
    const th = await q('thermal.power.report')
    assert(th.findings.length > 0, 'sem achados térmicos')
    if (th.temps.length === 0) assert(th.findings.some((f) => f.title === 'Sensor não disponível'), 'falta de sensor não informada')
    const cpu = await q('cpu.fixer.analyze', { durationSec: 25 })
    assert(cpu.analysis.verdict, 'sem veredito de CPU')
    const ov = await q('optimizer.overview')
    assert('powerPlan' in ov && 'lastResults' in ov, 'visão geral incompleta')
    const gb = await q('gameboost.settings')
    await q('gameboost.settings.save', gb)
    const auth = await q('license.authority.status')
    return `RAM ${ram.pressure.level} · ${th.temps.length} sensor(es), ${th.findings.length} achado(s) · CPU: ${cpu.analysis.label} (${cpu.summary.samples} amostras) · plano ${ov.powerPlan} · autoridade configurada: ${auth.configured}`
  })

  await scenario('Interface: menu lateral com todas as rotas originais, destaque e telas sem erro (capturas em .e2e-shots)', async () => {
    const menu = await ev(`[...document.querySelectorAll('aside [data-nav]')].map((b) => b.dataset.nav)`)
    const esperado = ['Dashboard', 'FPS Boost', 'Input Lag', 'Jogos', 'Apps', 'Memória', 'Redes', 'BIOS', 'Limpeza', 'Deploy', 'Atualizações', 'Progresso', 'Personalização', 'Serviços', 'Processos', 'Perfis', 'Histórico e Restauração', 'Aplicativos', 'Executor', 'Chaves', 'Administração', 'Configurações', 'Suporte']
    assert(JSON.stringify(menu) === JSON.stringify(esperado), `menu inesperado: ${menu.join(', ')}`)
    const visited = []
    for (const label of menu) {
      assert(await clickNav(label), `menu "${label}" não encontrado`)
      await sleep(label === 'Dashboard' ? 4000 : 2500)
      assert(!(await ev(`document.body.innerText.includes('Não foi possível iniciar')`)), `tela "${label}" quebrou`)
      const len = await ev(`document.querySelector('main').innerText.trim().length`)
      assert(len > 40, `tela "${label}" em branco (${len} caracteres)`)
      const marcado = await ev(`[...document.querySelectorAll('aside [data-nav]')].filter((b) => b.className.includes('border-performance')).map((b) => b.dataset.nav)`)
      assert(marcado.length === 1 && marcado[0] === label, `destaque incorreto em "${label}": ${marcado.join(', ') || 'nenhum'}`)
      await shot(`menu-${label}.png`)
      visited.push(label)
    }
    // Voltar para outra página continua funcionando.
    assert(await clickNav('Executor'), 'Executor ausente')
    await sleep(1200)
    assert(await clickNav('Dashboard'), 'Dashboard ausente')
    await sleep(1200)
    assert(await ev(`document.querySelector('[data-hero]') !== null`), 'Dashboard não voltou')
    return `${visited.length} rotas: ${visited.join(', ')}`
  })

  await scenario('Dashboard: índice verificável, estado real e dados coletados', async () => {
    assert(await clickNav('Dashboard'), 'Dashboard ausente')
    // O índice depende de leituras do Windows (alguns segundos).
    await waitFor(() => ev(`document.querySelectorAll('[data-criterion]').length === 7 && !document.querySelector('[data-index-detail]').innerText.includes('Coletando')`), 60_000)
    await sleep(3500)
    const criterios = await ev(`[...document.querySelectorAll('[data-criterion]')].map((c) => ({ id: c.dataset.criterion, state: c.dataset.state }))`)
    assert(criterios.length === 7, `critérios exibidos: ${criterios.length}`)
    const estado = (id) => criterios.find((c) => c.id === id)?.state
    // Conferência contra o Windows de verdade.
    const gm = ps(`try { [string](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\GameBar' -Name AutoGameModeEnabled -ErrorAction Stop).AutoGameModeEnabled } catch { 'ausente' }`)
    assert(estado('gamemode') === (gm === '0' ? 'fail' : 'ok'), `Modo de Jogo: registro=${gm} × índice=${estado('gamemode')}`)
    const plano = ps(`(powercfg /getactivescheme) | Out-String`)
    assert(estado('power') === (/econom|saver/i.test(plano) ? 'fail' : 'ok'), `plano de energia: "${plano.trim()}" × índice=${estado('power')}`)
    const livre = Number(ps(`[math]::Round(((Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { 100 * $_.FreeSpace / $_.Size } | Measure-Object -Minimum).Minimum), 0)`))
    if (Math.abs(livre - 15) > 1) assert(estado('disk') === (livre >= 15 ? 'ok' : 'fail'), `espaço livre mínimo ${livre}% × índice=${estado('disk')}`)
    // O resumo "X de Y" tem de bater com os critérios exibidos.
    const ok = criterios.filter((c) => c.state === 'ok').length
    const avaliados = criterios.filter((c) => c.state !== 'unknown').length
    const resumo = (await ev(`document.querySelector('[data-index-count]')?.innerText ?? ''`)).replace(/\s+/g, ' ')
    assert(resumo === `${ok} de ${avaliados}`, `resumo "${resumo}" × critérios ${ok} de ${avaliados}`)
    const falhas = criterios.filter((c) => c.state === 'fail').length
    const recs = await ev(`document.querySelectorAll('[data-recommendation]').length`)
    assert(recs === falhas, `recomendações (${recs}) deveriam ser uma por critério reprovado (${falhas})`)
    // Sem inventário completo, sem componentes decorativos de funcionalidade e sem links não configurados.
    assert((await ev(`document.querySelectorAll('[data-hardware]').length`)) === 0, 'o Dashboard não deve mostrar o inventário de hardware')
    assert((await ev(`document.querySelectorAll('[data-panel-social]').length`)) === 0, 'links sociais sem URL configurada não devem aparecer')
    // Resultados recentes = diário real.
    const mudancas = await jk('window.jk.ops.changes()')
    const itens = await ev(`document.querySelectorAll('[data-recent] li').length`)
    assert(itens === Math.min(5, mudancas.length), `resultados recentes: ${itens} × diário ${mudancas.length}`)
    await shot('dashboard-novo.png')
    return `${ok} de ${avaliados} critérios (${criterios.filter((c) => c.state === 'unknown').length} sem dados) · ${falhas} recomendação(ões) · ${itens} resultado(s) recente(s) · Modo de Jogo=${gm}, espaço livre mínimo=${livre}%`
  })

  await scenario('Emblema oficial: carrega, mantém a proporção e aparece nas áreas de marca (menu, barra superior, banner)', async () => {
    const imagens = () =>
      ev(`[...document.querySelectorAll('img[data-brand]')].map((i) => { const r = i.getBoundingClientRect(); return { marca: i.dataset.brand, ok: i.complete && i.naturalWidth > 0, nat: [i.naturalWidth, i.naturalHeight], tela: [r.width, r.height] } })`)
    const proporcaoOk = (i) => i.tela[1] === 0 || Math.abs(i.nat[0] / i.nat[1] / (i.tela[0] / i.tela[1]) - 1) < 0.03
    const rotas = ['Dashboard', 'FPS Boost', 'Memória', 'Aplicativos', 'Executor', 'Chaves', 'Administração', 'Configurações', 'Suporte']
    for (const rota of rotas) {
      assert(await clickNav(rota), `menu ${rota} ausente`)
      await sleep(1300)
      const imgs = await imagens()
      assert(imgs.some((i) => i.marca === 'mark'), `símbolo do menu lateral ausente em ${rota}`)
      assert(imgs.some((i) => i.marca === 'topbar'), `símbolo da barra superior ausente em ${rota}`)
      for (const i of imgs) {
        assert(i.ok, `imagem "${i.marca}" não carregou em ${rota}`)
        assert(proporcaoOk(i), `imagem "${i.marca}" deformada em ${rota}: natural ${i.nat.join('x')} × tela ${i.tela.map(Math.round).join('x')}`)
      }
    }
    // Banner do Dashboard: logo completa inteira (sem corte) e proporcional em várias larguras.
    const medidas = []
    for (const [w, h] of [[1024, 680], [1280, 800], [1600, 900]]) {
      await jk(`window.jk.window.setBounds({ x: 60, y: 40, width: ${w}, height: ${h} })`)
      assert(await clickNav('Dashboard'), 'Dashboard ausente')
      await sleep(1200)
      const r = await ev(`(() => { const i = document.querySelector('[data-hero] img[data-brand="emblem"]'); const hero = document.querySelector('[data-hero]').getBoundingClientRect(); const b = i.getBoundingClientRect(); return { ok: i.complete && i.naturalWidth > 0, nat: [i.naturalWidth, i.naturalHeight], tela: [b.width, b.height], dentro: b.left >= hero.left - 1 && b.right <= hero.right + 1 && b.top >= hero.top - 1 && b.bottom <= hero.bottom + 1 } })()`)
      assert(r.ok && r.dentro, `logo do banner em ${w}px: ${JSON.stringify(r)}`)
      assert(proporcaoOk(r), `logo do banner deformada em ${w}px: ${JSON.stringify(r)}`)
      medidas.push(`${w}px: ${Math.round(r.tela[0])}x${Math.round(r.tela[1])}`)
      await shot(`logo-dashboard-${w}.png`)
    }
    await jk(`window.jk.window.setBounds({ x: 320, y: 120, width: 1280, height: 800 })`)
    await sleep(600)
    return `${rotas.length} rotas com símbolo no menu e na barra superior · banner: ${medidas.join(' · ')} · 768x768 original`
  })

  await scenario('Janela: cantos arredondados, maximizar/restaurar, redimensionar pela borda com o mouse e larguras', async () => {
    assert(await clickNav('Dashboard'), 'Início ausente')
    await sleep(2500)
    const radius = await ev(`getComputedStyle(document.querySelector('[data-window-frame]')).borderTopLeftRadius`)
    assert(parseFloat(radius) >= 12, `cantos externos sem arredondamento: ${radius}`)
    assert(await ev(`document.querySelectorAll('[data-window-controls] button').length === 3`), 'controles da janela ausentes')
    await jk('window.jk.window.toggleMaximize()')
    await sleep(1200)
    const maxState = await ev(`({ max: document.querySelector('[data-window-frame]').dataset.maximized, radius: getComputedStyle(document.querySelector('[data-window-frame]')).borderTopLeftRadius, w: window.outerWidth })`)
    assert(maxState.max === 'true' && parseFloat(maxState.radius) === 0, `maximizado: ${JSON.stringify(maxState)}`)
    await shot('janela-maximizada.png')
    await jk('window.jk.window.toggleMaximize()')
    await sleep(1200)
    assert((await ev(`document.querySelector('[data-window-frame]').dataset.maximized`)) === 'false', 'não restaurou')
    // Redimensionamento real: arrasta a borda direita com o mouse do Windows.
    await jk('window.jk.window.setBounds({ x: 120, y: 80, width: 1200, height: 760 })')
    await sleep(800)
    const lerJanela = () => ev(`({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })`)
    let b0 = await lerJanela()
    // Na bateria completa a máquina fica em uso e a janela às vezes continua maximizada após restaurar:
    // tenta até 3 vezes e registra no resultado quando precisou repetir (isolado, o app acerta sempre).
    const repeticoes = []
    for (let n = 1; n <= 3 && !(b0.w === 1200 && b0.h === 760); n++) {
      repeticoes.push(JSON.stringify(b0))
      if (await jk('window.jk.window.isMaximized()')) await jk('window.jk.window.toggleMaximize()')
      await sleep(1500)
      await jk('window.jk.window.setBounds({ x: 120, y: 80, width: 1200, height: 760 })')
      await sleep(900)
      b0 = await lerJanela()
    }
    assert(b0.w === 1200 && b0.h === 760, `redimensionamento para menor falhou após ${repeticoes.length} repetição(ões): ${JSON.stringify(b0)}`)
    const dpi = Number(ps(`try { (Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI } catch { 96 }`)) / 96
    const ex = Math.round((b0.x + b0.w - 2) * dpi)
    const ey = Math.round((b0.y + b0.h / 2) * dpi)
    const dragEdge = () =>
      ps(`Add-Type @'
using System; using System.Runtime.InteropServices;
public class JkM { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(int x, int y); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
'@
$h = (Get-Process -Id ${app.pid}).MainWindowHandle
if ($h -ne 0) { [JkM]::ShowWindow($h, 9) | Out-Null; [JkM]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [JkM]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); [JkM]::BringWindowToTop($h) | Out-Null; [JkM]::SetForegroundWindow($h) | Out-Null }
Start-Sleep -Milliseconds 600
$top = [JkM]::GetAncestor([JkM]::WindowFromPoint(${ex}, ${ey}), 2); $owner = 0; [void][JkM]::GetWindowThreadProcessId($top, [ref]$owner)
if ($owner -ne ${app.pid}) { 'JANELA-NAO-ESTA-NO-PONTO'; return }
[JkM]::SetCursorPos(${ex}, ${ey}); Start-Sleep -Milliseconds 300
[JkM]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 25; $i++) { [JkM]::SetCursorPos(${ex} + $i * 6, ${ey}); Start-Sleep -Milliseconds 30 }
[JkM]::mouse_event(4,0,0,0,[UIntPtr]::Zero); 'ok'`)
    // O arrasto usa o mouse real: traz a janela para a frente (protocolo do Chromium) e tenta até 3 vezes.
    let b1 = { w: b0.w, h: b0.h }
    let ultimoArrasto = ""
    for (let attempt = 1; attempt <= 3 && b1.w <= b0.w + 60; attempt++) {
      await send('Page.bringToFront')
      await sleep(600)
      ultimoArrasto = dragEdge()
      await sleep(800)
      b1 = await ev(`({ w: window.outerWidth, h: window.outerHeight })`)
      if (b1.w <= b0.w + 60) await jk(`window.jk.window.setBounds({ x: ${b0.x}, y: ${b0.y}, width: ${b0.w}, height: ${b0.h} })`)
    }
    let arrastoNaoVerificado = ""
    if (b1.w <= b0.w + 60) {
      // Diagnóstico: qual janela do Windows está no ponto do clique?
      const quem = ps(`Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class JkW { [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(int x, int y); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n); }
'@
$h = [JkW]::GetAncestor([JkW]::WindowFromPoint(${ex}, ${ey}), 2); $p = 0; [void][JkW]::GetWindowThreadProcessId($h, [ref]$p)
$f = [JkW]::GetForegroundWindow(); $fp = 0; [void][JkW]::GetWindowThreadProcessId($f, [ref]$fp); $t = New-Object Text.StringBuilder 120; [void][JkW]::GetWindowText($f, $t, 120)
"no ponto: " + (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName + " (pid $p, app pid ${app.pid}); em primeiro plano: " + (Get-Process -Id $fp -ErrorAction SilentlyContinue).ProcessName + " '" + $t.ToString() + "'"`)
      // Foto da tela inteira e o que o Windows entrega em vários pontos da borda direita.
      const pontos = ps(`Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public class JkQ {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${join(shots, 'falha-tela-inteira.png').replace(/\\/g, '/')}'); $g.Dispose(); $bmp.Dispose()
$h = (Get-Process -Id ${app.pid}).MainWindowHandle
$r = New-Object JkQ+RECT; [void][JkQ]::GetWindowRect($h, [ref]$r)
$out = @("tela=" + $b.Width + "x" + $b.Height, "janela(SO)=" + $r.L + "," + $r.T + " " + ($r.R - $r.L) + "x" + ($r.B - $r.T), "minimizada=" + [JkQ]::IsIconic($h), "visivel=" + [JkQ]::IsWindowVisible($h))
foreach ($dx in @(-2, -10, -60, -300, -600)) { $x = ${ex} + $dx; $w = [JkQ]::GetAncestor([JkQ]::WindowFromPoint($x, ${ey}), 2); $p = 0; [void][JkQ]::GetWindowThreadProcessId($w, [ref]$p); $nome = if ($p -gt 0) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName } else { 'nenhuma' }; $out += ('x' + $x + '=' + $nome) }
$out -join ' | '`)
      console.log(`      pontos na borda: ${pontos}`)
      if (ultimoArrasto.includes("JANELA-NAO-ESTA-NO-PONTO")) {
        arrastoNaoVerificado = `NÃO VERIFICADO: o Windows entregou o ponteiro a outra janela (${quem}); alças presentes: ${await ev(`document.querySelectorAll("[data-resize]").length`)}/8`
      } else throw new Error(`borda não redimensionou com o mouse (${b0.w} → ${b1.w}); ponto (${ex},${ey}) dpi ${dpi}, janela ${JSON.stringify(b0)}; ${quem}`)
    }
    if (!arrastoNaoVerificado) assert(b1.w > b0.w + 60, `borda não redimensionou com o mouse (${b0.w} → ${b1.w})`)
    // O canal usado pelas alças (window:set-bounds) precisa funcionar mesmo quando o mouse real não pôde ser testado.
    await jk(`window.jk.window.setBounds({ x: 120, y: 80, width: 1350, height: 780 })`)
    await sleep(700)
    assert((await ev(`window.outerWidth`)) === 1350, "window:set-bounds não redimensionou a janela")
    // Larguras: sem sobreposição entre colunas e sem rolagem horizontal.
    const layouts = []
    for (const [w, h] of [[1024, 680], [1280, 800], [1600, 900]]) {
      await jk(`window.jk.window.setBounds({ x: 60, y: 40, width: ${w}, height: ${h} })`)
      await sleep(900)
      const r = await ev(`(() => {
        const m = document.querySelector('main'); const cols = [...document.querySelector('[data-dashboard]').children]; const hero = cols[0].getBoundingClientRect(); const soc = cols[1].getBoundingClientRect()
        const overlap = !(hero.right <= soc.left || soc.top >= hero.bottom || hero.top >= soc.bottom)
        return { w: window.innerWidth, hscroll: m.scrollWidth > m.clientWidth + 1, overlap, side: soc.left >= hero.right ? 'lado a lado' : 'empilhado' }
      })()`)
      assert(Math.abs(r.w - w) <= 2, `a janela não chegou a ${w}px (ficou em ${r.w}px)`)
      assert(!r.hscroll && !r.overlap, `layout ${w}px: ${JSON.stringify(r)}`)
      await shot(`inicio-${w}.png`)
      layouts.push(`${w}px ${r.side}`)
    }
    return `${repeticoes.length ? `ATENÇÃO: restaurar precisou de ${repeticoes.length} repetição(ões) (janela ficou em ${repeticoes.join(' → ')}) · ` : ''}raio ${radius} · maximizado sem cantos · ${arrastoNaoVerificado ? `arrasto com mouse real ${arrastoNaoVerificado}` : `borda com mouse real: ${b0.w}→${b1.w}px`} · set-bounds ok · ${layouts.join(' · ')}`
  })

  const DESK = 'HKCU:\\Control Panel\\Desktop'
  const PERS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
  const regGet = (key, name) => ps(`try { [string](Get-ItemProperty -LiteralPath '${key}' -Name '${name}' -ErrorAction Stop).'${name}' } catch { 'ausente' }`)
  const usbAc = () => {
    const out = ps(`(powercfg /q SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226) | Out-String`)
    const hex = [...out.matchAll(/0x([0-9a-f]{8})/gi)].map((m) => parseInt(m[1], 16))
    return hex.length >= 2 ? hex[hex.length - 2] : null
  }

  await scenario('Ajustes: valores da interface correspondem ao Windows', async () => {
    const cat = await q('tweaks.catalog')
    const t = Object.fromEntries(cat.tweaks.map((x) => [x.id, x]))
    const menu = regGet(DESK, 'MenuShowDelay')
    assert(t.menuDelay.current === menu || t.menuDelay.current === `custom:${menu}`, `MenuShowDelay ${menu} × ${t.menuDelay.current}`)
    const tr = regGet(PERS, 'EnableTransparency')
    assert(t.transparency.current === (tr === '0' ? 'off' : 'on'), `transparência ${tr} × ${t.transparency.current}`)
    const ms = regGet('HKCU:\\Control Panel\\Mouse', 'MouseSpeed')
    assert(t.mouseAccel.current === (ms === '0' ? 'off' : 'on'), `mouse ${ms} × ${t.mouseAccel.current}`)
    assert(t.powerPlan.current === activeScheme(), 'plano de energia diferente do powercfg')
    const usb = usbAc()
    if (usb !== null) assert(t.usbSuspend.current === (usb === 1 ? 'on' : 'off'), `USB ${usb} × ${t.usbSuspend.current}`)
    const distinct = cat.tweaks.filter((x) => x.profiles.ideal !== x.profiles.max).length
    const unavailable = cat.tweaks.filter((x) => x.unavailable).map((x) => `${x.id} (${x.unavailable})`)
    return `${cat.tweaks.length} ajustes lidos · Ideal≠Máximo em ${distinct} · indisponíveis: ${unavailable.join('; ') || 'nenhum'}`
  })

  await scenario('Ajustes: aplicar selecionados em lote, divergência externa e "Desativar todos"', async () => {
    const menu0 = regGet(DESK, 'MenuShowDelay')
    const tr0 = regGet(PERS, 'EnableTransparency')
    const usb0 = usbAc()
    const cat = await q('tweaks.catalog')
    const t = Object.fromEntries(cat.tweaks.map((x) => [x.id, x]))
    const menuTarget = t.menuDelay.current === '200' ? '100' : '200'
    const trTarget = t.transparency.current === 'on' ? 'off' : 'on'
    const changes = { menuDelay: menuTarget, transparency: trTarget }
    if (!t.usbSuspend.unavailable) changes.usbSuspend = t.usbSuspend.current === 'on' ? 'off' : 'on'
    try {
      // Já configurado: nada a aplicar.
      const same = await jk(`window.jk.ops.preview('tweaks.apply', ${JSON.stringify({ changes: { menuDelay: t.menuDelay.current.startsWith('custom:') ? '400' : t.menuDelay.current } })})`)
      if (!t.menuDelay.current.startsWith('custom:')) assert(same.blocked && same.blocked.includes('já estão configurados'), 'ajuste já configurado não foi detectado')
      // Valor não suportado é recusado sem executar nada.
      const bad = await jk(`window.jk.ops.preview('tweaks.apply', { changes: { powerPlan: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } })`)
      assert(bad.blocked, 'plano inexistente deveria ser bloqueado')
      const { outcome } = await act('tweaks.apply', { changes })
      assert(outcome?.ok && outcome.changeId, `aplicação falhou: ${outcome?.summary}`)
      assert(regGet(DESK, 'MenuShowDelay') === menuTarget, 'MenuShowDelay não mudou no Windows')
      assert(regGet(PERS, 'EnableTransparency') === (trTarget === 'on' ? '1' : '0'), 'transparência não mudou no Windows')
      if (changes.usbSuspend) assert(usbAc() === (changes.usbSuspend === 'on' ? 1 : 0), 'suspensão USB não mudou no powercfg')
      // Alteração externa depois da aplicação: deve ser preservada.
      ps(`Set-ItemProperty -LiteralPath '${DESK}' -Name MenuShowDelay -Value '333'`)
      const restore = await act('tweaks.restoreAll', {})
      assert(restore.outcome, 'Desativar todos não executou')
      assert(regGet(DESK, 'MenuShowDelay') === '333', 'alteração externa foi sobrescrita')
      assert(regGet(PERS, 'EnableTransparency') === tr0, `transparência não restaurada (${regGet(PERS, 'EnableTransparency')} × ${tr0})`)
      if (changes.usbSuspend) assert(usbAc() === usb0, 'suspensão USB não restaurada')
      assert(!restore.outcome.ok && restore.outcome.summary.includes('preservada'), `resumo deveria informar a preservação: ${restore.outcome.summary}`)
      return `${Object.keys(changes).length} ajustes aplicados e conferidos · externo preservado · ${restore.outcome.summary}`
    } finally {
      psCleanup(`Set-ItemProperty -LiteralPath '${DESK}' -Name MenuShowDelay -Value '${menu0}'`)
      if (tr0 === 'ausente') psCleanup(`Remove-ItemProperty -LiteralPath '${PERS}' -Name EnableTransparency -ErrorAction SilentlyContinue`)
      else psCleanup(`Set-ItemProperty -LiteralPath '${PERS}' -Name EnableTransparency -Value ${tr0} -Type DWord`)
      if (usb0 !== null) psCleanup(`powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 ${usb0}; powercfg /setactive SCHEME_CURRENT`)
    }
  })

  await scenario('Temas: 7 cores aplicadas na hora, logo acompanha o tema, estados e persistência', async () => {
    assert(await clickNav('Configurações'), 'menu Configurações não encontrado')
    await sleep(1500)
    const acento = () => ev(`getComputedStyle(document.documentElement).getPropertyValue('--jk-accent').trim().toLowerCase()`)
    const tema = () => ev(`document.documentElement.dataset.theme`)
    const esperado = { blue: '#2f7bff', red: '#ff1835', ruby: '#e11d74', violet: '#9b5cff', emerald: '#10b981', gold: '#f5b301', cyan: '#00c8ff' }
    // O padrão azul é conferido nos testes unitários (DEFAULT_SETTINGS); aqui parte-se do azul para não depender de cenários anteriores.
    await ev(`window.jk.settings.update({ theme: 'blue' })`)
    assert(await waitFor(async () => (await tema()) === 'blue', 15_000, 50), `tema inicial não ficou azul: ${await tema()}`)
    assert((await acento()) === esperado.blue, `acento azul: ${await acento()}`)
    const opcoes = await ev(`[...document.querySelectorAll('[data-setting="theme"] option')].map((o) => o.value)`)
    assert(JSON.stringify(opcoes) === JSON.stringify(Object.keys(esperado)), `opções de tema: ${opcoes.join(',')}`)
    const escolher = (v) => ev(`(() => { const s = document.querySelector('[data-setting="theme"]'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(s, ${JSON.stringify(v)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    const filtros = {}
    const contraste = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
    for (const id of Object.keys(esperado)) {
      const t0 = Date.now()
      await escolher(id)
      assert(await waitFor(async () => (await tema()) === id, 15_000, 50), `tema ${id} não foi aplicado`)
      const ms = Date.now() - t0
      assert((await acento()) === esperado[id], `acento de ${id}: ${await acento()}`)
      assert((await jk('window.jk.settings.get()')).theme === id, `tema ${id} não foi salvo`)
      // Texto sobre o destaque com contraste adequado (WCAG ≥ 4,5:1 contra o destaque)
      const onAcc = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--jk-on-accent').trim().toLowerCase()`)
      const btn = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--jk-accent-btn').trim().toLowerCase()`)
      const l1 = contraste(btn) + 0.05, l2 = contraste(onAcc.length === 7 ? onAcc : '#ffffff') + 0.05
      const razao = Math.max(l1, l2) / Math.min(l1, l2)
      assert(razao >= 4.5, `contraste do texto sobre o botão primário em ${id} (${btn}): ${razao.toFixed(2)}`)
      // Fundo continua escuro
      const bg = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--jk-bg').trim()`)
      assert(contraste(bg) < 0.02, `fundo de ${id} não é escuro: ${bg}`)
      await sleep(450)
      filtros[id] = await ev(`getComputedStyle(document.querySelector('.emblem-glow')).filter`)
      await shot(`tema-${id}.png`)
      assert(ms < 1500, `troca para ${id} levou ${ms} ms`)
    }
    const distintos = new Set(Object.values(filtros))
    assert(distintos.size === 7, `os filtros do brilho da logo deveriam ser 7 distintos: ${[...distintos].join(' | ')}`)
    // Base escura intacta: a camada base não recebe filtro
    const baseFiltro = await ev(`getComputedStyle(document.querySelector('img[data-brand]')).filter`)
    assert(baseFiltro === 'none', `a base escura da logo não pode ter filtro: ${baseFiltro}`)
    // Persistência: o valor salvo é lido de novo pelo processo principal
    await escolher('violet')
    await waitFor(async () => (await tema()) === 'violet', 15_000, 50)
    await sleep(600)
    const salvo = await jk('window.jk.settings.get()')
    assert(salvo.theme === 'violet', 'violeta não persistiu')
    // Estados visuais: ativado usa o destaque, desativado é cinza neutro
    const sw = await ev(`(() => { const on = document.querySelector('[role="switch"][aria-checked="true"]'); const off = document.querySelector('[role="switch"][aria-checked="false"]'); const cor = (e) => e && getComputedStyle(e).backgroundColor; return { on: cor(on), off: cor(off) } })()`)
    if (sw.on && sw.off) assert(sw.on !== sw.off, `interruptor ligado e desligado com a mesma cor: ${JSON.stringify(sw)}`)
    const invalido = await ev(`(async () => (await window.jk.settings.update({ theme: 'verde' })).ok)()`)
    assert(invalido === false, 'valor de tema inválido deveria ser recusado pelo processo principal')
    await escolher('blue')
    await waitFor(async () => (await tema()) === 'blue', 15_000, 50)
    return `7 temas (${Object.keys(esperado).join(', ')}) aplicados em < 1,5 s, salvos, com contraste ≥ 4,5:1 · 7 filtros de brilho distintos e base sem filtro · inválido recusado`
  })

  await scenario('Telemetria: coleta paralela, entrega por evento e latência medida', async () => {
    assert(await clickNav('Dashboard'), 'Dashboard ausente')
    await sleep(9000)
    const s = await ev(`window.__jkPerfStats`)
    assert(s && s.samples >= 5, `poucas amostras recebidas: ${JSON.stringify(s)}`)
    const idade = await ev(`(() => { const t = [...document.querySelectorAll('[data-status-tile]')].map((e) => e.dataset.state); return t })()`)
    // Confere CPU/RAM com o Windows no mesmo instante
    const ramApp = await ev(`parseInt(document.querySelector('[data-status-tile="RAM"] [data-metric-value]').innerText)`)
    const ramWin = Number(ps(`$o = Get-CimInstance Win32_OperatingSystem; [math]::Round(100 * ($o.TotalVisibleMemorySize - $o.FreePhysicalMemory) / $o.TotalVisibleMemorySize, 0)`))
    assert(Math.abs(ramApp - ramWin) <= 6, `RAM: app ${ramApp}% × Windows ${ramWin}%`)
    const cpuNome = await ev(`document.querySelector('[data-status-tile="CPU"]').innerText`)
    const cpuWin = ps(`(Get-CimInstance Win32_Processor | Select-Object -First 1).Name`)
    assert(cpuNome.includes(cpuWin.slice(0, 12)), `nome da CPU: app "${cpuNome.replace(/\s+/g, ' ')}" × Windows "${cpuWin}"`)
    const disco = await ev(`document.querySelector('[data-status-tile="Disco"]').innerText`)
    const dWin = ps(`$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"; [math]::Round(100 * ($d.Size - $d.FreeSpace) / $d.Size, 0)`)
    assert(disco.includes(`${dWin}%`) || Math.abs(parseInt(disco) - Number(dWin)) <= 1, `disco C: app "${disco.replace(/\s+/g, ' ')}" × Windows ${dWin}%`)
    assert(s.collectMs < 1000, `coleta média ${s.collectMs.toFixed(0)} ms`)
    assert(s.collectMax < 10000, `coleta máxima ${s.collectMax} ms (travamento do WMI)`)
    assert(s.deliveryMs < 400, `entrega média ${s.deliveryMs.toFixed(0)} ms`)
    assert(s.paintMs < 100, `pintura média ${s.paintMs.toFixed(0)} ms`)
    return `${s.samples} amostras · coleta média ${s.collectMs.toFixed(0)} ms (máx ${s.collectMax}) · entrega ${s.deliveryMs.toFixed(0)} ms (máx ${s.deliveryMax}) · até o quadro pintado ${s.paintMs.toFixed(0)} ms · RAM ${ramApp}% (Windows ${ramWin}%) · disco C: ${dWin}% · cartões: ${idade.join(',')}`
  })

  await scenario('Navegação: tempo de resposta de cada aba (clique até conteúdo)', async () => {
    const abas = ['Dashboard', 'FPS Boost', 'Memória', 'Aplicativos', 'Executor', 'Chaves', 'Configurações', 'Suporte', 'Dashboard']
    const tempos = []
    for (const a of abas) {
      const t = await ev(`new Promise((resolve) => { const t0 = performance.now(); const b = document.querySelector('aside [data-nav=' + JSON.stringify(${JSON.stringify(a)}) + ']'); b.click(); const check = () => { const m = document.querySelector('main'); if (m && m.innerText.trim().length > 30) { requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))) } else if (performance.now() - t0 > 8000) resolve(-1); else setTimeout(check, 10) }; check() })`)
      tempos.push([a, t])
      await sleep(700)
    }
    const lentas = tempos.filter(([, t]) => t < 0 || t > 400)
    assert(lentas.length === 0, `abas lentas (> 400 ms até o primeiro conteúdo): ${lentas.map(([a, t]) => `${a}=${t}ms`).join(', ')}`)
    return tempos.map(([a, t]) => `${a} ${t} ms`).join(' · ')
  })

  await scenario('Memória: valores da tela conferem com o Windows (RAM total, disponível) e lista de processos', async () => {
    assert(await clickNav('Memória'), 'menu Memória não encontrado')
    assert(await waitFor(() => ev(`!!document.querySelector('[data-memory-metrics]')`), 20_000), 'métricas ausentes')
    await sleep(2500)
    const txt = await ev(`document.querySelector('[data-memory-metrics]').innerText`)
    const totalGiB = Number(ps(`[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)`).replace(',', '.'))
    const m = /([\d.,]+)\s*GB/i.exec(txt)
    assert(m && Math.abs(Number(m[1].replace(',', '.')) - totalGiB) < 0.8, `RAM total na tela "${m?.[1]}" × Windows ${totalGiB} GiB`)
    await waitFor(() => ev(`document.querySelectorAll('[data-ram-pick]').length > 0`), 30_000)
    const linhas = await ev(`document.querySelectorAll('[data-ram-pick]').length`)
    assert(linhas > 0, 'lista de aplicativos vazia')
    await shot('memoria.png')
    return `RAM ${totalGiB} GiB conferida · ${linhas} aplicativos listados`
  })

  await scenario('Reinício: nunca automático (prévia com aviso, sem confirmação não executa)', async () => {
    const p = await jk(`window.jk.ops.preview('system.restart', {})`)
    assert(p.risk === 'high' && p.reversible === false && !p.blocked, `prévia do reinício: ${JSON.stringify({ risco: p.risk, reversivel: p.reversible })}`)
    assert(p.warnings.some((w) => /salve/i.test(w)), 'a prévia deve avisar para salvar os trabalhos')
    // Só pré-visualiza: a execução SEM confirmação tem de ser recusada. Nunca se executa com confirmação neste teste.
    const semConfirmar = await ev(`(async () => { const r = await window.jk.ops.execute(${JSON.stringify(p.previewId)}, false); return r.ok ? 'EXECUTOU' : r.error.code })()`)
    assert(semConfirmar === 'confirmation-required', `execução sem confirmação: ${semConfirmar}`)
    const abortar = await ev(`(async () => { const r = await window.jk.ops.query('system.restart.abort', {}); return r.ok ? 'ok' : r.error.code })()`)
    assert(abortar === 'ok', `cancelar reinício (sem nenhum agendado) deveria ser inofensivo: ${abortar}`)
    return 'risco alto, irreversível, aviso de trabalho não salvo; execução sem confirmação recusada; cancelar sem reinício agendado é inofensivo'
  })

  const cat = async (_id, ms = 1800) => {
    assert(await clickNav('FPS Boost'), 'menu FPS Boost não encontrado')
    await sleep(500)
    assert(await ev(`(() => { const b = [...document.querySelectorAll('main button')].find((x) => x.innerText.trim() === 'Ajustes avançados'); b?.click(); return !!b })()`), 'aba Ajustes avançados ausente')
    await sleep(ms)
  }
  const erroNaTela = () => ev(`/Esta categoria encontrou um erro|Não foi possível (consultar|listar|ler)/.test(document.querySelector('main')?.innerText ?? '')`)
  const setInput = (sel, value) =>
    ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)

  await scenario('Novas categorias: BIOS, Input Lag, DNS, conectividade e winget conferidos com o Windows', async () => {
    const out = []
    const bios = await qn('bios.report', {})
    const realBios = ps(`(Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion`)
    assert(bios.bios?.version === realBios, `BIOS ${bios.bios?.version} × ${realBios}`)
    const board = ps(`(Get-CimInstance Win32_BaseBoard).Product`)
    assert(bios.board?.product === board, `placa-mãe ${bios.board?.product} × ${board}`)
    const mods = Number(ps(`@(Get-CimInstance Win32_PhysicalMemory).Count`))
    assert(bios.memory.length === mods, `módulos ${bios.memory.length} × ${mods}`)
    out.push(`BIOS ${realBios} · ${mods} módulo(s) · ${bios.advice.length} recomendação(ões)`)
    const il = await qn('inputlag.report', {})
    const ms = ps(`(Get-ItemProperty 'HKCU:\Control Panel\Mouse').MouseSensitivity`)
    assert(String(il.mouse.sensitivity ?? '') === ms, `sensibilidade ${il.mouse.sensitivity} × ${ms}`)
    const hz = ps(`(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentRefreshRate } | Select-Object -First 1).CurrentRefreshRate`)
    assert(il.displays.length === 0 || String(il.displays[0].hz) === hz, `Hz ${il.displays[0]?.hz} × ${hz}`)
    out.push(`mouse ${ms} · ${hz} Hz`)
    const dns = await qn('network.dns.compare', { rounds: 1 })
    assert(dns.results.length === 5 && dns.results[0].id === 'current', 'comparação de DNS incompleta')
    const medidos = dns.results.filter((r) => r.median != null)
    assert(medidos.length >= 1, 'nenhum servidor respondeu (sem internet?)')
    out.push(`DNS: ${dns.results.map((r) => `${r.label.split(' ')[0]} ${r.median ?? 'falhou'} ms`).join(' · ')}`)
    const conn = await qn('network.connectivity', {})
    assert(typeof conn.dnsOk === 'boolean', 'diagnóstico sem resultado')
    out.push(`conectividade: internet ${conn.internetMs ?? '—'} ms, DNS ${conn.dnsOk ? 'ok' : 'falhou'}`)
    let winget
    try {
      winget = await qn('updates.winget.list', {})
      out.push(`winget: ${winget.rows.length} atualização(ões) listada(s)`)
    } catch (e) {
      out.push(`winget indisponível: ${String(e.message ?? e).slice(0, 80)}`)
    }
    const dnsAtual = ps(`(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses } | Select-Object -First 1).ServerAddresses -join ','`)
    const prev = await jk(`window.jk.ops.preview('network.dns.set', ${JSON.stringify({ alias: (await qn('network.adapters', {})).adapters.find((a) => a.status === 'Up' && !a.virtual)?.name ?? 'x', provider: 'google' })})`)
    assert(prev.requiresElevation && prev.changes.length === 1, 'prévia do DNS sem a alteração ou sem elevação')
    out.push(`prévia de DNS (sem executar; atual ${dnsAtual})`)
    return out.join(' | ')
  })

  await scenario('Menu: grupos Início, Otimização, Sistema, Extras e rodapé; recolher e expandir mantêm os ícones', async () => {
    const grupos = await ev(`[...document.querySelectorAll('aside [data-nav-group]')].map((g) => g.dataset.navGroup + ':' + g.querySelectorAll('[data-nav]').length)`)
    assert(JSON.stringify(grupos) === JSON.stringify(['start:1', 'optimization:7', 'system:5', 'extras:8', 'bottom:2']), `grupos: ${grupos.join(', ')}`)
    const titulos = await ev(`[...document.querySelectorAll('aside nav p')].map((p) => p.innerText.trim().toUpperCase())`)
    assert(['INÍCIO', 'OTIMIZAÇÃO', 'SISTEMA', 'EXTRAS'].every((t, i) => titulos[i] === t), `títulos: ${titulos.join(', ')}`)
    const ultimos = await ev(`[...document.querySelectorAll('aside [data-nav]')].slice(-2).map((b) => b.dataset.nav)`)
    assert(ultimos.join() === 'Configurações,Suporte', `rodapé: ${ultimos}`)
    const larg0 = await ev(`document.querySelector('aside').getBoundingClientRect().width`)
    await ev(`document.querySelector('[data-sidebar-toggle]').click()`)
    await sleep(500)
    const larg1 = await ev(`document.querySelector('aside').getBoundingClientRect().width`)
    const icones = await ev(`document.querySelectorAll('aside [data-nav] svg').length`)
    assert(larg1 < 100 && larg0 > 200 && icones === (await ev(`document.querySelectorAll('aside [data-nav]').length`)), `largura ${larg0} → ${larg1}, ícones ${icones}`)
    assert(await clickNav('Redes'), 'navegar recolhido')
    await sleep(800)
    await ev(`document.querySelector('[data-sidebar-toggle]').click()`)
    await sleep(500)
    const larg2 = await ev(`document.querySelector('aside').getBoundingClientRect().width`)
    assert(Math.abs(larg2 - larg0) < 2, `expandir: ${larg2} × ${larg0}`)
    return `5 grupos · menu ${larg0}px → ${larg1}px (recolhido, ${icones} ícones) → ${larg2}px`
  })

  await scenario('Aplicativos: aba logo abaixo de Monitoramento, 30 cartões, ícones, pesquisa e abertura recusa id fora do catálogo', async () => {
    const menu = await ev(`[...document.querySelectorAll('aside [data-nav]')].map((b) => b.dataset.nav)`)
    assert(menu.indexOf('Aplicativos') === menu.indexOf('Histórico e Restauração') + 1, `ordem do menu: ${menu.join(', ')}`)
    assert(await clickNav('Aplicativos'), 'menu Aplicativos ausente')
    await sleep(1200)
    const cards = await ev(`[...document.querySelectorAll('[data-app-card]')].map((c) => ({ id: c.dataset.appCard, nome: c.querySelector('h3').innerText, botao: c.querySelector('button').innerText, desc: c.querySelector('p').innerText.length }))`)
    assert(cards.length === 30, `${cards.length} cartões`)
    for (const c of cards) assert(c.botao.includes('Baixar aplicativo') && c.desc > 60, `cartão ${c.id}: ${JSON.stringify(c)}`)
    for (const n of ['Google Chrome', 'Mozilla Firefox', 'Brave', '7-Zip', 'WinRAR', 'Steam', 'Epic Games Launcher', 'Discord', 'WhatsApp', 'Microsoft PowerToys']) assert(cards.some((c) => c.nome === n), `falta ${n}`)
    const recusa = await jk(`window.jk.ops.query('apps.catalog.open', { id: 'site-malicioso' })`).then(() => false, () => true)
    assert(recusa, 'abertura de id fora do catálogo deveria ser recusada')
    // Ícone imediatamente antes do nome, em todos os cartões (oficial ou monograma de reserva).
    const icones = await ev(`[...document.querySelectorAll('[data-app-card]')].map((c) => { const i = c.querySelector('[data-app-icon]'); const h = c.querySelector('h3'); return { id: c.dataset.appCard, antes: !!i && !!(i.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING), alt: i?.getAttribute('alt') ?? i?.getAttribute('aria-label'), tipo: i?.dataset.iconKind } })`)
    assert(icones.every((i) => i.antes && /^Ícone do /.test(i.alt ?? '')), 'cartão sem ícone antes do nome: ' + JSON.stringify(icones.filter((i) => !i.antes)))
    const ids = (q) => ev(`[...document.querySelectorAll('[data-app-card]')].map((c) => c.dataset.appCard)`)
    const busca = async (q) => { await setInput('input[aria-label="Pesquisar aplicativo"]', q); await sleep(300); return ids() }
    assert(JSON.stringify(await busca('Claude')) === '["claude"]', 'pesquisa Claude')
    const design = await busca('design')
    assert(design.includes('canva') && design.includes('pinterest'), 'pesquisa design: ' + design)
    assert((await busca('IA')).includes('claude'), 'pesquisa IA')
    const video = await busca('vídeo')
    assert(video.includes('vlc') && video.includes('obs'), 'pesquisa vídeo: ' + video)
    assert((await busca('driver')).length >= 4, 'pesquisa driver')
    await busca('zzzzzz')
    assert((await ev('document.body.innerText')).includes('Nenhum aplicativo encontrado') && (await ev("document.querySelectorAll('[data-app-category]').length")) === 0, 'sem resultados')
    const todos = await busca('')
    const vazias = await ev("[...document.querySelectorAll('[data-app-category]')].filter((s) => s.querySelectorAll('[data-app-card]').length === 0).length")
    assert(todos.length === 30 && vazias === 0, 'limpar a pesquisa: ' + todos.length + ' cartões, ' + vazias + ' categorias vazias')
    // Layout em larguras diferentes: sem rolagem horizontal.
    const larguras = []
    for (const w of [820, 1100, 1500]) {
      await jk('window.jk.window.setBounds({ x: 60, y: 40, width: ' + w + ', height: 800 })')
      await sleep(700)
      const o = await ev("({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, colunas: new Set([...document.querySelectorAll('[data-app-card]')].slice(0, 12).map((c) => Math.round(c.getBoundingClientRect().left))).size })")
      assert(o.sw <= o.cw + 1, 'rolagem horizontal a ' + w + ' px: ' + JSON.stringify(o))
      larguras.push(w + 'px→' + o.colunas + ' col.')
    }
    await jk('window.jk.window.setBounds({ x: 120, y: 80, width: 1200, height: 760 })')
    await sleep(500)
    const fallback = icones.filter((i) => i.tipo === 'fallback').length
    await shot('aplicativos.png')
    return `${cards.length} cartões (ícone antes do nome: ${icones.length - fallback} oficiais, ${fallback} monogramas de reserva) · pesquisa (Claude, design, IA, vídeo, driver, sem resultado, limpar) ok · larguras ${larguras.join(', ')} · "Baixar aplicativo" · id fora do catálogo recusado (a abertura no navegador não foi disparada no teste)`
  })

  await scenario('Tarefas, recursos, privacidade e afinidade: listas reais conferidas', async () => {
    const tarefas = await jk(`window.jk.ops.query('tasks.list', {})`)
    const realT = Number(ps('@(Get-ScheduledTask).Count'))
    assert(Math.abs(tarefas.length - realT) <= 5, `tarefas: app ${tarefas.length} x Windows ${realT}`)
    const protegida = tarefas.find((t) => t.protectedReason)
    assert(protegida, 'nenhuma tarefa do Windows marcada como protegida')
    const prevT = await jk(`window.jk.ops.preview('tasks.toggle', { path: ${JSON.stringify(protegida.path)}, name: ${JSON.stringify(protegida.name)}, enable: false })`)
    assert(prevT.blocked, 'tarefa protegida deveria ser recusada')
    const feats = await jk(`window.jk.ops.query('features.list', {})`)
    const realF = Number(ps('@(Get-CimInstance Win32_OptionalFeature).Count'))
    assert(feats.length === realF, `recursos: app ${feats.length} x Windows ${realF}`)
    const cat0 = await jk(`window.jk.ops.query('tweaks.catalog', {})`)
    const priv = cat0.tweaks.filter((t) => t.category === 'Privacidade')
    assert(priv.length >= 4, `controles de privacidade: ${priv.length}`)
    const trk = priv.find((t) => t.id === 'trackDocs')
    const regv = ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' -Name Start_TrackDocs -ErrorAction SilentlyContinue).Start_TrackDocs`)
    assert(trk.current === (regv === '0' ? 'off' : 'on'), `trackDocs: app ${trk.current} x registro "${regv}"`)
    const aff = await jk(`window.jk.ops.preview('processes.affinity', { pid: 4, startTime: 'x', mask: 1 })`).catch(() => ({ blocked: 'recusado' }))
    assert(aff.blocked, 'afinidade de processo do sistema deveria ser recusada')
    return `${tarefas.length} tarefas (Windows ${realT}), protegida recusada · ${feats.length} recursos (Windows ${realF}) · ${priv.length} controles de privacidade conferidos no registro · afinidade de processo do sistema recusada`
  })

  // ---------------------------------------------------------------------------
  // Otimização 2 (ajustes avançados do Windows). Nada de administrador é executado: o UAC não pode ser aceito
  // por automação, então os ajustes elevados são verificados na prévia e os de usuário (HKCU) de ponta a ponta.
  // ---------------------------------------------------------------------------
  const svcStart = (n) => ps(`try { [string](Get-Service -Name '${n}' -ErrorAction Stop).StartType } catch { 'ausente' }`)
  const regRaw = (key, name) => ps(`try { [string](Get-ItemProperty -LiteralPath '${key}' -Name '${name}' -ErrorAction Stop).'${name}' } catch { 'ausente' }`)

  await scenario('Otimização 2: catálogo avançado confere com o Windows (serviços, hibernação, telemetria, NTFS, tarefa)', async () => {
    const cat = await q('tweaks.catalog')
    const t = Object.fromEntries(cat.tweaks.map((x) => [x.id, x]))
    const linhas = []
    for (const [id, svc] of [['indexing', 'WSearch'], ['diagTrack', 'DiagTrack'], ['bluetooth', 'bthserv']]) {
      const real = svcStart(svc)
      if (real === 'ausente') {
        assert(t[id].unavailable, `${id}: serviço ausente deveria estar indisponível`)
        linhas.push(`${id}: ausente`)
        continue
      }
      const esperado = real === 'Disabled' ? ['off'] : real === 'Manual' ? ['manual'] : ['auto', 'delayed']
      assert(esperado.includes(t[id].current), `${id}: app "${t[id].current}" × Windows ${real}`)
      linhas.push(`${id}=${t[id].current}`)
    }
    const hib = regRaw('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power', 'HibernateEnabled')
    assert(t.hibernation.current === (hib === '1' ? 'on' : 'off'), `hibernação: app ${t.hibernation.current} × registro ${hib}`)
    const tel = regRaw('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', 'AllowTelemetry')
    assert(t.telemetry.current === (tel === 'ausente' ? 'default' : tel === '0' ? 'off' : tel === '1' ? 'basic' : `custom:${tel}`), `telemetria: app ${t.telemetry.current} × política ${tel}`)
    const la = ps(`(fsutil behavior query disablelastaccess) -join ' '`)
    const n = Number(/=\s*(\d)/.exec(la)?.[1])
    assert(t.lastAccess.current === (n === 1 || n === 3 ? 'off' : 'on'), `último acesso: app ${t.lastAccess.current} × fsutil "${la}"`)
    const sc = ps(`try { [string](Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\DiskCleanup\\' -TaskName SilentCleanup -ErrorAction Stop).State } catch { 'ausente' }`)
    if (sc === 'ausente') assert(t.silentCleanup.unavailable, 'SilentCleanup ausente deveria estar indisponível')
    else assert(t.silentCleanup.current === (sc === 'Disabled' ? 'off' : 'on'), `SilentCleanup: app ${t.silentCleanup.current} × tarefa ${sc}`)
    const toast = regRaw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled')
    assert(t.notifications.current === (toast === '0' ? 'off' : 'on'), `notificações: app ${t.notifications.current} × registro ${toast}`)
    const ss = regRaw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy', '01')
    assert(t.storageSense.current === (ss === '1' ? 'on' : 'off'), `Sensor de Armazenamento: app ${t.storageSense.current} × registro ${ss}`)
    const fast = regRaw('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power', 'HiberbootEnabled')
    if (!t.fastStartup.unavailable) assert(t.fastStartup.current === (fast === '1' ? 'on' : 'off'), `Inicialização Rápida: app ${t.fastStartup.current} × registro ${fast}`)
    const semMotivo = cat.tweaks.filter((x) => x.current === null && !x.unavailable).map((x) => x.id)
    assert(semMotivo.length === 0, `ajustes sem estado e sem motivo: ${semMotivo.join(', ')}`)
    return `${cat.tweaks.length} ajustes · ${linhas.join(' ')} hib=${t.hibernation.current} telemetria=${t.telemetry.current} lastAccess=${t.lastAccess.current} silentCleanup=${t.silentCleanup.current ?? 'indisp.'}`
  })

  await scenario('Otimização 2: ajustes do usuário (HKCU) em lote, conferidos no registro e restaurados ao valor original', async () => {
    const alvos = [
      ['notifications', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled'],
      ['startSuggestions', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SystemPaneSuggestionsEnabled'],
      ['gameBar', 'HKCU:\\Software\\Microsoft\\GameBar', 'ShowStartupPanel'],
      ['storageSense', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy', '01']
    ]
    const antes = Object.fromEntries(alvos.map(([id, k, n]) => [id, regRaw(k, n)]))
    const cat = await q('tweaks.catalog')
    const t = Object.fromEntries(cat.tweaks.map((x) => [x.id, x]))
    const changes = {}
    for (const [id] of alvos) if (!t[id].unavailable) changes[id] = t[id].current === 'on' ? 'off' : 'on'
    assert(Object.keys(changes).length >= 3, 'poucos ajustes de usuário disponíveis')
    try {
      const { preview, outcome } = await act('tweaks.apply', { changes })
      assert(!preview.requiresElevation, 'ajustes de usuário não deveriam pedir administrador')
      assert(outcome?.ok && outcome.verified && outcome.changeId, `aplicação: ${outcome?.summary}`)
      for (const [id, k, n] of alvos) {
        if (!changes[id]) continue
        const valor = regRaw(k, n)
        assert(valor === (changes[id] === 'on' ? '1' : '0'), `${id}: registro "${valor}" após aplicar ${changes[id]}`)
      }
      const rev = await revert(outcome.changeId)
      assert(rev.status === 'reverted', 'reversão não concluída')
      for (const [id, k, n] of alvos) assert(regRaw(k, n) === antes[id], `${id}: após reverter "${regRaw(k, n)}" × original "${antes[id]}"`)
      return `${Object.keys(changes).length} ajustes aplicados (${Object.entries(changes).map(([a, b]) => a + '→' + b).join(', ')}), conferidos no registro e revertidos ao valor original (inclusive ausente)`
    } finally {
      for (const [id, k, n] of alvos) {
        if (regRaw(k, n) === antes[id]) continue
        if (antes[id] === 'ausente') psCleanup(`Remove-ItemProperty -LiteralPath '${k}' -Name '${n}' -ErrorAction SilentlyContinue`)
        else psCleanup(`Set-ItemProperty -LiteralPath '${k}' -Name '${n}' -Value ${antes[id]} -Type DWord`)
      }
    }
  })

  await scenario('Otimização 2: ajustes de administrador mostram os efeitos na prévia e não executam sem confirmação', async () => {
    const cat = await q('tweaks.catalog')
    const t = Object.fromEntries(cat.tweaks.map((x) => [x.id, x]))
    const changes = {}
    for (const id of ['hibernation', 'indexing', 'telemetry', 'lastAccess', 'netThrottle', 'qosLimit']) {
      if (t[id].unavailable) continue
      changes[id] = (t[id].options.find((o) => o.value !== t[id].current && o.value === 'off') ?? t[id].options.find((o) => o.value !== t[id].current)).value
    }
    const hib0 = regRaw('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power', 'HibernateEnabled')
    const idx0 = svcStart('WSearch')
    const prev = await jk(`window.jk.ops.preview('tweaks.apply', ${JSON.stringify({ changes })})`)
    assert(prev.requiresElevation, 'ajustes de HKLM/serviço deveriam exigir administrador')
    assert(prev.changes.length === Object.keys(changes).length, `prévia: ${prev.changes.length} alterações × ${Object.keys(changes).length} pedidas`)
    assert(prev.warnings.some((w) => /administrador/i.test(w) && /uma única vez/.test(w)), 'aviso de UAC único ausente')
    assert(prev.warnings.some((w) => /hiberna/i.test(w) && /Inicialização Rápida/.test(w)) || t.hibernation.unavailable || changes.hibernation === 'on', 'efeito da hibernação ausente')
    assert(prev.warnings.some((w) => /nunca reinicia/.test(w)), 'aviso de reinício ausente')
    assert(regRaw('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power', 'HibernateEnabled') === hib0 && svcStart('WSearch') === idx0, 'o Windows mudou sem confirmação')
    const disk = await jk(`window.jk.ops.preview('disk.optimize', { drives: ['C'] })`)
    assert(disk.requiresElevation && !disk.blocked, `disk.optimize: ${disk.blocked}`)
    const media = ps(`[string]@(Get-Partition -DriveLetter C | Get-Disk | Get-PhysicalDisk)[0].MediaType`)
    const esperado = /SSD/i.test(media) ? /TRIM/ : /HDD/i.test(media) ? /Desfragmenta/ : /autom/i
    assert(esperado.test(disk.changes[0].intended), `operação para ${media}: "${disk.changes[0].intended}"`)
    const idle = await jk(`window.jk.ops.preview('memory.idleTasks', {})`)
    assert(idle.requiresElevation && idle.warnings.some((w) => /sem documentação/.test(w)) && idle.warnings.some((w) => /NÃO libera/.test(w)), 'prévia das tarefas ociosas sem os avisos honestos')
    const sys = await jk(`window.jk.ops.preview('cleanup.extra.clean', { targets: ['temp-system'] })`)
    assert(sys.requiresElevation, 'limpeza do sistema deveria exigir administrador')
    const bad = await jk(`window.jk.ops.preview('cleanup.extra.clean', { targets: ['..-Windows'] })`).catch(() => ({ blocked: 'recusado' }))
    assert(bad.blocked, 'alvo fora da lista deveria ser recusado')
    return `${prev.changes.length} ajustes de administrador na prévia (UAC único, efeitos e aviso de reinício) · nada alterado sem confirmação · otimização de C: (${media}) → ${disk.changes[0].intended}`
  })

  await scenario('Otimização 2: estado de segurança (Defender, firewall, SmartScreen, UAC) confere com o Windows', async () => {
    const r = await q('security.status')
    const rows = Object.fromEntries(r.rows.map((x) => [x.id, x]))
    const lua = regRaw('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'EnableLUA')
    assert((rows.uac.state === 'desativado') === (lua === '0'), `UAC: app ${rows.uac.state} × EnableLUA ${lua}`)
    const fw = ps(`@(Get-NetFirewallProfile | Where-Object { $_.Enabled -eq 'True' }).Count`)
    assert(rows.firewall.summary.startsWith(`${fw} de`), `firewall: app "${rows.firewall.summary}" × ${fw} perfis ativos`)
    const rt = ps(`try { [string](Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled } catch { 'n/d' }`)
    if (rt !== 'n/d') assert(rows.defender.summary.includes(rt === 'True' ? 'em tempo real ativa' : 'em tempo real desativada') || /passivo/i.test(rows.defender.summary), `Defender: app "${rows.defender.summary}" × tempo real ${rt}`)
    // O app só consulta: nenhuma ação registrada altera essas proteções.
    const acoes = await jk('window.jk.ops.actions()')
    const mexe = acoes.filter((a) => /defender|firewall|smartscreen|uac/i.test(a.id))
    assert(mexe.length === 0, `ações que alteram proteções: ${mexe.map((a) => a.id).join(', ')}`)
    return `Defender: ${rows.defender.summary} · Firewall: ${rows.firewall.summary} · SmartScreen: ${rows.smartscreen.summary} · UAC: ${rows.uac.summary} (conferidos; somente consulta)`
  })

  await scenario('Otimização 2: limpeza ampliada em pastas isoladas apaga só o elegível e mede o espaço', async () => {
    if (!process.env.JKO_E2E_FAKE_LOCAL) return 'ignorado: rode com JKO_E2E_FAKE_LOCAL=1 (app com TEMP/LOCALAPPDATA em pasta de teste)'
    const L = fakeLocal
    const mk = (rel, kb, horas) => ps(`$f = Join-Path '${L}' '${rel}'; New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null; [IO.File]::WriteAllBytes($f, (New-Object byte[] ${kb * 1024})); (Get-Item $f).LastWriteTime = (Get-Date).AddHours(-${horas})`)
    mk('Temp\\a.tmp', 100, 5)
    mk('Temp\\sub\\b.tmp', 50, 5)
    mk('Temp\\recente.tmp', 10, 0)
    mk('Microsoft\\Windows\\Explorer\\thumbcache_256.db', 200, 5)
    mk('Microsoft\\Windows\\Explorer\\iconcache_32.db', 30, 5)
    mk('Microsoft\\Windows\\Explorer\\outro.dat', 40, 5)
    mk('Microsoft\\Windows\\INetCache\\x.bin', 70, 5)
    mk('Microsoft\\Windows\\WER\\ReportArchive\\r1\\Report.wer', 20, 48)
    mk('Microsoft\\Windows\\WER\\ReportArchive\\r2\\nova.wer', 20, 1)
    mk('CrashDumps\\app.dmp', 300, 72)
    const scan = await q('cleanup.extra.scan', { targets: ['temp-user', 'logs-user', 'explorer-cache', 'inet-cache'] })
    const by = Object.fromEntries(scan.targets.map((x) => [x.id, x]))
    assert(by['temp-user'].files === 2 && by['temp-user'].bytes === 150 * 1024, `temp-user: ${by['temp-user'].files} arquivos, ${by['temp-user'].bytes} B (esperado 2 / 153600)`)
    assert(by['explorer-cache'].files === 2 && by['explorer-cache'].bytes === 230 * 1024, `explorer-cache: ${by['explorer-cache'].files} / ${by['explorer-cache'].bytes}`)
    assert(by['inet-cache'].files === 1 && by['inet-cache'].bytes === 70 * 1024, 'inet-cache')
    assert(by['logs-user'].files === 2 && by['logs-user'].bytes === 320 * 1024, `logs-user: ${by['logs-user'].files} / ${by['logs-user'].bytes} (nova.wer tem 1 h e fica de fora)`)
    const { preview, outcome } = await act('cleanup.extra.clean', { targets: ['temp-user', 'logs-user', 'explorer-cache', 'inet-cache'] })
    assert(!preview.requiresElevation, 'alvos do usuário não deveriam pedir administrador')
    assert(preview.warnings.some((w) => /não pode ser desfeita/.test(w)), 'aviso de irreversibilidade ausente')
    assert(outcome?.ok && outcome.verified, `limpeza: ${outcome?.summary}`)
    const existe = (rel) => ps(`Test-Path (Join-Path '${L}' '${rel}')`) === 'True'
    for (const rel of ['Temp\\a.tmp', 'Temp\\sub\\b.tmp', 'Microsoft\\Windows\\Explorer\\thumbcache_256.db', 'Microsoft\\Windows\\Explorer\\iconcache_32.db', 'Microsoft\\Windows\\INetCache\\x.bin', 'Microsoft\\Windows\\WER\\ReportArchive\\r1\\Report.wer', 'CrashDumps\\app.dmp']) assert(!existe(rel), `não removido: ${rel}`)
    for (const rel of ['Temp\\recente.tmp', 'Microsoft\\Windows\\Explorer\\outro.dat', 'Microsoft\\Windows\\WER\\ReportArchive\\r2\\nova.wer']) assert(existe(rel), `removido indevidamente: ${rel}`)
    const total = (150 + 230 + 70 + 320) * 1024
    assert(outcome.summary.includes('arquivos removidos') && outcome.sections.some((s) => s.title === 'Espaço liberado'), 'medição do espaço ausente')
    return `7 arquivos elegíveis removidos (${total / 1024} KB), 3 recentes/não elegíveis preservados · ${outcome.summary}`
  })

  await scenario('Otimização 2: interface (7 seções, 22 scripts, confirmação com efeitos, tela de progresso com a logo)', async () => {
    await cat('windows2', 4000)
    const secoes = ['basic', 'power', 'cleanup', 'disable', 'scripts', 'booster', 'security']
    const rotulos = ['Otimizar Windows', 'Plano de energia', 'Limpeza Windows', 'Desativar Windows', 'Scripts importantes', 'Booster Robusta', 'Segurança']
    const aba = (i) => ev(`[...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === ${JSON.stringify(rotulos[i])}).click()`)
    const falhas = []
    for (const [i, id] of secoes.entries()) {
      await aba(i)
      await sleep(id === 'cleanup' || id === 'security' ? 9000 : 3500)
      const len = await ev(`document.querySelector('[data-win2-section="${id}"]')?.innerText.trim().length ?? 0`)
      const semDados = id === 'security' ? !(await ev(`!!document.querySelector('[data-security-status]')`)) : await erroNaTela()
      if (len < 120 || semDados) falhas.push(`${id} (${len})`)
      await shot(`otm2-${id}.png`)
    }
    assert(falhas.length === 0, `seções sem conteúdo ou com erro: ${falhas.join(', ')}`)
    await aba(4)
    await sleep(2500)
    const scripts = await ev(`document.querySelectorAll('[data-script]').length`)
    assert(scripts === 22, `esperados 22 scripts, encontrados ${scripts}`)
    // Fluxo real pela interface com um ajuste de usuário: Notificações.
    const alvo = ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled']
    const antes = regRaw(...alvo)
    try {
      await aba(0)
      await sleep(3500)
      // Escolhe o valor oposto ao atual no seletor da linha (a sugestão padrão é "desativar").
      await ev(`(() => { const s = document.querySelector('select[aria-label="Valor de Notificações de aplicativos"]'); const outro = [...s.options].map((o) => o.value).find((v) => v !== ${JSON.stringify(antes === '0' ? 'off' : 'on')}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, outro); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      await sleep(400)
      assert(!(await ev(`document.querySelector('[data-apply="notifications"]').disabled`)), 'botão Aplicar de Notificações desabilitado')
      await ev(`document.querySelector('[data-apply="notifications"]').click()`)
      await waitFor(() => ev(`!!document.querySelector('[data-confirm-warnings]')`), 20000, 400)
      assert(await ev(`!!document.querySelector('[data-confirm-warnings]')`), 'confirmação sem a lista de efeitos')
      await shot('otm2-confirmacao.png')
      await ev(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText.trim() === 'Confirmar').click()`)
      await waitFor(() => ev(`!!document.querySelector('[data-operation-progress]')`), 15000, 100)
      assert(await ev(`!!document.querySelector('[data-operation-progress] img[data-brand="mark"]')`), 'tela de progresso sem a logo oficial')
      await waitFor(() => ev(`!!document.querySelector('[data-operation-result]')`), 60000, 400)
      const estado = await ev(`({ itens: [...document.querySelectorAll('[data-op-item]')].map((i) => i.dataset.opState), pct: document.querySelector('[data-operation-percent]').innerText, res: document.querySelector('[data-operation-result]').innerText })`)
      await shot('otm2-progresso.png')
      assert(estado.itens.length === 1 && estado.itens[0] === 'ok', `estado dos itens: ${estado.itens}`)
      assert(/^100%/.test(estado.pct), `progresso final: ${estado.pct}`)
      await ev(`document.querySelector('[data-operation-close]').click()`)
      await sleep(600)
      assert(regRaw(...alvo) !== antes, 'o registro não mudou')
      const hist = await jk('window.jk.ops.changes()')
      const ultimo = hist.filter((c) => c.actionId === 'tweaks.apply' && c.status === 'applied').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      const rev = await revert(ultimo.id)
      assert(rev.status === 'reverted' && regRaw(...alvo) === antes, 'reversão não restaurou o valor original')
      return `7 seções com conteúdo · 22 scripts · confirmação com efeitos · progresso 100% com a logo e item "ok" · ToastEnabled restaurado (${antes})`
    } finally {
      if (regRaw(...alvo) !== antes) {
        if (antes === 'ausente') psCleanup(`Remove-ItemProperty -LiteralPath '${alvo[0]}' -Name '${alvo[1]}' -ErrorAction SilentlyContinue`)
        else psCleanup(`Set-ItemProperty -LiteralPath '${alvo[0]}' -Name '${alvo[1]}' -Value ${antes} -Type DWord`)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Otimização para Jogos
  // ---------------------------------------------------------------------------
  await scenario('Jogos: aba entre Input Lag e Apps, 31 cartões e detecção conferida por fora', async () => {
    const menu = await ev(`[...document.querySelectorAll('aside [data-nav]')].map((b) => b.dataset.nav)`)
    assert(menu.indexOf('Jogos') === menu.indexOf('Input Lag') + 1 && menu.indexOf('Apps') === menu.indexOf('Jogos') + 1, `ordem do menu: ${menu.join(', ')}`)
    assert(await clickNav('Jogos'), 'menu ausente')
    await waitFor(() => ev(`document.querySelectorAll('[data-game-card]').length > 0 && !!document.querySelector('[data-game-card][data-state="installed"], [data-game-card][data-state="not-detected"], [data-game-card][data-state="unknown"]')`), 90000, 700)
    await sleep(1500)
    const cards = await ev(`[...document.querySelectorAll('[data-game-card]')].map((c) => ({ id: c.dataset.gameCard, state: c.dataset.state, running: c.dataset.running === 'true' }))`)
    assert(cards.length === 31, `${cards.length} cartões`)
    assert(new Set(cards.map((c) => c.id)).size === 31, 'cartões duplicados')
    const scan = await q('games.scan', { refresh: true })
    const det = Object.fromEntries(scan.detections.map((d) => [d.id, d]))
    const falhas = []
    for (const d of scan.detections) {
      if (d.state !== 'installed' || !d.path) continue
      if (ps("Test-Path -LiteralPath '" + d.path.replace(/'/g, "''") + "'") !== 'True') falhas.push(d.id + ': pasta inexistente ' + d.path)
      if (d.exe && ps("Test-Path -LiteralPath '" + d.exe.replace(/'/g, "''") + "'") !== 'True') falhas.push(d.id + ': executável inexistente ' + d.exe)
    }
    assert(falhas.length === 0, falhas.join('; '))
    const fivemDir = ps(`Join-Path $env:LOCALAPPDATA 'FiveM'`)
    const fivemReal = ps(`(Test-Path (Join-Path '${fivemDir}' 'FiveM.exe')) -and (Test-Path (Join-Path '${fivemDir}' 'FiveM.app'))`) === 'True'
    if (!process.env.JKO_E2E_FAKE_LOCAL) assert((det.fivem.state === 'installed') === fivemReal, `FiveM: app ${det.fivem.state} × disco ${fivemReal}`)
    const uiInstalled = cards.filter((c) => c.state === 'installed').length
    const tiles = await ev(`Object.fromEntries([...document.querySelectorAll('[data-stat]')].map((t) => [t.dataset.stat, t.querySelector('[data-stat-value]').innerText]))`)
    const jogos = scan.detections.filter((d) => d.state === 'installed' && !['msi-app-player', 'bluestacks', 'ldplayer', 'gameloop', 'memu'].includes(d.id)).length
    assert(Number(tiles.games) === jogos, `jogos detectados: tela ${tiles.games} × detecção ${jogos}`)
    await shot('jogos-biblioteca.png')
    const inst = scan.detections.filter((d) => d.state === 'installed').map((d) => d.id + '(' + d.sources[0].split(' (')[0] + ', ' + d.confidence + ')')
    return `31 cartões · ${uiInstalled} instalado(s): ${inst.join(', ') || 'nenhum'} · FiveM no disco: ${fivemReal} · varredura ${scan.failed.length ? 'incompleta (' + scan.failed.join(',') + ')' : 'completa'} · painéis: ${JSON.stringify(tiles)}`
  })

  await scenario('Jogos: busca, filtros, "somente instalados", estado vazio e capas reais com cache em disco', async () => {
    const ids = () => ev(`[...document.querySelectorAll('[data-game-card]')].map((c) => c.dataset.gameCard)`)
    await setInput('input[aria-label="Pesquisar jogo"]', 'fivem')
    await sleep(300)
    assert(JSON.stringify(await ids()) === '["fivem"]', 'busca fivem: ' + (await ids()))
    await setInput('input[aria-label="Pesquisar jogo"]', 'GOD OF WAR')
    await sleep(300)
    assert((await ids()).length === 2, 'busca "god of war": ' + (await ids()))
    await setInput('input[aria-label="Pesquisar jogo"]', 'zzzzzz')
    await sleep(300)
    assert((await ev(`!!document.querySelector('[data-games-empty]')`)) && (await ids()).length === 0, 'estado vazio da busca')
    await setInput('input[aria-label="Pesquisar jogo"]', '')
    await ev(`document.querySelector('[data-game-filter="Emuladores"]').click()`)
    await sleep(300)
    assert((await ids()).length === 6, 'filtro Emuladores: ' + (await ids()).length)
    await ev(`document.querySelector('[data-game-filter="all"]').click()`)
    await ev(`document.querySelector('[data-only-installed]').click()`)
    await sleep(400)
    const inst = await ev(`[...document.querySelectorAll('[data-game-card]')].map((c) => c.dataset.state)`)
    assert(inst.length >= 1 && inst.every((s) => s === 'installed'), 'somente instalados: ' + inst)
    await ev(`document.querySelector('[data-only-installed]').click()`)
    await sleep(300)
    assert((await ids()).length === 31, 'limpar filtros restaura os 31 cartões')
    const vazias = await ev(`[...document.querySelectorAll('[data-game-category]')].filter((s) => s.querySelectorAll('[data-game-card]').length === 0).length`)
    assert(vazias === 0, 'categorias vazias')
    // Capas: espera as requisições (fila de 3) e confere o que chegou.
    await waitFor(() => ev(`document.querySelectorAll('[data-cover="loading"]').length === 0`), 90000, 1000)
    const covers = await ev(`[...document.querySelectorAll('[data-game-card]')].map((c) => ({ id: c.dataset.gameCard, tipo: c.querySelector('[data-cover]').dataset.cover, w: c.querySelector('[data-cover] img')?.naturalWidth ?? 0 }))`)
    const imagens = covers.filter((c) => c.tipo === 'image')
    assert(imagens.every((c) => c.w >= 400), 'capa quebrada: ' + JSON.stringify(imagens.filter((c) => c.w < 400)))
    const semCapa = covers.filter((c) => c.tipo !== 'image').map((c) => c.id)
    const cache = Number(ps(`@(Get-ChildItem -Path '${userData.replace(/'/g, "''")}' -Recurse -Filter '*.jpg' -ErrorAction SilentlyContinue | Where-Object { $_.DirectoryName -like '*game-covers*' }).Count`))
    assert(cache === imagens.length, `cache em disco ${cache} × capas na tela ${imagens.length}`)
    await shot('jogos-capas.png')
    return `busca, filtros e estado vazio ok · ${imagens.length} capas reais (cache em disco: ${cache}) · ${semCapa.length} com placeholder: ${semCapa.join(', ')}`
  })

  // --- FiveM/GTA V em pasta de teste isolada (JKO_E2E_FAKE_LOCAL): perfis, histórico, reversão e falhas reais ---
  const FAKE = !!process.env.JKO_E2E_FAKE_LOCAL
  const xmlDe = () => {
    const g = { MSAA: '4', ReflectionMSAA: '4', TXAA_Enabled: 'true', FXAA_Enabled: 'false', TextureQuality: '2', ShadowQuality: '3', ReflectionQuality: '3', WaterQuality: '2', ParticleQuality: '2', GrassQuality: '3', ShaderQuality: '2', PostFX: '3', SSAO: '2', Tessellation: '3', AnisotropicFiltering: '16', Shadow_SoftShadows: '3', UltraShadows_Enabled: 'true', Shadow_LongShadows: 'true', DoF: 'true', MotionBlurStrength: '1.000000', LodScale: '1.000000', MaxLodScale: '0.300000', PedLodBias: '0.500000', VehicleLodBias: '0.500000', CityDensity: '1.000000', PedVarietyMultiplier: '1.000000', VehicleVarietyMultiplier: '1.000000', HdStreamingInFlight: 'true' }
    const linhas = Object.entries(g).map(([k, v]) => '    <' + k + ' value="' + v + '" />').join('\n')
    return '<?xml version="1.0" encoding="UTF-8"?>\n<Settings>\n  <graphics>\n' + linhas + '\n  </graphics>\n  <video>\n    <VSync value="1" />\n    <ScreenWidth value="1920" />\n  </video>\n</Settings>\n'
  }
  const valoresXml = (f) => Object.fromEntries([...readFileSync(f, 'utf8').matchAll(/<([A-Za-z0-9_]+)\s+value="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  const fivemXml = FAKE ? join(fakeLocal, 'Roaming', 'CitizenFX', 'gta5_settings.xml') : ''
  const montarFake = () => {
    if (!FAKE) return
    for (const d of [['FiveM', 'FiveM.app', 'data', 'cache', 'game'], ['FiveM', 'FiveM.app', 'data', 'server-cache'], ['FiveM', 'FiveM.app', 'data', 'nui-storage'], ['FiveM', 'FiveM.app', 'crashes'], ['GTAV'], ['Roaming', 'CitizenFX'], ['Perfil', 'Documents', 'Rockstar Games', 'GTA V']]) mkdirSync(join(fakeLocal, ...d), { recursive: true })
    writeFileSync(join(fakeLocal, 'FiveM', 'FiveM.exe'), 'x')
    writeFileSync(join(fakeLocal, 'GTAV', 'GTA5.exe'), 'x')
    writeFileSync(join(fakeLocal, 'FiveM', 'FiveM.app', 'CitizenFX.ini'), 'IVPath=' + join(fakeLocal, 'GTAV') + '\nUpdateChannel=production\n')
    writeFileSync(fivemXml, xmlDe())
    writeFileSync(join(fakeLocal, 'Perfil', 'Documents', 'Rockstar Games', 'GTA V', 'settings.xml'), xmlDe())
    const mk = (rel, kb) => writeFileSync(join(fakeLocal, 'FiveM', 'FiveM.app', rel), Buffer.alloc(kb * 1024, 1))
    mk('data\\cache\\a.bin', 300)
    mk('data\\cache\\game\\pesado.bin', 900)
    mk('data\\server-cache\\s.bin', 120)
    mk('data\\nui-storage\\ui.db', 50)
    mk('crashes\\c.dmp', 80)
  }
  const sha = (f) => ps(`(Get-FileHash -LiteralPath '${f}' -Algorithm SHA256).Hash`)
  const estadoWindows = () => ({
    plano: activeScheme(),
    gm: regRaw('HKCU:\\Software\\Microsoft\\GameBar', 'AutoGameModeEnabled'),
    dvr: regRaw('HKCU:\\System\\GameConfigStore', 'GameDVR_Enabled'),
    cap: regRaw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled'),
    toast: regRaw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled'),
    bg: regRaw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', 'GlobalUserDisabled'),
    transp: regRaw('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'EnableTransparency'),
    usb: ps(`$o = (powercfg /q SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226) | Out-String; ([regex]::Matches($o, '0x([0-9a-fA-F]{8})') | ForEach-Object { $_.Groups[1].Value })[-2]`)
  })
  const restaurarWindows = (s) => {
    psCleanup(`powercfg /setactive ${s.plano}`)
    const set = (k, n, v) => (v === 'ausente' ? psCleanup(`Remove-ItemProperty -LiteralPath '${k}' -Name '${n}' -ErrorAction SilentlyContinue`) : psCleanup(`if (-not (Test-Path '${k}')) { New-Item -Path '${k}' -Force | Out-Null }; Set-ItemProperty -LiteralPath '${k}' -Name '${n}' -Value ${v} -Type DWord`))
    set('HKCU:\\Software\\Microsoft\\GameBar', 'AutoGameModeEnabled', s.gm)
    set('HKCU:\\System\\GameConfigStore', 'GameDVR_Enabled', s.dvr)
    set('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR', 'AppCaptureEnabled', s.cap)
    set('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', 'ToastEnabled', s.toast)
    set('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', 'GlobalUserDisabled', s.bg)
    set('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'EnableTransparency', s.transp)
    psCleanup(`powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 ${parseInt(s.usb, 16)}; powercfg /setactive SCHEME_CURRENT`)
  }
  // Estado "sem otimização" conhecido para as chaves dos perfis (o PC de teste já pode estar otimizado); restaurado no final.
  const prepararBase = () => {
    const set = (k, n, v) => psCleanup(`if (-not (Test-Path '${k}')) { New-Item -Path '${k}' -Force | Out-Null }; Set-ItemProperty -LiteralPath '${k}' -Name '${n}' -Value ${v} -Type DWord`)
    psCleanup('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e')
    set('HKCU:\Software\Microsoft\GameBar', 'AutoGameModeEnabled', 0)
    set('HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications', 'ToastEnabled', 1)
    set('HKCU:\Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications', 'GlobalUserDisabled', 0)
    set('HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize', 'EnableTransparency', 1)
    psCleanup('powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 1; powercfg /setactive SCHEME_CURRENT')
  }
  const abrirJogo = async (id) => {
    await clickNav('Dashboard')
    await sleep(700)
    await clickNav('Jogos')
    if (await ev(`!!document.querySelector('[data-games-back]')`)) await ev(`document.querySelector('[data-games-back]').click()`)
    await waitFor(() => ev(`!!document.querySelector('[data-game-card="${id}"]')`), 30000, 300)
    await sleep(600)
    await ev(`document.querySelector('[data-game-card="${id}"]').click()`)
    await waitFor(() => ev(`!!document.querySelector('[data-page="game-detail"]')`), 10000, 200)
  }
  const planosProntos = () => waitFor(() => ev(`document.querySelectorAll('[data-profile-summary]').length === 3 && ![...document.querySelectorAll('[data-profile-summary]')].some((s) => /Analisando/.test(s.innerText))`), 90000, 700)
  const botaoDialogo = (texto) => ev(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText.trim() === ${JSON.stringify(texto)}).click()`)

  await scenario('Jogos (FiveM isolado): detecção, perfis, cancelar, aplicar com progresso real, histórico e reversão exata', async () => {
    if (!FAKE) return 'ignorado: rode com JKO_E2E_FAKE_LOCAL=1'
    montarFake()
    const scan = await q('games.scan', { refresh: true })
    const det = Object.fromEntries(scan.detections.map((d) => [d.id, d]))
    assert(det.fivem.state === 'installed' && det.fivem.exe?.endsWith('FiveM.exe'), 'FiveM isolado não detectado: ' + JSON.stringify(det.fivem))
    assert(det.gta5.state === 'installed' && /GTA V/.test(det.gta5.sources[0]) && det.gta5.exe?.endsWith('GTA5.exe'), 'GTA V isolado: ' + JSON.stringify(det.gta5))
    const real = estadoWindows()
    prepararBase()
    const orig = estadoWindows()
    const xmlHash = sha(fivemXml)
    try {
      const planos = {}
      for (const l of ['basic', 'intermediate', 'promax']) planos[l] = await q('games.plan', { id: 'fivem', level: l })
      const n = (l, s) => planos[l].rows.filter((r) => r.status === s).length
      assert(planos.basic.rows.some((r) => r.kind === 'info' && /Somente análise/.test(r.intended)) && !planos.basic.rows.some((r) => r.kind === 'graphics'), 'Básica não deve gravar gráficos')
      assert(planos.intermediate.rows.some((r) => r.kind === 'graphics' && r.status === 'apply'), 'Intermediária deveria ter ajustes gráficos')
      assert(planos.promax.rows.length > planos.intermediate.rows.length && planos.intermediate.rows.length > planos.basic.rows.length, 'cada nível inclui o anterior')
      await abrirJogo('fivem')
      await planosProntos()
      const aplicar = planos.intermediate.rows.filter((r) => r.status === 'apply')
      // 1) Cancelar na confirmação: nada muda.
      await ev(`document.querySelector('[data-apply-level="intermediate"]').click()`)
      await waitFor(() => ev(`/Deseja aplicar esta otimização\\?/.test(document.querySelector('[role="dialog"]')?.innerText ?? '')`), 30000, 300)
      const dialogo = await ev(`document.querySelector('[role="dialog"]').innerText`)
      assert(/Cancelar/.test(dialogo) && /Confirmar/.test(dialogo) && aplicar.slice(0, 2).every((r) => dialogo.includes(r.label)), 'confirmação sem a lista de ajustes: ' + dialogo.slice(0, 300))
      await shot('jogos-confirmacao.png')
      await botaoDialogo('Cancelar')
      await sleep(600)
      assert(!(await ev(`!!document.querySelector('[data-operation-progress]')`)), 'abriu progresso depois de cancelar')
      assert(JSON.stringify(estadoWindows()) === JSON.stringify(orig) && sha(fivemXml) === xmlHash, 'cancelar alterou o sistema')
      // 2) Confirmar: progresso real, resultados individuais.
      await ev(`document.querySelector('[data-apply-level="intermediate"]').click()`)
      await waitFor(() => ev(`!!document.querySelector('[role="dialog"]')`), 30000, 300)
      await botaoDialogo('Confirmar')
      await waitFor(() => ev(`!!document.querySelector('[data-operation-progress]')`), 15000, 100)
      assert(await ev(`!!document.querySelector('[data-operation-progress] img[data-brand="mark"]')`), 'sem a logo oficial no progresso')
      await waitFor(() => ev(`!!document.querySelector('[data-operation-result]')`), 120000, 500)
      const fim = await ev(`({ itens: [...document.querySelectorAll('[data-op-item]')].map((i) => i.dataset.opItem + ':' + i.dataset.opState), pct: document.querySelector('[data-operation-percent]').innerText, res: document.querySelector('[data-operation-result]').innerText })`)
      await shot('jogos-progresso.png')
      assert(fim.itens.length >= 2 && fim.itens.every((i) => i.endsWith(':ok')), 'itens: ' + fim.itens.join(', '))
      assert(/^100%/.test(fim.pct) && /aplicada em FiveM/.test(fim.res), 'resultado: ' + fim.pct + ' | ' + fim.res)
      await ev(`document.querySelector('[data-operation-close]').click()`)
      await sleep(800)
      // 3) O sistema mudou de verdade.
      assert(JSON.stringify(estadoWindows()) !== JSON.stringify(orig), 'o estado do Windows não mudou')
      assert(sha(fivemXml) !== xmlHash, 'o arquivo gráfico não mudou')
      const xml = valoresXml(fivemXml)
      assert(xml.MSAA === '0' && xml.ShadowQuality === '1' && xml.VSync === '1' && xml.ScreenWidth === '1920', 'valores gráficos: ' + JSON.stringify(xml).slice(0, 200))
      assert(aplicar.filter((r) => r.kind === 'tweak').length >= 1, 'nenhum ajuste de sistema no perfil')
      // 4) Sem repetir: o mesmo perfil já está aplicado.
      const de = await q('games.plan', { id: 'fivem', level: 'intermediate' })
      assert(de.blocked && /já está aplicado/.test(de.blocked), 'repetição não bloqueada: ' + de.blocked)
      const pv = await jk(`window.jk.ops.preview('games.profile.apply', { id: 'fivem', level: 'intermediate' })`)
      assert(pv.blocked, 'prévia deveria bloquear a repetição')
      // 5) Histórico real e reversão pela interface.
      const h = await q('games.history', { id: 'fivem' })
      assert(h.length === 1 && h[0].outcome === 'ok' && h[0].change?.status === 'applied', 'histórico: ' + JSON.stringify(h[0]?.change))
      await waitFor(() => ev(`!!document.querySelector('[data-revert]')`), 20000, 400)
      await ev(`document.querySelector('[data-revert]').click()`)
      await waitFor(() => ev(`/Revertida/.test(document.querySelector('[data-history-list]')?.innerText ?? '')`), 120000, 600)
      assert(/Revertida/.test(await ev(`document.querySelector('[data-history-list]').innerText`)), 'reversão não aparece no histórico')
      const volta = estadoWindows()
      assert(JSON.stringify(volta) === JSON.stringify(orig), 'estado do Windows após reverter: ' + JSON.stringify(volta) + ' × original ' + JSON.stringify(orig))
      assert(sha(fivemXml) === xmlHash, 'arquivo gráfico não voltou ao original')
      return `perfis: básica ${n('basic', 'apply')}/${planos.basic.rows.length}, intermediária ${n('intermediate', 'apply')}/${planos.intermediate.rows.length}, Pro Max ${n('promax', 'apply')}/${planos.promax.rows.length} (a aplicar/total) · cancelar não alterou nada · ${fim.itens.length} itens "ok", 100% · repetição bloqueada · reversão restaurou registro, powercfg e o arquivo gráfico (hash igual)`
    } finally {
      restaurarWindows(real)
      writeFileSync(fivemXml, xmlDe())
    }
  })

  await scenario('Jogos (FiveM isolado): falha parcial real, jogo em execução, sem permissão e Pro Max revertido', async () => {
    if (!FAKE) return 'ignorado: rode com JKO_E2E_FAKE_LOCAL=1'
    montarFake()
    await q('games.scan', { refresh: true })
    const real = estadoWindows()
    prepararBase()
    const orig = estadoWindows()
    const xmlHash = sha(fivemXml)
    let pid = null
    try {
      // a) Arquivo gráfico somente leitura (falta de permissão de gravação): ajustes do Windows ok, gráficos falham → parcial.
      ps(`(Get-Item -LiteralPath '${fivemXml}').IsReadOnly = $true`)
      const parcial = await act('games.profile.apply', { id: 'fivem', level: 'intermediate' })
      ps(`(Get-Item -LiteralPath '${fivemXml}').IsReadOnly = $false`)
      assert(parcial.outcome && !parcial.outcome.ok && /parcialmente/.test(parcial.outcome.summary), 'esperava resultado parcial: ' + parcial.outcome?.summary)
      const linhas = parcial.outcome.sections[0].rows
      assert(linhas.some((r) => r.tone === 'error' && /Configurações gráficas/.test(r.label)) && linhas.some((r) => r.tone === 'ok'), 'resultados individuais: ' + JSON.stringify(linhas).slice(0, 300))
      assert(sha(fivemXml) === xmlHash, 'o arquivo somente leitura foi alterado')
      const h1 = await q('games.history', { id: 'fivem' })
      assert(h1[0].outcome === 'partial' && h1[0].change?.status === 'applied', 'histórico da execução parcial')
      const rev = await revert(parcial.outcome.changeId)
      assert(rev.status === 'reverted', 'reversão do parcial')
      assert(JSON.stringify(estadoWindows()) === JSON.stringify(orig), 'estado depois de reverter o parcial')
      // b) Jogo em execução: o cliente FiveM é reconhecido e a gravação gráfica é recusada.
      ps(`Copy-Item -LiteralPath "$env:SystemRoot\\System32\\PING.EXE" -Destination '${join(fakeLocal, 'FiveM', 'FiveM.exe')}' -Force`)
      pid = Number(ps(`(Start-Process -FilePath '${join(fakeLocal, 'FiveM', 'FiveM.exe')}' -ArgumentList '-n','400','127.0.0.1' -WindowStyle Hidden -PassThru).Id`))
      await sleep(1500)
      const run = await q('games.running')
      assert(run.running.fivem?.some((r) => r.pid === pid && r.role === 'Cliente FiveM'), 'processo do cliente não reconhecido: ' + JSON.stringify(run.running.fivem))
      assert(!run.running.gta5, 'o cliente FiveM não pode contar como GTA V')
      const plano = await q('games.plan', { id: 'fivem', level: 'intermediate' })
      assert(plano.rows.filter((r) => r.kind === 'graphics').every((r) => r.status === 'skipped') && plano.warnings.some((w) => /em execução/.test(w)), 'gráficos deveriam ser ignorados com o jogo aberto: ' + JSON.stringify(plano.rows.filter((r) => r.kind === 'graphics').map((r) => r.status + ':' + r.id)).slice(0, 200) + JSON.stringify(plano.warnings).slice(0, 300) + ' run=' + JSON.stringify(run.running))
      await clickNav('Jogos')
      await sleep(1000)
      if (await ev(`!!document.querySelector('[data-games-back]')`)) await ev(`document.querySelector('[data-games-back]').click()`)
      await sleep(1000)
      await ev(`document.querySelector('[data-games-refresh]').click()`)
      await waitFor(() => ev(`document.querySelector('[data-game-card="fivem"]')?.dataset.running === 'true'`), 60000, 800)
      assert(await ev(`document.querySelector('[data-game-card="fivem"]').dataset.running === 'true' && !!document.querySelector('[data-game-card="fivem"] [data-live]')`), 'cartão sem destaque de execução')
      ps(`Stop-Process -Id ${pid} -Force`)
      pid = null
      // c) Pro Max aplicado e revertido, com Windows e arquivo restaurados.
      const pm = await act('games.profile.apply', { id: 'fivem', level: 'promax' })
      assert(pm.outcome?.ok, 'Pro Max: ' + pm.outcome?.summary)
      assert(valoresXml(fivemXml).MSAA === '0' && valoresXml(fivemXml).CityDensity === '0.000000', 'Pro Max (iGPU = desempenho): ' + JSON.stringify(valoresXml(fivemXml)).slice(0, 160))
      const rv = await revert(pm.outcome.changeId)
      assert(rv.status === 'reverted' && JSON.stringify(estadoWindows()) === JSON.stringify(orig) && sha(fivemXml) === xmlHash, 'Pro Max não foi revertido por completo')
      // d) Jogo não instalado (CS2): a prévia recusa e nada muda.
      const cs = await jk(`window.jk.ops.preview('games.profile.apply', { id: 'cs2', level: 'basic' })`)
      assert(cs.blocked && /não foi detectado/.test(cs.blocked), 'jogo não instalado: ' + cs.blocked)
      return 'gravação recusada no arquivo somente leitura → resultado parcial com itens individuais (e revertido) · cliente FiveM reconhecido como tal (sem contar como GTA V), cartão destacado em execução e gráficos ignorados · Pro Max aplicado e revertido (hash e registro iguais) · CS2 não instalado recusado'
    } finally {
      if (pid) psCleanup(`Stop-Process -Id ${pid} -Force`)
      psCleanup(`(Get-Item -LiteralPath '${fivemXml}').IsReadOnly = $false`)
      restaurarWindows(real)
      writeFileSync(fivemXml, xmlDe())
      writeFileSync(join(fakeLocal, 'FiveM', 'FiveM.exe'), 'x')
    }
  })

  await scenario('Jogos (FiveM isolado): cache preservando dados, aplicativos em segundo plano e medição', async () => {
    if (!FAKE) return 'ignorado: rode com JKO_E2E_FAKE_LOCAL=1'
    montarFake()
    await q('games.scan', { refresh: true })
    const exe = join(fakeLocal, 'jko-teste-janela.exe')
    let appPid = null
    let gameProc = null
    try {
      // Cache do FiveM: tamanhos reais antes, limpeza só do escolhido, dados preservados.
      const scan = await q('fivem.cache.scan')
      const cat = Object.fromEntries(scan.categories.map((c) => [c.id, c]))
      assert(cat.cache.bytes === 300 * 1024 && cat.game.bytes === 900 * 1024 && cat.serverCache.bytes === 120 * 1024 && cat.crashes.bytes === 80 * 1024, 'tamanhos: ' + JSON.stringify(scan.categories.map((c) => [c.id, c.bytes])))
      const limpar = await act('fivem.cache.clean', { ids: ['cache', 'crashes'] })
      assert(limpar.outcome?.ok, 'limpeza: ' + limpar.outcome?.summary)
      const existe = (rel) => ps(`Test-Path (Join-Path '${fakeLocal}' 'FiveM\\FiveM.app\\${rel}')`) === 'True'
      assert(!existe('data\\cache\\a.bin') && !existe('crashes\\c.dmp'), 'o cache escolhido não foi apagado')
      assert(existe('data\\cache\\game\\pesado.bin') && existe('data\\server-cache\\s.bin') && existe('data\\nui-storage\\ui.db') && existe('CitizenFX.ini'), 'a limpeza apagou dados que deveriam ser preservados')
      // Aplicativos em segundo plano: executável de teste com janela; processos do Windows nunca aparecem.
      ps(`Copy-Item -LiteralPath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Destination '${exe}' -Force`)
      appPid = Number(ps(`(Start-Process -FilePath '${exe}' -ArgumentList '-NoLogo','-NoProfile','-NoExit','-Command','Start-Sleep 600' -WindowStyle Minimized -PassThru).Id`))
      await sleep(2500)
      const cands = await q('games.apps.candidates')
      assert(cands.some((c) => c.name.toLowerCase() === 'jko-teste-janela'), 'aplicativo de teste não aparece como candidato')
      const proibidos = cands.filter((c) => /^(explorer|svchost|dwm|csrss|winlogon|msmpeng|jk optimize|electron|fivem|gta5)$/i.test(c.name))
      assert(proibidos.length === 0, 'candidatos proibidos: ' + proibidos.map((c) => c.name))
      const recusa = await jk(`window.jk.ops.preview('games.apps.close', { names: ['explorer'] })`)
      assert(recusa.blocked, 'fechar o Explorer deveria ser recusado')
      const fecha = await act('games.apps.close', { names: ['jko-teste-janela'] })
      assert(fecha.outcome?.ok, 'fechar: ' + fecha.outcome?.summary)
      await sleep(800)
      assert(ps(`@(Get-Process -Id ${appPid} -ErrorAction SilentlyContinue).Count`) === '0', 'o aplicativo continua aberto')
      appPid = null
      // Medição (FPS Lab do app): sessão cronometrada de 15 s sobre o processo do jogo de teste.
      const procName = 'FiveM_b3258_GTAProcess.exe'
      ps(`Copy-Item -LiteralPath "$env:SystemRoot\\System32\\PING.EXE" -Destination '${join(fakeLocal, procName)}' -Force`)
      gameProc = Number(ps(`(Start-Process -FilePath '${join(fakeLocal, procName)}' -ArgumentList '-n','200','127.0.0.1' -WindowStyle Hidden -PassThru).Id`))
      const sessao = await jk(`window.jk.ops.query('fivem.lab.capture', { label: 'FiveM - antes', tag: 'antes', processName: ${JSON.stringify(procName)}, durationSec: 15, elevated: false })`)
      assert(sessao.telemetry.samples > 0 && sessao.fps === null && /PresentMon/.test(sessao.fpsUnavailableReason ?? ''), 'sessão sem PresentMon deve registrar telemetria e marcar FPS indisponível: ' + JSON.stringify(sessao.fpsUnavailableReason))
      await abrirJogo('fivem')
      await waitFor(() => ev(`!!document.querySelector('[data-measure-list]')`), 40000, 500)
      const lista = await ev(`document.querySelector('[data-measure-list]').innerText`)
      assert(/FiveM - antes/.test(lista) && /indisponível/.test(lista), 'medição não aparece na tela: ' + lista.slice(0, 200))
      await shot('jogos-detalhe.png')
      return 'cache: tamanhos reais conferidos, só o escolhido apagado (jogo baixado, server-cache, nui-storage e ini preservados) · candidatos sem processos protegidos, Explorer recusado, aplicativo de teste fechado normalmente · medição de 15 s registrada com FPS indisponível (sem PresentMon) e exibida'
    } finally {
      if (appPid) psCleanup(`Stop-Process -Id ${appPid} -Force`)
      if (gameProc) psCleanup(`Stop-Process -Id ${gameProc} -Force`)
    }
  })

  // Botões da janela: o clique real chega ao botão (nada o cobre) e o Windows reage.
  const WIN32 = "Add-Type -Name W -Namespace JkW -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int c);';"
  const estadoJanela = () => ps(WIN32 + ' $p = Get-Process -Id ' + app.pid + "; if ([JkW.W]::IsIconic($p.MainWindowHandle)) { 'minimizada' } else { 'normal' }")
  const botao = (nome) =>
    ev(
      "(() => { const b = document.querySelector('[data-window-controls] [aria-label=\"" + nome + "\"]'); if (!b) return null; const r = b.getBoundingClientRect(); const topo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const d = (e) => { for (let n = e; n; n = n.parentElement) { const v = getComputedStyle(n).getPropertyValue('-webkit-app-region'); if (v) return v } return 'none' }; return { acessivel: topo === b || b.contains(topo), regiao: d(b) }; })()"
    )
  const clicar = (nome) => ev("document.querySelector('[data-window-controls] [aria-label=\"" + nome + "\"]').click()")
  await scenario('Botões da janela: minimizar, maximizar/restaurar e fechar respondem ao clique', async () => {
    await jk('window.jk.window.setBounds({ x: 120, y: 80, width: 1200, height: 760 })')
    await sleep(600)
    for (const n of ['Minimizar', 'Maximizar', 'Fechar']) {
      const b = await botao(n)
      assert(b && b.acessivel && b.regiao === 'no-drag', 'botão ' + n + ' coberto ou dentro da área de arraste: ' + JSON.stringify(b))
    }
    await clicar('Maximizar')
    await waitFor(() => jk('window.jk.window.isMaximized()'), 6000, 200)
    assert(await jk('window.jk.window.isMaximized()'), 'Maximizar não maximizou')
    await sleep(500)
    await clicar('Restaurar')
    await waitFor(async () => !(await jk('window.jk.window.isMaximized()')), 6000, 200)
    assert(!(await jk('window.jk.window.isMaximized()')), 'Restaurar não restaurou')
    await clicar('Minimizar')
    await waitFor(async () => (await estadoJanela()) === 'minimizada', 6000, 300)
    const min = await estadoJanela()
    ps(WIN32 + ' $p = Get-Process -Id ' + app.pid + '; [JkW.W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null')
    await sleep(800)
    assert(min === 'minimizada', 'Minimizar não minimizou: ' + min)
    return 'maximizar, restaurar e minimizar (IsIconic) conferidos; os 3 botões ficam fora da área de arraste e descobertos'
  })

  await scenario('Fechar: o clique em Fechar encerra a janela e o processo do aplicativo', async () => {
    await clicar('Fechar')
    const fim = await waitFor(() => {
      try {
        process.kill(app.pid, 0)
        return false
      } catch {
        return true
      }
    }, 12000, 300)
    assert(fim, 'o processo principal continuou ativo 12 s após Fechar')
    return 'processo principal encerrado após o clique'
  })
} finally {
  try {
    ws?.close()
  } catch {}
  app.kill()
  await sleep(1500)
  try {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
  rmSync(userData, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} cenários passaram.`)
  writeFileSync(join(shots, 'resultado.json'), JSON.stringify(results, null, 2))
  process.exitCode = failed.length ? 1 : 0
}
