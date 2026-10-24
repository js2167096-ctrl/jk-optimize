import { useCallback, useEffect, useMemo, useState } from 'react'
import { BOOT_STAGES, type BootStage } from '@shared/boot'
import baseUrl from './assets/brand/carregamento-base.png'
import type { AccessState, BootstrapInfo, ExecutorStatus, Settings } from '@shared/types'
import { api, call, errorMessage } from './services/api'
import { AppContext, type AppContextValue } from './hooks/useApp'
import type { PageId } from './navigation'
import { AppLayout } from './layouts/AppLayout'
import { Splash } from './pages/gate/Splash'
import { SetupRequired } from './pages/gate/SetupRequired'
import { Activation } from './pages/gate/Activation'
import { OwnerUnlock } from './pages/gate/OwnerUnlock'
import { DashboardPage } from './pages/Dashboard'
import { AppsPage } from './pages/Apps'
import { GamesPage } from './pages/Games'
import { FpsBoostPage } from './pages/sections/FpsBoost'
import { InputLagPage } from './pages/sections/InputLag'
import { TuneAppsPage } from './pages/sections/TuneApps'
import { MemoryPage } from './pages/sections/MemoryPage'
import { NetworkPage } from './pages/sections/NetworkPage'
import { BiosPage } from './pages/sections/BiosPage'
import { CleanupPage } from './pages/sections/CleanupPage'
import { DeployPage } from './pages/sections/DeployPage'
import { UpdatesPage } from './pages/sections/UpdatesPage'
import { ProgressPage } from './pages/sections/ProgressPage'
import { PersonalizePage, applySavedDensity } from './pages/sections/PersonalizePage'
import { ServicesPage } from './pages/sections/ServicesPage'
import { ProcessesPage } from './pages/sections/ProcessesPage'
import { ProfilesPage } from './pages/sections/ProfilesPage'
import { HistoryPage } from './pages/sections/HistoryPage'
import { ExecutorPage } from './pages/ExecutorAdvanced'
import { KeysPage } from './pages/Keys'
import { AdminPage } from './pages/Admin'
import { SettingsPage } from './pages/Settings'
import { Overlay } from './pages/Overlay'
import { ActionProvider } from './components/ActionRunner'
import { WindowFrame } from './components/WindowFrame'
import { SupportPage } from './pages/Support'

// O processo principal limita cada etapa (licença 4 s, identificação 3 s, executor 6 s); este é só o limite de segurança.
const BOOT_TIMEOUT_MS = 12_000
const ACCESS_RECHECK_MS = 60_000

type Boot = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; info: BootstrapInfo }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('A inicialização demorou mais que o esperado.')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export function App() {
  useEffect(() => applySavedDensity(), [])
  // A janela do overlay carrega a mesma página com #overlay e não passa pelo fluxo de inicialização.
  return window.location.hash === '#overlay' ? <Overlay /> : <MainApp />
}

/** Marcos medidos na interface (ms desde o início da navegação), para diagnóstico e testes. Só leitura. */
const bootInfo: { stages: Record<string, number>; releasedAt: number | null; timeOrigin: number; timings: { step: string; ms: number }[] } = { stages: {}, releasedAt: null, timeOrigin: performance.timeOrigin, timings: [] }
;(globalThis as unknown as { __jkBoot: typeof bootInfo }).__jkBoot = bootInfo

/** Avisa quando a interface montada terminou de pintar o primeiro quadro (etapa real "Preparando a interface"). */
function UiReadyProbe({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(onReady)
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [onReady])
  return null
}

function MainApp() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' })
  const [access, setAccess] = useState<AccessState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [executor, setExecutor] = useState<ExecutorStatus | null>(null)
  const [page, setPage] = useState<PageId>('dashboard')
  const [done, setDone] = useState<ReadonlySet<BootStage>>(new Set())
  const [released, setReleased] = useState(false)

  const markDone = useCallback((stage: BootStage) => {
    bootInfo.stages[stage] ??= Math.round(performance.now())
    setDone((prev) => (prev.has(stage) ? prev : new Set(prev).add(stage)))
  }, [])

  const interfaceReady = useCallback(() => markDone('interface'), [markDone])

  // Recursos essenciais: fontes e a imagem da tela de carregamento decodificadas (etapa real).
  useEffect(() => {
    let alive = true
    const img = new Image()
    img.src = baseUrl
    Promise.all([document.fonts?.ready, img.decode().catch(() => undefined)]).finally(() => alive && markDone('resources'))
    return () => {
      alive = false
    }
  }, [markDone])

  // Etapas do processo principal, avisadas assim que terminam (assinatura antes da chamada de inicialização).
  useEffect(() => api.app.onBootProgress((step) => markDone(step)), [markDone])

  const start = useCallback(() => {
    setBoot({ phase: 'loading' })
    setReleased(false)
    setDone((prev) => new Set([...prev].filter((s) => s === 'resources')))
    withTimeout(call(api.app.bootstrap()), BOOT_TIMEOUT_MS)
      .then((info) => {
        setAccess(info.access)
        setSettings(info.settings)
        setExecutor(info.executor)
        bootInfo.timings = info.timings
        setBoot({ phase: 'ready', info })
      })
      .catch((e) => setBoot({ phase: 'error', message: errorMessage(e) }))
  }, [])

  useEffect(start, [start])

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', settings?.reduceMotion ?? false)
  }, [settings?.reduceMotion])

  useEffect(() => {
    const root = document.documentElement
    const first = !root.dataset.theme
    if (!first) root.dataset.themeChanging = ''
    root.dataset.theme = settings?.theme ?? 'blue'
    const t = setTimeout(() => delete root.dataset.themeChanging, 450)
    return () => clearTimeout(t)
  }, [settings?.theme])

  // Reavalia a ativação periodicamente (expiração ou revogação durante o uso).
  useEffect(() => {
    if (boot.phase !== 'ready') return
    const timer = setInterval(() => {
      call(api.app.getAccess()).then(setAccess).catch(() => undefined)
    }, ACCESS_RECHECK_MS)
    return () => clearInterval(timer)
  }, [boot.phase])

  // O painel é liberado quando todas as etapas reais terminaram: sem espera artificial.
  const allDone = BOOT_STAGES.every((s) => done.has(s.id))
  useEffect(() => {
    if (!allDone || released) return
    const t = setTimeout(() => {
      bootInfo.releasedAt = Math.round(performance.now())
      setReleased(true)
    }, 450) // tempo do esmaecimento da tela de carregamento (a barra já mostra 100%)
    return () => clearTimeout(t)
  }, [allDone, released])

  // Se o executor ainda estava iniciando quando o painel abriu, o estado real é atualizado até definir-se.
  useEffect(() => {
    if (boot.phase !== 'ready' || executor?.state !== 'starting') return
    const timer = setInterval(() => {
      call(api.executor.status()).then(setExecutor).catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [boot.phase, executor?.state])

  const context = useMemo<AppContextValue | null>(() => {
    if (boot.phase !== 'ready' || !access || !settings || !executor) return null
    return {
      info: boot.info,
      access,
      settings,
      executor,
      setAccess,
      setSettings,
      setExecutor,
      navigate: setPage
    }
  }, [boot, access, settings, executor])

  if (boot.phase === 'loading')
    return (
      <WindowFrame>
        <Splash done={done} executor={null} />
      </WindowFrame>
    )
  if (boot.phase === 'error' || !context)
    return (
      <WindowFrame>
        <Splash done={done} executor={null} error={boot.phase === 'error' ? boot.message : 'Estado inválido.'} onRetry={start} />
      </WindowFrame>
    )

  // A interface principal é montada por baixo da tela de carregamento (invisível) e a etapa "Preparando a interface"
  // termina quando o primeiro quadro é pintado; a coleta de dados de cada tela segue em segundo plano.
  return (
    <WindowFrame>
      <AppContext.Provider value={context}>
        <div className="h-full" style={released ? undefined : { visibility: 'hidden' }} aria-hidden={!released}>
          {renderAccess(context, page)}
        </div>
        <UiReadyProbe onReady={interfaceReady} />
      </AppContext.Provider>
      {!released && <Splash done={done} executor={context.executor} leaving={allDone} />}
    </WindowFrame>
  )
}

function renderAccess(ctx: AppContextValue, page: PageId) {
  switch (ctx.access.kind) {
    case 'unconfigured':
      return <SetupRequired isPackaged={ctx.info.isPackaged} />
    case 'owner-locked':
      return <OwnerUnlock />
    case 'activation-required':
      return <Activation problem={ctx.access.problem} />
    case 'active':
    case 'owner': {
      const effective = page === 'admin' && ctx.access.kind !== 'owner' ? 'dashboard' : page
      return (
        <ActionProvider>
          <AppLayout page={effective}>{renderPage(effective)}</AppLayout>
        </ActionProvider>
      )
    }
  }
}

function renderPage(page: PageId) {
  switch (page) {
    case 'dashboard':
      return <DashboardPage />
    case 'fps':
      return <FpsBoostPage />
    case 'inputlag':
      return <InputLagPage />
    case 'tuneapps':
      return <TuneAppsPage />
    case 'memory':
      return <MemoryPage />
    case 'network':
      return <NetworkPage />
    case 'bios':
      return <BiosPage />
    case 'cleanup':
      return <CleanupPage />
    case 'deploy':
      return <DeployPage />
    case 'updates':
      return <UpdatesPage />
    case 'progress':
      return <ProgressPage />
    case 'personalize':
      return <PersonalizePage />
    case 'services':
      return <ServicesPage />
    case 'processes':
      return <ProcessesPage />
    case 'profiles':
      return <ProfilesPage />
    case 'history':
      return <HistoryPage />
    case 'games':
      return <GamesPage />
    case 'apps':
      return <AppsPage />
    case 'executor':
      return <ExecutorPage />
    case 'keys':
      return <KeysPage />
    case 'admin':
      return <AdminPage />
    case 'settings':
      return <SettingsPage />
    case 'support':
      return <SupportPage />
  }
}
