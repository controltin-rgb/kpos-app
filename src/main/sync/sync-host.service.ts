import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import type { AuditService } from '@main/services/audit.service'
import type { CatalogService } from '@main/services/catalog.service'
import type { DocNumberService } from '@main/services/doc-number.service'
import type { PromoService } from '@main/services/promo.service'
import type { SaleService } from '@main/services/sale.service'
import type { SettingsService } from '@main/services/settings.service'
import { periodKey, type BillResetPolicy } from '@shared/bill-number'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { BLOCK_LOW_WATER, BLOCK_SIZE, offlineBillSchema, type BillBlockDto, type SyncResult, type SyncSnapshot } from '@shared/sync'

const DAY = 86_400_000

/** The numbering period after the one containing `now` (Asia/Bangkok), or '' when numbers never reset. */
export function nextPeriod(policy: BillResetPolicy, now: number): string {
  if (policy === 'none') return ''
  const cur = periodKey(policy, now)
  // step forward a day at a time until the key changes (≤ 366 steps, only for yearly)
  for (let t = now + DAY; ; t += DAY) {
    const k = periodKey(policy, t)
    if (k !== cur) return k
    if (t - now > 400 * DAY) return cur
  }
}

interface BlockRow {
  id: string
  period: string
  prefix: string
  from_no: number
  to_no: number
  used_to: number | null
}

/**
 * Host side of Client offline selling (D27, D36): hands each Client a copy of what it needs to sell
 * and bill-number blocks, and records the bills it sold while the Host was unreachable.
 */
export class SyncHostService {
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService,
    private readonly promo: PromoService,
    private readonly settings: SettingsService,
    private readonly docs: DocNumberService,
    private readonly sales: SaleService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.org = new OrgRepo(db)
  }

  private branchOf(deviceId: string): string {
    const b = this.db.prepare(`SELECT branch_id FROM devices WHERE id = ? AND role = 'client' AND revoked_at IS NULL`).pluck().get(deviceId) as string | undefined
    if (!b) throw new AppError('LAN_DEVICE_REVOKED')
    return b
  }

  /**
   * Keeps ≥ BLOCK_LOW_WATER unused numbers for the device in the current period (and the next one when
   * numbers reset, so a Client offline across midnight / month end can still sell). Returns live blocks.
   */
  ensureBlocks(deviceId: string): BillBlockDto[] {
    const branchId = this.branchOf(deviceId)
    const at = this.now()
    const policy = this.settings.get('bill.reset_policy')
    const periods = [...new Set([periodKey(policy, at), nextPeriod(policy, at)])]
    const prefix = this.docs.branchCode(branchId)
    this.db
      .transaction(() => {
        for (const period of periods) {
          const blocks = this.db
            .prepare('SELECT id, period, prefix, from_no, to_no, used_to FROM bill_number_blocks WHERE device_id = ? AND period = ? AND exhausted_at IS NULL')
            .all(deviceId, period) as BlockRow[]
          const left = blocks.reduce((s, b) => s + (b.to_no - (b.used_to ?? b.from_no - 1)), 0)
          if (left > BLOCK_LOW_WATER) continue
          const from = this.docs.reserve(branchId, this.docs.billDocType(period), BLOCK_SIZE, at, prefix)
          this.db
            .prepare(
              `INSERT INTO bill_number_blocks (id, branch_id, device_id, from_no, to_no, used_to, issued_at, period, prefix)
               VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            )
            .run(uuidv7(at), branchId, deviceId, from, from + BLOCK_SIZE - 1, at, period, prefix)
        }
        // blocks of past periods can never be used again
        const live = new Set(periods)
        const old = this.db.prepare('SELECT id, period FROM bill_number_blocks WHERE device_id = ? AND exhausted_at IS NULL').all(deviceId) as { id: string; period: string }[]
        const done = this.db.prepare('UPDATE bill_number_blocks SET exhausted_at = ? WHERE id = ?')
        for (const b of old) if (!live.has(b.period)) done.run(at, b.id)
      })
      .immediate()
    return (
      this.db
        .prepare('SELECT id, period, prefix, from_no, to_no, used_to FROM bill_number_blocks WHERE device_id = ? AND exhausted_at IS NULL ORDER BY period, from_no')
        .all(deviceId) as BlockRow[]
    ).map((b) => ({ id: b.id, period: b.period, prefix: b.prefix, fromNo: b.from_no, toNo: b.to_no }))
  }

  snapshot(deviceId: string): SyncSnapshot {
    const branchId = this.branchOf(deviceId)
    const branch = this.org.branch(branchId)
    if (!branch) throw new AppError('NOT_FOUND')
    const blocks = this.ensureBlocks(deviceId)
    const now = this.now()
    return {
      at: now,
      branch: { id: branchId, name: branch.name, code: this.docs.branchCode(branchId), shopName: branch.company_name },
      settings: {
        vatRateBp: this.settings.get('vat.rate_bp'),
        promptPayId: this.settings.get('promptpay.id'),
        billPolicy: this.settings.get('bill.reset_policy'),
        receiptHeader: this.settings.get('receipt.header'),
        receiptFooter: this.settings.get('receipt.footer'),
        paperMm: this.settings.get('receipt.paper_mm'),
        deliveryEnabled: this.settings.get('sales.delivery_enabled'),
      },
      posCatalog: this.catalog.posCatalog({ branchId }),
      products: this.catalog.saleSnapshots(branchId),
      // coupon-only promotions need a coupon, and coupons need the Host (D37)
      promotions: this.promo
        .defs(branchId)
        .filter((p) => p.active && !p.rules.couponOnly)
        .map(({ usedCount: _u, ...p }) => p),
      blocks,
    }
  }

  /** Records bills sold offline. Each bill is validated and committed on its own; one bad bill does not block the rest. */
  ingest(deviceId: string, raw: unknown): SyncResult[] {
    this.branchOf(deviceId)
    if (!Array.isArray(raw) || raw.length > 500) throw new AppError('INVALID_INPUT')
    const at = this.now()
    const results: SyncResult[] = raw.map((item) => {
      const parsed = offlineBillSchema.safeParse(item)
      if (!parsed.success) {
        const id = typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : 'unknown'
        return { id, status: 'rejected', reason: 'invalid' } as SyncResult
      }
      try {
        return this.sales.ingestOffline(deviceId, parsed.data, at)
      } catch (err) {
        return { id: parsed.data.id, status: 'rejected', reason: err instanceof AppError ? err.code : 'internal' } as SyncResult
      }
    })
    const ok = results.filter((r) => r.status === 'ok').length
    const rejected = results.filter((r) => r.status === 'rejected')
    if (ok || rejected.length) {
      const branchId = this.branchOf(deviceId)
      this.db
        .transaction(() => {
          this.audit.append({
            action: 'sync.offline_bills',
            permission: 'pos:create',
            branchId,
            deviceId,
            entity: 'device',
            entityId: deviceId,
            after: { received: raw.length, recorded: ok, duplicates: results.filter((r) => r.status === 'duplicate').length, rejected: rejected.length },
            risk: rejected.length ? 'high' : 'low',
          })
          // a refused bill is kept in full in the append-only audit log so nothing sold is lost
          for (const r of rejected) {
            const bill = (raw as { id?: unknown }[]).find((b) => b?.id === r.id) ?? null
            this.audit.append({ action: 'sync.rejected_bill', permission: 'pos:create', branchId, deviceId, entity: 'bills', entityId: r.id, after: { reason: r.status === 'rejected' ? r.reason : null, bill }, risk: 'high' })
          }
        })
        .immediate()
    }
    return results
  }
}
