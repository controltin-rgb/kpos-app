import { createHash, createHmac } from 'node:crypto'

/**
 * Minimal S3-compatible client (AWS S3, Cloudflare R2, Wasabi, Backblaze B2, MinIO …) with
 * Signature V4 and path-style URLs — just PUT / GET / DELETE / LIST, no SDK dependency.
 */

export interface S3Config {
  /** https://<account>.r2.cloudflarestorage.com · https://s3.ap-southeast-1.amazonaws.com */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Object {
  key: string
  size: number
  lastModified: number
}

export type S3Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface SignInput {
  method: string
  /** already-encoded path, e.g. /bucket/a%20b */
  path: string
  query: Record<string, string>
  /** lower-case names; must include host */
  headers: Record<string, string>
  payloadHash: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string
}

/** AWS Signature Version 4 → the Authorization header value. */
export function signV4(i: SignInput): string {
  const date = i.amzDate.slice(0, 8)
  const query = Object.keys(i.query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(i.query[k]!)}`)
    .join('&')
  const names = Object.keys(i.headers).map((h) => h.toLowerCase()).sort()
  const canonicalHeaders = names.map((n) => `${n}:${String(i.headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const canonical = [i.method, i.path, query, canonicalHeaders, signedHeaders, i.payloadHash].join('\n')
  const scope = `${date}/${i.region}/${i.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256Hex(canonical)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), i.service), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

const amzDateOf = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export class S3Client {
  private readonly base: URL

  constructor(
    private readonly cfg: S3Config,
    private readonly fetchImpl: S3Fetch = fetch as unknown as S3Fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.base = new URL(cfg.endpoint)
  }

  private async request(method: string, key: string | null, query: Record<string, string> = {}, body?: Uint8Array) {
    const segments = [this.cfg.bucket, ...(key ? key.split('/') : [])].map(uriEncode)
    const basePath = this.base.pathname.replace(/\/+$/, '')
    const path = `${basePath}/${segments.join('/')}`
    const payloadHash = sha256Hex(body ?? '')
    const amzDate = amzDateOf(this.now())
    const headers: Record<string, string> = { host: this.base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
    const authorization = signV4({ method, path, query, headers, payloadHash, region: this.cfg.region || 'auto', service: 's3', accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, amzDate })
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
      .join('&')
    const url = `${this.base.protocol}//${this.base.host}${path}${qs ? `?${qs}` : ''}`
    const { host: _host, ...sent } = headers
    const res = await this.fetchImpl(url, { method, headers: { ...sent, authorization, ...(body ? { 'content-length': String(body.length) } : {}) }, ...(body ? { body } : {}) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
      throw new Error(`S3 ${method} ${key ?? ''} → ${res.status}${code ? ` ${code}` : ''}`)
    }
    return res
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.request('PUT', key, {}, body)
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.request('GET', key)
    return Buffer.from(await res.arrayBuffer())
  }

  async delete(key: string): Promise<void> {
    await this.request('DELETE', key)
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = []
    let token: string | null = null
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix }
      if (token) query['continuation-token'] = token
      const xml = await (await this.request('GET', null, query)).text()
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const part = m[1]!
        const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(part)?.[1] ?? '')
        const size = Number(/<Size>(\d+)<\/Size>/.exec(part)?.[1] ?? 0)
        const lm = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(part)?.[1] ?? '')
        if (key) out.push({ key, size, lastModified: Number.isFinite(lm) ? lm : 0 })
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') || null) : null
    } while (token)
    return out
  }
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
