// Validação de atualizações: assinatura do manifesto, versões, nomes de arquivo e fonte.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { compareVersions, parseManifest, signManifest, verifyManifest } from '../src/main/security/update-manifest'
import { validateManifestUrl } from '../src/main/modules/updater'

const owner = generateKeyPairSync('ed25519')
const pem = owner.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const other = generateKeyPairSync('ed25519')

const base = {
  format: 'jk-optimize-update' as const,
  version: '0.2.0',
  file: 'JK-Optimize-Setup-0.2.0.exe',
  size: 92_000_000,
  sha512: 'A'.repeat(86) + '==',
  releasedAt: '2026-10-21T00:00:00Z',
  notes: 'Correções'
}

test('manifesto assinado pelo proprietário é aceito', () => {
  const m = signManifest(base, owner.privateKey)
  assert.equal(verifyManifest(parseManifest(JSON.parse(JSON.stringify(m))), pem), true)
})

test('manifesto adulterado ou assinado por outra chave é recusado', () => {
  const m = signManifest(base, owner.privateKey)
  assert.equal(verifyManifest({ ...m, version: '9.9.9' }, pem), false)
  assert.equal(verifyManifest({ ...m, sha512: 'B'.repeat(86) + '==' }, pem), false)
  assert.equal(verifyManifest(signManifest(base, other.privateKey), pem), false)
  assert.equal(verifyManifest({ ...m, signature: undefined }, pem), false)
})

test('manifesto com campos perigosos ou inválidos é rejeitado', () => {
  const m = signManifest(base, owner.privateKey)
  assert.throws(() => parseManifest({ ...m, file: '..\\..\\Windows\\evil.exe' }))
  assert.throws(() => parseManifest({ ...m, file: 'script.ps1' }))
  assert.throws(() => parseManifest({ ...m, version: '1.0' }))
  assert.throws(() => parseManifest({ ...m, size: -1 }))
  assert.throws(() => parseManifest({ ...m, format: 'outro' }))
})

test('comparação de versões', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0)
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.ok(compareVersions('0.1.3', '0.2.0') < 0)
})

test('fonte de atualização precisa ser HTTPS e apontar para o manifesto', () => {
  assert.equal(validateManifestUrl('https://exemplo.com/jk/jk-update.json').hostname, 'exemplo.com')
  assert.throws(() => validateManifestUrl('http://exemplo.com/jk-update.json'))
  assert.throws(() => validateManifestUrl('https://exemplo.com/instalador.exe'))
  assert.throws(() => validateManifestUrl('file:///C:/x/jk-update.json'))
})
