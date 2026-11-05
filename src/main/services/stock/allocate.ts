import { mulDivHalfUp } from '@shared/money'

export interface LotForAllocation {
  id: string
  qtyReceivedMilli: number
  qtyRemainingMilli: number
  totalCostSatang: number
  receivedAt: number
  expiresAt: number | null
}

export interface LotTake {
  lotId: string
  qtyMilli: number
  costSatang: number
}

/**
 * FEFO for ingredients with an expiry date (earliest expiry first, lots without a date last),
 * FIFO otherwise (earliest received first). Ties break on id for determinism. — Implement.md §6.1
 */
export function sortLots<T extends Pick<LotForAllocation, 'id' | 'receivedAt' | 'expiresAt'>>(lots: readonly T[], fefo: boolean): T[] {
  return [...lots].sort((a, b) => {
    if (fefo) {
      const ea = a.expiresAt ?? Number.POSITIVE_INFINITY
      const eb = b.expiresAt ?? Number.POSITIVE_INFINITY
      if (ea !== eb) return ea - eb
    }
    if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Cost consumed so far from a lot (D4): round(total × used / received).
 * Costing a take as the difference keeps a fully consumed lot at exactly its total cost.
 */
export function consumedCost(lot: Pick<LotForAllocation, 'qtyReceivedMilli' | 'totalCostSatang'>, remainingMilli: number): number {
  return mulDivHalfUp(lot.totalCostSatang, lot.qtyReceivedMilli - remainingMilli, lot.qtyReceivedMilli)
}

/** Picks lots for `neededMilli`; whatever the lots cannot cover is returned as a shortage (D16). */
export function allocateFromLots(lots: readonly LotForAllocation[], neededMilli: number, fefo: boolean): { takes: LotTake[]; shortageMilli: number } {
  let left = neededMilli
  const takes: LotTake[] = []
  for (const lot of sortLots(lots, fefo)) {
    if (left <= 0) break
    if (lot.qtyRemainingMilli <= 0) continue
    const qty = Math.min(left, lot.qtyRemainingMilli)
    const after = lot.qtyRemainingMilli - qty
    takes.push({ lotId: lot.id, qtyMilli: qty, costSatang: consumedCost(lot, after) - consumedCost(lot, lot.qtyRemainingMilli) })
    left -= qty
  }
  return { takes, shortageMilli: Math.max(0, left) }
}
