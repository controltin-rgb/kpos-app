import { describe, expect, it } from 'vitest'
import { allocateFromLots, type LotForAllocation } from '@main/services/stock/allocate'
import { bangkokDateParts, branchLetter, formatBillNo, periodKey } from '@shared/bill-number'
import { requirementPerUnit, scaleRequirement, type RecipeLine } from '@shared/bom'
import { countedTotal, DENOMINATIONS_SATANG } from '@shared/cash'
import { buildPromptPayPayload, crc16 } from '@shared/promptpay'
import { computeBillTotals } from '@shared/sale-totals'

// ---------------------------------------------------------------------------
// Implement.md §6.1 example: ชานมไข่มุก — นมสด / ไข่มุก / แก้ว / ฝา
// ---------------------------------------------------------------------------
const MILK = 'ing-milk'
const PEARL = 'ing-pearl'
const CUP16 = 'ing-cup16'
const CUP22 = 'ing-cup22'
const LID = 'ing-lid'
const SIZE16 = { id: 'size-16', multiplierMilli: 1000 } // base recipe is 16oz
const SIZE22 = { id: 'size-22', multiplierMilli: 1375 } // 22/16

const bubbleTea: RecipeLine[] = [
  { ingredientId: MILK, qtyMilli: 120_000, sizeMode: 'scale' }, // 120 ml at 16oz
  { ingredientId: PEARL, qtyMilli: 50_000, sizeMode: 'scale' }, // 50 g
  { ingredientId: CUP16, qtyMilli: 1_000, sizeMode: 'custom', perSize: { 'size-16': 1_000, 'size-22': 0 } },
  { ingredientId: CUP22, qtyMilli: 1_000, sizeMode: 'custom', perSize: { 'size-16': 0, 'size-22': 1_000 } },
  { ingredientId: LID, qtyMilli: 1_000, sizeMode: 'fixed' }, // 1 lid whatever the size
]

describe('BOM requirement per unit (§6.1)', () => {
  it('16oz uses the base recipe', () => {
    expect(requirementPerUnit(bubbleTea, SIZE16, [])).toEqual([
      { ingredientId: CUP16, qtyMilli: 1_000 },
      { ingredientId: LID, qtyMilli: 1_000 },
      { ingredientId: MILK, qtyMilli: 120_000 },
      { ingredientId: PEARL, qtyMilli: 50_000 },
    ])
  })

  it('22oz scales "scale" lines, keeps "fixed", uses "custom" per size', () => {
    expect(requirementPerUnit(bubbleTea, SIZE22, [])).toEqual([
      { ingredientId: CUP22, qtyMilli: 1_000 },
      { ingredientId: LID, qtyMilli: 1_000 },
      { ingredientId: MILK, qtyMilli: 165_000 }, // 120 × 1.375
      { ingredientId: PEARL, qtyMilli: 68_750 }, // 50 × 1.375
    ])
  })

  it('adds topping BOM (fixed or scaled) and merges same ingredient', () => {
    const extraPearl = [{ ingredientId: PEARL, qtyMilli: 30_000, sizeMode: 'fixed' as const }]
    const extraMilk = [{ ingredientId: MILK, qtyMilli: 20_000, sizeMode: 'scale' as const }]
    const req = requirementPerUnit(bubbleTea, SIZE22, [extraPearl, extraMilk])
    expect(req.find((r) => r.ingredientId === PEARL)!.qtyMilli).toBe(98_750) // 68.75 + 30
    expect(req.find((r) => r.ingredientId === MILK)!.qtyMilli).toBe(192_500) // 165 + 20 × 1.375
  })

  it('rounds scaled quantities half up to 0.001 unit', () => {
    const r = requirementPerUnit([{ ingredientId: 'x', qtyMilli: 333, sizeMode: 'scale' }], { id: 's', multiplierMilli: 1500 }, [])
    expect(r).toEqual([{ ingredientId: 'x', qtyMilli: 500 }]) // 499.5 → 500
  })

  it('falls back to scaling when a custom line has no value for the size', () => {
    const r = requirementPerUnit([{ ingredientId: 'x', qtyMilli: 1_000, sizeMode: 'custom', perSize: {} }], SIZE22, [])
    expect(r).toEqual([{ ingredientId: 'x', qtyMilli: 1_375 }])
  })

  it('works for products without sizes (multiplier 1.0)', () => {
    expect(requirementPerUnit(bubbleTea.slice(0, 2), null, [])).toHaveLength(2)
  })

  it('multiplies by the quantity sold', () => {
    expect(scaleRequirement([{ ingredientId: MILK, qtyMilli: 165_000 }], 3)).toEqual([{ ingredientId: MILK, qtyMilli: 495_000 }])
  })
})

// ---------------------------------------------------------------------------
// FEFO / FIFO lot picking
// ---------------------------------------------------------------------------
const day = 86_400_000
const lot = (id: string, remaining: number, o: Partial<LotForAllocation> = {}): LotForAllocation => ({
  id,
  qtyReceivedMilli: remaining,
  qtyRemainingMilli: remaining,
  totalCostSatang: remaining / 10, // 0.01 satang per milli → e.g. 1000 ml lot = 100 baht
  receivedAt: 0,
  expiresAt: null,
  ...o,
})

describe('lot allocation', () => {
  it('FEFO: takes the lot that expires first, even if received later (§6.1 "ตัดล็อต EXP เก่าก่อน")', () => {
    const lots = [lot('new-exp', 1_000_000, { receivedAt: 1 * day, expiresAt: 10 * day }), lot('old-exp', 1_000_000, { receivedAt: 2 * day, expiresAt: 5 * day })]
    const r = allocateFromLots(lots, 165_000, true)
    expect(r.takes.map((t) => t.lotId)).toEqual(['old-exp'])
    expect(r.shortageMilli).toBe(0)
  })

  it('FEFO: lots without an expiry date go last', () => {
    const lots = [lot('no-exp', 500, { receivedAt: 0 }), lot('exp', 500, { receivedAt: 5, expiresAt: 100 })]
    expect(allocateFromLots(lots, 700, true).takes.map((t) => [t.lotId, t.qtyMilli])).toEqual([
      ['exp', 500],
      ['no-exp', 200],
    ])
  })

  it('FIFO: ignores expiry and takes the earliest received', () => {
    const lots = [lot('later', 500, { receivedAt: 2, expiresAt: 1 }), lot('earlier', 500, { receivedAt: 1, expiresAt: 9 })]
    expect(allocateFromLots(lots, 600, false).takes.map((t) => [t.lotId, t.qtyMilli])).toEqual([
      ['earlier', 500],
      ['later', 100],
    ])
  })

  it('reports the shortage when lots run out (D16)', () => {
    const r = allocateFromLots([lot('a', 300), lot('b', 200, { receivedAt: 1 })], 900, false)
    expect(r.takes.map((t) => t.qtyMilli)).toEqual([300, 200])
    expect(r.shortageMilli).toBe(400)
    expect(allocateFromLots([], 50, true)).toEqual({ takes: [], shortageMilli: 50 })
  })

  it('costs takes by lot share so a fully used lot costs exactly its total', () => {
    const l = { ...lot('a', 3_000), totalCostSatang: 1_000 } // 3 units for 10.00 baht
    let remaining = l.qtyRemainingMilli
    let cost = 0
    for (let i = 0; i < 3; i++) {
      const t = allocateFromLots([{ ...l, qtyRemainingMilli: remaining }], 1_000, false).takes[0]!
      cost += t.costSatang
      remaining -= t.qtyMilli
    }
    expect(cost).toBe(1_000) // 333 + 334 + 333, never 999 or 1001
  })
})

// ---------------------------------------------------------------------------
// Bill numbers (D14)
// ---------------------------------------------------------------------------
describe('bill numbers', () => {
  it('maps branch order to letters', () => {
    expect([0, 1, 2, 25, 26, 27].map(branchLetter)).toEqual(['A', 'B', 'C', 'Z', 'AA', 'AB'])
  })

  it('uses the Buddhist year and Bangkok local date', () => {
    expect(bangkokDateParts(Date.UTC(2026, 10, 5, 3))).toEqual({ yy: '69', mm: '11', dd: '05' })
    // 17:30 UTC = 00:30 next day in Bangkok
    expect(bangkokDateParts(Date.UTC(2026, 10, 5, 17, 30))).toEqual({ yy: '69', mm: '11', dd: '06' })
  })

  it('formats each reset policy', () => {
    const at = Date.UTC(2026, 10, 5, 3)
    expect(formatBillNo('A', 'none', periodKey('none', at), 1)).toBe('A-000001')
    expect(formatBillNo('A', 'daily', periodKey('daily', at), 1)).toBe('A-691105-0001')
    expect(formatBillNo('A', 'monthly', periodKey('monthly', at), 12)).toBe('A-6911-0012')
    expect(formatBillNo('B', 'yearly', periodKey('yearly', at), 123)).toBe('B-69-000123')
    expect(formatBillNo('A', 'none', '', 1_234_567)).toBe('A-1234567') // grows past the padding
  })

  it('gives each reset period its own counter key', () => {
    const d1 = Date.UTC(2026, 10, 5, 3)
    const d2 = Date.UTC(2026, 10, 6, 3)
    expect(periodKey('daily', d1)).not.toBe(periodKey('daily', d2))
    expect(periodKey('monthly', d1)).toBe(periodKey('monthly', d2))
    expect(periodKey('none', d1)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Bill totals (D9 + D15)
// ---------------------------------------------------------------------------
describe('bill totals', () => {
  it('prices include VAT when the rate is > 0; VAT is extracted once per bill', () => {
    const t = computeBillTotals({
      lines: [
        { unitPriceSatang: 4_500, qty: 2, vatType: 'vat7' },
        { unitPriceSatang: 5_500, qty: 1, vatType: 'vat7' },
      ],
      vatRateBp: 700,
    })
    expect(t).toMatchObject({ subtotal: 14_500, discount: 0, total: 14_500, vatMode: 'inclusive', vat: 949, net: 13_551 })
    // 14500 × 7/107 = 948.598… → 949
  })

  it('no VAT at rate 0 (D15)', () => {
    const t = computeBillTotals({ lines: [{ unitPriceSatang: 4_500, qty: 1, vatType: 'vat7' }], vatRateBp: 0 })
    expect(t).toMatchObject({ total: 4_500, vat: 0, vatMode: 'none', net: 4_500 })
  })

  it('excludes vat0/exempt lines from the VAT base', () => {
    const t = computeBillTotals({
      lines: [
        { unitPriceSatang: 10_700, qty: 1, vatType: 'vat7' },
        { unitPriceSatang: 2_000, qty: 1, vatType: 'exempt' },
      ],
      vatRateBp: 700,
    })
    expect(t).toMatchObject({ total: 12_700, vat: 700 })
  })

  it('spreads a bill discount over lines exactly and taxes the discounted amount', () => {
    const t = computeBillTotals({
      lines: [
        { unitPriceSatang: 5_000, qty: 1, vatType: 'vat7' },
        { unitPriceSatang: 5_000, qty: 1, vatType: 'vat7' },
      ],
      billDiscountSatang: 1_001,
      vatRateBp: 700,
    })
    expect(t.lines.map((l) => l.discount)).toEqual([501, 500])
    expect(t).toMatchObject({ subtotal: 10_000, discount: 1_001, total: 8_999, vat: 589 }) // 8999×7/107 = 588.7
  })

  it('rejects a discount larger than the subtotal', () => {
    expect(() => computeBillTotals({ lines: [{ unitPriceSatang: 100, qty: 1, vatType: 'vat7' }], billDiscountSatang: 101, vatRateBp: 700 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Cash drawer count
// ---------------------------------------------------------------------------
describe('cash count', () => {
  it('lists Thai notes and coins in satang', () => {
    expect(DENOMINATIONS_SATANG).toEqual([100_000, 50_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 25])
  })
  it('sums counts by denomination', () => {
    expect(countedTotal([
      { denominationSatang: 100_000, count: 3 },
      { denominationSatang: 2_000, count: 4 },
      { denominationSatang: 25, count: 3 },
    ])).toBe(308_075)
  })
  it('rejects unknown denominations and negative counts', () => {
    expect(() => countedTotal([{ denominationSatang: 300, count: 1 }])).toThrow()
    expect(() => countedTotal([{ denominationSatang: 100, count: -1 }])).toThrow()
  })
})

// ---------------------------------------------------------------------------
// PromptPay (EMVCo merchant-presented QR)
// ---------------------------------------------------------------------------
describe('PromptPay payload', () => {
  it('uses CRC-16/CCITT-FALSE', () => {
    expect(crc16('123456789')).toBe('29B1')
  })

  it('builds a dynamic payload for a phone number with an amount', () => {
    const p = buildPromptPayPayload({ id: '081-234-5678', amountSatang: 4_500 })
    expect(p).toBe(
      '000201' + '010212' + '2937' + '0016A000000677010111' + '01130066812345678' + '5802TH' + '5303764' + '540545.00' + '6304' + crc16(p.slice(0, -4)),
    )
    expect(p.endsWith(crc16(p.slice(0, -4)))).toBe(true)
  })

  it('builds a static payload for a 13-digit tax id', () => {
    const p = buildPromptPayPayload({ id: '0105556012345' })
    expect(p.startsWith('000201010211' + '2937' + '0016A000000677010111' + '02130105556012345')).toBe(true)
    expect(p).toContain('5303764' + '6304') // no amount tag (54) between currency and CRC
  })

  it('rejects invalid ids', () => {
    expect(() => buildPromptPayPayload({ id: '1234' })).toThrow()
  })
})
