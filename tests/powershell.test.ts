// Integração real com o PowerShell do Windows: códigos de saída, falhas, entrada por
// stdin (sem interpolação) e cancelamento de processos longos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PowerShellError, readableStderr, runPowerShell, runPowerShellJson, runPowerShellWith, streamPowerShell } from '../src/main/services/powershell'

test('erros em CLIXML viram texto legível', () => {
  const clixml =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Process : Não foi possível _x000D__x000A_</S><S S="Error">encontrar o processo &lt;7092&gt;._x000D__x000A_</S></Objs>'
  assert.equal(readableStderr(clixml), 'Get-Process : Não foi possível \nencontrar o processo <7092>.')
  assert.equal(readableStderr('erro simples'), 'erro simples')
})

test('erro de script com entrada redirecionada traz a mensagem real', async () => {
  await assert.rejects(runPowerShellWith('Get-Process -Id 999999 -ErrorAction Stop', { x: 1 }), (e: unknown) => e instanceof PowerShellError && !e.message.includes('CLIXML') && e.message.length > 5)
})

test('código de saída diferente de zero vira erro com o código', async () => {
  await assert.rejects(runPowerShell('[Console]::Error.WriteLine("falhou"); exit 3'), (e: unknown) => e instanceof PowerShellError && e.exitCode === 3 && e.message.includes('falhou'))
})

test('saída JSON é interpretada; saída vazia vira null', async () => {
  assert.deepEqual(await runPowerShellJson('[pscustomobject]@{ a = 1; b = "ç" } | ConvertTo-Json -Compress'), { a: 1, b: 'ç' })
  assert.equal(await runPowerShellJson('$null'), null)
})

test('parâmetros vão pela entrada padrão e não são executados como código', async () => {
  const malicious = '"; Remove-Item C:\\nao-existe -WhatIf; "'
  const r = await runPowerShellWith<{ echo: string }>('[pscustomobject]@{ echo = [string]$in.value } | ConvertTo-Json -Compress', { value: malicious })
  assert.equal(r?.echo, malicious)
})

test('processo longo é encerrado ao cancelar', async () => {
  const controller = new AbortController()
  const lines: string[] = []
  const started = Date.now()
  const done = streamPowerShell('while ($true) { "tick"; Start-Sleep -Milliseconds 200 }', (l) => {
    lines.push(l)
    if (lines.length === 2) controller.abort()
  }, { signal: controller.signal })
  await done
  assert.ok(lines.length >= 2)
  assert.ok(Date.now() - started < 15_000)
})
