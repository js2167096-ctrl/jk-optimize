// Testes reais da inicialização no Windows: tempo até o painel, barra de progresso, fidelidade da tela de carregamento,
// painel sem sensores e consumo de recursos. Usa pastas de dados temporárias (nunca os dados do usuário).
// Uso: $env:JKO_TEST_OWNER_PASSPHRASE = '<senha>'; node scripts/e2e/inicializacao.mjs
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = join(root, '.e2e-shots')
mkdirSync(shots, { recursive: true })
const passphrase = process.env.JKO_TEST_OWNER_PASSPHRASE
if (!passphrase) throw new Error('Defina JKO_TEST_OWNER_PASSPHRASE.')
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8' }).trim()
const results = []
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
async function scenario(name, fn) {
  // JKO_E2E_ONLY=trecho|trecho: roda só os cenários cujo nome contém algum trecho (depuração).
  if (process.env.JKO_E2E_ONLY && !process.env.JKO_E2E_ONLY.split('|').some((t) => name.includes(t))) return
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name} — ${detail}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name} — ${e.message}`)
  }
}

let portSeq = 9460
/** Abre o app (pasta de dados informada) e conecta ao protocolo de depuração. */
async function launch(userData, env = {}) {
  const port = portSeq++
  const t0 = Date.now()
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, JKO_USER_DATA_DIR: userData, ...env }, stdio: 'ignore' })
  let ws
  let id = 0
  const pending = new Map()
  for (let i = 0; i < 600 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.includes('#overlay'))
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) pending.get(m.id)(m)
        }
      }
    } catch {}
    if (!ws) await sleep(20)
  }
  assert(ws, 'o app não abriu a porta de depuração')
  const send = (method, params = {}) => new Promise((res) => ((pending.set(++id, res), ws.send(JSON.stringify({ id, method, params })))))
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
  const close = async () => {
    try {
      ws.close()
    } catch {}
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
    await sleep(700)
  }
  return { child, t0, send, ev, close, cdpMs: Date.now() - t0 }
}

const unlockExpr = `(async () => { const r = await window.jk.owner.unlock(${JSON.stringify(passphrase)}); return r.ok })()`
function novoPerfil() {
  const userData = mkdtempSync(join(tmpdir(), 'jko-boot-'))
  mkdirSync(join(userData, 'jk-data', 'owner'), { recursive: true })
  copyFileSync(join(root, 'owner-keys', 'owner-key.jkokey'), join(userData, 'jk-data', 'owner', 'owner-key.jkokey'))
  return userData
}
/** Espera a tela de carregamento terminar e o painel (ou a tela de acesso) aparecer; devolve os marcos medidos. */
async function medirPainel(app, limiteMs = 30_000) {
  const marcos = {}
  const fim = Date.now() + limiteMs
  while (Date.now() < fim) {
    const s = await app.ev(`(() => ({ splash: !!document.querySelector('[data-splash]'), dash: !!document.querySelector('[data-dashboard]'), gate: document.body.innerText.length > 40 }))()`)
    if (s?.splash && marcos.splash === undefined) marcos.splash = Date.now() - app.t0
    if (s && !s.splash && s.dash) {
      marcos.painel = Date.now() - app.t0
      break
    }
    await sleep(20)
  }
  marcos.boot = await app.ev(`window.__jkBoot`)
  return marcos
}

const perfil = novoPerfil()
try {
  // Preparação: desbloqueia o proprietário uma vez (a sessão fica lembrada para as próximas aberturas, como no uso real).
  const prep = await launch(perfil)
  for (let i = 0; i < 200 && !(await prep.ev(`!!document.querySelector('[data-splash]') === false && document.body.innerText.length > 40`)); i++) await sleep(50)
  assert(await prep.ev(unlockExpr), 'não foi possível desbloquear o proprietário para o teste')
  await sleep(800)
  await prep.close()

  await scenario('Tela de carregamento: arquivo aprovado localizado, preservado e usado como base', async () => {
    const ref = join(root, 'imagem referencia', 'Tela de Carregamento JK Optimize.png')
    assert(existsSync(ref), 'imagem aprovada não encontrada em imagem referencia')
    const bytes = readFileSync(ref)
    assert(bytes.readUInt32BE(16) === 1536 && bytes.readUInt32BE(20) === 1024, 'dimensões inesperadas da imagem aprovada')
    const base = join(root, 'src', 'renderer', 'assets', 'brand', 'carregamento-base.png')
    const b = readFileSync(base)
    assert(b.readUInt32BE(16) === 1536 && b.readUInt32BE(20) === 1024, 'a base derivada deve ter as mesmas dimensões')
    const dist = readdirAssets()
    assert(dist, 'a base não foi empacotada em out/renderer/assets')
    return `imagem "Tela de Carregamento JK Optimize.png" (1536x1024, ${(bytes.length / 1024).toFixed(0)} KB, original intacto) → base derivada empacotada (${dist})`
  })

  await scenario('Inicialização: painel liberado em até 10 s (3 aberturas reais)', async () => {
    const tempos = []
    const detalhes = []
    for (let i = 0; i < 3; i++) {
      const app = await launch(perfil)
      const m = await medirPainel(app)
      const b = m.boot
      await app.close()
      assert(m.painel !== undefined, `abertura ${i + 1}: o painel não apareceu`)
      assert(b && b.releasedAt !== null, `abertura ${i + 1}: a tela de carregamento não foi liberada`)
      tempos.push(m.painel)
      detalhes.push(`${m.painel} ms (janela ${m.cdp ?? app.cdpMs} ms; etapas: ${Object.entries(b.stages).map(([k, v]) => `${k}@${v}`).join(' ')}; liberada @${b.releasedAt} ms)`)
    }
    const maximo = Math.max(...tempos)
    assert(maximo <= 10_000, `abertura mais lenta: ${maximo} ms`)
    return `até o painel: ${tempos.join(' / ')} ms (limite 10000) · ${detalhes[0]}`
  })

  await scenario('Barra de progresso: avança só com etapas reais, não passa de 60% antes do executor e chega a 100%', async () => {
    const atraso = 5000
    const app = await launch(perfil, { JKO_E2E_BOOT_DELAY_MS: String(atraso) })
    try {
      await app.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false })
      const amostras = []
      let shotFeito = false
      const inicio = Date.now()
      while (Date.now() - inicio < atraso + 9000) {
        const s = await app.ev(`(() => { const e = document.querySelector('[data-splash]'); if (!e) return document.querySelector('[data-dashboard]') ? { gone: true, painel: true } : { carregando: true }; const fill = document.querySelector('[data-splash-fill]'); const tr = fill.parentElement.getBoundingClientRect(); return { pct: Number(e.dataset.splashProgress), texto: document.querySelector('[data-splash-percent]').innerText, label: document.querySelector('[data-splash-label]').innerText, largura: Math.round(100 * fill.getBoundingClientRect().width / (tr.width - 3)) } })()`)
        amostras.push({ t: Date.now() - inicio, ...s })
        if (!shotFeito && s?.pct >= 50 && Date.now() - inicio > 1500) {
          const { result } = await app.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(join(shots, 'carregamento-60.png'), Buffer.from(result.data, 'base64'))
          shotFeito = true
          app.shot = result.data
        }
        if (s?.gone) break
        await sleep(100)
      }
      const vivos = amostras.filter((a) => a.pct !== undefined)
      for (let i = 1; i < vivos.length; i++) assert(vivos[i].pct >= vivos[i - 1].pct, `a barra retrocedeu: ${vivos[i - 1].pct} → ${vivos[i].pct}`)
      for (const a of vivos) assert(a.texto === `${a.pct}%`, `texto "${a.texto}" diferente da barra ${a.pct}%`)
      const antes = vivos.filter((a) => a.t < atraso - 600)
      assert(antes.length > 5 && Math.max(...antes.map((a) => a.pct)) <= 60, `antes do executor terminar a barra passou de 60%: ${Math.max(...antes.map((a) => a.pct))}`)
      assert(vivos.some((a) => a.pct === 100), 'a barra não chegou a 100%')
      const ultimo = amostras.at(-1)
      assert(ultimo.gone && ultimo.painel, 'o painel não foi liberado depois dos 100%')
      const rotulos = [...new Set(vivos.map((a) => a.label))]
      assert(rotulos.length >= 3, `o texto da etapa quase não mudou: ${rotulos.join(' | ')}`)
      const b = await app.ev(`window.__jkBoot`)
      const liberado = b.releasedAt
      assert(liberado >= atraso, `liberou em ${liberado} ms, antes do fim da etapa retida (${atraso} ms)`)
      assert(liberado < atraso + 2500, `liberou só ${liberado - atraso} ms depois do fim da etapa retida`)
      // Largura visual do preenchimento acompanha a porcentagem
      const desvio = Math.max(...vivos.filter((a) => a.largura !== undefined && a.pct > 0).map((a) => Math.abs(a.largura - a.pct)))
      return `${vivos.length} leituras · 0→60% até o executor (retido ${atraso} ms) → 100% → painel @${liberado} ms · etapas: ${Object.entries(b.stages).map(([k, v]) => `${k}@${v}`).join(' ')} · ${rotulos.length} textos de etapa · desvio da barra visual ≤ ${desvio}% (transição)`
    } finally {
      await app.close()
    }
  })

  await scenario('Fidelidade visual: captura a 1536x1024 comparada com a imagem aprovada (fora dos elementos dinâmicos)', async () => {
    const app = await launch(perfil, { JKO_E2E_BOOT_DELAY_MS: '6000' })
    try {
      await app.send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false })
      await sleep(2500)
      const { result } = await app.send('Page.captureScreenshot', { format: 'png' })
      const ref = readFileSync(join(root, 'imagem referencia', 'Tela de Carregamento JK Optimize.png')).toString('base64')
      const r = await app.ev(`(async () => {
        const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64 })
        const [a, b] = await Promise.all([load(${JSON.stringify(result.data)}), load(${JSON.stringify(ref)})])
        const draw = (img) => { const c = document.createElement('canvas'); c.width = 1536; c.height = 1024; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 1536, 1024); return g.getImageData(0, 0, 1536, 1024).data }
        const A = draw(a), B = draw(b)
        const dyn = [[180, 752, 1296, 842], [735, 592, 1284, 668], [1380, 0, 1536, 56]] // barra/%, estado, controles da janela
        let soma = 0, n = 0, iguais = 0
        for (let y = 16; y < 1008; y++) for (let x = 16; x < 1520; x++) {
          if (dyn.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue
          const i = (y * 1536 + x) * 4
          const d = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3
          soma += d; n++; if (d <= 12) iguais++
        }
        return { media: soma / n, iguais: iguais / n }
      })()`)
      assert(r.media < 2.5, `diferença média ${r.media.toFixed(2)} (0-255)`)
      assert(r.iguais > 0.97, `só ${(100 * r.iguais).toFixed(1)}% dos pixels coincidem`)
      writeFileSync(join(shots, 'carregamento-fidelidade.png'), Buffer.from(result.data, 'base64'))
      return `diferença média ${r.media.toFixed(2)}/255 · ${(100 * r.iguais).toFixed(2)}% dos pixels iguais (±12 de 255; a moldura de 1 px da janela reamostra a imagem em frações de pixel) fora dos elementos dinâmicos`
    } finally {
      await app.close()
    }
  })

  await scenario('Sensores indisponíveis: o painel abre no prazo e mostra "indisponível" em vez de valores', async () => {
    const app = await launch(perfil, { JKO_E2E_NO_SAMPLER: '1' })
    try {
      const m = await medirPainel(app)
      assert(m.painel !== undefined && m.painel <= 10_000, `painel em ${m.painel} ms`)
      await sleep(9000)
      const s = await app.ev(`({ tiles: [...document.querySelectorAll('[data-status-tile]')].map((t) => ({ n: t.dataset.statusTile, s: t.dataset.state, v: t.querySelector('[data-metric-value]').innerText })), status: document.querySelector('[data-status]').innerText })`)
      const cpu = s.tiles.find((t) => t.n === 'CPU'), gpu = s.tiles.find((t) => t.n === 'GPU'), ram = s.tiles.find((t) => t.n === 'RAM'), disco = s.tiles.find((t) => t.n === 'Disco')
      assert(cpu.s === 'unavailable' && cpu.v === '—', `CPU deveria estar indisponível: ${JSON.stringify(cpu)}`)
      assert(ram.s === 'unavailable' && gpu.s === 'unavailable', 'RAM e GPU deveriam estar indisponíveis sem o coletor')
      assert(disco.s === 'live', `o disco vem do inventário do Windows e deve aparecer: ${JSON.stringify(disco)}`)
      assert(/Telemetria indisponível|Aguardando a primeira leitura|sem resposta/i.test(s.status), `texto de estado: ${s.status}`)
      return `painel @${m.painel} ms sem coletor · CPU/RAM/GPU "—" (indisponível) · disco do inventário · estado: "${s.status.replace(/\s+/g, ' ')}"`
    } finally {
      await app.close()
    }
  })

  await scenario('Recursos do app: CPU, memória e responsividade com o painel aberto', async () => {
    const app = await launch(perfil)
    try {
      const m = await medirPainel(app)
      assert(m.painel !== undefined, 'o painel não abriu')
      await sleep(6000)
      const nucleos = Number(ps('(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors'))
      const tree = (pid) => `$ids = New-Object System.Collections.ArrayList; $q = @(${pid}); while ($q.Count) { $p = $q[0]; $q = $q[1..($q.Count)]; [void]$ids.Add($p); $q += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object { $_.ProcessId }) }`
      const medida = () => JSON.parse(ps(`${tree(app.child.pid)}; $ps = @(Get-Process -Id $ids -ErrorAction SilentlyContinue); [pscustomobject]@{ ws = ($ps | Measure-Object WorkingSet64 -Sum).Sum; n = $ps.Count; t = (Get-Date).ToFileTimeUtc(); por = @($ps | ForEach-Object { $cl = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.Id)).CommandLine; $tipo = if ($cl -match '--type=([a-z-]+)') { $Matches[1] } elseif ($_.ProcessName -eq 'electron') { 'principal' } else { $_.ProcessName }; [pscustomobject]@{ id = $_.Id; nome = $tipo; cpu = $_.CPU } }) } | ConvertTo-Json -Depth 3 -Compress`))
      const janela = async (nome) => {
        const a = medida()
        await sleep(9000)
        const b = medida()
        const seg = (b.t - a.t) / 1e7
        const por = {}
        for (const p of b.por) { const antes = a.por.find((x) => x.id === p.id); por[p.nome] = (por[p.nome] ?? 0) + ((p.cpu - (antes?.cpu ?? p.cpu)) / seg / nucleos) * 100 }
        const total = Object.values(por).reduce((x, y) => x + y, 0)
        return { nome, total, mem: b.ws / 1048576, texto: `${nome}: ${total.toFixed(1)}% (${Object.entries(por).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')})` }
      }
      const nav = async (label) => {
        await app.ev(`document.querySelector('aside [data-nav=' + JSON.stringify(${JSON.stringify(label)}) + ']').click()`)
        await sleep(2500)
      }
      const dash = await janela('Dashboard')
      await nav('Suporte')
      const sup = await janela('Suporte (sem métricas)')
      await nav('Monitoramento')
      const mon = await janela('Monitoramento')
      await nav('Dashboard')
      const lag = await app.ev(`new Promise((res) => { let max = 0, last = performance.now(), n = 0; const t = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last - 50); last = now; if (++n >= 120) { clearInterval(t); res(Math.round(max)) } }, 50) })`)
      const stats = await app.ev('window.__jkPerfStats')
      assert(Math.max(dash.total, sup.total, mon.total) < 12, 'uso médio de CPU alto: ' + [dash, sup, mon].map((x) => x.texto).join(' | '))
      assert(lag < 250, `atraso máximo do laço de eventos: ${lag} ms`)
      return `CPU (% do computador, ${nucleos} núcleos lógicos) · ${dash.texto} · ${sup.texto} · ${mon.texto} · memória ${dash.mem.toFixed(0)} MB · atraso máx. da interface ${lag} ms · telemetria: coleta ${stats.collectMs.toFixed(0)} ms, entrega ${stats.deliveryMs.toFixed(0)} ms, quadro ${stats.paintMs.toFixed(0)} ms`
    } finally {
      await app.close()
    }
  })
} finally {
  rmSync(perfil, { recursive: true, force: true })
  const falhas = results.filter((r) => !r.ok)
  console.log(`\n${results.length - falhas.length}/${results.length} cenários passaram.`)
  process.exitCode = falhas.length ? 1 : 0
}

function readdirAssets() {
  try {
    const dir = join(root, 'out', 'renderer', 'assets')
    const f = execFileSync('cmd.exe', ['/c', 'dir', '/b', dir], { encoding: 'utf8' }).split(/\r?\n/).find((n) => n.startsWith('carregamento-base'))
    return f ?? null
  } catch {
    return null
  }
}
