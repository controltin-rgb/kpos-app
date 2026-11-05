import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import type { KdsTicketDto } from '@shared/api-sales'
import { AppError } from '@shared/errors'

const NEXT: Record<string, string> = { new: 'preparing', preparing: 'ready', ready: 'completed' }

/** Bar/kitchen display: tickets grouped per bill, NEW → PREPARING → READY → COMPLETED. */
export class KdsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  tickets(actor: Actor, station: string): KdsTicketDto[] {
    const rows = this.db
      .prepare(
        `SELECT t.bill_id, t.status, t.created_at, b.bill_no, b.order_type, b.channel,
                i.id AS item_id, i.qty, i.product_name, i.size_label, i.note
         FROM kds_tickets t JOIN bills b ON b.id = t.bill_id JOIN bill_items i ON i.id = t.bill_item_id
         WHERE t.branch_id = ? AND t.station = ? AND t.status IN ('new', 'preparing', 'ready')
         ORDER BY t.created_at, i.line_no`,
      )
      .all(actor.branchId, station) as {
      bill_id: string
      status: 'new' | 'preparing' | 'ready'
      created_at: number
      bill_no: string
      order_type: KdsTicketDto['orderType']
      channel: KdsTicketDto['channel']
      item_id: string
      qty: number
      product_name: string
      size_label: string | null
      note: string | null
    }[]
    const mods = this.db
      .prepare(`SELECT bill_item_id, option_name, kds_highlight FROM bill_item_modifiers WHERE bill_item_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`)
      .all(JSON.stringify(rows.map((r) => r.item_id))) as { bill_item_id: string; option_name: string; kds_highlight: number }[]

    const byBill = new Map<string, KdsTicketDto>()
    for (const r of rows) {
      let t = byBill.get(r.bill_id)
      if (!t) {
        t = { billId: r.bill_id, billNo: r.bill_no, orderType: r.order_type, channel: r.channel, status: r.status, createdAt: r.created_at, items: [] }
        byBill.set(r.bill_id, t)
      }
      // a bill's tickets move together; show the least advanced status
      if (r.status === 'new' || (r.status === 'preparing' && t.status === 'ready')) t.status = r.status
      t.items.push({
        qty: r.qty,
        name: r.product_name,
        sizeLabel: r.size_label,
        note: r.note,
        mods: mods.filter((m) => m.bill_item_id === r.item_id).map((m) => ({ text: m.option_name, highlight: m.kds_highlight === 1 })),
      })
    }
    return [...byBill.values()]
  }

  /** Moves every ticket of the bill at this station one step forward. */
  advance(actor: Actor, billId: string, station: string): void {
    const at = this.now()
    this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id, status FROM kds_tickets WHERE branch_id = ? AND bill_id = ? AND station = ? AND status IN ('new', 'preparing', 'ready')`)
        .all(actor.branchId, billId, station) as { id: string; status: string }[]
      if (!rows.length) throw new AppError('NOT_FOUND')
      const order = ['new', 'preparing', 'ready']
      const current = rows.map((r) => r.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!
      const next = NEXT[current]!
      const col = next === 'preparing' ? 'started_at' : next === 'ready' ? 'ready_at' : 'completed_at'
      this.db
        .prepare(`UPDATE kds_tickets SET status = ?, ${col} = ?, updated_at = ? WHERE branch_id = ? AND bill_id = ? AND station = ? AND status = ?`)
        .run(next, at, at, actor.branchId, billId, station, current)
    }).immediate()
  }
}
