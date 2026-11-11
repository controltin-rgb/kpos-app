import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Sessions } from '@main/ipc/router'
import type { LocalDevice } from '@main/services/device.service'
import type { AppEvent, SessionUser } from '@shared/api'
import type { LanStatusDto } from '@shared/api-lan'
import { cfdStateSchema, type CfdState } from '@shared/api-sales'
import { AppError, type Envelope, type ErrorCode } from '@shared/errors'
import { periodKey } from '@shared/bill-number'
import type { HostConnection } from './host-connection'
import type { ClientStore } from '@main/sync/client-store'
import { ClientSync } from '@main/sync/client-sync'
import { isOfflineError, OfflineSupport } from '@main/sync/offline-support'
import type { UpdaterPort } from '@main/updater'
import type { UpdateStatusDto } from '@shared/api-system'
import { featureForChannel, type LicenseFeatures } from '@shared/license'

export interface ClientContextOptions {
  conn: HostConnection
  device: LocalDevice
  versions?: { app: string; electron: string; node: string; chrome: string; platform: string }
  printHtml?: (html: string, opts: { paperMm: 58 | 80 | 210 }) => Promise<void>
  saveFile?: (defaultName: string, content: string) => Promise<string | null>
  /** receipt image picker on this machine */
  pickFile?: () => Promise<string | null>
  pickLicenseFile?: () => Promise<string | null>
  openWindow?: (kind: 'kds' | 'cfd', senderId: number) => void
  /** forget the Host and restart as a fresh install */
  unpair?: () => void
  log?: (msg: string, err: unknown) => void
  /** local queue for selling while the Host is down (D36); absent = online only */
  store?: ClientStore
  now?: () => number
  /** this machine's own auto-update (D42); the feed URL comes from the Host settings */
  updater?: UpdaterPort
  /** called with the Host's feed settings whenever update.status is answered */
  setUpdateFeed?: (feedUrl: string, autoCheck: boolean) => void
}

const fail = (code: ErrorCode, data?: Record<string, unknown>): Envelope<never> => ({ ok: false, error: { code, ...(data ? { data } : {}) } })

/** Channels that make no sense on a Client (Host administration, first-run pairing). */
const NOT_ON_CLIENT = new Set(['lan.setMode', 'lan.startPairing', 'lan.cancelPairing', 'lan.revokeDevice', 'lan.ping', 'lan.pair', 'backup.pickFolder'])

/**
 * The main process of a Client (D33): no database here — every call goes to the Host over the
 * pinned HTTPS connection, acting as this device. What must happen on THIS machine stays here:
 * printing, save dialogs, file pickers, the KDS/CFD windows and the customer display state.
 */
export function createClientContext(opts: ClientContextOptions) {
  const { conn } = opts
  const events = new EventEmitter()
  const emit = (e: AppEvent) => events.emit('event', e)
  /** secondary windows (KDS) share the session of the window that opened them */
  const alias = new Map<number, number>()
  let lastCfd: CfdState | null = null
  const now = opts.now ?? Date.now
  const offline = opts.store ? new OfflineSupport(opts.store, { id: conn.cfg.deviceId, name: opts.device.name }, now) : null
  const sync = opts.store
    ? new ClientSync(opts.store, conn, (s) => emit({ type: 'sync.state', pending: s.pending, rejected: s.rejected }), now, opts.log ?? (() => {}))
    : null
  const winOf = (sender: number) => alias.get(sender) ?? sender
  /** session token per window — held here in the main process, never given to the renderer (D12) */
  const tokens = new Map<number, string>()
  /** last time the Host did not answer — skip the network for a while instead of waiting for timeouts */
  let offlineSince = 0
  const OFFLINE_SHORTCUT_MS = 15_000
  const printLocal = async (html: string, paperMm: 58 | 80) => {
    await opts.printHtml?.(html, { paperMm })
  }

  const sessions: Sessions = {
    get: () => null,
    set: () => {},
    delete: (id) => {
      alias.delete(id)
      tokens.delete(id)
      offline?.forgetWindow(id)
    },
  }

  async function forward(sender: number, channel: string, input: unknown): Promise<Envelope<unknown>> {
    let res
    try {
      res = await conn.rpc(winOf(sender), channel, input, tokens.get(winOf(sender)) ?? null)
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError('LAN_UNREACHABLE')
      if (isOfflineError(e.code)) offlineSince ||= now()
      return fail(e.code, e.data)
    }
    if (res.session) tokens.set(winOf(sender), res.session)
    else tokens.delete(winOf(sender))
    offline?.observe(winOf(sender), channel, res.envelope)
    offlineSince = 0
    let envelope = res.envelope
    for (const effect of res.effects) {
      try {
        if (effect.kind === 'print') await opts.printHtml?.(effect.html, { paperMm: effect.paperMm })
        else if (effect.kind === 'save') {
          const path = (await opts.saveFile?.(effect.name, effect.content)) ?? null
          if (envelope.ok) envelope = { ok: true, data: path }
        }
      } catch (err) {
        opts.log?.('[client] local effect failed', err)
        if (effect.kind === 'print') return fail('PRINT_FAILED')
      }
    }
    return envelope
  }

  /** Permission check for calls answered locally: the Host knows who is logged in on this window. */
  async function can(sender: number, perm: string): Promise<boolean> {
    const me = await forward(sender, 'auth.me', undefined)
    if (!me.ok && isOfflineError(me.error.code)) return offline?.cachedCan(winOf(sender), perm) ?? false
    const user = me.ok ? (me.data as SessionUser | null) : null
    return !!user && (user.permissions.includes('*') || user.permissions.includes(perm))
  }

  function status(): LanStatusDto {
    return {
      role: 'client',
      deviceName: opts.device.name,
      running: false,
      port: 0,
      addresses: [],
      fingerprint: conn.cfg.fingerprint.split(':').slice(0, 4).join(':'),
      clients: [],
      maxClients: 0,
      pairing: null,
      error: null,
      sync: sync ? { ...sync.state(), numbersLeft: numbersLeft() } : null,
      host: { url: conn.url, name: conn.cfg.hostName, shopName: conn.cfg.shopName, connected: conn.status.connected, lastError: conn.status.lastError },
    }
  }

  /** last license features the Host reported (system.info); null until known → nothing is refused */
  let hostFeatures: LicenseFeatures | null = null

  async function dispatch(sender: number, channel: string, input: unknown): Promise<Envelope<unknown>> {
    try {
      if (NOT_ON_CLIENT.has(channel)) return fail('LAN_NOT_AVAILABLE')
      // channels answered here never reach the Host's gate, so the Host's license features are checked here (D51)
      const needed = featureForChannel(channel) ?? (channel === 'pos.openWindow' ? ((input as { kind?: unknown } | null)?.kind === 'cfd' ? 'cfd' : (input as { kind?: unknown } | null)?.kind === 'kds' ? 'kds' : null) : null)
      if (needed && hostFeatures && !hostFeatures[needed]) return { ok: false, error: { code: 'FEATURE_NOT_LICENSED', data: { feature: needed } } }
      switch (channel) {
        case 'pos.openWindow': {
          const kind = (input as { kind?: unknown } | null)?.kind
          if (kind !== 'kds' && kind !== 'cfd') return fail('INVALID_INPUT')
          if (!(await can(sender, 'pos:view'))) return fail('FORBIDDEN')
          opts.openWindow?.(kind, sender)
          return { ok: true, data: null }
        }
        case 'pos.showOnCfd': {
          const parsed = cfdStateSchema.safeParse(input)
          if (!parsed.success) return fail('INVALID_INPUT')
          lastCfd = parsed.data
          emit({ type: 'cfd.state', payload: parsed.data })
          return { ok: true, data: null }
        }
        case 'cfd.state':
          return { ok: true, data: lastCfd }
        case 'lan.status':
          if (!(await can(sender, 'settings:view'))) return fail('FORBIDDEN')
          return { ok: true, data: status() }
        case 'lan.syncNow': {
          if (!(await can(sender, 'pos:view'))) return fail('FORBIDDEN')
          await sync?.tick()
          return { ok: true, data: status() }
        }
        case 'lan.unpair': {
          if ((input as { confirm?: unknown } | null)?.confirm !== 'UNPAIR') return fail('INVALID_INPUT')
          // a revoked device cannot log in anymore, so it may always be reset
          if (conn.status.lastError !== 'LAN_DEVICE_REVOKED' && !(await can(sender, 'settings:update'))) return fail('FORBIDDEN')
          setTimeout(() => opts.unpair?.(), 300)
          return { ok: true, data: { restarting: !!opts.unpair } }
        }
        case 'system.info': {
          // never fails: the renderer needs it to show the "Host unreachable" screen
          const knownDown = offlineSince && now() - offlineSince < OFFLINE_SHORTCUT_MS && !conn.status.connected
          const host = knownDown ? fail('LAN_UNREACHABLE') : await forward(sender, channel, input)
          const v = opts.versions ?? { app: '', electron: '', node: process.versions.node, chrome: '', platform: process.platform }
          const base = host.ok ? (host.data as Record<string, unknown>) : { sqlite: '', schemaVersion: 0 }
          if (host.ok && (base as { features?: LicenseFeatures }).features) hostFeatures = (base as { features: LicenseFeatures }).features
          return {
            ok: true,
            data: { ...base, deviceRole: 'client', deviceName: opts.device.name, hostName: conn.cfg.hostName, hostConnected: host.ok, offlinePending: opts.store?.counts().pending ?? null, appVersion: v.app, electron: v.electron, node: v.node, chrome: v.chrome, platform: v.platform },
          }
        }
        // every machine installs its own update; the Host only tells where the files are
        case 'update.status': {
          const host = await forward(sender, channel, input)
          if (host.ok) {
            const h = host.data as UpdateStatusDto
            opts.setUpdateFeed?.(h.feedUrl, h.autoCheck)
          }
          if (!opts.updater) return host
          return { ok: true, data: opts.updater.status() }
        }
        case 'update.check':
        case 'update.install': {
          if (!opts.updater) return forward(sender, channel, input)
          if (!(await can(sender, 'settings:update'))) return fail('FORBIDDEN')
          if (channel === 'update.install') {
            setTimeout(() => opts.updater?.install(), 300)
            return { ok: true, data: null }
          }
          return { ok: true, data: await opts.updater.check() }
        }
        case 'expenses.pickReceipt': {
          const file = await opts.pickFile?.()
          if (!file) return { ok: true, data: null }
          const data = await readFile(file)
          if (data.length > 5 * 1024 * 1024) return fail('INVALID_INPUT', { reason: 'size' })
          return forward(sender, 'expenses.uploadReceipt', { ext: extname(file).toLowerCase(), dataBase64: data.toString('base64') })
        }
        case 'license.import': {
          const content = (input as { content?: unknown } | null)?.content
          if (typeof content === 'string') return forward(sender, channel, input)
          const picked = await opts.pickLicenseFile?.()
          if (picked === null || picked === undefined) return { ok: true, data: null }
          return forward(sender, channel, { content: picked })
        }
        case 'shift.close': {
          // the drawer total must include every bill sold offline before the shift is counted
          if (sync && opts.store!.counts().pending > 0) await sync.push().catch(() => undefined)
          if (opts.store && opts.store.counts().pending > 0) return fail('SYNC_PENDING')
          return forward(sender, channel, input)
        }
        default: {
          // a retried checkout / reprint of a bill that only exists here
          if (offline && (channel === 'pos.checkout' || channel === 'orders.print')) {
            const key = (input as { requestId?: unknown; id?: unknown } | null) ?? {}
            const local = channel === 'pos.checkout' ? key.requestId : key.id
            if (offline.isLocalBill(local) && (channel === 'pos.checkout' || !conn.status.connected)) return offline.handle(winOf(sender), channel, input, printLocal)
          }
          if (offline?.handles(channel) && offlineSince && now() - offlineSince < OFFLINE_SHORTCUT_MS && !conn.status.connected) {
            const out = await offline.handle(winOf(sender), channel, input, printLocal)
            if (channel === 'pos.checkout' && out.ok) emit({ type: 'sync.state', ...opts.store!.counts() })
            return out
          }
          const env = await forward(sender, channel, input)
          if (offline && !env.ok && offline.handles(channel) && (isOfflineError(env.error.code) || (channel === 'orders.print' && env.error.code === 'NOT_FOUND'))) {
            const out = await offline.handle(winOf(sender), channel, input, printLocal)
            if (channel === 'pos.checkout' && out.ok) {
              emit({ type: 'sync.state', ...opts.store!.counts() })
              void sync?.push().catch(() => undefined)
            }
            return out
          }
          return env
        }
      }
    } catch (err) {
      opts.log?.(`[client] ${channel} failed`, err)
      return fail('INTERNAL')
    }
  }

  function numbersLeft(): number {
    const snap = opts.store?.snapshot()
    if (!snap || !opts.store) return 0
    return opts.store.numbersLeft(periodKey(snap.settings.billPolicy, now()))
  }

  const stopEvents = conn.subscribe((e) => emit(e))
  const stopState = conn.onState((s) => {
    emit({ type: 'lan.state', connected: s.connected, error: s.lastError })
    if (s.connected) {
      offlineSince = 0
      void sync?.tick() // back online: send offline bills, refresh prices and numbers
    }
  })
  sync?.start()

  return {
    role: 'client' as const,
    dispatch,
    sessions,
    events,
    conn,
    /** a KDS/CFD window opened from `parent` uses the same Host session */
    aliasWindow: (child: number, parent: number) => alias.set(child, alias.get(parent) ?? parent),
    sync,
    stop: () => {
      stopEvents()
      stopState()
      sync?.stop()
    },
  }
}

export type ClientContext = ReturnType<typeof createClientContext>
