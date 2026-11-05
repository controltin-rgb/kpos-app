import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const dirs: string[] = []

/** Creates a temp dir that is removed after each test. */
export function tmpDir(prefix = 'kposs-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Writes a set of migration files into a fresh temp dir and returns its path. */
export function migrationsDir(files: Record<string, string>): string {
  const dir = join(tmpDir('kposs-mig-'), 'migrations')
  mkdirSync(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
