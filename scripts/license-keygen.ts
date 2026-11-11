/**
 * Creates the Ed25519 key pair used to sign .LIC files (D31).
 *
 *   pnpm license:keygen                 → private key in ~/.kposs/license-signing-key.pem
 *   pnpm license:keygen -- --out <file> → private key elsewhere (USB / password manager export)
 *   pnpm license:keygen -- --force      → overwrite an existing key (old licenses stop verifying
 *                                          unless the old public key stays in public-key.ts)
 *
 * The PRIVATE key must never be committed (CLAUDE.md rule 8). The public key is written into
 * src/main/license/public-key.ts, which is safe to commit. The point-and-click version is `pnpm license:tool`.
 */
import { resolve } from 'node:path'
import { IssueError } from './license-lib'
import { generateKey } from './license-key'

const args = process.argv.slice(2).filter((a) => a !== '--')
const outIdx = args.indexOf('--out')
const force = args.includes('--force')

try {
  const r = generateKey({ ...(outIdx >= 0 ? { out: resolve(args[outIdx + 1]!) } : {}), replace: force, dropOldPublicKeys: force })
  if (r.backup) console.log(`previous key kept at ${r.backup}`)
  console.log(`private key: ${r.out}  (keep it secret, back it up offline)`)
  console.log(`public key written to ${r.publicKeyFile}  (fingerprint ${r.fingerprint})`)
} catch (err) {
  console.error(err instanceof IssueError ? `${err.message} (use --force to replace it)` : err)
  process.exit(1)
}
