import type { Satang } from './money'

/** Thai banknotes and coins, in satang (largest first). */
export const DENOMINATIONS_SATANG = [100_000, 50_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 25] as const

export interface DenominationCount {
  denominationSatang: number
  count: number
}

const KNOWN: ReadonlySet<number> = new Set(DENOMINATIONS_SATANG)

/** Total cash counted in the drawer. */
export function countedTotal(counts: readonly DenominationCount[]): Satang {
  let sum = 0
  for (const c of counts) {
    if (!KNOWN.has(c.denominationSatang)) throw new RangeError(`unknown denomination ${c.denominationSatang}`)
    if (!Number.isSafeInteger(c.count) || c.count < 0) throw new RangeError('count must be a non-negative integer')
    sum += c.denominationSatang * c.count
  }
  return sum
}
