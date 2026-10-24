// Confere os links da aba Aplicativos: precisam ser https, responder com sucesso e terminar no mesmo domínio oficial
// (ou num subdomínio dele). Sites que bloqueiam robôs (403/429) ficam como "não confirmado", nunca como aprovados.
// Uso: node scripts/validar-links.mjs
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/shared/constants/apps-catalog.ts', import.meta.url), 'utf8')
const apps = [...src.matchAll(/id: '([^']+)',[^}]*?name: '([^']+)'[^}]*?url: '([^']+)'/g)].map((m) => ({ id: m[1], name: m[2], url: m[3] }))
const root = (host) => host.split('.').slice(-2).join('.')
let bad = 0
for (const app of apps) {
  const u = new URL(app.url)
  let line
  try {
    const res = await fetch(app.url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JKOptimize-LinkCheck' }, signal: AbortSignal.timeout(20000) })
    const final = new URL(res.url)
    const sameSite = root(final.hostname) === root(u.hostname)
    const ok = res.status >= 200 && res.status < 400 && sameSite && final.protocol === 'https:'
    const blocked = res.status === 403 || res.status === 429
    line = `${ok ? 'OK ' : blocked ? 'NÃO CONFIRMADO (site bloqueia robôs)' : 'FALHA'}  ${app.name} -> ${res.status} ${final.hostname}${sameSite ? '' : ' (DOMÍNIO DIFERENTE)'}`
    if (!ok && !blocked) bad++
  } catch (e) {
    line = `FALHA  ${app.name}: ${e.message}`
    bad++
  }
  console.log(line)
}
console.log(`\n${apps.length} link(s) conferido(s); ${bad} com falha.`)
process.exitCode = bad ? 1 : 0
