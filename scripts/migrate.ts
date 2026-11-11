/**
 * Dev helper: migrate a sample database.
 *   pnpm migrate              → .data/dev.sqlite
 *   pnpm migrate -- path.db   → given file
 * The app itself migrates automatically at startup (src/main/index.ts).
 */
import { resolve } from 'node:path'
import { openDatabase } from '../src/main/db/connection'
import { migrate, MigrationError } from '../src/main/db/migrate'

const root = resolve(import.meta.dirname, '..')
const dbPath = resolve(process.argv[2] ?? resolve(root, '.data/dev.sqlite'))
const db = openDatabase(dbPath)
try {
  const r = migrate(db, { dbPath, migrationsDir: resolve(root, 'migrations'), backupDir: resolve(root, '.data/backup') })
  console.log(r.applied.length ? `migrated ${dbPath}: v${r.from} → v${r.to} (${r.applied.join(', ')})` : `${dbPath} is up to date (v${r.to})`)
  if (r.backupPath) console.log(`backup: ${r.backupPath}`)
} catch (err) {
  if (err instanceof MigrationError) {
    console.error(`[${err.code}] ${err.message}`)
    if (err.backupPath) console.error(`backup: ${err.backupPath}`)
  } else console.error(err)
  process.exitCode = 1
} finally {
  db.close()
}
