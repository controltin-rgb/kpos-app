/**
 * Issues a signed .LIC file for one machine (D29, D31). Vendor machine only.
 * For a point-and-click version with the register of issued licenses: pnpm license:tool
 *
 *   pnpm license:issue -- --hw HW-1A2B-3C4D-5E6F-7A8B --licensee "ร้านกาแฟตัวอย่าง" --plan "Standard" \
 *        --days 365 [--employees 15] [--clients 2] [--members 500] [--cloud] [--no-kds] [--key <private.pem>] [--out <file.LIC>] [--note "…"]
 *   --plan <name>          a package saved in the Manager (its limits and features become the defaults)
 *   --clients N            0 = single machine (cannot be a Host); N>0 = Host with N client machines
 *   --members N            0 = unlimited customers
 *   --no-<feature>         switch one off: cfd kds promotions auto-update labels modifiers drawer-shift inventory cloud
 *   --cloud                switch cloud backup on
 *   --expires 2027-12-31   instead of --days (end of that day, Asia/Bangkok)
 *   --perpetual            no expiry
 *
 * The private key defaults to ~/.kposs/license-signing-key.pem (or env KPOSS_LICENSE_KEY); every
 * issued license is appended to ~/.kposs/issued-licenses.jsonl (or env KPOSS_LICENSE_REGISTER).
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FEATURE_KEYS } from '../src/shared/license'
import { defaultKeyPath, issue, IssueError, readPlans, type IssueInput } from './license-lib'

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

const term: IssueInput['term'] = flag('perpetual') ? { kind: 'perpetual' } : opt('expires') ? { kind: 'until', date: opt('expires')! } : { kind: 'days', days: Number(opt('days') ?? 365) }

const planName = opt('plan') ?? 'Standard'
const preset = readPlans({}).find((p) => p.name === planName)

try {
  const { content, payload, fileName } = issue(
    {
      hardwareId: opt('hw') ?? fail('--hw is required (the Hardware ID shown in Settings → License)'),
      licensee: opt('licensee') ?? fail('--licensee is required'),
      plan: planName,
      term,
      maxEmployees: Number(opt('employees') ?? preset?.maxEmployees ?? 10),
      maxClients: Number(opt('clients') ?? preset?.maxClients ?? 0),
      maxMembers: Number(opt('members') ?? preset?.maxMembers ?? 0),
      cloudBackup: flag('no-cloud') ? false : flag('cloud') || (preset?.cloudBackup ?? false),
      ...Object.fromEntries(FEATURE_KEYS.filter((k) => k !== 'cloudBackup').map((k) => [k, flag(`no-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ? false : (preset?.[k] ?? true)])),
      note: opt('note') ?? '',
    },
    { keyPath: opt('key') ? resolve(opt('key')!) : defaultKeyPath() },
  )
  const out = resolve(opt('out') ?? fileName)
  writeFileSync(out, content)
  console.log(`issued ${payload.licenseId} → ${out}`)
  console.log(JSON.stringify({ ...payload, expiresAt: payload.expiresAt ? new Date(payload.expiresAt).toISOString() : 'perpetual' }, null, 2))
} catch (err) {
  fail(err instanceof IssueError ? err.message : String(err))
}
