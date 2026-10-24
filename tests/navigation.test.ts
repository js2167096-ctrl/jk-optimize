// Nova navegação, DNS, BIOS e winget: regras puras (sem tocar no Windows).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NAV_GROUPS, NAV_ITEMS } from '../src/renderer/navigation'
import { validateOps } from '../src/main/modules/elevops'
import { DNS_PROVIDERS } from '../src/main/modules/network-dns'
import { adviseBios } from '../src/main/modules/bios'
import { parseWingetTable } from '../src/main/modules/updates'

test('menu: grupos e ordem pedidos, Configurações penúltimo e Suporte último', () => {
  assert.deepEqual(NAV_GROUPS.map((g) => g.title), ['Início', 'Otimização', 'Sistema', 'Extras', null])
  assert.deepEqual(NAV_GROUPS[1].items.map((i) => i.label), ['FPS Boost', 'Input Lag', 'Jogos', 'Apps', 'Memória', 'Redes', 'BIOS'])
  assert.deepEqual(NAV_GROUPS[2].items.map((i) => i.label), ['Limpeza', 'Deploy', 'Atualizações', 'Progresso', 'Personalização'])
  assert.deepEqual(NAV_GROUPS[3].items.map((i) => i.label), ['Serviços', 'Processos', 'Perfis', 'Histórico e Restauração', 'Aplicativos', 'Executor', 'Chaves', 'Administração'])
  assert.deepEqual(NAV_ITEMS.slice(-2).map((i) => i.label), ['Configurações', 'Suporte'])
  assert.ok(!NAV_ITEMS.some((i) => i.label === 'Monitoramento' || i.label === 'Otimização'))
  assert.equal(new Set(NAV_ITEMS.map((i) => i.id)).size, NAV_ITEMS.length)
})

test('DNS: operação administrativa só aceita adaptador válido e IPv4 (no máximo 4)', () => {
  assert.doesNotThrow(() => validateOps([{ k: 'dns', alias: 'Wi-Fi', servers: [...DNS_PROVIDERS.cloudflare.servers] }]))
  assert.doesNotThrow(() => validateOps([{ k: 'dns', alias: 'Ethernet 2', servers: null }]))
  for (const bad of [{ alias: 'Wi-Fi"; calc', servers: ['1.1.1.1'] }, { alias: 'Wi-Fi', servers: ['1.1.1.256'] }, { alias: 'Wi-Fi', servers: ['dns.exemplo'] }, { alias: 'Wi-Fi', servers: [] }, { alias: 'Wi-Fi', servers: ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'] }]) {
    assert.throws(() => validateOps([{ k: 'dns', ...bad }]), /inválid/i)
  }
})

test('BIOS: recomendações vêm só dos dados lidos', () => {
  const base = { firmware: 2, secureBoot: 1, tpm: { present: true, enabled: true, version: '2.0' }, cpuVirt: true, hypervisor: false, memory: [{ gb: 8, speed: 3200, configured: 3200 }, { gb: 8, speed: 3200, configured: 3200 }] }
  assert.deepEqual(adviseBios(base), [])
  const ids = adviseBios({ ...base, memory: [{ gb: 8, speed: 3200, configured: 2400 }], cpuVirt: false, firmware: 1, tpm: null }).map((a) => a.id)
  assert.deepEqual(ids.sort(), ['channel', 'legacy', 'tpm', 'virt', 'xmp'].sort())
  assert.ok(adviseBios({ ...base, secureBoot: 0 }).some((a) => a.id === 'secureboot' && /BIOS|UEFI/.test(a.steps)))
})

test('winget: tabela de atualizações interpretada pelas colunas', () => {
  const text = [
    'Name                 Id                      Version   Available Source',
    '------------------------------------------------------------------------',
    'Git                  Git.Git                 2.44.0    2.45.1    winget',
    '7-Zip                7zip.7zip               23.01     24.07     winget',
    '2 upgrades available.'
  ].join('\r\n')
  const rows = parseWingetTable(text)
  assert.deepEqual(rows.map((r) => [r.id, r.version, r.available]), [['Git.Git', '2.44.0', '2.45.1'], ['7zip.7zip', '23.01', '24.07']])
  assert.deepEqual(parseWingetTable('Nenhuma atualização.'), [])
})
