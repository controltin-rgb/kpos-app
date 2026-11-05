/**
 * Bill numbers (docs/decisions.md D14):
 *   prefix = branch letter (A, B, C … by the order branches were recorded)
 *   none    → A-000001
 *   daily   → A-691105-0001   (Buddhist year, Asia/Bangkok)
 *   monthly → A-6911-0001
 *   yearly  → A-69-000001
 */

export const BILL_RESET_POLICIES = ['none', 'daily', 'monthly', 'yearly'] as const
export type BillResetPolicy = (typeof BILL_RESET_POLICIES)[number]

export const DEFAULT_BILL_RESET: BillResetPolicy = 'none'

/** 0 → A, 25 → Z, 26 → AA … */
export function branchLetter(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('index must be >= 0')
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

const bkk = new Intl.DateTimeFormat('en-US-u-ca-buddhist', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Asia/Bangkok',
})

/** Local Bangkok date with a 2-digit Buddhist year. */
export function bangkokDateParts(ms: number): { yy: string; mm: string; dd: string } {
  const p = Object.fromEntries(bkk.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  const year = String(p['year']).replace(/\D/g, '')
  return { yy: year.slice(-2), mm: String(p['month']), dd: String(p['day']) }
}

/** Counter key for the reset period ('' = never resets). */
export function periodKey(policy: BillResetPolicy, ms: number): string {
  if (policy === 'none') return ''
  const { yy, mm, dd } = bangkokDateParts(ms)
  if (policy === 'daily') return `${yy}${mm}${dd}`
  if (policy === 'monthly') return `${yy}${mm}`
  return yy
}

export function formatBillNo(prefix: string, policy: BillResetPolicy, period: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError('seq must be >= 1')
  const pad = policy === 'daily' || policy === 'monthly' ? 4 : 6
  const n = String(seq).padStart(pad, '0')
  return policy === 'none' ? `${prefix}-${n}` : `${prefix}-${period}-${n}`
}
