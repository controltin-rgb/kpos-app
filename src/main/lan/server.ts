import type { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { requestScope } from '@main/request-scope'
import type { AppEvent } from '@shared/api'
import { AppError, type Envelope } from '@shared/errors'
import type { Sessions } from '@main/ipc/router'
import type { HostCert } from './cert'
import type { LanHostService } from './lan-host.service'
import type { PairRequest, PingResponse, RpcRequest, RpcResponse } from './protocol'

const MAX_BODY = 10 * 1024 * 1024
const KEEPALIVE_MS = 25_000
/** never accepted from another machine, whatever its permissions */
const HOST_ONLY_CHANNELS = new Set(['lan.setMode', 'lan.pair', 'lan.unpair', 'pos.openWindow', 'pos.showOnCfd', 'cfd.state'])

export interface LanServerDeps {
  cert: HostCert
  host: LanHostService
  dispatch: (sender: number, channel: string, input: unknown) => Promise<Envelope<unknown>>
  /** the Host's sender → session map (the Client supplies its window's token with each call) */
  sessions: Sessions
  /** AppEvents of the Host ('event') — forwarded to Clients, except the per-device CFD state */
  events: EventEmitter
  info: () => Omit<PingResponse, 'app' | 'pairing'>
  /** offline selling (D36): snapshot for the Client, bills it sold while the Host was down */
  sync?: { snapshot: (deviceId: string) => unknown; ingest: (deviceId: string, bills: unknown) => unknown; changed?: () => void }
  log?: (msg: string, err: unknown) => void
}

/**
 * HTTPS API the Host exposes to paired Clients (D33–D34):
 *   GET  /ping    no auth — "is a KPOSS Host here?" (setup screen)
 *   POST /pair    pairing code proof → device token
 *   POST /rpc     Bearer token — one IPC call, run as that device (request scope)
 *   GET  /events  Bearer token — server-sent AppEvents (KDS, bills, shifts)
 */
export class LanServer {
  private server: Server | null = null
  private readonly streams = new Map<string, Set<ServerResponse>>()
  /** synthetic sender ids for LAN calls (negative: never a real window) */
  private nextSender = -1000
  /** every raw socket, including ones still in the TLS handshake (closeAllConnections misses those) */
  private readonly sockets = new Set<Socket>()
  private readonly onEvent = (e: AppEvent) => this.broadcast(e)

  constructor(private readonly deps: LanServerDeps) {}

  get port(): number | null {
    const a = this.server?.address() as AddressInfo | null | undefined
    return a?.port ?? null
  }

  get running(): boolean {
    return !!this.server?.listening
  }

  async start(port: number, hostname = '0.0.0.0'): Promise<void> {
    if (this.server) return
    const server = createServer({ key: this.deps.cert.key, cert: this.deps.cert.cert, minVersion: 'TLSv1.2' }, (req, res) => void this.handle(req, res))
    server.headersTimeout = 15_000
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, hostname, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.deps.events.on('event', this.onEvent)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    this.deps.events.off('event', this.onEvent)
    for (const set of this.streams.values()) for (const r of set) r.end()
    this.streams.clear()
    this.syncConnected()
    server.closeAllConnections()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Closes the event streams of a revoked device. */
  dropDevice(deviceId: string): void {
    for (const r of this.streams.get(deviceId) ?? []) r.end()
    this.streams.delete(deviceId)
    this.syncConnected()
  }

  private syncConnected() {
    this.deps.host.connected = new Set(this.streams.keys())
  }

  private broadcast(e: AppEvent) {
    if (e.type === 'cfd.state') return // each Client drives its own customer display
    const line = `data: ${JSON.stringify(e)}\n\n`
    for (const set of this.streams.values()) for (const r of set) r.write(line)
  }

  private deviceOf(req: IncomingMessage): string | null {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    return m ? this.deps.host.authenticate(m[1]!) : null
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'https://host')
      if (req.method === 'GET' && url.pathname === '/ping') {
        return json(res, 200, { app: 'kposs', ...this.deps.info(), pairing: this.deps.host.activePairing() !== null } satisfies PingResponse)
      }
      if (req.method === 'POST' && url.pathname === '/pair') {
        const body = (await readJson(req)) as PairRequest
        if (!body || typeof body.proof !== 'string' || typeof body.deviceName !== 'string' || typeof body.hardwareId !== 'string') throw new AppError('INVALID_INPUT')
        const kind = (['pos', 'kds', 'cfd', 'office'] as const).find((k) => k === body.kind) ?? 'pos'
        const out = this.deps.host.pair({ proof: body.proof, deviceName: body.deviceName.trim().slice(0, 40) || 'POS', hardwareId: body.hardwareId.slice(0, 64), kind }, this.deps.cert.fingerprint)
        return json(res, 200, out)
      }
      const deviceId = this.deviceOf(req)
      if (url.pathname === '/rpc' || url.pathname === '/events' || url.pathname.startsWith('/sync/')) {
        if (!deviceId) return json(res, 401, { error: { code: 'LAN_DEVICE_REVOKED' } })
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        const body = (await readJson(req)) as RpcRequest
        if (!body || typeof body.channel !== 'string' || !Number.isInteger(body.window) || typeof body.instance !== 'string' || body.instance.length > 64) throw new AppError('INVALID_INPUT')
        const session = typeof body.session === 'string' && body.session.length <= 200 ? body.session : null
        if (HOST_ONLY_CHANNELS.has(body.channel)) return json(res, 200, { envelope: { ok: false, error: { code: 'LAN_NOT_AVAILABLE' } }, effects: [], session } satisfies RpcResponse)
        // a fresh Host-side slot per call: the session travels with the call (concurrent calls cannot
        // clobber each other, a Host restart keeps people logged in, a Client restart starts logged out)
        const sender = this.nextSender--
        const { sessions } = this.deps
        if (session) sessions.set(sender, session)
        else sessions.delete(sender)
        const scope = { deviceId: deviceId!, effects: [] }
        try {
          const envelope = await requestScope.run(scope, () => this.deps.dispatch(sender, body.channel, body.input))
          return json(res, 200, { envelope, effects: scope.effects, session: sessions.get(sender) } satisfies RpcResponse)
        } finally {
          sessions.delete(sender) // nothing about a Client window is kept on the Host between calls
        }
      }
      if (this.deps.sync && req.method === 'GET' && url.pathname === '/sync/snapshot') {
        return json(res, 200, this.deps.sync.snapshot(deviceId!))
      }
      if (this.deps.sync && req.method === 'POST' && url.pathname === '/sync/bills') {
        const out = this.deps.sync.ingest(deviceId!, await readJson(req))
        this.deps.sync.changed?.()
        return json(res, 200, out)
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': connected\n\n')
        const set = this.streams.get(deviceId!) ?? new Set()
        set.add(res)
        this.streams.set(deviceId!, set)
        this.syncConnected()
        const ping = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS)
        req.on('close', () => {
          clearInterval(ping)
          set.delete(res)
          if (set.size === 0) this.streams.delete(deviceId!)
          this.syncConnected()
        })
        return
      }
      json(res, 404, { error: { code: 'NOT_FOUND' } })
    } catch (err) {
      if (err instanceof AppError) return json(res, 400, { error: { code: err.code, ...(err.data ? { data: err.data } : {}) } })
      this.deps.log?.('[lan] request failed', err)
      json(res, 500, { error: { code: 'INTERNAL' } })
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' })
  res.end(data)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new AppError('INVALID_INPUT', { reason: 'too_large' })
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new AppError('INVALID_INPUT')
  }
}
