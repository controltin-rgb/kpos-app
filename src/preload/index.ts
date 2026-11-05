import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppEvent, KpossBridge } from '@shared/api'

// Must match RPC_CHANNEL / EVENT_CHANNEL in @shared/api (kept literal so the sandboxed preload bundles nothing else).
const RPC_CHANNEL = 'kposs:rpc'
const EVENT_CHANNEL = 'kposs:event'

// The renderer gets exactly two functions. No direct DB, Node or Electron access.
const bridge: KpossBridge = {
  invoke: (channel, input) => ipcRenderer.invoke(RPC_CHANNEL, { channel, input }),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AppEvent) => listener(event)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld('kposs', bridge)
