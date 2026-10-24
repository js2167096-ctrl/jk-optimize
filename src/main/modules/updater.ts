// Atualizador: busca um manifesto assinado numa fonte configurada (URL HTTPS ou
// pasta local/rede), valida assinatura, versão, tamanho e SHA-512 do instalador
// e só então executa o instalador NSIS gerado pelo próprio projeto.
import { app, BrowserWindow, dialog, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppFailure } from '../security/validate'
import { LICENSE_PUBLIC_KEY_PEM } from '../security/license-public-key'
import { compareVersions, parseManifest, verifyManifest, type UpdateManifest } from '../security/update-manifest'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, oneOf, str } from '../ops/params'
import { JsonStore } from '../services/store'

interface UpdaterConfig {
  source: { type: 'url' | 'folder'; value: string } | null
  lastCheck: { at: string; result: string } | null
}

const store = new JsonStore<UpdaterConfig>('updater.json', (raw) => {
  const r = (raw ?? {}) as Partial<UpdaterConfig>
  const s = r.source
  return {
    source: s && (s.type === 'url' || s.type === 'folder') && typeof s.value === 'string' ? s : null,
    lastCheck: r.lastCheck && typeof r.lastCheck.at === 'string' ? r.lastCheck : null
  }
})

const MANIFEST_NAME = 'jk-update.json'
const MAX_MANIFEST = 64 * 1024

export function validateManifestUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AppFailure('invalid-input', 'URL inválida.')
  }
  if (url.protocol !== 'https:') throw new AppFailure('invalid-input', 'Use uma URL HTTPS.')
  if (!url.pathname.endsWith('.json')) throw new AppFailure('invalid-input', `Informe a URL do manifesto (${MANIFEST_NAME}).`)
  return url
}

async function fetchWithLimit(url: string, limit: number, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const res = await net.fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new AppFailure('update-http', `Servidor respondeu ${res.status}.`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > limit) throw new AppFailure('update-too-large', 'Resposta maior que o permitido.')
    return buf
  } catch (error) {
    if (error instanceof AppFailure) throw error
    throw new AppFailure('update-offline', `Não foi possível acessar a fonte de atualização: ${(error as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function loadManifest(): Promise<{ manifest: UpdateManifest; base: string; type: 'url' | 'folder' }> {
  const { source } = store.read()
  if (!source) throw new AppFailure('update-unconfigured', 'Nenhuma fonte de atualização configurada.')
  if (!LICENSE_PUBLIC_KEY_PEM) throw new AppFailure('unconfigured', 'Sem chave pública para verificar atualizações.')
  let raw: string
  if (source.type === 'url') {
    raw = (await fetchWithLimit(validateManifestUrl(source.value).href, MAX_MANIFEST, 15_000)).toString('utf8')
  } else {
    const file = join(source.value, MANIFEST_NAME)
    if (!existsSync(file)) throw new AppFailure('update-missing', `Arquivo ${MANIFEST_NAME} não encontrado na pasta configurada.`)
    if (statSync(file).size > MAX_MANIFEST) throw new AppFailure('update-too-large', 'Manifesto grande demais.')
    raw = readFileSync(file, 'utf8')
  }
  let manifest: UpdateManifest
  try {
    manifest = parseManifest(JSON.parse(raw.replace(/^﻿/, '')))
  } catch (error) {
    throw new AppFailure('update-invalid', (error as Error).message)
  }
  if (!verifyManifest(manifest, LICENSE_PUBLIC_KEY_PEM)) {
    throw new AppFailure('update-signature', 'Assinatura do manifesto inválida. A atualização foi recusada.')
  }
  return { manifest, base: source.value, type: source.type }
}

async function check() {
  try {
    const { manifest } = await loadManifest()
    const available = compareVersions(manifest.version, app.getVersion()) > 0
    const result = available ? `Versão ${manifest.version} disponível.` : 'Você já está na versão mais recente.'
    store.write({ ...store.read(), lastCheck: { at: new Date().toISOString(), result } })
    return { available, current: app.getVersion(), manifest, result }
  } catch (error) {
    store.write({ ...store.read(), lastCheck: { at: new Date().toISOString(), result: (error as Error).message } })
    throw error
  }
}

defineQuery({
  id: 'updater.status',
  module: 'updater',
  parse: noParams,
  async run() {
    const cfg = store.read()
    return { current: app.getVersion(), packaged: app.isPackaged, source: cfg.source, lastCheck: cfg.lastCheck }
  }
})

defineQuery({
  id: 'updater.source.set',
  module: 'updater',
  parse(raw) {
    const p = obj(raw, ['type', 'url'])
    const type = oneOf(p.type, 'tipo', ['url', 'folder', 'none'] as const)
    return { type, url: type === 'url' ? validateManifestUrl(str(p.url, 'URL', 2000)).href : null }
  },
  async run({ type, url }) {
    const cfg = store.read()
    if (type === 'none') return store.write({ ...cfg, source: null }).source
    if (type === 'url') return store.write({ ...cfg, source: { type, value: url! } }).source
    const win = BrowserWindow.getFocusedWindow()
    const options = { title: 'Pasta com jk-update.json e o instalador', properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return cfg.source
    return store.write({ ...cfg, source: { type: 'folder', value: picked.filePaths[0] } }).source
  }
})

defineQuery({ id: 'updater.check', module: 'updater', parse: noParams, run: () => check() })

function sha512File(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

defineAction<Record<string, never>, never>({
  id: 'updater.install',
  module: 'updater',
  title: 'Instalar atualização',
  description: 'Baixa o instalador da fonte configurada, confere assinatura, tamanho e SHA-512 e instala a nova versão.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'Para voltar, instale a versão anterior manualmente. Ativação e configurações são preservadas.',
  requiresElevation: false,
  exclusive: 'updater',
  parse: noParams,
  async preview() {
    const r = await check()
    return {
      summary: r.available ? `Atualizar de ${r.current} para ${r.manifest.version}.` : r.result,
      changes: r.available ? [{ target: 'JK Optimize', current: r.current, intended: r.manifest.version }] : [],
      warnings: [
        'O aplicativo será fechado durante a instalação e reaberto em seguida.',
        ...(r.manifest.notes ? [`Notas da versão: ${r.manifest.notes}`] : []),
        ...(!app.isPackaged ? ['Modo de desenvolvimento: a instalação substituiria a versão instalada, não este código.'] : [])
      ],
      blocked: r.available ? null : 'Não há versão mais nova.'
    }
  },
  async execute(_p, ctx) {
    const { manifest, base, type } = await loadManifest()
    if (compareVersions(manifest.version, app.getVersion()) <= 0) throw new AppFailure('blocked', 'Não há versão mais nova.')
    const target = join(tmpdir(), `jko-update-${randomUUID()}.exe`)
    try {
      if (type === 'folder') {
        copyFileSync(join(base, manifest.file), target)
      } else {
        const fileUrl = new URL(manifest.file, base)
        if (fileUrl.origin !== new URL(base).origin) throw new AppFailure('update-origin', 'O instalador está em outro domínio; recusado.')
        ctx.progress('Baixando instalador…')
        const buf = await fetchWithLimit(fileUrl.href, manifest.size + 1, 30 * 60_000, ctx.signal)
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(target)
          ws.on('error', reject)
          ws.end(buf, () => resolve())
        })
      }
      const size = statSync(target).size
      if (size !== manifest.size) throw new AppFailure('update-integrity', `Tamanho diferente do manifesto (${size} × ${manifest.size}).`)
      if (sha512File(target) !== manifest.sha512) throw new AppFailure('update-integrity', 'O SHA-512 do instalador não confere. A atualização foi recusada.')
    } catch (error) {
      rmSync(target, { force: true })
      throw error
    }
    spawn(target, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 1500)
    return {
      ok: true,
      verified: true,
      summary: `Instalador da versão ${manifest.version} verificado (assinatura, tamanho e SHA-512) e iniciado. O app será reaberto ao final.`
    }
  }
})
