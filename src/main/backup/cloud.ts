import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { CloudStatusDto } from '@shared/api-system'
import { AppError } from '@shared/errors'
import { S3Client, type S3Config, type S3Fetch, type S3Object } from './s3'

/**
 * Cloud copy of the backups (D43): the backup folder (verified snapshots + manifests) and the change
 * journal are mirrored, end-to-end encrypted, to S3-compatible storage. The shop's passphrase never
 * leaves the machine; without it the objects are unreadable — also for the storage provider.
 *
 * Mirror rules: a local file that is new or changed (size / mtime) is uploaded; a remote object whose
 * local file was pruned by retention is deleted, so the cloud keeps the same 14/30/90-day window.
 * Recovery on a new machine: download everything into the backup folder, then the Backup page lists
 * the snapshots again (reconcile) and point-in-time restore works from the downloaded journal.
 */

const MAGIC = Buffer.from('KPOSSENC') // 8 bytes
const VERSION = 1
const HEADER = MAGIC.length + 1 + 16 + 12
const TAG = 16

const keyCache = new Map<string, Buffer>()
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  const id = `${salt.toString('hex')}:${passphrase}`
  let k = keyCache.get(id)
  if (!k) {
    k = scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    keyCache.set(id, k)
  }
  return k
}

/** AES-256-GCM, key = scrypt(passphrase, salt). Layout: MAGIC | ver | salt16 | iv12 | ciphertext | tag16 */
export function encryptBlob(plain: Buffer, passphrase: string, salt: Buffer = randomBytes(16)): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv, body, c.getAuthTag()])
}

export function decryptBlob(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < HEADER + TAG || !blob.subarray(0, MAGIC.length).equals(MAGIC) || blob[MAGIC.length] !== VERSION) throw new Error('not a KPOSS encrypted file')
  const salt = blob.subarray(MAGIC.length + 1, MAGIC.length + 17)
  const iv = blob.subarray(MAGIC.length + 17, HEADER)
  const d = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  d.setAuthTag(blob.subarray(blob.length - TAG))
  return Buffer.concat([d.update(blob.subarray(HEADER, blob.length - TAG)), d.final()]) // throws on a wrong passphrase / tampering
}

export interface CloudConfig extends S3Config {
  prefix: string
  passphrase: string
}

interface MirrorState {
  files: Record<string, { size: number; mtimeMs: number }>
  lastSyncAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

/** Files under the backup folder that belong in the cloud copy (relative, forward slashes). */
export function mirrorFiles(backupDir: string): string[] {
  const out: string[] = []
  if (!existsSync(backupDir)) return out
  for (const name of readdirSync(backupDir)) {
    if (/\.sqlite(\.json)?$/.test(name) && !name.startsWith('replaced-')) out.push(name)
  }
  const jdir = join(backupDir, 'journal')
  if (existsSync(jdir)) for (const name of readdirSync(jdir)) if (/^(seg-.*\.jsonl|timeline-.*\.json)$/.test(name)) out.push(`journal/${name}`)
  return out.sort()
}

export class CloudBackup {
  private running: Promise<CloudStatusDto> | null = null
  private readonly stateFile: string

  constructor(
    private readonly backupDir: string,
    private readonly config: () => Promise<CloudConfig | null>,
    private readonly opts: { now?: () => number; fetch?: S3Fetch } = {},
  ) {
    this.stateFile = join(backupDir, 'cloud-state.json')
  }

  private now() {
    return (this.opts.now ?? Date.now)()
  }

  private state(): MirrorState {
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as MirrorState
    } catch {
      return { files: {}, lastSyncAt: null, lastError: null, lastErrorAt: null }
    }
  }

  private save(s: MirrorState) {
    mkdirSync(this.backupDir, { recursive: true })
    writeFileSync(this.stateFile, JSON.stringify(s, null, 2))
  }

  private client(cfg: CloudConfig) {
    return new S3Client(cfg, this.opts.fetch, this.opts.now)
  }

  private key(cfg: CloudConfig, rel: string) {
    return `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/${rel}.enc`.replace(/^\//, '')
  }

  status(configured: boolean): CloudStatusDto {
    const s = this.state()
    const local = mirrorFiles(this.backupDir)
    const pending = local.filter((rel) => {
      const st = statSync(join(this.backupDir, rel))
      const prev = s.files[rel]
      return !prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs
    }).length
    return { configured, lastSyncAt: s.lastSyncAt, lastError: s.lastError, lastErrorAt: s.lastErrorAt, uploadedFiles: Object.keys(s.files).length, pendingFiles: pending, running: this.running !== null }
  }

  /** One mirror pass (never two at once). Errors are recorded in the state and rethrown as CLOUD_FAILED. */
  sync(): Promise<CloudStatusDto> {
    this.running ??= this.syncOnce().finally(() => (this.running = null))
    return this.running
  }

  private async syncOnce(): Promise<CloudStatusDto> {
    const cfg = await this.config()
    if (!cfg) throw new AppError('CLOUD_NOT_CONFIGURED')
    const s = this.state()
    const s3 = this.client(cfg)
    const salt = randomBytes(16) // one salt (one scrypt) per pass
    try {
      const local = mirrorFiles(this.backupDir)
      for (const rel of local) {
        const path = join(this.backupDir, rel)
        const st = statSync(path)
        const prev = s.files[rel]
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue
        await s3.put(this.key(cfg, rel), encryptBlob(readFileSync(path), cfg.passphrase, salt))
        s.files[rel] = { size: st.size, mtimeMs: st.mtimeMs }
        this.save(s) // progress survives a failure halfway
      }
      // retention: whatever is no longer kept locally goes from the cloud too
      const keep = new Set(local)
      for (const rel of Object.keys(s.files)) {
        if (keep.has(rel)) continue
        await s3.delete(this.key(cfg, rel))
        delete s.files[rel]
        this.save(s)
      }
      s.lastSyncAt = this.now()
      s.lastError = null
      s.lastErrorAt = null
      this.save(s)
      return this.status(true)
    } catch (err) {
      s.lastError = String(err instanceof Error ? err.message : err).slice(0, 300)
      s.lastErrorAt = this.now()
      this.save(s)
      throw new AppError('CLOUD_FAILED', { message: s.lastError })
    }
  }

  /** What is in the cloud for this shop (to download on a new machine). */
  async remote(): Promise<S3Object[]> {
    const cfg = await this.config()
    if (!cfg) throw new AppError('CLOUD_NOT_CONFIGURED')
    try {
      const prefix = `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/`.replace(/^\//, '')
      return (await this.client(cfg).list(prefix)).filter((o) => o.key.endsWith('.enc'))
    } catch (err) {
      throw new AppError('CLOUD_FAILED', { message: String(err instanceof Error ? err.message : err) })
    }
  }

  /** Downloads + decrypts every object missing locally into the backup folder. Returns files written. */
  async downloadAll(): Promise<number> {
    const cfg = await this.config()
    if (!cfg) throw new AppError('CLOUD_NOT_CONFIGURED')
    const prefix = `${cfg.prefix.replace(/^\/+|\/+$/g, '')}/`.replace(/^\//, '')
    const s3 = this.client(cfg)
    let written = 0
    try {
      for (const o of await this.remote()) {
        const rel = o.key.slice(prefix.length, -'.enc'.length)
        // only names this app writes (no path tricks from a tampered bucket)
        if (!rel || rel.includes('..') || !/^(journal\/)?[A-Za-z0-9._-]+$/.test(rel)) continue
        const path = join(this.backupDir, ...rel.split('/'))
        if (relative(this.backupDir, path).startsWith(`..${sep}`)) continue
        if (existsSync(path)) continue
        const plain = decryptBlob(await s3.get(o.key), cfg.passphrase)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, plain)
        written++
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError('CLOUD_FAILED', { message: String(err instanceof Error ? err.message : err) })
    }
    return written
  }
}
