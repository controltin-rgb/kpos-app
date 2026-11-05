import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Per-installation BetterAuth secret, generated on first run and kept outside the DB (and the repo). */
export function loadOrCreateSecret(file: string): string {
  if (existsSync(file)) {
    const s = readFileSync(file, 'utf8').trim()
    if (s.length >= 32) return s
  }
  mkdirSync(dirname(file), { recursive: true })
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(file, secret, { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // best effort on Windows
  }
  return secret
}
