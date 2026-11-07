/**
 * Creates the Ed25519 key pair used to sign .LIC files (D31).
 *
 *   pnpm license:keygen                 → private key in ~/.kposs/license-signing-key.pem
 *   pnpm license:keygen -- --out <file> → private key elsewhere (USB / password manager export)
 *   pnpm license:keygen -- --force      → overwrite an existing key (old licenses stop verifying
 *                                          unless the old public key stays in public-key.ts)
 *
 * The PRIVATE key must never be committed (CLAUDE.md rule 8). The public key is written into
 * src/main/license/public-key.ts, which is safe to commit.
 */
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2).filter((a) => a !== '--')
const outIdx = args.indexOf('--out')
const out = resolve(outIdx >= 0 ? args[outIdx + 1]! : join(homedir(), '.kposs', 'license-signing-key.pem'))
const force = args.includes('--force')
const root = resolve(import.meta.dirname, '..')

if (out.startsWith(root)) {
  console.error('refusing to write the private key inside the repository')
  process.exit(1)
}
if (existsSync(out) && !force) {
  console.error(`${out} already exists (use --force to replace it)`)
  process.exit(1)
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
try {
  chmodSync(out, 0o600)
} catch {
  // Windows: NTFS permissions of the user profile apply
}
const pub = (publicKey.export({ type: 'spki', format: 'pem' }) as string).trim()

const file = join(root, 'src/main/license/public-key.ts')
const src = readFileSync(file, 'utf8')
const next = src.replace(/(export const LICENSE_PUBLIC_KEYS: readonly string\[\] = \[)([\s\S]*?)(\])/, (_m, a: string, keys: string, b: string) => {
  const existing = force ? '' : keys
  return `${a}\n  \`${pub}\`,${existing.trim() ? `\n  ${existing.trim()}` : ''}\n${b}`
})
writeFileSync(file, next)

console.log(`private key: ${out}  (keep it secret, back it up offline)`)
console.log(`public key written to ${file}`)
