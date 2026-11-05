/**
 * Money utilities. All amounts are integer satang (1 baht = 100 satang) — never floats (CLAUDE.md rule 1).
 * Percentages/rates are integer basis points (1% = 100 bp).
 *
 * VAT rounding follows คำสั่งกรมสรรพากร ที่ ป. 86/2542 ข้อ 4(6) (docs/decisions.md D9):
 * look at the 3rd decimal of the baht amount — below 5 drop it, 5 or more round up.
 * In satang this is "round half up" to an integer, applied ONCE per bill / tax invoice.
 * ⚠ ต้องให้นักบัญชีตรวจก่อนใช้งานจริง
 */

export type Satang = number

/** Default VAT rate: 7% in basis points. Configurable via settings. */
export const DEFAULT_VAT_RATE_BP = 700

const BP_DENOMINATOR = 10_000

export function assertSatang(value: number, name = 'amount'): asserts value is Satang {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be an integer number of satang, got ${value}`)
}

function assertBp(value: number, name = 'rate'): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer bp`)
}

/**
 * Integer division rounded half up (away from zero for negatives, so refunds mirror sales).
 * Uses BigInt internally so intermediate products never lose precision.
 */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator)) throw new RangeError('numerator must be a safe integer')
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new RangeError('denominator must be > 0')
  const n = BigInt(Math.abs(numerator))
  const d = BigInt(denominator)
  const q = (n * 2n + d) / (d * 2n)
  const result = Number(q)
  return numerator < 0 ? -result : result
}

/** a × b / d, rounded half up, without intermediate overflow. */
export function mulDivHalfUp(a: number, b: number, d: number): number {
  const product = BigInt(a) * BigInt(b)
  const neg = product < 0n
  const abs = neg ? -product : product
  const dd = BigInt(d)
  const q = Number((abs * 2n + dd) / (dd * 2n))
  return neg ? -q : q
}

export interface VatBreakdown {
  /** value before VAT */
  net: Satang
  vat: Satang
  /** amount the customer pays */
  total: Satang
}

/** Price already includes VAT: VAT = total × rate / (1 + rate). */
export function vatInclusive(total: Satang, rateBp: number = DEFAULT_VAT_RATE_BP): VatBreakdown {
  assertSatang(total, 'total')
  assertBp(rateBp)
  const vat = mulDivHalfUp(total, rateBp, BP_DENOMINATOR + rateBp)
  return { net: total - vat, vat, total }
}

/** Price excludes VAT: VAT = net × rate. */
export function vatExclusive(net: Satang, rateBp: number = DEFAULT_VAT_RATE_BP): VatBreakdown {
  assertSatang(net, 'net')
  assertBp(rateBp)
  const vat = mulDivHalfUp(net, rateBp, BP_DENOMINATOR)
  return { net, vat, total: net + vat }
}

/** amount × bp / 10000, rounded half up (discounts, delivery commission, …). */
export function percentOfSatang(amount: Satang, bp: number): Satang {
  assertSatang(amount)
  assertBp(bp, 'bp')
  return mulDivHalfUp(amount, bp, BP_DENOMINATOR)
}

/**
 * Splits `amount` across `weights` so the parts sum exactly to `amount`
 * (largest remainder; ties go to the earliest index). Used to spread bill-level discounts over lines.
 */
export function allocateSatang(amount: Satang, weights: readonly number[]): Satang[] {
  assertSatang(amount)
  weights.forEach((w) => {
    if (!Number.isSafeInteger(w) || w < 0) throw new RangeError('weights must be non-negative integers')
  })
  if (amount === 0) return weights.map(() => 0)
  const total = weights.reduce((s, w) => s + w, 0)
  if (total === 0) throw new RangeError('cannot allocate a non-zero amount over zero weights')

  const sign = amount < 0 ? -1n : 1n
  const abs = BigInt(Math.abs(amount))
  const T = BigInt(total)
  const parts = weights.map((w) => (abs * BigInt(w)) / T)
  const rema = weights.map((w, i) => ({ i, r: (abs * BigInt(w)) % T }))
  let left = abs - parts.reduce((s, p) => s + p, 0n)
  rema.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  for (const { i } of rema) {
    if (left === 0n) break
    parts[i]! += 1n
    left--
  }
  return parts.map((p) => Number(p * sign))
}

const BAHT_RE = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

/** Parses user input like "1,234.5" into satang using string arithmetic only (no float). */
export function bahtToSatang(input: string): Satang {
  const m = BAHT_RE.exec(input.trim())
  if (!m) throw new RangeError(`invalid baht amount: ${JSON.stringify(input)}`)
  const [, minus, intPart, frac = ''] = m
  const satang = Number(intPart!.replace(/,/g, '')) * 100 + Number(frac.padEnd(2, '0'))
  assertSatang(satang)
  return minus ? -satang : satang
}

/** Formats satang as baht for display: 123405 → "1,234.05". */
export function formatBaht(satang: Satang, opts: { symbol?: boolean } = {}): string {
  assertSatang(satang)
  const abs = Math.abs(satang)
  const baht = Math.floor(abs / 100)
  const st = String(abs % 100).padStart(2, '0')
  const intStr = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${satang < 0 ? '-' : ''}${opts.symbol ? '฿' : ''}${intStr}.${st}`
}
