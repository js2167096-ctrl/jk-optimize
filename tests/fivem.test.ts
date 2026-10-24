// FiveM: detecção de instalação, configurações gráficas, memória, gargalos, relatórios e PresentMon.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyGtaSettings,
  fivemAppDir,
  growthPerMinute,
  gtaEdition,
  parseGtaSettings,
  recommendSettings,
  TUNABLE
} from '../src/main/modules/fivem'
import { parsePresentMonCsv } from '../src/main/modules/presentmon'

test('detecção: GTA V legacy/enhanced e FiveM pelos arquivos reais da pasta', () => {
  const base = mkdtempSync(join(tmpdir(), 'jko-fivem-'))
  const legacy = join(base, 'GTAV')
  const enhanced = join(base, 'GTAVE')
  const fivem = join(base, 'FiveM')
  mkdirSync(legacy)
  mkdirSync(enhanced)
  mkdirSync(join(fivem, 'FiveM.app'), { recursive: true })
  writeFileSync(join(legacy, 'GTA5.exe'), '')
  writeFileSync(join(enhanced, 'GTA5_Enhanced.exe'), '')
  writeFileSync(join(fivem, 'FiveM.exe'), '')
  assert.equal(gtaEdition(legacy), 'legacy')
  assert.equal(gtaEdition(enhanced), 'enhanced')
  assert.equal(gtaEdition(base), null, 'pasta sem executável não é aceita')
  assert.equal(fivemAppDir(fivem), join(fivem, 'FiveM.app'))
  assert.equal(fivemAppDir(legacy), null)
})

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Settings>
  <version value="27" />
  <graphics>
    <MSAA value="4" />
    <GrassQuality value="3" />
    <TextureQuality value="2" />
    <DoF value="true" />
    <MotionBlurStrength value="0.500000" />
  </graphics>
  <video>
    <Windowed value="2" />
  </video>
</Settings>`

test('leitura e alteração do settings.xml preservam todo o resto', () => {
  const values = parseGtaSettings(XML)
  assert.equal(values.MSAA, '4')
  assert.equal(values.Windowed, '2')
  assert.equal(values.version, undefined, 'só lê graphics e video')
  const updated = applyGtaSettings(XML, { MSAA: '0', DoF: 'false' })
  assert.equal(parseGtaSettings(updated).MSAA, '0')
  assert.equal(parseGtaSettings(updated).DoF, 'false')
  assert.equal(updated.replace('<MSAA value="0" />', '<MSAA value="4" />').replace('<DoF value="false" />', '<DoF value="true" />'), XML)
  assert.throws(() => applyGtaSettings(XML, { Inexistente: '1' }))
})

test('valores permitidos por chave', () => {
  assert.ok(TUNABLE.MSAA.allowed.test('0'))
  assert.ok(!TUNABLE.MSAA.allowed.test('3'))
  assert.ok(!TUNABLE.TextureQuality.allowed.test('"/><x'))
  assert.ok(TUNABLE.CityDensity.allowed.test('0.5'))
})

test('recomendações dependem do hardware e não repetem valores já bons', () => {
  const values = parseGtaSettings(XML)
  const integrated = recommendSettings(values, { integratedGpu: true, ramGB: 8 }, 'balanced')
  assert.ok(integrated.some((r) => r.key === 'GrassQuality' && r.recommended === '0'))
  assert.ok(integrated.some((r) => r.key === 'TextureQuality'))
  const dedicated = recommendSettings(values, { integratedGpu: false, ramGB: 32 }, 'balanced')
  assert.ok(!dedicated.some((r) => r.key === 'GrassQuality'))
  assert.ok(dedicated.some((r) => r.key === 'MSAA'))
  const tuned = recommendSettings({ MSAA: '0' }, { integratedGpu: true, ramGB: 8 }, 'performance')
  assert.ok(!tuned.some((r) => r.key === 'MSAA'))
  for (const r of integrated) assert.ok(TUNABLE[r.key].allowed.test(r.recommended), `recomendação fora dos valores permitidos: ${r.key}`)
})

test('tendência de memória por mínimos quadrados', () => {
  const mb = 1024 * 1024
  const pts = [0, 1, 2, 3].map((m) => ({ t: m * 60_000, v: 1000 * mb + m * 50 * mb }))
  assert.equal(Math.round(growthPerMinute(pts)! / mb), 50)
  assert.equal(growthPerMinute(pts.slice(0, 2)), null, 'poucos pontos = sem conclusão')
})

test('PresentMon: CSV v1 e v2, filtro de processo e formato desconhecido', () => {
  const v1 = 'Application,ProcessID,MsBetweenPresents\nFiveM_GTAProcess.exe,1,16.6\nFiveM_GTAProcess.exe,1,16.8\nOutro.exe,2,5\nFiveM_GTAProcess.exe,1,33.4\n'
  const s = parsePresentMonCsv(v1, 'FiveM_GTAProcess.exe')
  assert.equal(s.frames, 3)
  assert.equal(s.column, 'MsBetweenPresents')
  assert.equal(s.frametimeMaxMs, 33.4)
  assert.ok(s.avgFps! > 40 && s.avgFps! < 45)
  const v2 = 'Application,ProcessID,FrameTime\nGame.exe,1,10\nGame.exe,1,10\n'
  assert.equal(parsePresentMonCsv(v2).avgFps, 100)
  assert.throws(() => parsePresentMonCsv('Application,Outra\nx,1\n'), /não reconhecido/)
  assert.throws(() => parsePresentMonCsv('Application,MsBetweenPresents\n'), /não registrou/)
})
