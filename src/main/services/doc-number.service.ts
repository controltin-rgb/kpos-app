import type { Db } from '@main/db/connection'
import { formatBillNo, periodKey, type BillResetPolicy } from '@shared/bill-number'

/**
 * Running document numbers per branch (doc_sequences). Must be called INSIDE the caller's
 * write transaction so a number is consumed only if the document is committed — no gaps
 * from rolled-back sales, no duplicates.
 */
export class DocNumberService {
  private readonly getStmt
  private readonly insertStmt
  private readonly bumpStmt
  private readonly branchCodeStmt

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare('SELECT next_no FROM doc_sequences WHERE branch_id = ? AND doc_type = ?').pluck()
    this.insertStmt = db.prepare(
      `INSERT INTO doc_sequences (branch_id, doc_type, prefix, next_no, updated_at) VALUES (?, ?, ?, 2, ?)`,
    )
    this.bumpStmt = db.prepare('UPDATE doc_sequences SET next_no = next_no + 1, updated_at = ? WHERE branch_id = ? AND doc_type = ?')
    this.branchCodeStmt = db.prepare('SELECT code FROM branches WHERE id = ?').pluck()
  }

  /** Returns the next sequence number for (branch, docType) and advances the counter. */
  next(branchId: string, docType: string, now: number, prefix = ''): number {
    if (!this.db.inTransaction) throw new Error('DocNumberService.next must run inside a transaction')
    const current = this.getStmt.get(branchId, docType) as number | undefined
    if (current === undefined) {
      this.insertStmt.run(branchId, docType, prefix, now)
      return 1
    }
    this.bumpStmt.run(now, branchId, docType)
    return current
  }

  branchCode(branchId: string): string {
    return (this.branchCodeStmt.get(branchId) as string | undefined) ?? 'A'
  }

  /** D14: A-000001 / A-691105-0001 / A-6911-0001 / A-69-000001 */
  nextBillNo(branchId: string, policy: BillResetPolicy, now: number): string {
    const period = periodKey(policy, now)
    const prefix = this.branchCode(branchId)
    const seq = this.next(branchId, period ? `bill:${period}` : 'bill', now, prefix)
    return formatBillNo(prefix, policy, period, seq)
  }

  /** Other documents: <branch>-<TYPE>-000001 (shift S, waste W, …). */
  nextDocNo(branchId: string, type: string, now: number): string {
    const prefix = this.branchCode(branchId)
    return `${prefix}-${type}${String(this.next(branchId, `doc:${type}`, now, prefix)).padStart(6, '0')}`
  }
}
