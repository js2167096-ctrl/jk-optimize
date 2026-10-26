// Regressão: barras invertidas engolidas em template literals quebravam a leitura do registro (Input Lag).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SCRIPT, mouseAcceleration, numberFromText } from '../src/main/modules/inputlag'

test('o script do Input Lag mantém as barras dos caminhos do Windows', () => {
  assert.ok(SCRIPT.includes("'HKCU:\\Control Panel\\Mouse'"))
  assert.ok(SCRIPT.includes("'HKCU:\\Control Panel\\Keyboard'"))
  assert.ok(SCRIPT.includes('root\\wmi'))
})

test('nenhum módulo escreve caminho de registro ou namespace WMI com barra simples em texto de script', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
  const offenders: string[] = []
  for (const file of walk(join(process.cwd(), 'src', 'main')).filter((f) => f.endsWith('.ts'))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // "HKCU:\Letra" ou "root\wmi" com UMA barra no fonte: o JavaScript a descarta.
      if (/HK(?:CU|LM):\\[A-Za-z]/.test(line) || /root\\[a-z]/.test(line)) offenders.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [])
})

test('texto do registro vira número; ausente ou inválido vira null', () => {
  assert.equal(numberFromText('10'), 10)
  assert.equal(numberFromText(' 0 '), 0)
  assert.equal(numberFromText('-1'), -1)
  assert.equal(numberFromText(''), null)
  assert.equal(numberFromText(null), null)
  assert.equal(numberFromText('abc'), null)
  assert.equal(numberFromText(10), null)
})

test('aceleração do ponteiro: leitura real decide; sem leitura é desconhecida (não "ativada")', () => {
  assert.equal(mouseAcceleration({ speed: '0', t1: '0', t2: '0' }), false)
  assert.equal(mouseAcceleration({ speed: '1', t1: '6', t2: '10' }), true)
  assert.equal(mouseAcceleration({ speed: '0', t1: '6', t2: '0' }), true)
  assert.equal(mouseAcceleration({}), null)
  assert.equal(mouseAcceleration({ speed: '0', t1: '0' }), null)
})
