import { can, type Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { renderTaxInvoice } from '@main/print/tax-invoice'
import type { ParsedInput } from '@shared/api'
import type { ChannelKey, ExpenseReportDto, ProfitReportDto, SalesReportDto, SalesSummaryDto, SalesSummaryRowDto, TaxInvoiceDto, ZListItemDto } from '@shared/api-reports'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { formatBaht, mulDivHalfUp } from '@shared/money'
import { isValidThaiTaxId } from '@shared/tax-id'
import type { AuditService } from './audit.service'
import type { DocNumberService } from './doc-number.service'
import type { ExpenseService } from './expense.service'
import type { SaleService } from './sale.service'
import type { SettingsService } from './settings.service'
import type { ShiftService } from './shift.service'
import type { StockOpsService } from './stock-ops.service'

const bkk = (ms: number) => new Date(ms + 7 * 3_600_000) // shift to Asia/Bangkok wall clock (no DST)
const pad = (n: number) => String(n).padStart(2, '0')
const DAY = 86_400_000
const METHOD_TH: Record<string, string> = { cash: "เงินสด", promptpay: "PromptPay", card: "บัตร", transfer: "โอนเงิน", delivery: "เดลิเวอรี", other: "อื่นๆ" }
const BKK = 7 * 3_600_000
/** Start of the Bangkok day that contains ms. */
const dayStart = (ms: number) => Math.floor((ms + BKK) / DAY) * DAY - BKK
/** Bangkok day starts covering [from, to). */
function daysIn(from: number, to: number): number[] {
  const out: number[] = []
  for (let d = dayStart(from); d < to; d += DAY) out.push(d)
  return out
}
const emptyRow = (): SalesSummaryRowDto => ({ billCount: 0, grossSatang: 0, discountSatang: 0, totalSatang: 0, vatSatang: 0, netSatang: 0, commissionSatang: 0, voidCount: 0, refundCount: 0, refundSatang: 0, methods: {} })

/** Reports (sales, profit by ledger cost, Z list, CSV export) and tax invoices (D19/D20). */
export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly sales: SaleService,
    private readonly shifts: ShiftService,
    private readonly stockOps: StockOpsService,
    private readonly expenses: ExpenseService,
    private readonly docs: DocNumberService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {}

  // ===========================================================================
  // sales & profit
  // ===========================================================================

  salesReport(actor: Actor, from: number, to: number, bucket: 'hour' | 'day'): SalesReportDto {
    const bills = this.db
      .prepare(
        `SELECT id, status, order_type, channel, subtotal_satang, discount_satang, vat_satang, total_satang, ifnull(commission_satang, 0) AS commission, created_at
         FROM bills WHERE branch_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .all(actor.branchId, from, to) as { id: string; status: string; order_type: string; channel: string | null; subtotal_satang: number; discount_satang: number; vat_satang: number; total_satang: number; commission: number; created_at: number }[]
    const paid = bills.filter((b) => b.status === 'paid')
    const sum = (f: (b: (typeof paid)[number]) => number) => paid.reduce((s, b) => s + f(b), 0)
    const total = sum((b) => b.total_satang)

    const bucketMap = new Map<number, { start: number; label: string; totalSatang: number; billCount: number }>()
    for (const b of paid) {
      const d = bkk(b.created_at)
      const key = bucket === 'hour' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()) - 7 * 3_600_000 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 7 * 3_600_000
      const label = bucket === 'hour' ? `${pad(d.getUTCHours())}:00` : `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`
      const e = bucketMap.get(key) ?? { start: key, label, totalSatang: 0, billCount: 0 }
      e.totalSatang += b.total_satang
      e.billCount++
      bucketMap.set(key, e)
    }

    const chMap = new Map<ChannelKey, { channel: ChannelKey; totalSatang: number; commissionSatang: number; netSatang: number; billCount: number }>()
    for (const b of paid) {
      const key = (b.channel ?? b.order_type) as ChannelKey
      const e = chMap.get(key) ?? { channel: key, totalSatang: 0, commissionSatang: 0, netSatang: 0, billCount: 0 }
      e.totalSatang += b.total_satang
      e.commissionSatang += b.commission
      e.netSatang = e.totalSatang - e.commissionSatang
      e.billCount++
      chMap.set(key, e)
    }

    const ids = JSON.stringify(paid.map((b) => b.id))
    const methods = this.db
      .prepare(`SELECT method, sum(amount_satang) AS totalSatang FROM payments WHERE status = 'confirmed' AND bill_id IN (SELECT value FROM json_each(?)) GROUP BY method ORDER BY totalSatang DESC`)
      .all(ids) as { method: string; totalSatang: number }[]
    const topProducts = this.db
      .prepare(
        `SELECT product_name AS name, sum(qty) AS qty, sum(line_total_satang) AS totalSatang FROM bill_items
         WHERE bill_id IN (SELECT value FROM json_each(?)) GROUP BY product_name ORDER BY totalSatang DESC LIMIT 5`,
      )
      .all(ids) as { name: string; qty: number; totalSatang: number }[]

    return {
      from,
      to,
      billCount: paid.length,
      grossSatang: sum((b) => b.subtotal_satang),
      discountSatang: sum((b) => b.discount_satang),
      totalSatang: total,
      vatSatang: sum((b) => b.vat_satang),
      netSatang: total - sum((b) => b.vat_satang),
      avgBillSatang: paid.length ? Math.round(total / paid.length) : 0,
      voidCount: bills.filter((b) => b.status === 'void').length,
      refundCount: bills.filter((b) => b.status === 'refunded').length,
      refundSatang: bills.filter((b) => b.status === 'refunded').reduce((s, b) => s + b.total_satang, 0),
      buckets: [...bucketMap.values()].sort((a, b) => a.start - b.start),
      channels: [...chMap.values()].sort((a, b) => b.totalSatang - a.totalSatang),
      methods,
      topProducts,
    }
  }

  /** One row per Bangkok day (paid bills; voids and refunds counted by the day the bill was made). */
  salesSummary(actor: Actor, from: number, to: number): SalesSummaryDto {
    const bills = this.db
      .prepare(`SELECT id, status, subtotal_satang, discount_satang, vat_satang, total_satang, ifnull(commission_satang, 0) AS commission, created_at
         FROM bills WHERE branch_id = ? AND created_at >= ? AND created_at < ? AND status IN ('paid', 'void', 'refunded')`)
      .all(actor.branchId, from, to) as { id: string; status: string; subtotal_satang: number; discount_satang: number; vat_satang: number; total_satang: number; commission: number; created_at: number }[]
    const pays = this.db
      .prepare(
        `SELECT b.created_at, p.method, sum(p.amount_satang) AS amount FROM payments p JOIN bills b ON b.id = p.bill_id
         WHERE b.branch_id = ? AND b.status = 'paid' AND p.status = 'confirmed' AND b.created_at >= ? AND b.created_at < ? GROUP BY b.id, p.method`,
      )
      .all(actor.branchId, from, to) as { created_at: number; method: string; amount: number }[]
    const rows = new Map(daysIn(from, to).map((d) => [d, emptyRow()]))
    const total = emptyRow()
    const at = (ms: number) => rows.get(dayStart(ms))!
    for (const b of bills) {
      for (const r of [at(b.created_at), total]) {
        if (b.status === 'void') r.voidCount++
        else if (b.status === 'refunded') {
          r.refundCount++
          r.refundSatang += b.total_satang
        } else {
          r.billCount++
          r.grossSatang += b.subtotal_satang
          r.discountSatang += b.discount_satang
          r.totalSatang += b.total_satang
          r.vatSatang += b.vat_satang
          r.netSatang += b.total_satang - b.vat_satang
          r.commissionSatang += b.commission
        }
      }
    }
    for (const p of pays) for (const r of [at(p.created_at), total]) r.methods[p.method] = (r.methods[p.method] ?? 0) + p.amount
    return {
      from,
      to,
      days: [...rows].map(([start, r]) => ({ start, ...r })),
      total,
      methodKeys: Object.keys(total.methods).sort((a, b) => total.methods[b]! - total.methods[a]!),
    }
  }

  expenseReport(actor: Actor, from: number, to: number): ExpenseReportDto {
    const sum = this.expenses.summary(actor, from, to)
    const list = this.db
      .prepare(`SELECT category_id, amount_satang, spent_at FROM expenses WHERE branch_id = ? AND voided_at IS NULL AND spent_at >= ? AND spent_at < ?`)
      .all(actor.branchId, from, to) as { category_id: string; amount_satang: number; spent_at: number }[]
    const counts = new Map<string, number>()
    const days = new Map(daysIn(from, to).map((d) => [d, { start: d, totalSatang: 0, count: 0 }]))
    for (const e of list) {
      counts.set(e.category_id, (counts.get(e.category_id) ?? 0) + 1)
      const d = days.get(dayStart(e.spent_at))
      if (d) {
        d.totalSatang += e.amount_satang
        d.count++
      }
    }
    const salesSatang = can(actor, 'reports:view')
      ? (this.db.prepare(`SELECT ifnull(sum(total_satang), 0) FROM bills WHERE branch_id = ? AND status = 'paid' AND created_at >= ? AND created_at < ?`).pluck().get(actor.branchId, from, to) as number)
      : null
    return {
      from,
      to,
      totalSatang: sum.totalSatang,
      count: list.length,
      inputVatSatang: sum.inputVatSatang,
      bySource: sum.bySource,
      categories: sum.byCategory.map((c) => ({ ...c, count: counts.get(c.categoryId) ?? 0 })),
      days: [...days.values()],
      salesSatang,
    }
  }

  /** COGS = lot costs taken for paid bills (incl. shortages settled later from new lots). */
  profitReport(actor: Actor, from: number, to: number): ProfitReportDto {
    const items = this.db
      .prepare(
        `SELECT i.id, i.product_name, i.qty, i.line_total_satang, b.vat_satang, b.total_satang
         FROM bill_items i JOIN bills b ON b.id = i.bill_id
         WHERE b.branch_id = ? AND b.status = 'paid' AND b.created_at >= ? AND b.created_at < ?`,
      )
      .all(actor.branchId, from, to) as { id: string; product_name: string; qty: number; line_total_satang: number; vat_satang: number; total_satang: number }[]
    const costStmt = this.db.prepare(
      `SELECT ifnull(-sum(cost_satang), 0) FROM stock_ledger
       WHERE reason = 'sale' AND ((ref_type = 'bill_item' AND ref_id = @id)
         OR (ref_type = 'stock_shortage' AND ref_id IN (SELECT id FROM stock_shortages WHERE ref_type = 'bill_item' AND ref_id = @id)))`,
    )
    const byProduct = new Map<string, { name: string; qty: number; netSatang: number; cogsSatang: number; profitSatang: number }>()
    let netSales = 0
    let cogs = 0
    for (const i of items) {
      const vatShare = i.total_satang > 0 ? mulDivHalfUp(i.line_total_satang, i.vat_satang, i.total_satang) : 0
      const net = i.line_total_satang - vatShare
      const cost = costStmt.pluck().get({ id: i.id }) as number
      const e = byProduct.get(i.product_name) ?? { name: i.product_name, qty: 0, netSatang: 0, cogsSatang: 0, profitSatang: 0 }
      e.qty += i.qty
      e.netSatang += net
      e.cogsSatang += cost
      e.profitSatang = e.netSatang - e.cogsSatang
      byProduct.set(i.product_name, e)
      netSales += net
      cogs += cost
    }
    // bill-level VAT rounding: make the product nets add up to the bills' net exactly
    const billsNet = this.db
      .prepare(`SELECT ifnull(sum(total_satang - vat_satang), 0) FROM bills WHERE branch_id = ? AND status = 'paid' AND created_at >= ? AND created_at < ?`)
      .pluck()
      .get(actor.branchId, from, to) as number
    netSales = billsNet
    const profit = netSales - cogs
    return {
      from,
      to,
      netSalesSatang: netSales,
      cogsSatang: cogs,
      grossProfitSatang: profit,
      marginBp: netSales > 0 ? mulDivHalfUp(profit, 10_000, netSales) : null,
      wasteSatang: this.stockOps.wasteSummary(actor, from, to).totalSatang,
      products: [...byProduct.values()].sort((a, b) => b.profitSatang - a.profitSatang),
    }
  }

  zList(actor: Actor, from: number, to: number): ZListItemDto[] {
    const rows = this.db.prepare('SELECT * FROM shifts WHERE branch_id = ? AND opened_at >= ? AND opened_at < ? ORDER BY opened_at DESC').all(actor.branchId, from, to) as Parameters<ShiftService['summary']>[0][]
    return rows.map((r) => {
      const s = this.shifts.summary(r)
      return { shiftId: s.id, shiftNo: s.shiftNo, openedAt: s.openedAt, closedAt: s.closedAt, openedByName: s.openedByName, totalSalesSatang: s.totalSalesSatang, expectedCashSatang: s.expectedCashSatang, countedCashSatang: s.countedCashSatang, overShortSatang: s.overShortSatang }
    })
  }

  /** CSV (UTF-8 with BOM so Excel shows Thai correctly). */
  exportCsv(actor: Actor, report: ParsedInput<'reports.export'>['report'], from: number, to: number): { name: string; content: string } {
    const money = (s: number) => formatBaht(s).replace(/,/g, '')
    const cell = (v: string | number) => {
      const s = String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const dt = (ms: number) => {
      const d = bkk(ms)
      return `${d.getUTCFullYear() + 543}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    }
    let rows: (string | number)[][]
    if (report === 'sales') {
      const bills = this.db
        .prepare(
          `SELECT b.bill_no, b.created_at, b.status, b.order_type, b.channel, b.ext_order_id, b.subtotal_satang, b.discount_satang, b.vat_satang, b.total_satang,
             ifnull(b.commission_satang, 0) AS commission, (SELECT method FROM payments p WHERE p.bill_id = b.id LIMIT 1) AS method
           FROM bills b WHERE b.branch_id = ? AND b.created_at >= ? AND b.created_at < ? ORDER BY b.created_at`,
        )
        .all(actor.branchId, from, to) as Record<string, string | number | null>[]
      rows = [
        ['เลขที่บิล', 'วันที่เวลา', 'สถานะ', 'ประเภท', 'ค่าย', 'Order ID', 'ยอดก่อนส่วนลด', 'ส่วนลด', 'VAT', 'ยอดสุทธิ', 'ค่าคอมมิชชัน', 'ชำระด้วย'],
        ...bills.map((b) => [b['bill_no']!, dt(b['created_at'] as number), b['status']!, b['order_type']!, b['channel'] ?? '', b['ext_order_id'] ?? '', money(b['subtotal_satang'] as number), money(b['discount_satang'] as number), money(b['vat_satang'] as number), money(b['total_satang'] as number), money(b['commission'] as number), b['method'] ?? '']),
      ]
    } else if (report === 'sales_summary') {
      const r = this.salesSummary(actor, from, to)
      const day = (ms: number) => dt(ms).slice(0, 10)
      const line = (label: string, x: SalesSummaryRowDto) => [label, x.billCount, money(x.grossSatang), money(x.discountSatang), money(x.totalSatang), money(x.vatSatang), money(x.netSatang), money(x.commissionSatang), ...r.methodKeys.map((m) => money(x.methods[m] ?? 0)), x.voidCount, x.refundCount, money(x.refundSatang)]
      rows = [
        ['วันที่', 'จำนวนบิล', 'ยอดก่อนส่วนลด', 'ส่วนลด', 'ยอดขาย', 'VAT', 'ยอดก่อน VAT', 'ค่าคอมมิชชัน', ...r.methodKeys.map((m) => METHOD_TH[m] ?? m), 'บิลยกเลิก', 'บิลคืนเงิน', 'ยอดคืนเงิน'],
        ...r.days.map((d) => line(day(d.start), d)),
        line('รวม', r.total),
      ]
    } else if (report === 'expiry') {
      const lots = this.stockOps.expiring(actor, Math.min(60, Math.max(0, Math.round((to - this.now()) / DAY))))
      rows = [['วัตถุดิบ', 'ล็อต', 'คงเหลือ', 'หน่วย', 'มูลค่า', 'หมดอายุ', 'เหลือ (วัน)'], ...lots.map((l) => [l.ingredientName, l.lotNo ?? '', l.qtyRemainingMilli / 1000, l.baseUnit, money(l.valueSatang), dt(l.expiresAt).slice(0, 10), Math.floor((dayStart(l.expiresAt) - dayStart(this.now())) / DAY)])]
    } else if (report === 'profit') {
      const p = this.profitReport(actor, from, to)
      rows = [['สินค้า', 'จำนวน', 'ยอดขายก่อน VAT', 'ต้นทุนวัตถุดิบ', 'กำไรขั้นต้น'], ...p.products.map((r) => [r.name, r.qty, money(r.netSatang), money(r.cogsSatang), money(r.profitSatang)])]
    } else if (report === 'waste') {
      const list = this.db.prepare('SELECT * FROM waste_records WHERE branch_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at').all(actor.branchId, from, to) as Record<string, string | number | null>[]
      rows = [['เลขที่', 'วันที่เวลา', 'ประเภท', 'เหตุผล', 'มูลค่า', 'ยกเลิก'], ...list.map((w) => [w['waste_no']!, dt(w['created_at'] as number), w['kind']!, w['reason']!, money(w['value_satang'] as number), w['voided_at'] ? 'Y' : ''])]
    } else if (report === 'expenses') {
      const items = []
      for (let page = 1; ; page++) {
        const r = this.expenses.list(actor, { page, pageSize: 50, from, to })
        items.push(...r.items)
        if (items.length >= r.total || !r.items.length) break
      }
      rows = [['เลขที่', 'วันที่', 'หมวด', 'รายการ', 'จ่ายจาก', 'จำนวนเงิน', 'VAT ซื้อ', 'ยกเลิก'], ...items.map((e) => [e.expenseNo, dt(e.spentAt), e.categoryName, e.description ?? '', e.source, money(e.amountSatang), money(e.hasTaxInvoice ? e.vatSatang : 0), e.voided ? 'Y' : ''])]
    } else {
      const list = this.taxList(actor, from, to)
      rows = [['เลขที่', 'ชนิด', 'วันที่', 'อ้างอิงบิล', 'ผู้ซื้อ', 'เลขผู้เสียภาษีผู้ซื้อ', 'มูลค่าก่อนภาษี', 'VAT', 'รวม', 'ยกเลิก'], ...list.map((i) => [i.invoiceNo, i.type, dt(i.issuedAt), i.billNo, i.customerName ?? '', i.customerTaxId ?? '', money(i.totalSatang - i.vatSatang), money(i.vatSatang), money(i.totalSatang), i.cancelled ? 'Y' : ''])]
    }
    this.audit.append({ action: 'reports.export', permission: 'reports:export', userId: actor.userId, branchId: actor.branchId, entity: 'reports', entityId: report, after: { from, to, rows: rows.length - 1 } })
    const d = bkk(this.now())
    return { name: `kposs-${report}-${d.getUTCFullYear() + 543}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.csv`, content: '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n' }
  }

  // ===========================================================================
  // tax invoices (D19, D20) — formats must be reviewed by an accountant
  // ===========================================================================

  private seller() {
    return {
      name: this.settings.get('tax.seller_name'),
      taxId: this.settings.get('tax.seller_tax_id'),
      branch: this.settings.get('tax.seller_branch'),
      address: this.settings.get('tax.seller_address'),
      vatRateBp: this.settings.get('vat.rate_bp'),
      paperMm: this.settings.get('receipt.paper_mm'),
    }
  }

  taxList(actor: Actor, from: number, to: number, billId?: string): TaxInvoiceDto[] {
    const ids = (
      billId
        ? this.db.prepare('SELECT id FROM tax_invoices WHERE branch_id = ? AND bill_id = ? ORDER BY issued_at DESC').pluck().all(actor.branchId, billId)
        : this.db.prepare('SELECT id FROM tax_invoices WHERE branch_id = ? AND issued_at >= ? AND issued_at < ? ORDER BY issued_at DESC').pluck().all(actor.branchId, from, to)
    ) as string[]
    return ids.map((id) => this.taxDto(id))
  }

  private taxDto(id: string): TaxInvoiceDto {
    const r = this.db
      .prepare(
        `SELECT t.*, b.bill_no, b.total_satang, b.vat_satang, u.display_name AS by_name, (SELECT invoice_no FROM tax_invoices o WHERE o.id = t.replaces_id) AS replaces_no
         FROM tax_invoices t JOIN bills b ON b.id = t.bill_id JOIN users u ON u.id = t.issued_by WHERE t.id = ?`,
      )
      .get(id) as Record<string, string | number | null>
    return {
      id: r['id'] as string,
      type: r['type'] as TaxInvoiceDto['type'],
      invoiceNo: r['invoice_no'] as string,
      billId: r['bill_id'] as string,
      billNo: r['bill_no'] as string,
      issuedAt: r['issued_at'] as number,
      issuedByName: r['by_name'] as string,
      customerName: r['customer_name'] as string | null,
      customerTaxId: r['customer_tax_id'] as string | null,
      customerBranch: r['customer_branch'] as string | null,
      customerAddress: r['customer_address'] as string | null,
      totalSatang: r['total_satang'] as number,
      vatSatang: r['vat_satang'] as number,
      cancelled: r['cancelled_at'] !== null,
      cancelReason: r['cancel_reason'] as string | null,
      replacesNo: r['replaces_no'] as string | null,
    }
  }

  issueTax(actor: Actor, input: ParsedInput<'tax.issue'>): TaxInvoiceDto {
    const s = this.seller()
    if (!s.name || !s.address || !isValidThaiTaxId(s.taxId)) throw new AppError('TAX_NOT_CONFIGURED', { reason: 'seller' })
    if (input.type === 'full' && !isValidThaiTaxId(input.customer.taxId)) throw new AppError('INVALID_INPUT', { fields: { 'customer.taxId': ['checksum'] } })
    const at = this.now()
    const id = uuidv7(at)
    this.db.transaction(() => {
      const bill = this.db.prepare('SELECT * FROM bills WHERE id = ? AND branch_id = ?').get(input.billId, actor.branchId) as { id: string; status: string; vat_mode: string; bill_no: string } | undefined
      if (!bill) throw new AppError('NOT_FOUND')
      if (bill.status !== 'paid') throw new AppError('NOT_EDITABLE', { status: bill.status })
      if (bill.vat_mode !== 'inclusive') throw new AppError('TAX_NOT_CONFIGURED', { reason: 'no_vat' })
      const active = this.db.prepare('SELECT id FROM tax_invoices WHERE bill_id = ? AND type = ? AND cancelled_at IS NULL').get(bill.id, input.type)
      if (active) throw new AppError('TAX_INVOICE_EXISTS')
      if (input.replacesId) {
        const old = this.db.prepare('SELECT bill_id, cancelled_at FROM tax_invoices WHERE id = ?').get(input.replacesId) as { bill_id: string; cancelled_at: number | null } | undefined
        if (!old || old.bill_id !== bill.id || old.cancelled_at === null) throw new AppError('INVALID_INPUT', { fields: { replacesId: ['must_be_cancelled_same_bill'] } })
      }
      const c = input.type === 'full' ? input.customer : null
      const invoiceNo = this.docs.nextTaxNo(actor.branchId, input.type, at)
      this.db
        .prepare(
          `INSERT INTO tax_invoices (id, branch_id, bill_id, type, invoice_no, customer_name, customer_tax_id, customer_branch, customer_address, replaces_id, issued_by, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, actor.branchId, bill.id, input.type, invoiceNo, c?.name ?? null, c ? c.taxId.replace(/\D/g, '') : null, c?.branch ?? null, c?.address ?? null, input.replacesId, actor.userId, at)
      this.sales.repo.insertEvent({ id: uuidv7(at), bill_id: bill.id, event: 'tax_invoice', user_id: actor.userId, approved_by: null, reason: null, data_json: JSON.stringify({ invoiceNo, type: input.type }), device_id: null, created_at: at })
      this.audit.append({ action: 'tax.issue', permission: 'orders:tax_invoice', userId: actor.userId, branchId: actor.branchId, entity: 'tax_invoices', entityId: id, after: { invoiceNo, billNo: bill.bill_no, type: input.type, customer: c }, risk: 'medium' })
    }).immediate()
    return this.taxDto(id)
  }

  cancelTax(actor: Actor, id: string, reason: string): TaxInvoiceDto {
    const at = this.now()
    this.db.transaction(() => {
      const r = this.db.prepare('UPDATE tax_invoices SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ? AND branch_id = ? AND cancelled_at IS NULL').run(at, actor.userId, reason, id, actor.branchId)
      if (!r.changes) throw new AppError('NOT_EDITABLE')
      this.audit.append({ action: 'tax.cancel', permission: 'orders:tax_invoice', userId: actor.userId, branchId: actor.branchId, entity: 'tax_invoices', entityId: id, reason, risk: 'high' })
    }).immediate()
    return this.taxDto(id)
  }

  taxHtml(actor: Actor, id: string): { html: string; paper: 'a4' | 'receipt' } {
    const inv = this.taxDto(id)
    const bill = this.sales.get(actor, inv.billId)
    return { html: renderTaxInvoice(inv, bill, this.seller()), paper: inv.type === 'full' ? 'a4' : 'receipt' }
  }
}
