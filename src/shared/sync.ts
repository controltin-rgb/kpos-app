import { z } from 'zod'
import type { PosCatalog } from './api-sales'
import type { BillResetPolicy } from './bill-number'
import type { SaleableSnapshot } from './pricing'
import type { PromoDef } from './promotions'

/**
 * Host ⇄ Client offline-selling contract (Implement.md §2, D27, D35, D36).
 * Sent over the paired LAN connection with the DEVICE token (no user session needed):
 *   GET  /sync/snapshot  → SyncSnapshot  (prices, recipes, promotions, settings, bill number blocks)
 *   POST /sync/bills     → SyncResult[]  (bills sold while the Host was down; idempotent by bill id)
 */

/** D27: numbers reserved per Client and topped up when this many or fewer are left. */
export const BLOCK_SIZE = 200
export const BLOCK_LOW_WATER = 50

export interface BillBlockDto {
  id: string
  /** numbering period ('' = never resets) */
  period: string
  /** branch letter used in the bill number */
  prefix: string
  fromNo: number
  toNo: number
}

export interface SyncSnapshot {
  /** Host time the snapshot was taken */
  at: number
  branch: { id: string; name: string; code: string; shopName: string }
  settings: {
    vatRateBp: number
    promptPayId: string
    billPolicy: BillResetPolicy
    receiptHeader: string
    receiptFooter: string
    paperMm: 58 | 80
    /** absent in snapshots from older Hosts → enabled */
    deliveryEnabled?: boolean
  }
  /** what the POS screen shows (without the per-device fields) */
  posCatalog: Omit<PosCatalog, 'vatRateBp' | 'deliveryEnabled' | 'promptPayId' | 'device' | 'branchName'>
  /** pricing + BOM per product (shared/pricing.ts) */
  products: SaleableSnapshot[]
  /** automatic promotions (coupons are not available offline — D37) */
  promotions: PromoDef[]
  /** this device's bill number blocks for the current (and next) numbering period */
  blocks: BillBlockDto[]
}

const id = z.string().min(1).max(64)
const satang = z.number().int().min(0).max(100_000_000_00)
const milli = z.number().int().min(0).max(1_000_000_000_000)

/** A bill sold on a Client while offline — validated by the Host before it is recorded. */
export const offlineBillSchema = z.object({
  /** the checkout requestId (UUIDv7) — the bill id; a retry or an online duplicate is detected by it */
  id: z.string().uuid(),
  billNo: z.string().min(1).max(40),
  blockId: id,
  period: z.string().max(10),
  seq: z.number().int().min(1),
  createdAt: z.number().int(),
  /** the logged-in seller (D35) */
  userId: id,
  shiftId: id,
  orderType: z.enum(['dine_in', 'takeaway', 'delivery']),
  channel: z.enum(['grab', 'lineman', 'shopeefood', 'foodpanda', 'other']).nullable(),
  extOrderId: z.string().max(60).nullable(),
  commissionBp: z.number().int().min(0).max(10_000).nullable(),
  /** lines as priced on the Client from its snapshot (D36: the price the customer paid) */
  lines: z
    .array(
      z.object({
        productId: id,
        sizeId: id.nullable(),
        productName: z.string().min(1).max(160),
        sizeLabel: z.string().max(30).nullable(),
        qty: z.number().int().min(1).max(999),
        unitPriceSatang: satang,
        vatType: z.enum(['vat7', 'vat0', 'exempt']),
        note: z.string().max(120).nullable(),
        kdsStation: z.string().max(30).nullable(),
        categoryId: id.nullable(),
        modifiers: z.array(z.object({ optionId: id, groupName: z.string().max(60), optionName: z.string().max(60), priceSatang: satang, highlight: z.boolean() })).max(30),
        requirementPerUnit: z.array(z.object({ ingredientId: id, qtyMilli: milli })).max(100),
      }),
    )
    .min(1)
    .max(100),
  promotions: z.array(z.object({ promotionId: id, name: z.string().max(120), discountSatang: satang })).max(20),
  vatRateBp: z.number().int().min(0).max(10_000),
  totalSatang: satang,
  payment: z.discriminatedUnion('method', [
    z.object({ method: z.literal('cash'), tenderedSatang: satang }),
    z.object({ method: z.literal('promptpay'), confirmed: z.literal(true), reference: z.string().max(60).nullable().optional() }),
    z.object({ method: z.enum(['card', 'transfer', 'other']), reference: z.string().max(60).nullable().optional() }),
    z.object({ method: z.literal('delivery') }),
  ]),
})
export type OfflineBill = z.infer<typeof offlineBillSchema>

export type SyncResult =
  | { id: string; status: 'ok'; billNo: string }
  /** already on the Host (a retried push, or the online checkout did go through) */
  | { id: string; status: 'duplicate'; billNo: string }
  /** refused — kept on the Client and in the Host audit log for a person to look at */
  | { id: string; status: 'rejected'; reason: string }
