import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { HARDWARE_ID_RE, type LicensePayload } from '@shared/license'

/** .LIC container (D29). The signature covers the exact payload bytes, so no canonical JSON is needed. */
export const LICENSE_FORMAT = 'KPOSS-LIC-1'

const fileSchema = z.object({
  format: z.literal(LICENSE_FORMAT),
  payload: z.string().min(1).max(8_000),
  signature: z.string().min(1).max(200),
})

export const payloadSchema = z.object({
  licenseId: z.string().min(1).max(64),
  licensee: z.string().trim().min(1).max(160),
  plan: z.string().trim().min(1).max(60),
  hardwareId: z.string().regex(HARDWARE_ID_RE),
  issuedAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  features: z.object({
    maxEmployees: z.number().int().min(1).max(1000),
    maxClients: z.number().int().min(0).max(100),
    cloudBackup: z.boolean(),
  }),
}) satisfies z.ZodType<LicensePayload>

export type LicenseProblem = 'format' | 'signature' | 'hardware'

export type ParsedLicense = { ok: true; payload: LicensePayload } | { ok: false; problem: LicenseProblem }

/** Builds a signed .LIC file. Used by scripts/license-issue.ts and tests only — the app never signs. */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  const body = Buffer.from(JSON.stringify(payloadSchema.parse(payload)), 'utf8')
  const signature = sign(null, body, key)
  return JSON.stringify({ format: LICENSE_FORMAT, payload: body.toString('base64url'), signature: signature.toString('base64url') }, null, 2) + '\n'
}

/**
 * Verifies a .LIC file against the embedded public key(s) and this machine's hardware id.
 * Several public keys may be trusted at once (key rotation).
 */
export function parseLicense(raw: string, publicKeysPem: readonly string[], hardwareId: string): ParsedLicense {
  let file: z.infer<typeof fileSchema>
  let body: Buffer
  try {
    file = fileSchema.parse(JSON.parse(raw))
    body = Buffer.from(file.payload, 'base64url')
  } catch {
    return { ok: false, problem: 'format' }
  }
  const sig = Buffer.from(file.signature, 'base64url')
  const keys: KeyObject[] = publicKeysPem.map((p) => createPublicKey(p))
  if (!keys.some((k) => verify(null, body, k, sig))) return { ok: false, problem: 'signature' }
  let payload: LicensePayload
  try {
    payload = payloadSchema.parse(JSON.parse(body.toString('utf8')))
  } catch {
    return { ok: false, problem: 'format' }
  }
  if (payload.hardwareId !== hardwareId) return { ok: false, problem: 'hardware' }
  return { ok: true, payload }
}
