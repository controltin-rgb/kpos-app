import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const dirs: string[] = []
const closables: { close(): unknown; open?: boolean }[] = []

/** Creates a temp dir that is removed after each test. */
export function tmpDir(prefix = 'kposs-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * Closes `db` after the test, before its temp dir is removed.
 * Windows refuses to delete a folder holding an open SQLite file (EPERM).
 */
export function closeAfter<T extends { close(): unknown; open?: boolean }>(db: T): T {
  closables.push(db)
  return db
}

/** Writes a set of migration files into a fresh temp dir and returns its path. */
export function migrationsDir(files: Record<string, string>): string {
  const dir = join(tmpDir('kposs-mig-'), 'migrations')
  mkdirSync(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

afterEach(() => {
  while (closables.length) {
    const c = closables.pop()!
    if (c.open !== false) c.close()
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
