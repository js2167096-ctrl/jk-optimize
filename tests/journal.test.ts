// Persistência do histórico de alterações, integridade e proteção dos backups, logs sem segredos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackupIntegrityError, Journal } from '../src/main/ops/journal'
import { redactText, redactValue } from '../src/main/ops/redact'

const change = (n = 1) => ({
  actionId: 'power.plan.set',
  module: 'power' as const,
  title: `Teste ${n}`,
  summaryBefore: 'Plano: Equilibrado',
  summaryAfter: 'Plano: Alto desempenho',
  reversible: true,
  before: { previous: 'guid-a', n },
  after: { guid: 'guid-b' }
})

test('alteração é persistida e o backup é lido com integridade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jko-journal-'))
  const journal = new Journal(() => dir)
  const record = journal.add(change())
  const reopened = new Journal(() => dir)
  assert.equal(reopened.list().length, 1)
  assert.equal(reopened.get(record.id)?.status, 'applied')
  const backup = reopened.readBackup(record.id)
  assert.deepEqual(backup.before, { previous: 'guid-a', n: 1 })
  assert.equal(backup.formatVersion, 1)
  assert.equal(backup.actionId, 'power.plan.set')
})

test('backup adulterado bloqueia a reversão', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jko-journal-'))
  const journal = new Journal(() => dir)
  const record = journal.add(change())
  const file = join(dir, 'backups', `${record.id}.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('guid-a', 'guid-x'))
  assert.throws(() => journal.readBackup(record.id), BackupIntegrityError)
})

test('identificador malformado não acessa arquivos fora da pasta', () => {
  const journal = new Journal(() => mkdtempSync(join(tmpdir(), 'jko-journal-')))
  assert.throws(() => journal.readBackup('..\\..\\windows'), BackupIntegrityError)
})

test('estado da reversão é registrado', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jko-journal-'))
  const journal = new Journal(() => dir)
  const record = journal.add(change())
  journal.setStatus(record.id, 'revert-failed', 'motivo')
  assert.equal(journal.get(record.id)?.revertError, 'motivo')
  journal.setStatus(record.id, 'reverted')
  const after = journal.get(record.id)!
  assert.equal(after.status, 'reverted')
  assert.ok(after.revertedAt)
})

test('arquivo de índice corrompido não derruba o diário', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jko-journal-'))
  writeFileSync(join(dir, 'index.json'), '{ quebrado')
  assert.deepEqual(new Journal(() => dir).list(), [])
})

test('logs não registram chaves de ativação nem senhas', () => {
  const text = redactText('ativado com JKO1.eyJhIjoxfQ.c2lnbmF0dXJh e senha=777 password: segredo token=abc')
  assert.ok(!text.includes('eyJhIjoxfQ'))
  assert.ok(!text.includes('777'))
  assert.ok(!text.includes('segredo'))
  assert.ok(!text.includes('abc'))
  assert.deepEqual(redactValue({ passphrase: '777', nested: { key: 'x', ok: 'visível' } }), { passphrase: '[removido]', nested: { key: '[removido]', ok: 'visível' } })
})
