import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ClientEffect } from '@main/request-scope'
import type { Envelope } from '@shared/errors'

/** Pairing code alphabet: no 0/O, 1/I/L — read aloud and typed on a touch screen. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_TTL_MS = 10 * 60_000
export const PAIRING_MAX_ATTEMPTS = 5
export const DEFAULT_LAN_PORT = 3000

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

const hmac = (code: string, msg: string) => createHmac('sha256', normalizeCode(code)).update(msg).digest('hex')

/**
 * Client → Host: proves the Client knows the code AND binds it to the certificate the Client saw.
 * A man in the middle presents a different certificate, so its relayed proof does not verify (D34).
 */
export const clientProof = (code: string, certFingerprint: string) => hmac(code, `kposs-pair-v1|${certFingerprint}`)

/** Host → Client: proves the Host knows the code too (the Client is not talking to an impostor). */
export const hostProof = (code: string, certFingerprint: string, deviceId: string) => hmac(code, `kposs-host-v1|${certFingerprint}|${deviceId}`)

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export type DeviceKind = 'pos' | 'kds' | 'cfd' | 'office'

export interface PairRequest {
  proof: string
  deviceName: string
  hardwareId: string
  kind: DeviceKind
}

export interface PairResponse {
  deviceId: string
  token: string
  hostName: string
  shopName: string
  branchName: string
  hostProof: string
}

export interface PingResponse {
  app: 'kposs'
  version: string
  hostName: string
  shopName: string | null
  /** pairing is open right now (a code is showing on the Host) */
  pairing: boolean
}

export interface RpcRequest {
  /** random id of this run of the Client app — window ids restart at 1 after a restart */
  instance: string
  /** window id on the Client (each window has its own session) */
  window: number
  /** the window's session token, kept in the Client's main process only (never the renderer, D12) */
  session: string | null
  channel: string
  input: unknown
}

export interface RpcResponse {
  envelope: Envelope<unknown>
  effects: ClientEffect[]
  /** the window's session after the call (set by login, cleared by logout / expiry) */
  session: string | null
}
