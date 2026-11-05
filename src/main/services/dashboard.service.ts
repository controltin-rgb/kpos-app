import { can, type Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { thMain } from '@main/i18n/th'
import type { DashboardDto, DashboardPeriod, NotificationDto } from '@shared/api-dashboard'
import { uuidv7 } from '@shared/id'
import type { ReportService } from './report.service'
import type { ShiftService } from './shift.service'
import type { StockService } from './stock/stock.service'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const OFFSET = 7 * HOUR // Asia/Bangkok, no DST

/** Bangkok-local period boundaries [from, to) and the previous period of the same length. */
export function periodRange(period: DashboardPeriod, now: number): { from: number; to: number; prevFrom: number; prevTo: number } {
  const local = new Date(now + OFFSET)
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET
  if (period === 'today') return { from: dayStart, to: dayStart + DAY, prevFrom: dayStart - DAY, prevTo: dayStart }
  if (period === 'yesterday') return { from: dayStart - DAY, to: dayStart, prevFrom: dayStart - 2 * DAY, prevTo: dayStart - DAY }
  if (period === 'week') {
    const dow = (local.getUTCDay() + 6) % 7 // Monday = 0
    const from = dayStart - dow * DAY
    return { from, to: from + 7 * DAY, prevFrom: from - 7 * DAY, prevTo: from }
  }
  const from = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - OFFSET
  const to = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - OFFSET
  const prevFrom = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - OFFSET
  return { from, to, prevFrom, prevTo: from }
}

const WEEKDAYS = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']

/** Dashboard figures (confirmed prototype) and the notification bell. */
export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly reports: ReportService,
    private readonly shifts: ShiftService,
    private readonly stock: StockService,
    private readonly now: () => number = Date.now,
  ) {}

  summary(actor: Actor, period: DashboardPeriod): DashboardDto {
    const now = this.now()
    const r = periodRange(period, now)
    const cur = this.reports.salesReport(actor, r.from, r.to, period === 'today' || period === 'yesterday' ? 'hour' : 'day')
    const prev = this.reports.salesReport(actor, r.prevFrom, r.prevTo, 'day')
    const items = this.db
      .prepare(
        `SELECT i.product_name AS name, p.kind, sum(i.qty) AS qty FROM bill_items i JOIN bills b ON b.id = i.bill_id JOIN products p ON p.id = i.product_id
         WHERE b.branch_id = ? AND b.status = 'paid' AND b.created_at >= ? AND b.created_at < ? GROUP BY i.product_name ORDER BY qty DESC`,
      )
      .all(actor.branchId, r.from, r.to) as { name: string; kind: string; qty: number }[]
    const totalItems = items.reduce((s, i) => s + i.qty, 0)

    // chart
    let chart: DashboardDto['chart']
    if (period === 'today' || period === 'yesterday') {
      const hours = cur.buckets.map((b) => Number(b.label.slice(0, 2)))
      const lo = Math.min(8, ...hours)
      const hi = Math.max(17, ...hours)
      const labels = Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i).padStart(2, '0'))
      chart = { kind: 'hour', labels, values: labels.map((h) => cur.buckets.find((b) => b.label.startsWith(h))?.totalSatang ?? 0) }
    } else if (period === 'week') {
      chart = { kind: 'weekday', labels: WEEKDAYS, values: WEEKDAYS.map((_, i) => cur.buckets.filter((b) => b.start === r.from + i * DAY).reduce((s, b) => s + b.totalSatang, 0)) }
    } else {
      const weeks = Math.ceil((r.to - r.from) / (7 * DAY))
      chart = {
        kind: 'week',
        labels: Array.from({ length: weeks }, (_, i) => String(i + 1)),
        values: Array.from({ length: weeks }, (_, i) => cur.buckets.filter((b) => b.start >= r.from + i * 7 * DAY && b.start < r.from + (i + 1) * 7 * DAY).reduce((s, b) => s + b.totalSatang, 0)),
      }
    }

    const chBills = (c: string) => cur.channels.find((x) => x.channel === c)?.billCount ?? 0
    const ings = this.stock.repo.ingredientsWithStock(actor.branchId)
    const low = ings
      .filter((i) => i.on_hand_milli - i.shortage_milli <= i.min_qty_milli)
      .map((i) => ({ name: i.name, pct: Math.max(0, Math.min(100, Math.round(((i.on_hand_milli - i.shortage_milli) * 100) / Math.max(1, i.pack_size_milli)))) }))
      .sort((a, b) => a.pct - b.pct)
    const lots = this.db
      .prepare(
        `SELECT i.name, l.lot_no, l.expires_at FROM stock_lots l JOIN ingredients i ON i.id = l.ingredient_id
         WHERE l.branch_id = ? AND l.qty_remaining_milli > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ? ORDER BY l.expires_at`,
      )
      .all(actor.branchId, now + 7 * DAY) as { name: string; lot_no: string | null; expires_at: number }[]
    const daysLeft = (t: number) => Math.max(0, Math.ceil((t - now) / DAY))
    const open = this.db.prepare(`SELECT * FROM shifts WHERE branch_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`).get(actor.branchId) as Parameters<ShiftService['summary']>[0] | undefined
    const lastClosed = this.db.prepare(`SELECT over_short_satang FROM shifts WHERE branch_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1`).pluck().get(actor.branchId) as number | undefined
    const openSummary = open ? this.shifts.summary(open) : null

    return {
      period,
      salesSatang: cur.totalSatang,
      deltaPct: prev.totalSatang > 0 ? Math.round(((cur.totalSatang - prev.totalSatang) * 100) / prev.totalSatang) : null,
      bills: cur.billCount,
      voids: cur.voidCount,
      avgBillSatang: cur.avgBillSatang,
      itemsPerBillX10: cur.billCount ? Math.round((totalItems * 10) / cur.billCount) : 0,
      grossProfitSatang: can(actor, 'reports:view_cost') ? this.reports.profitReport(actor, r.from, r.to).grossProfitSatang : null,
      chart,
      channels: (['dine_in', 'takeaway', 'grab', 'lineman', 'shopeefood', 'foodpanda'] as const).map((c) => ({ channel: c, bills: chBills(c) })),
      deliveries: { grab: chBills('grab'), lineman: chBills('lineman'), shopeefood: chBills('shopeefood'), foodpanda: chBills('foodpanda') },
      top: items.slice(0, 5).map((i) => ({ name: i.name, qty: i.qty, unit: i.kind === 'drink' ? 'cup' : 'piece' })),
      stock: {
        lowCount: low.length,
        exp3Count: lots.filter((l) => l.expires_at <= now + 3 * DAY).length,
        exp7Count: lots.filter((l) => l.expires_at > now + 3 * DAY).length,
        low: low.slice(0, 3),
        expiring: lots.slice(0, 2).map((l) => ({ name: l.name, lotNo: l.lot_no, days: daysLeft(l.expires_at) })),
      },
      shift: openSummary ? { openedByName: openSummary.openedByName, expectedCashSatang: openSummary.expectedCashSatang, openingFloatSatang: openSummary.openingFloatSatang, lastOverShortSatang: lastClosed ?? null } : null,
      pending: {
        counts: this.db.prepare(`SELECT count(*) FROM stock_counts WHERE branch_id = ? AND status = 'pending'`).pluck().get(actor.branchId) as number,
        voids: 0,
        licenseDaysLeft: null,
        lastBackupAt: (this.db.prepare('SELECT max(finished_at) FROM backup_runs WHERE ok = 1').pluck().get() as number | null) ?? null,
      },
    }
  }

  // ===========================================================================
  // notification bell — alerts derived from current state, stored so read state sticks
  // ===========================================================================

  private sync(actor: Actor): void {
    const now = this.now()
    const t = thMain.notifications
    const want: { kind: NotificationDto['kind']; refId: string; title: string; body: string; permission: string }[] = []
    for (const i of this.stock.repo.ingredientsWithStock(actor.branchId)) {
      const avail = i.on_hand_milli - i.shortage_milli
      if (avail <= i.min_qty_milli) {
        const pct = Math.max(0, Math.min(100, Math.round((avail * 100) / Math.max(1, i.pack_size_milli))))
        want.push({ kind: 'low_stock', refId: i.id, title: t.lowStock(i.name, pct), body: t.lowStockBody, permission: 'inventory:view' })
      }
    }
    const lots = this.db
      .prepare(`SELECT l.id, i.name, l.expires_at FROM stock_lots l JOIN ingredients i ON i.id = l.ingredient_id WHERE l.branch_id = ? AND l.qty_remaining_milli > 0 AND l.expires_at IS NOT NULL AND l.expires_at <= ?`)
      .all(actor.branchId, now + 3 * DAY) as { id: string; name: string; expires_at: number }[]
    for (const l of lots) want.push({ kind: 'near_expiry', refId: l.id, title: t.nearExpiry(l.name, Math.max(0, Math.ceil((l.expires_at - now) / DAY))), body: t.nearExpiryBody, permission: 'inventory:view' })
    const pending = this.db.prepare(`SELECT count(*) FROM stock_counts WHERE branch_id = ? AND status = 'pending'`).pluck().get(actor.branchId) as number
    if (pending) want.push({ kind: 'pending_count', refId: `pending:${pending}`, title: t.pendingCount(pending), body: t.pendingCountBody, permission: 'inventory:approve_count' })

    const exists = this.db.prepare(`SELECT 1 FROM notifications WHERE branch_id = ? AND kind = ? AND ref_id = ? AND (read_at IS NULL OR read_at > ?)`)
    const ins = this.db.prepare(
      `INSERT INTO notifications (id, branch_id, permission, kind, severity, title, body, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      for (const w of want) {
        // an alert that was read comes back after a day if the condition persists
        if (!exists.get(actor.branchId, w.kind, w.refId, now - DAY)) ins.run(uuidv7(now), actor.branchId, w.permission, w.kind, w.kind === 'low_stock' ? 'danger' : 'warning', w.title, w.body, w.kind, w.refId, now)
      }
    }).immediate()
  }

  notifications(actor: Actor): { items: NotificationDto[]; unread: number } {
    this.sync(actor)
    const rows = (
      this.db.prepare('SELECT * FROM notifications WHERE branch_id = ? ORDER BY created_at DESC LIMIT 50').all(actor.branchId) as {
        id: string
        kind: NotificationDto['kind']
        title: string
        body: string | null
        permission: string | null
        created_at: number
        read_at: number | null
      }[]
    ).filter((n) => !n.permission || can(actor, n.permission as never))
    const items = rows.slice(0, 5).map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, createdAt: n.created_at, read: n.read_at !== null }))
    return { items, unread: rows.filter((n) => n.read_at === null).length }
  }

  markRead(actor: Actor, id: string | null): void {
    const now = this.now()
    if (id) this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND branch_id = ? AND read_at IS NULL').run(now, id, actor.branchId)
    else this.db.prepare('UPDATE notifications SET read_at = ? WHERE branch_id = ? AND read_at IS NULL').run(now, actor.branchId)
  }
}
