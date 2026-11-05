import type { KpossBridge } from '../shared/api'

declare global {
  interface Window {
    kposs: KpossBridge
  }
}

export {}
