import { createContext, useContext } from 'react'
import type { AccessState, BootstrapInfo, ExecutorStatus, Settings } from '@shared/types'
import type { PageId } from '../navigation'

export interface AppContextValue {
  info: BootstrapInfo
  access: AccessState
  settings: Settings
  executor: ExecutorStatus
  setAccess: (access: AccessState) => void
  setSettings: (settings: Settings) => void
  setExecutor: (status: ExecutorStatus) => void
  navigate: (page: PageId) => void
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp fora do AppContext')
  return ctx
}
