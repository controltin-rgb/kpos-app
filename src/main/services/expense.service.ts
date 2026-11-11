import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import type { ParsedInput } from '@shared/api'
import type { ExpenseCategoryDto, ExpenseDto, ExpenseSource, ExpenseSummaryDto } from '@shared/api-expenses'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import type { AuditService } from './audit.service'
import type { DocNumberService } from './doc-number.service'
import type { ShiftService } from './shift.service'

/** Default categories from docs/design/Expenses.dc.html. */
export const DEFAULT_EXPENSE_CATEGORIES = ['วัตถุดิบ', 'ค่าสาธารณูปโภค', 'ค่าเช่า', 'เงินเดือน', 'ซ่อมบำรุง', 'อื่นๆ']

const RECEIPT_RE = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$/
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' }

interface ExpenseRow {
  id: string
  branch_id: string
  expense_no: string
  category_id: string
  amount_satang: number
  vat_satang: number
  source: ExpenseSource
  has_tax_invoice: 0 | 1
  vendor: string | null
  description: string | null
  receipt_path: string | null
  shift_id: string | null
  spent_at: number
  created_by: string
  created_at: number
  voided_at: number | null
  voided_by: string | null
  void_reason: string | null
}

/**
 * Expenses (Implement.md §6.6). Drawer expenses write a negative 'expense' row into the cash ledger of
 * the shift open on this device, so they lower the expected cash at shift close (§6.5).
 * Recorded expenses are never edited: a mistake is voided with a reason (reversal row) and re-entered.
 */
export class ExpenseService {
  constructor(
    private readonly db: Db,
    private readonly shifts: ShiftService,
    private readonly docs: DocNumberService,
    private readonly audit: AuditService,
    private readonly receiptsDir: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  categories(actor: Actor): ExpenseCategoryDto[] {
    const list = () =>
      this.db.prepare('SELECT id, name, icon FROM expense_categories WHERE branch_id = ? AND deleted_at IS NULL ORDER BY sort_order, name').all(actor.branchId) as ExpenseCategoryDto[]
    let rows = list()
    if (!rows.length) {
      const at = this.now()
      this.db.transaction(() => {
        DEFAULT_EXPENSE_CATEGORIES.forEach((name, i) =>
          this.db.prepare('INSERT INTO expense_categories (id, branch_id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(uuidv7(at), actor.branchId, name, i, at, at),
        )
      }).immediate()
      rows = list()
    }
    return rows
  }

  saveCategory(actor: Actor, input: ParsedInput<'expenses.saveCategory'>): ExpenseCategoryDto {
    const at = this.now()
    let id = input.id
    this.db.transaction(() => {
      if (id) {
        const r = this.db.prepare('UPDATE expense_categories SET name = ?, icon = ?, updated_at = ?, rev = rev + 1 WHERE id = ? AND branch_id = ?').run(input.name, input.icon ?? null, at, id, actor.branchId)
        if (!r.changes) throw new AppError('NOT_FOUND')
      } else {
        id = uuidv7(at)
        this.db.prepare('INSERT INTO expense_categories (id, branch_id, name, icon, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 99, ?, ?)').run(id, actor.branchId, input.name, input.icon ?? null, at, at)
      }
      this.audit.append({ action: 'expenses.category_save', permission: 'expenses:update', userId: actor.userId, branchId: actor.branchId, entity: 'expense_categories', entityId: id, after: { name: input.name } })
    }).immediate()
    return this.categories(actor).find((c) => c.id === id)!
  }

  create(actor: Actor, input: ParsedInput<'expenses.create'>): ExpenseDto {
    if (input.vatSatang > input.amountSatang) throw new AppError('INVALID_INPUT', { fields: { vatSatang: ['too_big'] } })
    if (input.receiptFile && (!RECEIPT_RE.test(input.receiptFile) || !this.receiptPath(input.receiptFile))) throw new AppError('INVALID_INPUT', { fields: { receiptFile: ['invalid'] } })
    const cat = this.db.prepare('SELECT id FROM expense_categories WHERE id = ? AND branch_id = ? AND deleted_at IS NULL').get(input.categoryId, actor.branchId)
    if (!cat) throw new AppError('NOT_FOUND', { entity: 'expense_categories' })
    const at = this.now()
    const id = uuidv7(at)
    this.db.transaction(() => {
      let shiftId: string | null = null
      if (input.source === 'drawer') {
        if (!this.shifts.drawerEnabled()) throw new AppError('FEATURE_NOT_LICENSED', { feature: 'drawerShift' })
        const shift = this.shifts.requireOpen()
        if (this.shifts.expected(shift.id) < input.amountSatang) throw new AppError('PAYMENT_INVALID', { reason: 'drawer_insufficient' })
        shiftId = shift.id
        this.shifts.repo.insertCash({
          id: uuidv7(at),
          branch_id: actor.branchId,
          shift_id: shift.id,
          kind: 'expense',
          amount_satang: -input.amountSatang,
          ref_type: 'expense',
          ref_id: id,
          reverses_id: null,
          note: input.description,
          user_id: actor.userId,
          device_id: shift.device_id,
          created_at: at,
        })
      }
      this.db
        .prepare(
          `INSERT INTO expenses (id, branch_id, expense_no, category_id, amount_satang, vat_satang, source, has_tax_invoice, vendor,
             description, receipt_path, shift_id, spent_at, created_by, created_at)
           VALUES (@id, @branch_id, @expense_no, @category_id, @amount_satang, @vat_satang, @source, @has_tax_invoice, @vendor,
             @description, @receipt_path, @shift_id, @spent_at, @created_by, @created_at)`,
        )
        .run({
          id,
          branch_id: actor.branchId,
          expense_no: this.docs.nextDocNo(actor.branchId, 'E', at),
          category_id: input.categoryId,
          amount_satang: input.amountSatang,
          vat_satang: input.vatSatang,
          source: input.source,
          has_tax_invoice: input.hasTaxInvoice ? 1 : 0,
          vendor: input.vendor ?? null,
          description: input.description,
          receipt_path: input.receiptFile ?? null,
          shift_id: shiftId,
          spent_at: input.spentAt ?? at,
          created_by: actor.userId,
          created_at: at,
        })
      this.audit.append({ action: 'expenses.create', permission: 'expenses:create', userId: actor.userId, branchId: actor.branchId, entity: 'expenses', entityId: id, after: { ...input }, risk: 'low' })
    }).immediate()
    return this.get(id)
  }

  void(actor: Actor, id: string, reason: string): ExpenseDto {
    const at = this.now()
    this.db.transaction(() => {
      const e = this.row(id)
      if (!e || e.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
      if (e.voided_at) throw new AppError('NOT_EDITABLE')
      if (e.source === 'drawer') {
        const orig = this.shifts.repo.cashFor('expense', id)[0]
        if (orig) {
          // money goes back into the drawer of the original shift if still open, else of the current shift
          const original = this.shifts.repo.shift(orig.shift_id)
          const target = original?.status === 'open' ? original : this.shifts.requireOpen()
          this.shifts.repo.insertCash({
            id: uuidv7(at),
            branch_id: e.branch_id,
            shift_id: target.id,
            kind: 'expense_reversal',
            amount_satang: -orig.amount_satang,
            ref_type: 'expense',
            ref_id: id,
            reverses_id: orig.id,
            note: reason,
            user_id: actor.userId,
            device_id: target.device_id,
            created_at: at,
          })
        }
      }
      this.db.prepare('UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(at, actor.userId, reason, id)
      this.audit.append({ action: 'expenses.void', permission: 'expenses:update', userId: actor.userId, branchId: actor.branchId, entity: 'expenses', entityId: id, before: { amountSatang: e.amount_satang, source: e.source }, reason, risk: 'high' })
    }).immediate()
    return this.get(id)
  }

  list(actor: Actor, q: ParsedInput<'expenses.list'>) {
    const where = ['e.branch_id = @b']
    if (q.categoryId) where.push('e.category_id = @c')
    if (q.source) where.push('e.source = @s')
    if (q.from !== undefined) where.push('e.spent_at >= @from')
    if (q.to !== undefined) where.push('e.spent_at < @to')
    const p = { b: actor.branchId, c: q.categoryId ?? null, s: q.source ?? null, from: q.from ?? null, to: q.to ?? null, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }
    const w = where.join(' AND ')
    const ids = this.db.prepare(`SELECT id FROM expenses e WHERE ${w} ORDER BY e.spent_at DESC, e.expense_no DESC LIMIT @limit OFFSET @offset`).pluck().all(p) as string[]
    return { items: ids.map((id) => this.get(id)), total: this.db.prepare(`SELECT count(*) FROM expenses e WHERE ${w}`).pluck().get(p) as number }
  }

  summary(actor: Actor, from: number, to: number): ExpenseSummaryDto {
    const rows = this.db
      .prepare(
        `SELECT e.category_id, c.name, e.source, sum(e.amount_satang) AS total, sum(e.vat_satang * e.has_tax_invoice) AS vat
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
         WHERE e.branch_id = ? AND e.voided_at IS NULL AND e.spent_at >= ? AND e.spent_at < ?
         GROUP BY e.category_id, e.source`,
      )
      .all(actor.branchId, from, to) as { category_id: string; name: string; source: ExpenseSource; total: number; vat: number }[]
    const byCat = new Map<string, { categoryId: string; name: string; totalSatang: number }>()
    const bySource: Record<ExpenseSource, number> = { drawer: 0, petty_cash: 0, bank: 0 }
    let vat = 0
    for (const r of rows) {
      const c = byCat.get(r.category_id) ?? { categoryId: r.category_id, name: r.name, totalSatang: 0 }
      c.totalSatang += r.total
      byCat.set(r.category_id, c)
      bySource[r.source] += r.total
      vat += r.vat
    }
    const byCategory = [...byCat.values()].sort((a, b) => b.totalSatang - a.totalSatang)
    return { totalSatang: byCategory.reduce((s, c) => s + c.totalSatang, 0), byCategory, bySource, inputVatSatang: vat }
  }

  /** Copies a picked file into userData/receipts under a random name; returns that name. */
  storeReceipt(sourcePath: string): string {
    if (!this.receiptsDir) throw new AppError('INTERNAL')
    const ext = extname(sourcePath).toLowerCase()
    if (!MIME[ext]) throw new AppError('INVALID_INPUT', { fields: { receiptFile: ['type'] } })
    mkdirSync(this.receiptsDir, { recursive: true })
    const name = `${uuidv7()}${ext}`
    copyFileSync(sourcePath, join(this.receiptsDir, name))
    return name
  }

  /** Same as storeReceipt for an image uploaded by a LAN Client (picked on that machine). */
  storeReceiptBytes(ext: string, data: Buffer): string {
    if (!this.receiptsDir) throw new AppError('INTERNAL')
    const e = ext.toLowerCase()
    if (!MIME[e] || e === '.pdf') throw new AppError('INVALID_INPUT', { fields: { receiptFile: ['type'] } })
    mkdirSync(this.receiptsDir, { recursive: true })
    const name = `${uuidv7()}${e}`
    writeFileSync(join(this.receiptsDir, name), data)
    return name
  }

  receiptDataUrl(actor: Actor, id: string): string | null {
    const e = this.row(id)
    if (!e || e.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    if (!e.receipt_path) return null
    const file = this.receiptPath(e.receipt_path)
    if (!file) return null
    return `data:${MIME[extname(file).toLowerCase()]};base64,${readFileSync(file).toString('base64')}`
  }

  /** Resolves a stored receipt name inside the receipts folder only (no path traversal). */
  private receiptPath(name: string): string | null {
    if (!this.receiptsDir || !RECEIPT_RE.test(name)) return null
    const file = join(this.receiptsDir, name)
    return existsSync(file) ? file : null
  }

  private row(id: string): ExpenseRow | undefined {
    return this.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseRow | undefined
  }

  private get(id: string): ExpenseDto {
    const e = this.row(id)!
    const cat = this.db.prepare('SELECT name FROM expense_categories WHERE id = ?').pluck().get(e.category_id) as string
    const by = this.db.prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(e.created_by) as string
    return {
      id: e.id,
      expenseNo: e.expense_no,
      categoryId: e.category_id,
      categoryName: cat,
      amountSatang: e.amount_satang,
      vatSatang: e.vat_satang,
      source: e.source,
      hasTaxInvoice: e.has_tax_invoice === 1,
      vendor: e.vendor,
      description: e.description,
      hasReceipt: !!e.receipt_path,
      spentAt: e.spent_at,
      createdByName: by,
      voided: e.voided_at !== null,
      voidReason: e.void_reason,
    }
  }
}
