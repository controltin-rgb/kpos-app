import { join } from 'node:path'
import { openDatabase, type Db } from './connection'
import { migrate, type MigrateResult } from './migrate'

export interface DbPaths {
  dbPath: string
  backupDir: string
  migrationsDir: string
}

/** Resolves where the DB, backups and bundled migrations live. */
export function resolveDbPaths(opts: { userData: string; isPackaged: boolean; resourcesPath: string; appPath: string }): DbPaths {
  return {
    dbPath: join(opts.userData, 'data', 'kposs.sqlite'),
    backupDir: join(opts.userData, 'backup'),
    migrationsDir: opts.isPackaged ? join(opts.resourcesPath, 'migrations') : join(opts.appPath, 'migrations'),
  }
}

/** Opens the single DB connection of this process and migrates it. Throws MigrationError on failure. */
export function initDatabase(paths: DbPaths): { db: Db; migration: MigrateResult } {
  const db = openDatabase(paths.dbPath)
  try {
    const migration = migrate(db, paths)
    return { db, migration }
  } catch (err) {
    db.close()
    throw err
  }
}
