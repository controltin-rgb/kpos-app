import { AsyncLocalStorage } from 'node:async_hooks'

/** Side effects a handler wants on the CALLING machine (printer, save dialog) — D33. */
export type ClientEffect =
  | { kind: 'print'; html: string; paperMm: 58 | 80 | 210 }
  | { kind: 'save'; name: string; content: string }

/**
 * Per-request context. Calls from this machine's windows run without a scope (deviceId = this
 * machine). Calls from a paired Client over the LAN run inside one: services then act for that
 * device (its shift, its bills), and printing / file saving is handed back to the Client.
 */
export interface RequestScope {
  /** devices.id of the calling Client */
  deviceId: string
  /** effects collected during the call, returned to the Client with the result */
  effects: ClientEffect[]
}

export const requestScope = new AsyncLocalStorage<RequestScope>()

export const remoteScope = (): RequestScope | undefined => requestScope.getStore()
