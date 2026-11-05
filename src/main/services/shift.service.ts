import { can, type Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { SalesRepo, type ShiftRow } from '@main/db/repos/sales.repo'
import type { PaymentMethod, ShiftSummaryDto } from '@shared/api-sales'
import { countedTotal, type DenominationCount } from '@shared/cash'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import type { AuditService } from './audit.service'
import type { DeviceService } from './device.service'
import type { DocNumberService } from './doc-number.service'

const METHODS: PaymentMethod[] = ['cash', 'promptpay', 'card', 'transfer', 'delivery', 'other']

/**
 * Shifts and the cash drawer (Implement.md §6.5).
 * Expected cash = SUM(cash_ledger.amount) of the shift: opening float + cash sales − voids − refunds
 *                 + cash in − cash out − drawer expenses.
 * Over/Short = counted − expected.
 */
export class ShiftService {
  readonly repo: SalesRepo

  constructor(
    private readonly db: Db,
    private readonly devices: DeviceService,
    private readonly docs: DocNumberService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.repo = new SalesRepo(db)
  }

  /** The open shift of this device, or null. */
  current(): ShiftSummaryDto | null {
    const s = this.repo.openShiftForDevice(this.devices.local.id)
    return s ? this.summary(s) : null
  }

  /** Must be called inside a transaction; throws SHIFT_NOT_OPEN. */
  requireOpen(): ShiftRow {
    const s = this.repo.openShiftForDevice(this.devices.local.id)
    if (!s) throw new AppError('SHIFT_NOT_OPEN')
    return s
  }

  open(actor: Actor, openingFloatSatang: number): ShiftSummaryDto {
    const at = this.now()
    const id = this.db.transaction(() => {
      const deviceId = this.devices.ensure(actor.branchId)
      if (this.repo.openShiftForDevice(deviceId)) throw new AppError('SHIFT_ALREADY_OPEN')
      const sid = uuidv7(at)
      this.repo.insertShift({
        id: sid,
        branch_id: actor.branchId,
        device_id: deviceId,
        shift_no: this.docs.nextDocNo(actor.branchId, 'S', at),
        opened_by: actor.userId,
        opened_at: at,
        opening_float_satang: openingFloatSatang,
      })
      if (openingFloatSatang > 0) {
        this.repo.insertCash({
          id: uuidv7(at),
          branch_id: actor.branchId,
          shift_id: sid,
          kind: 'opening_float',
          amount_satang: openingFloatSatang,
          ref_type: 'shift',
          ref_id: sid,
          reverses_id: null,
          note: null,
          user_id: actor.userId,
          device_id: deviceId,
          created_at: at,
        })
      }
      this.audit.append({
        action: 'shift.open',
        permission: 'shift:create',
        userId: actor.userId,
        branchId: actor.branchId,
        deviceId,
        entity: 'shifts',
        entityId: sid,
        after: { openingFloatSatang },
      })
      return sid
    }).immediate()
    return this.summary(this.repo.shift(id)!)
  }

  /** Cash in / cash out of the drawer with a reason (audited). */
  cashMove(actor: Actor, kind: 'cash_in' | 'cash_out', amountSatang: number, reason: string): ShiftSummaryDto {
    const at = this.now()
    const shift = this.db.transaction(() => {
      const s = this.requireOpen()
      this.assertOwnerOrAll(actor, s)
      const expected = this.expected(s.id)
      if (kind === 'cash_out' && amountSatang > expected) throw new AppError('PAYMENT_INVALID', { reason: 'drawer_insufficient', expected })
      const entryId = uuidv7(at)
      this.repo.insertCash({
        id: entryId,
        branch_id: s.branch_id,
        shift_id: s.id,
        kind,
        amount_satang: kind === 'cash_in' ? amountSatang : -amountSatang,
        ref_type: null,
        ref_id: null,
        reverses_id: null,
        note: reason,
        user_id: actor.userId,
        device_id: s.device_id,
        created_at: at,
      })
      this.audit.append({
        action: `shift.${kind}`,
        permission: 'shift:update',
        userId: actor.userId,
        branchId: actor.branchId,
        deviceId: s.device_id,
        entity: 'cash_ledger',
        entityId: entryId,
        after: { amountSatang, reason },
        reason,
        risk: 'medium',
      })
      return s
    }).immediate()
    return this.summary(this.repo.shift(shift.id)!)
  }

  close(actor: Actor, shiftId: string, counts: DenominationCount[], note: string | null): ShiftSummaryDto {
    const counted = countedTotal(counts)
    const at = this.now()
    this.db.transaction(() => {
      const s = this.repo.shift(shiftId)
      if (!s || s.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
      if (s.status !== 'open') throw new AppError('SHIFT_NOT_OPEN')
      this.assertOwnerOrAll(actor, s)
      const expected = this.expected(s.id)
      for (const c of counts) if (c.count > 0) this.repo.insertCashCount(s.id, c.denominationSatang, c.count)
      this.repo.closeShift(s.id, { closed_by: actor.userId, closed_at: at, expected, counted, note })
      this.audit.append({
        action: 'shift.close',
        permission: 'shift:update',
        userId: actor.userId,
        branchId: actor.branchId,
        deviceId: s.device_id,
        entity: 'shifts',
        entityId: s.id,
        before: { status: 'open', expectedCashSatang: expected },
        after: { status: 'closed', expectedCashSatang: expected, countedCashSatang: counted, overShortSatang: counted - expected, counts },
        reason: note,
        risk: counted === expected ? 'medium' : 'high',
      })
    }).immediate()
    return this.summary(this.repo.shift(shiftId)!)
  }

  expected(shiftId: string): number {
    return Object.values(this.repo.cashByKind(shiftId)).reduce((a, b) => a + b, 0)
  }

  summary(s: ShiftRow): ShiftSummaryDto {
    const k = this.repo.cashByKind(s.id)
    const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>
    for (const r of this.repo.salesByMethod(s.id)) byMethod[r.method as PaymentMethod] = r.total
    const counts = this.repo.billCounts(s.id)
    return {
      id: s.id,
      shiftNo: s.shift_no,
      status: s.status,
      openedAt: s.opened_at,
      openedByName: this.repo.userName(s.opened_by) ?? '',
      closedAt: s.closed_at,
      closedByName: this.repo.userName(s.closed_by),
      openingFloatSatang: s.opening_float_satang,
      cashSalesSatang: (k['sale'] ?? 0) + (k['void_reversal'] ?? 0),
      cashRefundsSatang: -(k['refund'] ?? 0),
      cashInSatang: k['cash_in'] ?? 0,
      cashOutSatang: -((k['cash_out'] ?? 0) + (k['drop'] ?? 0)),
      expensesSatang: -((k['expense'] ?? 0) + (k['expense_reversal'] ?? 0)),
      expectedCashSatang: s.status === 'closed' ? s.expected_cash_satang! : this.expected(s.id),
      countedCashSatang: s.counted_cash_satang,
      overShortSatang: s.over_short_satang,
      byMethod,
      billCount: counts.paid,
      voidCount: counts.void,
      refundCount: counts.refunded,
      totalSalesSatang: Object.values(byMethod).reduce((a, b) => a + b, 0),
    }
  }

  /** Cashiers handle their own shift; closing someone else's needs shift:view_all (Design-Spec §2). */
  private assertOwnerOrAll(actor: Actor, s: ShiftRow) {
    if (s.opened_by !== actor.userId && !can(actor, 'shift:view_all')) throw new AppError('NOT_SHIFT_OWNER')
  }
}
