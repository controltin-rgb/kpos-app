/**
 * Ed25519 public key(s) that may sign .LIC files (SPKI PEM). Safe to commit — the matching
 * PRIVATE key lives outside the repository (D31, CLAUDE.md rule 8).
 * `pnpm license:keygen` rewrites this list; keep an old key here while its licenses are in use.
 *
 * NOTE: the key generated during development is a DEV key. Create the production key pair on a
 * secure machine (`pnpm license:keygen -- --force`) before selling licenses.
 */
export const LICENSE_PUBLIC_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAes5z9iP1OkxQMjr2yn3RjI6Rog7DUtXOqvyxu/5/198=
-----END PUBLIC KEY-----`,
]
