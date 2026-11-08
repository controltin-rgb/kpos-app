import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { lastAppVersion, preUpdateBackup, recordAppVersion } from '@main/backup/pre-update'
import { openDatabase } from '@main/db/connection'
import { closeAfter, tmpDir } from '../helpers/tmp'

describe('backup before a new app version (D39)', () => {
  it('copies the database once per new version, never on a fresh install', () => {
    const root = tmpDir('kposs-preupdate-')
    const dbPath = join(root, 'data', 'kposs.sqlite')
    const backupDir = join(root, 'backup')

    // fresh install: nothing to copy
    expect(preUpdateBackup(dbPath, backupDir, '0.1.0')).toBeNull()

    const db = closeAfter(openDatabase(dbPath))
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY) STRICT; INSERT INTO t VALUES ('a')`)
    recordAppVersion(dbPath, '0.1.0')
    expect(lastAppVersion(dbPath)).toBe('0.1.0')
    expect(preUpdateBackup(dbPath, backupDir, '0.1.0')).toBeNull() // same version

    // the shop installs 0.2.0 over 0.1.0 (the live DB is still open in WAL mode with uncheckpointed data)
    db.exec(`INSERT INTO t VALUES ('b')`)
    const copy = preUpdateBackup(dbPath, backupDir, '0.2.0', Date.UTC(2026, 10, 8, 2, 0, 0))
    expect(copy).toBe(join(backupDir, 'kposs-pre_update-20261108-090000-v0.1.0-to-v0.2.0.sqlite'))
    expect(existsSync(copy!)).toBe(true)
    const c = closeAfter(new Database(copy!, { readonly: true }))
    expect(c.prepare('SELECT id FROM t ORDER BY id').pluck().all()).toEqual(['a', 'b'])
    c.close()
    // it runs again until the new version has started successfully once
    expect(preUpdateBackup(dbPath, backupDir, '0.2.0', Date.UTC(2026, 10, 8, 2, 1, 0))).not.toBeNull()
    recordAppVersion(dbPath, '0.2.0')
    expect(preUpdateBackup(dbPath, backupDir, '0.2.0')).toBeNull()
  })
})
