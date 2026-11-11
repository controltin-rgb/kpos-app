/**
 * Vendor License Manager (pnpm license:tool): a local web app to issue .LIC files, keep customers and the
 * register of what was issued, renew shops before they expire, cancel / replace licenses, check a .LIC a shop
 * sends back, and manage the signing key. Dev / vendor machine only — it is not part of the shop installer.
 *
 * Runs only on this machine, bound to 127.0.0.1 with a random token in the URL (other websites cannot call it).
 * The private key is read from ~/.kposs/license-signing-key.pem (or KPOSS_LICENSE_KEY) and never leaves this
 * process; the register, customers and plans live next to it in ~/.kposs/ (KPOSS_LICENSE_REGISTER) — nothing is
 * written inside the repository (except the public key that `license:keygen` adds to public-key.ts).
 *
 *   pnpm license:tool                 → prints the URL (and opens the browser)
 *   pnpm license:tool -- --port 4777 --no-open
 */
import { spawn } from 'node:child_process'
import { defaultKeyPath, defaultRegisterPath, keyStatus } from './license-lib'
import { createLicenseServer } from './license-server'

if (process.env['NODE_ENV'] === 'production' || process.versions['electron']) {
  console.error('The License Manager is a development tool: run it with `pnpm license:tool` on the vendor machine, not inside the app.')
  process.exit(1)
}

const argv = process.argv.slice(2).filter((a) => a !== '--')
const portArg = argv.indexOf('--port')
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 0

const srv = await createLicenseServer({ port })
const k = keyStatus()
console.log(`KPOSS License Manager: ${srv.url}`)
console.log(`private key: ${defaultKeyPath()} (${k.found ? (k.trusted ? 'matches the app' : 'DOES NOT match the app public key') : 'missing — create it on the Settings page or run pnpm license:keygen'})`)
console.log(`register:    ${defaultRegisterPath()}`)
console.log('Ctrl+C to stop')
if (!argv.includes('--no-open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', srv.url]] : process.platform === 'darwin' ? ['open', [srv.url]] : ['xdg-open', [srv.url]]
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // no browser: the URL is printed above
  }
}
process.on('SIGINT', () => void srv.close().then(() => process.exit(0)))
