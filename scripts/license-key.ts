/**
 * Creates the Ed25519 key pair used to sign .LIC files (D31) — shared by `pnpm license:keygen` and the
 * License Manager. The PRIVATE key is written outside the repository (CLAUDE.md rule 8); the public key is
 * added to src/main/license/public-key.ts, which is safe to commit.
 */
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultKeyPath, IssueError, publicKeyFingerprint, REPO_ROOT } from './license-lib'

export interface GenerateKeyOptions {
  /** private key file (default ~/.kposs/license-signing-key.pem) */
  out?: string
  /** replace an existing key file; the old private key is first copied to <out>.bak-<timestamp> */
  replace?: boolean
  /** drop the old public keys from public-key.ts too (licenses signed by them stop verifying) */
  dropOldPublicKeys?: boolean
  /** override for tests */
  publicKeyFile?: string
  now?: number
}

export function generateKey(opts: GenerateKeyOptions = {}): { out: string; backup: string | null; publicKeyFile: string; fingerprint: string } {
  const out = opts.out ?? defaultKeyPath()
  if (out.startsWith(REPO_ROOT)) throw new IssueError('refusing to write the private key inside the repository')
  if (existsSync(out) && !opts.replace) throw new IssueError(`${out} already exists`)
  let backup: string | null = null
  if (existsSync(out)) {
    backup = `${out}.bak-${opts.now ?? Date.now()}`
    copyFileSync(out, backup)
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

  const file = opts.publicKeyFile ?? join(REPO_ROOT, 'src/main/license/public-key.ts')
  const src = readFileSync(file, 'utf8')
  const next = src.replace(/(export const LICENSE_PUBLIC_KEYS: readonly string\[\] = \[)([\s\S]*?)(\])/, (_m, a: string, keys: string, b: string) => {
    const existing = opts.dropOldPublicKeys ? '' : keys
    return `${a}\n  \`${pub}\`,${existing.trim() ? `\n  ${existing.trim()}` : ''}\n${b}`
  })
  writeFileSync(file, next)
  return { out, backup, publicKeyFile: file, fingerprint: publicKeyFingerprint(pub) }
}
