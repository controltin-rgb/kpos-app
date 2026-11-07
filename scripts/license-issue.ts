/**
 * Issues a signed .LIC file for one machine (D29, D31).
 *
 *   pnpm license:issue -- --hw HW-1A2B-3C4D-5E6F-7A8B --licensee "ร้านกาแฟตัวอย่าง" --plan "Standard" \
 *        --days 365 --employees 15 --clients 2 [--cloud] [--key <private.pem>] [--out <file.LIC>]
 *   --expires 2027-12-31   instead of --days (end of that day, Asia/Bangkok)
 *   --perpetual            no expiry
 *
 * The private key defaults to ~/.kposs/license-signing-key.pem (or env KPOSS_LICENSE_KEY).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { signLicense } from '../src/main/license/license-file'
import { uuidv7 } from '../src/shared/id'
import { DAY_MS, HARDWARE_ID_RE, type LicensePayload } from '../src/shared/license'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const flag = (name: string) => argv.includes(`--${name}`)
const fail = (msg: string): never => {
  console.error(msg)
  process.exit(1)
}

const hardwareId = (opt('hw') ?? fail('--hw is required (the Hardware ID shown in Settings → License)')).toUpperCase()
if (!HARDWARE_ID_RE.test(hardwareId)) fail(`invalid --hw ${hardwareId} (expected HW-XXXX-XXXX-XXXX-XXXX)`)
const licensee = opt('licensee') ?? fail('--licensee is required')
const plan = opt('plan') ?? 'Standard'
const now = Date.now()

let expiresAt: number | null
if (flag('perpetual')) expiresAt = null
else if (opt('expires')) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opt('expires')!) ?? fail('--expires must be YYYY-MM-DD')
  // end of that day in Asia/Bangkok (UTC+7)
  expiresAt = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) - 7 * 3_600_000
} else expiresAt = now + Number(opt('days') ?? 365) * DAY_MS

const num = (name: string, def: number) => {
  const v = Number(opt(name) ?? def)
  return Number.isInteger(v) && v >= 0 ? v : fail(`--${name} must be a whole number`)
}

const payload: LicensePayload = {
  licenseId: uuidv7(now),
  licensee,
  plan,
  hardwareId,
  issuedAt: now,
  expiresAt,
  features: { maxEmployees: num('employees', 10), maxClients: num('clients', 0), cloudBackup: flag('cloud') },
}

const keyPath = resolve(opt('key') ?? process.env['KPOSS_LICENSE_KEY'] ?? join(homedir(), '.kposs', 'license-signing-key.pem'))
let pem: string
try {
  pem = readFileSync(keyPath, 'utf8')
} catch {
  fail(`cannot read private key ${keyPath} — run pnpm license:keygen first`)
}
const out = resolve(opt('out') ?? `${licensee.replace(/[^\p{L}\p{N}_-]+/gu, '_')}-${hardwareId}.LIC`)
writeFileSync(out, signLicense(payload, pem!))
console.log(`issued ${payload.licenseId} → ${out}`)
console.log(JSON.stringify({ ...payload, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : 'perpetual' }, null, 2))
