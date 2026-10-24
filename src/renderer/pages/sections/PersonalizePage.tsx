// Personalização: a aparência do JK Optimize e as preferências visuais do Windows ficam em seções separadas.
import { useState } from 'react'
import { Palette } from 'lucide-react'
import { THEMES } from '@shared/constants/themes'
import type { Settings as SettingsType } from '@shared/types'
import { useApp } from '../../hooks/useApp'
import { api, call, errorMessage } from '../../services/api'
import { Card, cx, Emblem, Notice, PageHeader, Toggle } from '../../components/ui'
import { Tabs } from '../../components/kit'
import { TweakPanel } from '../optimization/Windows2'

type Tab = 'app' | 'windows'

export function PersonalizePage() {
  const [tab, setTab] = useState<Tab>('app')
  return (
    <>
      <PageHeader icon={Palette} accent="advanced" title="Personalização" description="Aparência do JK Optimize e preferências visuais do Windows, em seções separadas." />
      <Tabs value={tab} onChange={setTab} accent="advanced" tabs={[{ id: 'app', label: 'JK Optimize' }, { id: 'windows', label: 'Windows' }]} />
      <div data-personalize-tab={tab}>{tab === 'app' ? <AppLook /> : <WindowsLook />}</div>
    </>
  )
}

const readDensity = () => {
  try {
    return localStorage.getItem('jko-density') === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}
export function applySavedDensity() {
  document.documentElement.dataset.density = readDensity()
}

function AppLook() {
  const [density, setDensity] = useState(readDensity)
  const pickDensity = (v: 'comfortable' | 'compact') => {
    setDensity(v)
    document.documentElement.dataset.density = v
    try {
      localStorage.setItem('jko-density', v)
    } catch {
      /* preferência opcional */
    }
  }
  const { settings, setSettings } = useApp()
  const [error, setError] = useState<string | null>(null)
  const update = (patch: Partial<SettingsType>) => {
    setError(null)
    call(api.settings.update(patch)).then(setSettings).catch((e) => setError(errorMessage(e)))
  }
  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <Card title="Cor do painel" icon={Palette} accent="advanced">
        <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-7" role="radiogroup" aria-label="Tema">
          {THEMES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={settings.theme === t.id} data-theme-choice={t.id} onClick={() => update({ theme: t.id })} className={cx('no-drag flex flex-col items-center gap-2 rounded-card border p-3 text-[12px] transition-colors', settings.theme === t.id ? 'border-performance/60 bg-performance/10 text-fg' : 'border-line text-muted hover:text-fg')}>
              <span className="size-8 rounded-full border border-line-strong" style={{ background: t.swatch }} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-control border border-line p-3">
          <Emblem small brand="mark" className="size-10" />
          <p className="text-[12.5px] text-muted">Pré-visualização: a logo e os destaques acompanham o tema imediatamente. A logo e o nome JK Optimize não mudam.</p>
        </div>
      </Card>
      <Card title="Densidade visual" icon={Palette} accent="advanced">
        <div className="flex gap-2" role="radiogroup" aria-label="Densidade">
          {([['comfortable', 'Confortável'], ['compact', 'Compacta']] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={density === id} data-density-choice={id} onClick={() => pickDensity(id)} className={cx('no-drag h-9 rounded-control border px-4 text-[13px] transition-colors', density === id ? 'border-performance/60 bg-performance/10 text-fg' : 'border-line text-muted hover:text-fg')}>
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-subtle">Aplicada na hora e lembrada neste computador.</p>
      </Card>
      <Card title="Efeitos" icon={Palette} accent="advanced">
        <div className="flex items-center justify-between gap-6">
          <div><p className="text-[13px] text-fg">Reduzir animações</p><p className="text-[12px] text-subtle">Desativa transições e animações da interface do JK Optimize.</p></div>
          <Toggle label="Reduzir animações" checked={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
        </div>
      </Card>
    </div>
  )
}

function WindowsLook() {
  return (
    <Card title="Efeitos visuais do Windows" icon={Palette} accent="advanced">
      <TweakPanel ids={['transparency', 'minAnimate', 'taskbarAnim', 'dragFull', 'menuDelay']} />
      <p className="mt-3 text-[12px] text-subtle">O estado é lido do registro do Windows, o valor anterior é guardado e a mudança é conferida depois. Algumas alterações só aparecem ao reabrir janelas ou entrar de novo na sessão.</p>
    </Card>
  )
}
