// Atualizações: pacotes com atualização disponível segundo o winget (fonte oficial da Microsoft) e atualização de um pacote por vez.
// Drivers nunca são instalados daqui: o app informa versão e fabricante e leva ao link oficial.
import { execFile } from 'node:child_process'
import { AppFailure } from '../security/validate'
import { defineAction, defineQuery } from '../ops/registry'
import { noParams, obj, str } from '../ops/params'

const WINGET_TIMEOUT = 60_000

function winget(args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile('winget.exe', args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null
      if (err && err.code === 'ENOENT') return reject(new AppFailure('winget-missing', 'O winget não está instalado neste computador (Instalador de Aplicativo da Microsoft).'))
      resolve({ code: typeof err?.code === 'number' ? err.code : err ? 1 : 0, out: `${stdout}\n${stderr}` })
    })
  })
}

export interface UpgradeRow {
  name: string
  id: string
  version: string
  available: string
  source: string
}

/** Interpreta a tabela do `winget upgrade` usando as posições das colunas do cabeçalho (qualquer idioma). Exportada para testes. */
export function parseWingetTable(text: string): UpgradeRow[] {
  const lines = text.replace(/\r/g, '\n').split('\n').map((l) => l.replace(/\u0008/g, ''))
    .filter((l) => l.trim().length > 0)
  const sep = lines.findIndex((l) => /^-{5,}\s*$/.test(l.trim()))
  if (sep < 1) return []
  const header = lines[sep - 1]
  // Colunas: nome, ID, versão, disponível, origem (as posições vêm do cabeçalho).
  const all = [...header.matchAll(/\S+/g)]
  // Cinco palavras = cinco colunas; com mais palavras (cabeçalhos de várias palavras), colunas são separadas por 3 ou mais espaços.
  const starts: number[] = []
  let last = -10
  for (const m of all) {
    const idx = m.index ?? 0
    if (all.length <= 5 || idx - last > 2 || starts.length === 0) starts.push(idx)
    last = idx + m[0].length
  }
  if (starts.length < 4) return []
  const rows: UpgradeRow[] = []
  for (const line of lines.slice(sep + 1)) {
    if (!line.trim() || /^\d+ .*(upgrade|atualiza)/i.test(line.trim()) || /^(The following|Os seguintes)/i.test(line.trim())) continue
    const cut = (i: number) => line.slice(starts[i], starts[i + 1] ?? undefined).trim()
    const row = { name: cut(0), id: cut(1), version: cut(2), available: cut(3), source: starts.length > 4 ? cut(4) : '' }
    if (row.id && /^[A-Za-z0-9][\w.+-]*$/.test(row.id) && row.available) rows.push(row)
  }
  return rows
}

defineQuery({
  id: 'updates.winget.list',
  module: 'apps',
  parse: noParams,
  async run() {
    const r = await winget(['upgrade', '--include-unknown', '--accept-source-agreements', '--disable-interactivity'], WINGET_TIMEOUT)
    const rows = parseWingetTable(r.out)
    return { available: true, rows, at: new Date().toISOString(), note: rows.length === 0 ? 'O winget não listou pacotes com atualização (ou o formato da saída não foi reconhecido).' : null }
  }
})

const ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{1,120}$/

defineAction<{ id: string }, never>({
  id: 'updates.winget.upgrade',
  module: 'apps',
  title: 'Atualizar programa com o winget',
  description: 'Atualiza um único pacote pelo winget (origem oficial), sem instalar nada fora da lista do winget.',
  risk: 'medium',
  reversible: false,
  irreversibleReason: 'O winget não mantém a versão anterior; para voltar, instale a versão desejada manualmente.',
  requiresElevation: false,
  parse: (raw) => ({ id: str(obj(raw, ['id']).id, 'pacote', 121, ID) }),
  async preview({ id }) {
    const r = await winget(['upgrade', '--include-unknown', '--accept-source-agreements', '--disable-interactivity'], WINGET_TIMEOUT)
    const row = parseWingetTable(r.out).find((x) => x.id === id)
    return {
      summary: row ? `${row.name}: ${row.version} → ${row.available}` : 'Pacote sem atualização listada.',
      changes: row ? [{ target: row.name, current: row.version, intended: row.available }] : [],
      warnings: ['O programa pode ser fechado durante a atualização; salve seu trabalho. O winget pode pedir permissão de administrador (UAC) por conta própria.'],
      blocked: row ? null : 'O winget não lista atualização para este pacote agora.'
    }
  },
  async execute({ id }, ctx) {
    ctx.progress(`Atualizando ${id} pelo winget…`)
    const r = await winget(['upgrade', '--id', id, '--exact', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 15 * 60_000)
    const after = parseWingetTable((await winget(['upgrade', '--include-unknown', '--disable-interactivity'], WINGET_TIMEOUT)).out)
    const still = after.some((x) => x.id === id)
    if (r.code !== 0 && still) throw new AppFailure('winget-failed', `O winget retornou o código ${r.code}. ${r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`)
    if (still) throw new AppFailure('winget-verify', 'O winget terminou, mas o pacote ainda aparece com atualização pendente (pode exigir reinício do programa).')
    return { ok: true, verified: true, summary: `${id} atualizado e conferido (não aparece mais como pendente).` }
  }
})
