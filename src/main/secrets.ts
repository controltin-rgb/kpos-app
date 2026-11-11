import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretBox } from '@main/lan/host-store'

/**
 * Credentials the shop types in (cloud secret key, backup passphrase, payment provider API key).
 * Kept OUT of the database on purpose: backups and cloud copies never carry them, and they are
 * encrypted with the OS key store when available (Electron safeStorage: DPAPI / Keychain / libsecret).
 */
export interface SecretStore {
  has(name: SecretName): boolean
  get(name: SecretName): Promise<string | null>
  /** null removes it */
  set(name: SecretName, value: string | null): Promise<void>
}

export const SECRET_NAMES = ['cloud.secret_access_key', 'cloud.passphrase', 'promptpay.api_key'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export class FileSecretStore implements SecretStore {
  constructor(
    private readonly dir: string,
    private readonly box: () => Promise<SecretBox | null>,
  ) {}

  private file(name: SecretName) {
    return join(this.dir, `vault-${name.replace(/[^a-z0-9_]/gi, '_')}`)
  }

  has(name: SecretName): boolean {
    return existsSync(this.file(name))
  }

  async get(name: SecretName): Promise<string | null> {
    const f = this.file(name)
    if (!existsSync(f)) return null
    try {
      const raw = readFileSync(f)
      const tag = raw.subarray(0, 4).toString()
      if (tag === 'raw:') return raw.subarray(4).toString()
      const box = await this.box()
      return tag === 'enc:' && box ? await box.decrypt(raw.subarray(4)) : null
    } catch {
      return null
    }
  }

  async set(name: SecretName, value: string | null): Promise<void> {
    const f = this.file(name)
    if (value === null || value === '') {
      rmSync(f, { force: true })
      return
    }
    mkdirSync(this.dir, { recursive: true })
    const box = await this.box()
    const sealed = box ? Buffer.concat([Buffer.from('enc:'), await box.encrypt(value)]) : Buffer.from(`raw:${value}`)
    writeFileSync(f, sealed, { mode: 0o600 })
  }
}

/** Tests / no userData. */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<SecretName, string>()
  has(name: SecretName) {
    return this.map.has(name)
  }
  async get(name: SecretName) {
    return this.map.get(name) ?? null
  }
  async set(name: SecretName, value: string | null) {
    if (value === null || value === '') this.map.delete(name)
    else this.map.set(name, value)
  }
}
