import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostConfig } from './host-connection'

/** Optional OS-level encryption for the device token (Electron safeStorage: DPAPI / Keychain). */
export interface SecretBox {
  encrypt(plain: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<string>
}

const files = (userData: string) => ({ config: join(userData, 'host.json'), token: join(userData, 'secrets', 'lan-token') })

/** A Client's Host: certificate + address in host.json, the bearer token separately (encrypted when possible). */
export async function saveHostConfig(userData: string, cfg: HostConfig, box: SecretBox | null): Promise<void> {
  const f = files(userData)
  const { token, ...rest } = cfg
  mkdirSync(join(userData, 'secrets'), { recursive: true })
  const sealed = box ? Buffer.concat([Buffer.from('enc:'), await box.encrypt(token)]) : Buffer.from(`raw:${token}`)
  writeFileSync(f.token, sealed, { mode: 0o600 })
  writeFileSync(f.config, JSON.stringify(rest, null, 2))
}

export async function loadHostConfig(userData: string, box: SecretBox | null): Promise<HostConfig | null> {
  const f = files(userData)
  if (!existsSync(f.config) || !existsSync(f.token)) return null
  try {
    const rest = JSON.parse(readFileSync(f.config, 'utf8')) as Omit<HostConfig, 'token'>
    const raw = readFileSync(f.token)
    const tag = raw.subarray(0, 4).toString()
    const token = tag === 'enc:' && box ? await box.decrypt(raw.subarray(4)) : tag === 'raw:' ? raw.subarray(4).toString() : null
    if (!token || !rest.hostname || !rest.certPem || !rest.fingerprint || !rest.deviceId) return null
    return { ...rest, token }
  } catch {
    return null
  }
}

export function clearHostConfig(userData: string): void {
  const f = files(userData)
  rmSync(f.config, { force: true })
  rmSync(f.token, { force: true })
}
