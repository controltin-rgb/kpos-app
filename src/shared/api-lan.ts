import { z } from 'zod'
import type { Access, Endpoint } from './api'

/** Phase 4c-1 IPC contract — Host / Client over the shop LAN (Implement.md §2, D30, D33–D34). */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

export type DeviceRole = 'standalone' | 'host' | 'client'

export interface LanDeviceDto {
  id: string
  name: string
  kind: 'pos' | 'kds' | 'cfd' | 'office'
  hardwareId: string
  lastSeenAt: number | null
  pairedAt: number
  revoked: boolean
  online: boolean
}

export interface LanStatusDto {
  role: DeviceRole
  /** this machine's name (device.json) */
  deviceName: string
  // ---- Host ----
  /** LAN API listening (Host only) */
  running: boolean
  port: number
  /** IPv4 addresses of this machine on the LAN */
  addresses: string[]
  /** short certificate fingerprint people can compare on both screens */
  fingerprint: string | null
  clients: LanDeviceDto[]
  maxClients: number
  pairing: { code: string; expiresAt: number } | null
  /** Host could not start listening (port in use…) */
  error: string | null
  // ---- Client ----
  /** offline selling (D36): bills waiting to reach the Host, reserved numbers left */
  sync: { pending: number; rejected: number; sent: number; lastPullAt: number | null; lastPushAt: number | null; numbersLeft: number } | null
  host: { url: string; name: string; shopName: string; connected: boolean; lastError: string | null } | null
}

export interface LanPingDto {
  ok: boolean
  hostName: string | null
  shopName: string | null
  pairing: boolean
  latencyMs: number | null
  error: string | null
}

/** "192.168.1.10", "192.168.1.10:3000" or "pos-host.local:3000" */
const address = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[A-Za-z0-9.-]+(:\d{2,5})?$/)

export const lanApi = {
  'lan.status': ep<LanStatusDto>()('settings:view', z.undefined()),
  /** Standalone ⇄ Host on this machine (switching to Client happens at first-run setup only) */
  'lan.setMode': ep<LanStatusDto>()('settings:update', z.object({ mode: z.enum(['standalone', 'host']), port: z.number().int().min(1024).max(65535).optional() })),
  'lan.startPairing': ep<{ code: string; expiresAt: number }>()('settings:update', z.undefined()),
  'lan.cancelPairing': ep<null>()('settings:update', z.undefined()),
  'lan.revokeDevice': ep<null>()('settings:update', z.object({ id: z.string().min(1).max(64) })),
  /** first-run setup screen: is there a KPOSS Host at this address? */
  'lan.ping': ep<LanPingDto>()('public', z.object({ address })),
  /** first-run setup screen: pair this fresh install with a Host, then restart as a Client */
  'lan.pair': ep<{ hostName: string; shopName: string; restarting: boolean }>()(
    'public',
    z.object({
      address,
      code: z.string().trim().min(8).max(12),
      deviceName: z.string().trim().min(1).max(40),
      kind: z.enum(['pos', 'kds', 'cfd', 'office']).default('pos'),
    }),
  ),
  /** Client: send offline bills and refresh the offline copy now (Host: just returns the status) */
  'lan.syncNow': ep<LanStatusDto>()('pos:view', z.undefined()),
  /** Client: forget the Host and restart as a fresh install */
  'lan.unpair': ep<{ restarting: boolean }>()('settings:update', z.object({ confirm: z.literal('UNPAIR') })),
} as const
