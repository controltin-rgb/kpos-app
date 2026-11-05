import { describe, expect, it } from 'vitest'
import type { Db } from '@main/db/connection'
import { AuditService, canonicalJson, GENESIS_HASH } from '@main/services/audit.service'
import { migratedDb, seedBasics, T0 } from '../helpers/fixtures'

function setup() {
  const db = migratedDb()
  const b = seedBasics(db)
  let t = T0
  const audit = new AuditService(db, () => (t += 1000))
  return { db, b, audit }
}

/** Simulates someone editing the DB file directly (bypassing the app and the triggers). */
function tamper(db: Db, sql: string, ...params: unknown[]) {
  db.exec('DROP TRIGGER trg_audit_log_no_update; DROP TRIGGER trg_audit_log_no_delete;')
  db.prepare(sql).run(...params)
}

describe('canonicalJson', () => {
  it('sorts keys recursively and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}')
  })
  it('drops undefined values like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}')
  })
})

describe('AuditService', () => {
  it('chains entries from the genesis hash', () => {
    const { audit, b } = setup()
    const e1 = audit.append({ userId: b.userId, action: 'user.create', entity: 'users', entityId: b.userId })
    const e2 = audit.append({
      userId: b.userId,
      action: 'settings.update',
      permission: 'settings:update',
      entity: 'settings',
      entityId: 'vat',
      before: { rateBp: 700 },
      after: { rateBp: 0 },
      risk: 'high',
    })
    expect(e1.seq).toBe(1)
    expect(e1.prevHash).toBe(GENESIS_HASH)
    expect(e2.seq).toBe(2)
    expect(e2.prevHash).toBe(e1.hash)
    expect(e2.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stores before/after as canonical JSON', () => {
    const { audit, db } = setup()
    audit.append({ action: 'x', before: { b: 1, a: 2 }, after: null })
    const row = db.prepare('SELECT before_json, after_json FROM audit_log').get() as Record<string, unknown>
    expect(row).toEqual({ before_json: '{"a":2,"b":1}', after_json: null })
  })

  it('verifies an intact chain', () => {
    const { audit } = setup()
    for (let i = 0; i < 20; i++) audit.append({ action: `a${i}`, after: { i } })
    expect(audit.verifyChain()).toEqual({ ok: true, count: 20 })
  })

  it('verifies an empty log', () => {
    expect(setup().audit.verifyChain()).toEqual({ ok: true, count: 0 })
  })

  it('detects an edited row', () => {
    const { audit, db } = setup()
    for (let i = 0; i < 5; i++) audit.append({ action: 'bill.void', after: { amount: 100 * i } })
    tamper(db, `UPDATE audit_log SET after_json = '{"amount":1}' WHERE seq = 3`)
    expect(audit.verifyChain()).toEqual({ ok: false, count: 5, brokenAtSeq: 3, reason: 'hash_mismatch' })
  })

  it('detects a deleted row', () => {
    const { audit, db } = setup()
    for (let i = 0; i < 5; i++) audit.append({ action: 'a' })
    tamper(db, 'DELETE FROM audit_log WHERE seq = 2')
    expect(audit.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 3, reason: 'sequence_gap' })
  })

  it('detects a deleted tail only via the expected count (documented limitation)', () => {
    const { audit, db } = setup()
    for (let i = 0; i < 3; i++) audit.append({ action: 'a' })
    const head = audit.head()
    tamper(db, 'DELETE FROM audit_log WHERE seq = 3')
    expect(audit.verifyChain()).toEqual({ ok: true, count: 2 })
    expect(audit.verifyChain({ expectHead: head })).toMatchObject({ ok: false, reason: 'head_mismatch' })
  })

  it('participates in the caller transaction (rolled back with it)', () => {
    const { audit, db } = setup()
    const tx = db.transaction(() => {
      audit.append({ action: 'will-roll-back' })
      throw new Error('boom')
    })
    expect(() => tx.immediate()).toThrow('boom')
    expect(audit.verifyChain()).toEqual({ ok: true, count: 0 })
  })
})
