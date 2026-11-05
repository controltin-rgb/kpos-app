import { describe, expect, it } from 'vitest'
import { openDatabase, sqliteVersion } from '@main/db/connection'

describe('openDatabase', () => {
  it('loads native better-sqlite3 and reports a version', () => {
    const db = openDatabase(':memory:')
    expect(sqliteVersion(db)).toMatch(/^3\.\d+\.\d+$/)
    db.close()
  })

  it('applies the required PRAGMAs', () => {
    const db = openDatabase(':memory:')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.pragma('synchronous', { simple: true })).toBe(1) // NORMAL
    // in-memory DBs cannot use WAL; file DBs are covered in phase 1 migration tests
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory')
    db.close()
  })
})
