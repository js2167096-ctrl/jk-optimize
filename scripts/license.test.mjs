// Testes do formato de chaves e do arquivo da chave do proprietário.
// Executar com: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  generateKeyId,
  privateKeyMatchesPublic,
  signLicense,
  verifyLicense
} from '../src/main/security/license.ts'
import { decryptOwnerKey, encryptOwnerKey, OwnerKeyError } from '../src/main/security/owner-key-file.ts'

const owner = generateKeyPairSync('ed25519')
const ownerPem = owner.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const other = generateKeyPairSync('ed25519')
const NOW = Date.UTC(2026, 9, 21)
const ctx = { machineId: 'AAAAA-BBBBB-CCCCC-DDDDD', revoked: new Set(), now: NOW }

function issue(overrides = {}) {
  const payload = { v: 1, id: generateKeyId(), iat: NOW - 1000, exp: null, mid: null, ...overrides }
  return { payload, token: signLicense(payload, owner.privateKey) }
}

test('identificadores são aleatórios e no formato esperado', () => {
  const ids = new Set(Array.from({ length: 2000 }, generateKeyId))
  assert.equal(ids.size, 2000)
  for (const id of ids) assert.match(id, /^[0-9A-Z]{6}(-[0-9A-Z]{6}){3}$/)
})

test('chave válida é aceita', () => {
  const { token, payload } = issue({ exp: NOW + 86_400_000 })
  const result = verifyLicense(token, ownerPem, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.info.id, payload.id)
  assert.equal(result.info.machineBound, false)
})

test('espaços e quebras de linha coladas junto com a chave são ignorados', () => {
  const { token } = issue()
  assert.equal(verifyLicense(`  ${token.slice(0, 40)}\n${token.slice(40)}  `, ownerPem, ctx).ok, true)
})

test('payload alterado invalida a assinatura', () => {
  const { token } = issue({ exp: NOW - 1 })
  const [prefix, , sig] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, id: 'AAAAAA-AAAAAA-AAAAAA-AAAAAA', iat: NOW, exp: null, mid: null })).toString('base64url')
  assert.deepEqual(verifyLicense(`${prefix}.${forged}.${sig}`, ownerPem, ctx), { ok: false, problem: 'invalid' })
})

test('chave assinada por outra chave privada é recusada', () => {
  const payload = { v: 1, id: generateKeyId(), iat: NOW, exp: null, mid: null }
  const token = signLicense(payload, other.privateKey)
  assert.deepEqual(verifyLicense(token, ownerPem, ctx), { ok: false, problem: 'invalid' })
})

test('entradas malformadas são recusadas sem exceção', () => {
  for (const bad of ['', 'abc', 'JKO1.x.y', 'JKO2.a.b', 'JKO1..', 'x'.repeat(5000)]) {
    assert.deepEqual(verifyLicense(bad, ownerPem, ctx), { ok: false, problem: 'invalid' })
  }
})

test('expiração, revogação, vínculo e data futura', () => {
  assert.equal(verifyLicense(issue({ exp: NOW - 1 }).token, ownerPem, ctx).problem, 'expired')

  const revoked = issue()
  assert.equal(verifyLicense(revoked.token, ownerPem, { ...ctx, revoked: new Set([revoked.payload.id]) }).problem, 'revoked')

  const bound = issue({ mid: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' })
  assert.equal(verifyLicense(bound.token, ownerPem, ctx).problem, 'machine-mismatch')
  assert.equal(verifyLicense(bound.token, ownerPem, { ...ctx, machineId: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' }).ok, true)
  assert.equal(verifyLicense(bound.token, ownerPem, { ...ctx, machineId: null }).problem, 'machine-mismatch')

  assert.equal(verifyLicense(issue({ iat: NOW + 3_600_000 }).token, ownerPem, ctx).problem, 'not-yet-valid')
})

test('arquivo da chave do proprietário: cifra, decifra e recusa senha errada', async () => {
  const file = await encryptOwnerKey(owner.privateKey, 'senha-muito-segura-123')
  assert.ok(!file.includes('PRIVATE KEY'))

  const restored = await decryptOwnerKey(file, 'senha-muito-segura-123')
  assert.equal(privateKeyMatchesPublic(restored, ownerPem), true)
  assert.equal(privateKeyMatchesPublic(other.privateKey, ownerPem), false)

  await assert.rejects(decryptOwnerKey(file, 'senha-errada-000000'), (e) => e instanceof OwnerKeyError && e.reason === 'wrong-passphrase')
  await assert.rejects(decryptOwnerKey('{"format":"x"}', 'qualquer'), (e) => e instanceof OwnerKeyError && e.reason === 'malformed')
})
