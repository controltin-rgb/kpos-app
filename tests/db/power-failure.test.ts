import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '@main/db/connection'
import { createTestApp } from '../helpers/app'
import { requestId, seedShop } from '../helpers/shop'
import { tmpDir } from '../helpers/tmp'

/** Starts the writer, waits until it has committed `atLeast` bills, then kills it without warning. */
function runAndKill(dbPath: string, atLeast: number, extraMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // same runtime as the app: Electron's Node (ELECTRON_RUN_AS_NODE=1 is set for the test run)
    const child = spawn(process.execPath, [join(import.meta.dirname, 'crash-writer.cjs'), dbPath], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let killed = false
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.stdout.on('data', (d: Buffer) => {
      const n = Number(d.toString().trim().split('\n').pop())
      if (!killed && n >= atLeast) {
        killed = true
        setTimeout(() => child.kill('SIGKILL'), extraMs) // TerminateProcess on Windows: no cleanup, no close()
      }
    })
    child.on('exit', () => (killed ? resolve() : reject(new Error(`writer exited on its own: ${err}`))))
    setTimeout(() => {
      if (!killed) child.kill('SIGKILL')
    }, 20_000)
  })
}

describe('sudden power loss / process kill (Design-Spec: power-failure tests)', () => {
  it('never leaves a half-written bill or a corrupt file after repeated kills mid-transaction', async () => {
    const dbPath = join(tmpDir('kposs-crash-'), 'kposs.sqlite')
    for (let round = 0; round < 6; round++) await runAndKill(dbPath, 20 + round * 20, Math.floor(Math.random() * 40))

    const db = openDatabase(dbPath) // reopening replays / discards the WAL, like the next app start
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(db.pragma('foreign_key_check')).toEqual([])
      const bills = db.prepare('SELECT count(*) FROM bills').pluck().get() as number
      expect(bills).toBeGreaterThanOrEqual(120)
      // every bill has all of its lines and its final total — nothing in between
      const broken = db
        .prepare(
          `SELECT b.id FROM bills b LEFT JOIN (SELECT bill_id, count(*) AS c, sum(amount) AS s FROM bill_lines GROUP BY bill_id) l ON l.bill_id = b.id
           WHERE ifnull(l.c, 0) <> b.lines OR ifnull(l.s, 0) <> b.total`,
        )
        .all()
      expect(broken).toEqual([])
      // stock moved exactly once per sold line
      const lines = db.prepare('SELECT count(*) FROM bill_lines').pluck().get() as number
      expect(db.prepare('SELECT qty FROM stock WHERE id = 1').pluck().get()).toBe(-lines)
    } finally {
      db.close()
    }
  }, 60_000)

  it('a checkout interrupted before COMMIT leaves no bill, no stock movement and no used bill number', async () => {
    const root = tmpDir('kposs-crash-app-')
    const files = { dbPath: join(root, 'data', 'kposs.sqlite'), backupDir: join(root, 'backup') }
    const t = createTestApp({ files })
    await t.setup()
    const shop = await seedShop(t)
    await t.call(1, 'shift.open', { openingFloatSatang: 100_000 })
    const sell = () => t.call(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [{ productId: shop.tea.id, qty: 2, optionIds: [shop.normalSweet] }], payment: { method: 'cash', tenderedSatang: 10_000 } })
    await sell()
    const count = (sql: string) => t.db.prepare(sql).pluck().get() as number
    const before = { bills: count('SELECT count(*) FROM bills'), ledger: count('SELECT count(*) FROM stock_ledger'), seq: count(`SELECT ifnull(sum(next_no), 0) FROM doc_sequences`) }

    // "power cut" in the middle of the sale: the 2nd stock deduction never returns
    const stock = t.app.stock as unknown as { deduct: (...a: unknown[]) => unknown }
    const real = stock.deduct.bind(stock)
    let calls = 0
    stock.deduct = (...a: unknown[]) => {
      if (++calls === 2) throw new Error('power cut')
      return real(...a)
    }
    const res = await t.raw(1, 'pos.checkout', { requestId: requestId(), orderType: 'takeaway', items: [
        { productId: shop.tea.id, sizeId: shop.sizes.s16, qty: 1, optionIds: [shop.normalSweet] },
        { productId: shop.tea.id, sizeId: shop.sizes.s22, qty: 1, optionIds: [shop.normalSweet] },
      ],
      payment: { method: 'cash', tenderedSatang: 20_000 },
    })
    expect(calls).toBe(2) // the bill row and its first line were already written when it stopped
    expect(res.ok).toBe(false)
    stock.deduct = real
    t.db.close()

    // the next start sees exactly the state before the interrupted sale
    const db = new Database(files.dbPath, { readonly: true })
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      const c = (sql: string) => db.prepare(sql).pluck().get() as number
      expect({ bills: c('SELECT count(*) FROM bills'), ledger: c('SELECT count(*) FROM stock_ledger'), seq: c(`SELECT ifnull(sum(next_no), 0) FROM doc_sequences`) }).toEqual(before)
    } finally {
      db.close()
    }
  })
})
