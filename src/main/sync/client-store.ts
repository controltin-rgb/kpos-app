import type { BillDetailDto } from '@shared/api-sales'
import type { Db } from '@main/db/connection'
import { AppError } from '@shared/errors'
import type { OfflineBill, SyncResult, SyncSnapshot } from '@shared/sync'

export interface OutboxCounts {
  pending: number
  rejected: number
  sent: number
}

/**
 * The Client's own small database (migrations-client/): the latest Host snapshot, the reserved bill
 * numbers and the offline bills queue. Taking a number and queuing the bill happen in ONE
 * transaction, so a number is never used twice and a sale is never lost (CLAUDE.md rule 2).
 */
export class ClientStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  saveSnapshot(snap: SyncSnapshot): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(`INSERT INTO kv (key, value_json, updated_at) VALUES ('snapshot', ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
          .run(JSON.stringify(snap), this.now())
        const ins = this.db.prepare('INSERT OR IGNORE INTO bill_blocks (id, period, prefix, from_no, to_no, next_no) VALUES (?, ?, ?, ?, ?, ?)')
        for (const b of snap.blocks) ins.run(b.id, b.period, b.prefix, b.fromNo, b.toNo, b.fromNo)
        // blocks the Host no longer lists belong to a past period
        const keep = new Set(snap.blocks.map((b) => b.id))
        const del = this.db.prepare('DELETE FROM bill_blocks WHERE id = ?')
        for (const id of this.db.prepare('SELECT id FROM bill_blocks').pluck().all() as string[]) if (!keep.has(id)) del.run(id)
      })
      .immediate()
  }

  snapshot(): SyncSnapshot | null {
    const raw = this.db.prepare(`SELECT value_json FROM kv WHERE key = 'snapshot'`).pluck().get() as string | undefined
    return raw ? (JSON.parse(raw) as SyncSnapshot) : null
  }

  numbersLeft(period: string): number {
    return (this.db.prepare('SELECT ifnull(sum(to_no - next_no + 1), 0) FROM bill_blocks WHERE period = ?').pluck().get(period) as number) ?? 0
  }

  /**
   * Reserves the next number of the period and queues the bill built with it — atomically.
   * `build` receives the number and returns the bill + its printed detail.
   */
  sell(period: string, build: (n: { blockId: string; period: string; prefix: string; seq: number }) => { bill: OfflineBill; detail: BillDetailDto }): BillDetailDto {
    return this.db
      .transaction(() => {
        const block = this.db.prepare('SELECT id, prefix, next_no FROM bill_blocks WHERE period = ? AND next_no <= to_no ORDER BY from_no LIMIT 1').get(period) as
          | { id: string; prefix: string; next_no: number }
          | undefined
        if (!block) throw new AppError('OFFLINE_NO_NUMBERS')
        const { bill, detail } = build({ blockId: block.id, period, prefix: block.prefix, seq: block.next_no })
        this.db.prepare('UPDATE bill_blocks SET next_no = next_no + 1 WHERE id = ?').run(block.id)
        this.db
          .prepare('INSERT INTO outbox (id, bill_no, payload_json, detail_json, total_satang, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(bill.id, bill.billNo, JSON.stringify(bill), JSON.stringify(detail), bill.totalSatang, bill.createdAt)
        return detail
      })
      .immediate()
  }

  /** A queued bill by id (retried checkout / reprint while offline). */
  detail(id: string): BillDetailDto | null {
    const raw = this.db.prepare('SELECT detail_json FROM outbox WHERE id = ?').pluck().get(id) as string | undefined
    return raw ? (JSON.parse(raw) as BillDetailDto) : null
  }

  pending(limit = 100): OfflineBill[] {
    return (this.db.prepare(`SELECT payload_json FROM outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?`).pluck().all(limit) as string[]).map((r) => JSON.parse(r) as OfflineBill)
  }

  /** Applies the Host's answers; failed attempts keep the bill pending. */
  record(results: SyncResult[], attempted: readonly string[]): void {
    const at = this.now()
    this.db
      .transaction(() => {
        const set = this.db.prepare('UPDATE outbox SET status = ?, sent_at = ?, last_error = ?, attempts = attempts + 1 WHERE id = ?')
        const seen = new Set<string>()
        for (const r of results) {
          seen.add(r.id)
          if (r.status === 'rejected') set.run('rejected', null, r.reason, r.id)
          else set.run(r.status === 'ok' ? 'sent' : 'duplicate', at, null, r.id)
        }
        const bump = this.db.prepare('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?')
        for (const id of attempted) if (!seen.has(id)) bump.run(id)
      })
      .immediate()
  }

  failAttempt(ids: readonly string[], error: string): void {
    const st = this.db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?')
    this.db.transaction(() => ids.forEach((id) => st.run(error.slice(0, 200), id))).immediate()
  }

  counts(): OutboxCounts {
    const rows = this.db.prepare('SELECT status, count(*) AS n FROM outbox GROUP BY status').all() as { status: string; n: number }[]
    const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0
    return { pending: n('pending'), rejected: n('rejected'), sent: n('sent') + n('duplicate') }
  }
}
