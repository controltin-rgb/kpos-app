import { contextBridge, ipcRenderer } from 'electron'
import type { KpossBridge } from '@shared/api'

// Must match RPC_CHANNEL in @shared/api (kept literal so the sandboxed preload bundles nothing else).
const RPC_CHANNEL = 'kposs:rpc'

// The renderer gets exactly one function. No direct DB, Node or Electron access.
const bridge: KpossBridge = {
  invoke: (channel, input) => ipcRenderer.invoke(RPC_CHANNEL, { channel, input }),
}

contextBridge.exposeInMainWorld('kposs', bridge)
