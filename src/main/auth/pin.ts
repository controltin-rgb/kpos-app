import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// scrypt parameters (N=2^15, r=8, p=1 ≈ 32 MiB, tens of ms) — Implement.md §12
const N = 1 << 15
const R = 8
const P = 1
const KEYLEN = 32
const MAXMEM = 64 * 1024 * 1024

export const PIN_RE = /^\d{4,6}$/

/** Hash format: scrypt:N:r:p:<salt b64>:<hash b64> */
export function hashPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new RangeError('PIN must be 4–6 digits')
  const salt = randomBytes(16)
  const hash = scryptSync(pin, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join(':')
}

export function verifyPinHash(pin: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string]
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
