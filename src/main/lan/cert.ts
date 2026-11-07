import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generate } from 'selfsigned'

export interface HostCert {
  key: string
  cert: string
  /** SHA-256 fingerprint "AB:CD:…" — what Clients pin (D34) */
  fingerprint: string
}

export const fingerprintOf = (certPem: string): string => new X509Certificate(certPem).fingerprint256

/** Short form shown to people for a visual check: first 4 bytes, e.g. "AB:CD:EF:01". */
export const shortFingerprint = (fp: string): string => fp.split(':').slice(0, 4).join(':')

/**
 * The Host's self-signed TLS certificate, created once and kept in userData/secrets.
 * Clients pin it at pairing, so it never needs a CA or a host name.
 */
export async function loadOrCreateHostCert(dir: string, commonName = 'KPOSS Host'): Promise<HostCert> {
  const keyFile = join(dir, 'lan-key.pem')
  const certFile = join(dir, 'lan-cert.pem')
  if (existsSync(keyFile) && existsSync(certFile)) {
    const key = readFileSync(keyFile, 'utf8')
    const cert = readFileSync(certFile, 'utf8')
    return { key, cert, fingerprint: fingerprintOf(cert) }
  }
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 20)
  const pems = await generate([{ name: 'commonName', value: commonName }], { keySize: 2048, algorithm: 'sha256', notAfterDate: notAfter })
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, pems.private, { mode: 0o600 })
  writeFileSync(certFile, pems.cert)
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOf(pems.cert) }
}
