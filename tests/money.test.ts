import { describe, expect, it } from 'vitest'
import {
  allocateSatang,
  bahtToSatang,
  formatBaht,
  percentOfSatang,
  roundHalfUpDiv,
  vatExclusive,
  vatInclusive,
} from '@shared/money'

describe('roundHalfUpDiv (ป. 86/2542 ข้อ 4(6): look at the 3rd decimal)', () => {
  it('drops the fraction when the 3rd decimal is below 5', () => {
    expect(roundHalfUpDiv(6542, 10)).toBe(654) // 6.542 → 6.54 (example in the order)
    expect(roundHalfUpDiv(6544, 10)).toBe(654) // 6.544 → 6.54
    expect(roundHalfUpDiv(65449, 100)).toBe(654) // 6.5449: 3rd decimal is 4 → drop
  })
  it('rounds up when the 3rd decimal is 5 or more', () => {
    expect(roundHalfUpDiv(11775, 10)).toBe(1178) // 11.775 → 11.78 (example in the order)
    expect(roundHalfUpDiv(6545, 10)).toBe(655) // 6.545 → 6.55
    expect(roundHalfUpDiv(6549, 10)).toBe(655) // 6.549 → 6.55
  })
  it('is symmetric for negatives (refund/credit amounts)', () => {
    expect(roundHalfUpDiv(-11775, 10)).toBe(-1178)
    expect(roundHalfUpDiv(-6542, 10)).toBe(-654)
  })
  it('rejects non-integers and bad divisors', () => {
    expect(() => roundHalfUpDiv(1.5, 10)).toThrow()
    expect(() => roundHalfUpDiv(10, 0)).toThrow()
  })
})

describe('vatInclusive (price includes VAT)', () => {
  it('100.00 baht → VAT 6.54, net 93.46', () => {
    // 10000 × 7 / 107 = 654.205… satang
    expect(vatInclusive(10_000)).toEqual({ net: 9_346, vat: 654, total: 10_000 })
  })
  it('net + vat always equals the total', () => {
    for (let total = 0; total <= 50_000; total += 37) {
      const r = vatInclusive(total)
      expect(r.net + r.vat).toBe(total)
    }
  })
  it('rounds on the 3rd decimal', () => {
    // At 7% an exact .5-satang VAT cannot occur for inclusive prices (14·total is even, 107·odd is odd),
    // so check values just below and above the half.
    expect(vatInclusive(5_350).vat).toBe(350) // 350.000
    expect(vatInclusive(5_357).vat).toBe(350) // 350.457… → 350
    expect(vatInclusive(5_358).vat).toBe(351) // 350.523… → 351
  })
  it('supports a configurable rate (bp) and 0%', () => {
    expect(vatInclusive(10_000, 0)).toEqual({ net: 10_000, vat: 0, total: 10_000 })
    expect(vatInclusive(11_000, 1_000).vat).toBe(1_000)
  })
})

describe('vatExclusive (price excludes VAT)', () => {
  it('100.00 baht → VAT 7.00, total 107.00', () => {
    expect(vatExclusive(10_000)).toEqual({ net: 10_000, vat: 700, total: 10_700 })
  })
  it('167.50 baht → VAT 11.725 → 11.73 (half up)', () => {
    expect(vatExclusive(16_750).vat).toBe(1_173)
  })
  it('168.21 baht → VAT 11.7747 → 11.77', () => {
    expect(vatExclusive(16_821).vat).toBe(1_177)
  })
})

describe('bill-level rounding differs from per-line rounding (D9: bill level)', () => {
  it('computes VAT once from the bill total', () => {
    // three 0.50-baht lines: per line 50×7/107 = 3.27 → 3 each = 9; bill level 150×7/107 = 9.81 → 10
    const lines = [50, 50, 50]
    const perLine = lines.reduce((s, l) => s + vatInclusive(l).vat, 0)
    const billLevel = vatInclusive(lines.reduce((s, l) => s + l, 0)).vat
    expect(perLine).toBe(9)
    expect(billLevel).toBe(10)
  })
})

describe('percentOfSatang', () => {
  it('applies basis points with half-up rounding', () => {
    expect(percentOfSatang(10_000, 1_000)).toBe(1_000) // 10% of 100.00
    expect(percentOfSatang(4_550, 3_000)).toBe(1_365) // 30% GP of 45.50
    expect(percentOfSatang(3_333, 1_500)).toBe(500) // 499.95 → 500
  })
})

describe('allocateSatang', () => {
  it('splits exactly with the largest-remainder method', () => {
    expect(allocateSatang(1_000, [1, 1, 1])).toEqual([334, 333, 333])
    expect(allocateSatang(100, [4_500, 5_500])).toEqual([45, 55])
    const parts = allocateSatang(997, [3, 7, 11, 13])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(997)
  })
  it('handles zero weights', () => {
    expect(allocateSatang(0, [1, 2])).toEqual([0, 0])
    expect(() => allocateSatang(10, [0, 0])).toThrow()
  })
})

describe('bahtToSatang', () => {
  it.each([
    ['45', 4_500],
    ['45.5', 4_550],
    ['45.50', 4_550],
    ['1,234.05', 123_405],
    ['0.01', 1],
    ['-12.30', -1_230],
    [' 7 ', 700],
  ])('%s → %i', (input, expected) => {
    expect(bahtToSatang(input)).toBe(expected)
  })
  it.each(['', '1.234', 'abc', '1..2', '1,2,3.4.5', '.'])('rejects %j', (input) => {
    expect(() => bahtToSatang(input)).toThrow()
  })
  it('never goes through floating point', () => {
    expect(bahtToSatang('0.29')).toBe(29) // 0.29 * 100 = 28.999999999999996 in float
    expect(bahtToSatang('1.13')).toBe(113)
  })
})

describe('formatBaht', () => {
  it('formats with thousands separators and 2 decimals', () => {
    expect(formatBaht(123_405)).toBe('1,234.05')
    expect(formatBaht(1)).toBe('0.01')
    expect(formatBaht(0)).toBe('0.00')
    expect(formatBaht(-1_230)).toBe('-12.30')
    expect(formatBaht(100_000_000)).toBe('1,000,000.00')
  })
  it('can prefix the baht sign', () => {
    expect(formatBaht(4_550, { symbol: true })).toBe('฿45.50')
    expect(formatBaht(-4_550, { symbol: true })).toBe('-฿45.50')
  })
})
