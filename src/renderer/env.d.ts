/// <reference types="vite/client" />
import type { JkApi } from '@shared/types'

declare global {
  interface Window {
    jk: JkApi
  }
}

export {}
