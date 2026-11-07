import { randomUUID, X509Certificate } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { request, type RequestOptions } from 'node:https'
import { connect, type PeerCertificate } from 'node:tls'
import type { AppEvent } from '@shared/api'
import { AppError, type ErrorCode } from '@shared/errors'
import { clientProof, DEFAULT_LAN_PORT, hostProof, safeEqualHex, type DeviceKind, type PairResponse, type PingResponse, type RpcRequest, type RpcResponse } from './protocol'

/** What a Client remembers about its Host (userData/host.json + the token in secrets). */
export interface HostConfig {
  hostname: string
  port: number
  deviceId: string
  token: string
  /** the Host certificate pinned at pairing (PEM) */
  certPem: string
  fingerprint: string
  hostName: string
  shopName: string
}

export function parseAddress(address: string): { hostname: string; port: number } {
  const [hostname, port] = address.trim().split(':') as [string, string | undefined]
  const p = port ? Number(port) : DEFAULT_LAN_PORT
  if (!hostname || !Number.isInteger(p) || p < 1 || p > 65535) throw new AppError('INVALID_INPUT', { fields: { address: ['invalid'] } })
  return { hostname, port: p }
}

const TIMEOUT_MS = 8_000

function pinned(cfg: Pick<HostConfig, 'certPem' | 'fingerprint'>): Pick<RequestOptions, 'ca' | 'checkServerIdentity'> & { allowPartialTrustChain: boolean } {
  return {
    ca: cfg.certPem,
    // Electron's BoringSSL only accepts a self-signed leaf as a trust anchor with partial chains on
    allowPartialTrustChain: true,
    // the pinned certificate IS the trust anchor; the name in it does not matter, its fingerprint does
    checkServerIdentity: (_host: string, cert: PeerCertificate) => (cert.fingerprint256 === cfg.fingerprint ? undefined : new Error('LAN_CERT_MISMATCH')),
  }
}

function lanError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const msg = String((err as Error)?.message ?? err)
  if (/LAN_CERT_MISMATCH|self.signed|certificate/i.test(msg)) return new AppError('LAN_CERT_MISMATCH')
  return new AppError('LAN_UNREACHABLE', { message: msg.slice(0, 120) })
}

/** JSON request; HTTP errors with an `{ error: { code } }` body become AppErrors. */
function call<T>(opts: RequestOptions, body?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      { ...opts, timeout: TIMEOUT_MS, headers: { ...(opts.headers ?? {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code: ErrorCode; data?: Record<string, unknown> } }
            if (res.statusCode !== 200) return reject(new AppError(parsed.error?.code ?? 'LAN_UNREACHABLE', parsed.error?.data))
            resolve(parsed as T)
          } catch (err) {
            reject(lanError(err))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (err) => reject(lanError(err)))
    req.end(data)
  })
}

/** Reads the certificate a server presents (no trust decision yet — that is what pairing is for). */
export function fetchPeerCert(hostname: string, port: number): Promise<{ certPem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const raw = socket.getPeerCertificate().raw
      socket.end()
      if (!raw) return reject(new AppError('LAN_UNREACHABLE'))
      const certPem = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----\n`
      resolve({ certPem, fingerprint: new X509Certificate(certPem).fingerprint256 })
    })
    socket.on('timeout', () => socket.destroy(new Error('timeout')))
    socket.on('error', (err) => reject(lanError(err)))
  })
}

/** "Is there a KPOSS Host at this address?" — for the setup screen (not trusted, display only). */
export async function pingHost(address: string): Promise<PingResponse & { latencyMs: number }> {
  const { hostname, port } = parseAddress(address)
  const t0 = Date.now()
  const out = await call<PingResponse>({ hostname, port, path: '/ping', method: 'GET', rejectUnauthorized: false })
  if (out.app !== 'kposs') throw new AppError('LAN_UNREACHABLE')
  return { ...out, latencyMs: Date.now() - t0 }
}

/**
 * Pairs with a Host (D34): read its certificate, prove knowledge of the code bound to that
 * certificate, pin it, and check the Host's counter-proof.
 */
export async function pairWithHost(address: string, code: string, device: { name: string; hardwareId: string; kind: DeviceKind }): Promise<HostConfig> {
  const { hostname, port } = parseAddress(address)
  const { certPem, fingerprint } = await fetchPeerCert(hostname, port)
  const res = await call<PairResponse>(
    { hostname, port, path: '/pair', method: 'POST', ...pinned({ certPem, fingerprint }) },
    { proof: clientProof(code, fingerprint), deviceName: device.name, hardwareId: device.hardwareId, kind: device.kind },
  )
  if (!safeEqualHex(res.hostProof, hostProof(code, fingerprint, res.deviceId))) throw new AppError('LAN_CERT_MISMATCH')
  return { hostname, port, deviceId: res.deviceId, token: res.token, certPem, fingerprint, hostName: res.hostName, shopName: res.shopName }
}

export type ConnectionState = { connected: boolean; lastError: ErrorCode | null }

/** Authenticated, pinned connection from a Client to its Host. */
export class HostConnection {
  private state: ConnectionState = { connected: false, lastError: null }
  /** this run of the app — window ids repeat after a restart, sessions must not */
  readonly instance = randomUUID()
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()

  constructor(readonly cfg: HostConfig) {}

  get url(): string {
    return `${this.cfg.hostname}:${this.cfg.port}`
  }

  get status(): ConnectionState {
    return this.state
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  private setState(next: ConnectionState) {
    if (next.connected === this.state.connected && next.lastError === this.state.lastError) return
    this.state = next
    for (const fn of this.stateListeners) fn(next)
  }

  private opts(path: string, method: 'GET' | 'POST'): RequestOptions {
    return { hostname: this.cfg.hostname, port: this.cfg.port, path, method, headers: { authorization: `Bearer ${this.cfg.token}` }, ...pinned(this.cfg) }
  }

/** Device-authenticated JSON request (offline sync endpoints, D36). */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    try {
      const out = await call<T>(this.opts(path, method), body)
      this.setState({ connected: true, lastError: null })
      return out
    } catch (err) {
      const e = lanError(err)
      this.setState({ connected: false, lastError: e.code })
      throw e
    }
  }

  /** One IPC call on the Host for a Client window (session = that window's token, D12). */
  async rpc(window: number, channel: string, input: unknown, session: string | null = null): Promise<RpcResponse> {
    try {
      const out = await call<RpcResponse>(this.opts('/rpc', 'POST'), { instance: this.instance, window, session, channel, input } satisfies RpcRequest)
      this.setState({ connected: true, lastError: null })
      return out
    } catch (err) {
      const e = lanError(err)
      this.setState({ connected: false, lastError: e.code })
      throw e
    }
  }

  /**
   * Server-sent events from the Host, reconnecting with backoff (1 s → 30 s).
   * Returns a function that stops listening.
   */
  subscribe(onEvent: (e: AppEvent) => void): () => void {
    let stopped = false
    let delay = 1_000
    let current: ReturnType<typeof request> | null = null
    const open = () => {
      if (stopped) return
      const req = request(this.opts('/events', 'GET'), (res) => {
        if (res.statusCode !== 200) {
          this.setState({ connected: false, lastError: res.statusCode === 401 ? 'LAN_DEVICE_REVOKED' : 'LAN_UNREACHABLE' })
          res.resume()
          return retry()
        }
        delay = 1_000
        this.setState({ connected: true, lastError: null })
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n')
            if (data) {
              try {
                onEvent(JSON.parse(data) as AppEvent)
              } catch {
                // ignore a malformed event
              }
            }
          }
        })
        res.on('end', retry)
        res.on('error', retry)
      })
      req.on('error', (err) => {
        this.setState({ connected: false, lastError: lanError(err).code })
        retry()
      })
      req.end()
      current = req
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const retry = () => {
      if (stopped || timer) return
      if (this.state.connected) this.setState({ connected: false, lastError: 'LAN_UNREACHABLE' })
      timer = setTimeout(() => {
        timer = null
        open()
      }, delay)
      delay = Math.min(delay * 2, 30_000)
    }
    open()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      current?.destroy()
    }
  }
}
