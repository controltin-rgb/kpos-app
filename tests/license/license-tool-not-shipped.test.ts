import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

describe('the License Manager is a dev tool and never ships with the app', () => {
  it('the installer only packages out/** (no tools/ or scripts/)', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    const files = yml.split('\nfiles:\n')[1]!.split(/\n\S/)[0]!
    expect(files).toContain('- out/**')
    expect(files).not.toMatch(/tools\/|scripts\//)
  })

  it('no app code imports the manager, the signing scripts or the private key tooling', () => {
    const offenders = sources(join(ROOT, 'src')).filter((f) => /from ['"][^'"]*(tools\/license-manager|scripts\/license-)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the app source has no private key material', () => {
    const offenders = sources(join(ROOT, 'src')).filter((f) => /BEGIN (ED25519 |EC |RSA )?PRIVATE KEY/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the manager refuses to run inside the app or in production', () => {
    const launcher = readFileSync(join(ROOT, 'scripts/license-tool.ts'), 'utf8')
    expect(launcher).toMatch(/NODE_ENV'\] === 'production'/)
    expect(launcher).toMatch(/process\.versions\['electron'\]/)
  })
})
