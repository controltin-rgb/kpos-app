import type { EventEmitter } from 'node:events'
import { networkInterfaces } from 'node:os'
import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import type { LicenseService } from '@main/license/license.service'
import type { AuditService } from '@main/services/audit.service'
import type { DeviceService } from '@main/services/device.service'
import type { SettingsService } from '@main/services/settings.service'
import type { LanPingDto, LanStatusDto } from '@shared/api-lan'
import { AppError, type Envelope } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { loadOrCreateHostCert, shortFingerprint, type HostCert } from './cert'
import { pairWithHost, pingHost, type HostConfig } from './host-connection'
import { LanHostService } from './lan-host.service'
import type { DeviceKind } from './protocol'
import { LanServer, type LanServerDeps } from './server'
import type { Sessions } from '@main/ipc/router'

export interface LanManagerOptions {
  /** where the Host TLS key/cert live (userData/secrets); null = this process cannot be a Host */
  certDir: string | null
  /** persist this machine's role (device.json) */
  saveRole?: (role: 'standalone' | 'host') => void
  /** store the Host config and restart as a Client (Electron) */
  becomeClient?: (cfg: HostConfig, deviceName: string) => void
  appVersion: string
  /** interface to listen on (tests: 127.0.0.1) */
  bindHost?: string
  /** listen on this port instead of the lan.port setting (tests: 0 = any free port) */
  listenPort?: number
  log?: (msg: string, err: unknown) => void
}

export interface LanManagerDeps {
  db: Db
  audit: AuditService
  settings: SettingsService
  license: LicenseService
  device: DeviceService
  events: EventEmitter
  setupRequired: () => boolean
  dispatch: (sender: number, channel: string, input: unknown) => Promise<Envelope<unknown>>
  sessions: Sessions
  now: () => number
  sync?: LanServerDeps['sync']
}

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
}

/** Host / Standalone networking of this machine (D33–D34). */
export class LanManager {
  readonly host: LanHostService
  private server: LanServer | null = null
  private cert: HostCert | null = null
  private error: string | null = null
  private readonly org: OrgRepo

  constructor(
    private readonly deps: LanManagerDeps,
    private readonly opts: LanManagerOptions,
  ) {
    this.host = new LanHostService(deps.db, deps.audit, deps.license, deps.device, deps.now)
    this.org = new OrgRepo(deps.db)
  }

  get role() {
    return this.deps.device.local.role
  }

  /** At startup: listen if this machine is a Host. Never throws (the error shows on the Settings page). */
  async startIfHost(): Promise<void> {
    if (this.role === 'host') {
      // the license no longer lets this machine be a Host (D51): fall back to a single machine
      if (this.deps.license.status().features.maxClients === 0) {
        this.deps.device.local.role = 'standalone'
        this.opts.saveRole?.('standalone')
        return
      }
      await this.listen().catch(() => undefined)
    }
  }

  private async listen(): Promise<void> {
    if (!this.opts.certDir) throw new AppError('LAN_NOT_AVAILABLE')
    this.cert ??= await loadOrCreateHostCert(this.opts.certDir, `KPOSS ${this.deps.device.local.name}`)
    if (!this.server) {
      this.server = new LanServer({
        cert: this.cert,
        host: this.host,
        dispatch: this.deps.dispatch,
        sessions: this.deps.sessions,
        events: this.deps.events,
        ...(this.deps.sync ? { sync: this.deps.sync } : {}),
        info: () => ({ version: this.opts.appVersion, hostName: this.deps.device.local.name, shopName: this.org.firstBranch()?.company_name ?? null }),
        ...(this.opts.log ? { log: this.opts.log } : {}),
      })
    }
    try {
      await this.server.start(this.opts.listenPort ?? this.deps.settings.get('lan.port'), this.opts.bindHost ?? '0.0.0.0')
      this.error = null
    } catch (err) {
      this.error = String((err as Error)?.message ?? err).slice(0, 160)
      throw new AppError('LAN_UNREACHABLE', { message: this.error })
    }
  }

  async stop(): Promise<void> {
    await this.server?.stop()
  }

  get listeningPort(): number | null {
    return this.server?.port ?? null
  }

  status(): LanStatusDto {
    return {
      role: this.role,
      deviceName: this.deps.device.local.name,
      running: !!this.server?.running,
      port: this.server?.port ?? this.deps.settings.get('lan.port'),
      addresses: lanAddresses(),
      fingerprint: this.cert ? shortFingerprint(this.cert.fingerprint) : null,
      clients: this.host.list(),
      maxClients: this.deps.license.status().features.maxClients,
      pairing: this.host.activePairing(),
      error: this.error,
      sync: null,
      host: null,
    }
  }

  /** Standalone ⇄ Host. Audited (high): it opens or closes the shop's LAN API. */
  async setMode(actor: Actor, mode: 'standalone' | 'host', port?: number): Promise<LanStatusDto> {
    if (this.role === 'client') throw new AppError('LAN_NOT_AVAILABLE')
    if (mode === 'host' && this.deps.license.status().features.maxClients === 0) throw new AppError('FEATURE_NOT_LICENSED', { feature: 'host' })
    const before = { role: this.role, port: this.deps.settings.get('lan.port') }
    if (port !== undefined && port !== before.port) {
      await this.server?.stop()
      this.deps.settings.update(actor, { 'lan.port': port })
    }
    if (mode === 'host') await this.listen()
    else {
      this.host.cancelPairing()
      await this.server?.stop()
    }
    this.deps.device.local.role = mode
    this.opts.saveRole?.(mode)
    const at = this.deps.now()
    this.deps.db
      .transaction(() => {
        this.deps.audit.append({ action: 'lan.set_mode', permission: 'settings:update', userId: actor.userId, branchId: actor.branchId, entity: 'device', entityId: this.deps.device.local.id, before, after: { role: mode, port: this.deps.settings.get('lan.port') }, risk: 'high' })
        this.org.setSetting({ id: uuidv7(at), key: 'lan.role', branchId: null, value: mode, userId: actor.userId, now: at })
      })
      .immediate()
    return this.status()
  }

  startPairing(actor: Actor) {
    if (this.role !== 'host' || !this.server?.running) throw new AppError('LAN_NOT_AVAILABLE')
    return this.host.startPairing(actor)
  }

  revoke(actor: Actor, id: string): void {
    this.host.revoke(actor, id)
    this.server?.dropDevice(id)
  }

  async ping(address: string): Promise<LanPingDto> {
    try {
      const p = await pingHost(address)
      return { ok: true, hostName: p.hostName, shopName: p.shopName, pairing: p.pairing, latencyMs: p.latencyMs, error: null }
    } catch (err) {
      return { ok: false, hostName: null, shopName: null, pairing: false, latencyMs: null, error: err instanceof AppError ? err.code : 'LAN_UNREACHABLE' }
    }
  }

  /** First-run setup only: a fresh install becomes a Client of an existing Host. */
  async pair(input: { address: string; code: string; deviceName: string; kind: DeviceKind }): Promise<{ hostName: string; shopName: string; restarting: boolean }> {
    if (!this.deps.setupRequired() || this.role !== 'standalone') throw new AppError('SETUP_ALREADY_DONE')
    const cfg = await pairWithHost(input.address, input.code, { name: input.deviceName, hardwareId: this.deps.license.hardwareId, kind: input.kind })
    if (this.opts.becomeClient) setTimeout(() => this.opts.becomeClient!(cfg, input.deviceName), 300)
    return { hostName: cfg.hostName, shopName: cfg.shopName, restarting: !!this.opts.becomeClient }
  }
}
