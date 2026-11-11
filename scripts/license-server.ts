/**
 * Local server behind `pnpm license:tool` — the License Manager (vendor / dev machine only, never part of the app).
 *
 * - Binds to 127.0.0.1 only; the Host header must be localhost (DNS-rebinding guard).
 * - The URL printed at start holds a random token (`?t=`). The first request swaps it for an HttpOnly,
 *   SameSite=Strict cookie, because the page loads many module files that cannot carry the token.
 * - The private key never leaves this process: the API only reports its fingerprint.
 * - /api/* is the JSON API; everything else is the React UI in tools/license-manager, served by Vite (middleware mode).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { ZodError } from 'zod'
import {
  backupAll,
  customerRows,
  customerTimeline,
  defaultKeyPath,
  defaultRegisterPath,
  eventsPathOf,
  expiringSoon,
  fileNameFor,
  importCustomers,
  inspect,
  issue,
  IssueError,
  keyInfo,
  licenseRows,
  plansPathOf,
  readPlans,
  readTrialPackage,
  readRegister,
  registerCsv,
  renewTerm,
  expiryOf,
  saveCustomer,
  savePlans,
  setTrialPackage,
  setLicenseStatus,
  REPO_ROOT,
  type StoreOpts,
} from './license-lib'
import { generateKey } from './license-key'
import type { Customer, IssueInput, ManagerState, Plan } from './license-types'

export interface LicenseServerOptions {
  port?: number
  keyPath?: string
  registerPath?: string
  /** serve the React UI (tests turn this off and only use the API) */
  ui?: boolean
  now?: () => number
  /** where the generated key goes when the UI asks for one (tests); default = keyPath */
  publicKeyFile?: string
  /** public keys the app trusts (tests) */
  trustedKeys?: readonly string[]
}

export interface LicenseServer {
  server: Server
  token: string
  port: number
  url: string
  close(): Promise<void>
}

const COOKIE = 'kposs_license_manager'
const CONFIRM_PHRASE = 'สร้างคีย์ใหม่'

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...extra })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 128_000) throw new IssueError('request too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

function cookieOf(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return v.join('=')
  }
  return ''
}

export async function createLicenseServer(options: LicenseServerOptions = {}): Promise<LicenseServer> {
  const token = randomBytes(16).toString('hex')
  const keyPath = options.keyPath ?? defaultKeyPath()
  const registerPath = options.registerPath ?? defaultRegisterPath()
  const nowFn = options.now ?? Date.now
  const store = (): StoreOpts & { now: number } => ({ keyPath, registerPath, now: nowFn(), ...(options.trustedKeys ? { trustedKeys: options.trustedKeys } : {}) })

  let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void; close(): Promise<void> } | null = null
  if (options.ui !== false) {
    const [{ createServer: createVite }, react, tailwind] = await Promise.all([import('vite'), import('@vitejs/plugin-react'), import('@tailwindcss/vite')])
    vite = await createVite({
      root: resolve(REPO_ROOT, 'tools/license-manager'),
      configFile: false,
      appType: 'spa',
      logLevel: 'warn',
      plugins: [react.default(), tailwind.default()],
      resolve: { alias: { '@shared': resolve(REPO_ROOT, 'src/shared'), '@renderer': resolve(REPO_ROOT, 'src/renderer') } },
      server: { middlewareMode: true, hmr: false, fs: { allow: [REPO_ROOT] } },
    })
  }

  const state = (): ManagerState => {
    const s = store()
    return {
      key: keyInfo(keyPath, s.trustedKeys),
      paths: { key: keyPath, register: registerPath, events: eventsPathOf(s), plans: plansPathOf(s) },
      plans: readPlans(s),
      trialPackage: readTrialPackage().name,
      customers: customerRows(s, s.now),
      licenses: licenseRows(s, s.now),
    }
  }

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const s = store()
    const route = `${req.method} ${url.pathname}`
    const json = (data: unknown) => send(res, 200, JSON.stringify(data))

    if (route === 'GET /api/state') return json(state())
    if (route === 'GET /api/expiring') return json(expiringSoon(Math.min(3650, Math.max(1, Number(url.searchParams.get('days') ?? 30) || 30)), s, s.now))
    if (route === 'GET /api/export.csv') return send(res, 200, registerCsv(s, s.now), 'text/csv; charset=utf-8', { 'content-disposition': "attachment; filename*=UTF-8''kposs-licenses.csv" })

    if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/file/'.length))
      const e = readRegister(registerPath).find((x) => x.licenseId === id)
      if (!e) return send(res, 404, 'not found', 'text/plain')
      return send(res, 200, e.file, 'application/octet-stream', { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileNameFor(e.licensee, e.hardwareId))}` })
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/customers/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/customers/'.length))
      const customer = customerRows(s, s.now).find((c) => c.id === id)
      if (!customer) return send(res, 404, JSON.stringify({ error: 'customer not found' }))
      return json({ customer, licenses: licenseRows(s, s.now).filter((l) => l.customerId === id), timeline: customerTimeline(id, s, s.now) })
    }

    if (req.method !== 'POST') return send(res, 404, 'not found', 'text/plain')
    const body = await readBody(req)
    switch (url.pathname) {
      case '/api/customers':
        return json(saveCustomer(body as Partial<Customer> & { name: string }, s))
      case '/api/customers/import':
        return json(importCustomers(s))
      case '/api/issue':
        return json(issue(body as unknown as IssueInput, s))
      case '/api/renew-preview': {
        const row = licenseRows(s, s.now).find((l) => l.licenseId === body['licenseId'])
        if (!row) throw new IssueError('license not found')
        const term = renewTerm(row.expiresAt, Number(body['days']), body['mode'] === 'from_expiry' ? 'from_expiry' : 'from_now', s.now)
        return json({ term, expiresAt: expiryOf(term, s.now), previousExpiresAt: row.expiresAt })
      }
      case '/api/status':
        setLicenseStatus(String(body['licenseId'] ?? ''), body['status'] === 'superseded' ? 'superseded' : 'void', String(body['reason'] ?? ''), s)
        return json({ ok: true })
      case '/api/inspect':
        return json(inspect(String(body['content'] ?? ''), body['hardwareId'] ? String(body['hardwareId']) : undefined, s.now, s.trustedKeys))
      case '/api/plans':
        return json(savePlans(body['plans'] as Plan[], s))
      case '/api/trial-package':
        return json(setTrialPackage(String(body['name'] ?? ''), s))
      case '/api/backup':
        return json(backupAll(s))
      case '/api/key/generate': {
        if (body['confirm'] !== CONFIRM_PHRASE) throw new IssueError('confirmation phrase is missing')
        const replace = body['replace'] === true
        const r = generateKey({ out: keyPath, replace, now: s.now, ...(options.publicKeyFile ? { publicKeyFile: options.publicKeyFile } : {}) })
        return json({ fingerprint: r.fingerprint, backup: r.backup, publicKeyFile: r.publicKeyFile })
      }
      default:
        return send(res, 404, 'not found', 'text/plain')
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return send(res, 403, 'forbidden', 'text/plain')
      const viaToken = url.searchParams.get('t')
      if (viaToken !== null && same(viaToken, token)) {
        // first visit: trade the URL token for a cookie and drop it from the address bar
        return send(res, 302, '', 'text/plain', { location: '/', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` })
      }
      if (!same(cookieOf(req), token)) return send(res, 403, 'forbidden', 'text/plain')
      try {
        if (url.pathname.startsWith('/api/')) return await api(req, res, url)
        if (!vite) return send(res, 404, 'not found', 'text/plain')
        return vite.middlewares(req, res, (err) => send(res, err ? 500 : 404, err ? String(err) : 'not found', 'text/plain'))
      } catch (err) {
        const known = err instanceof IssueError || err instanceof ZodError
        const message = err instanceof ZodError ? `invalid license data: ${err.issues.map((i) => i.path.join('.')).join(', ')}` : err instanceof Error ? err.message : ''
        return send(res, known ? 400 : 500, JSON.stringify({ error: known ? message : 'internal error' }))
      }
    })()
  })

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(options.port ?? 0, '127.0.0.1', ok)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (options.port ?? 0)
  return {
    server,
    token,
    port,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: async () => {
      await vite?.close()
      await new Promise<void>((ok) => server.close(() => ok()))
    },
  }
}
