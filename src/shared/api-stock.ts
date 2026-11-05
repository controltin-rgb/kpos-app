import { z } from 'zod'
import type { Access, Endpoint } from './api'

/** Phase 3 IPC contract — purchasing, receiving, stock counts, waste, manual adjustments. */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

const id = z.string().min(1).max(64)
const milli = z.number().int().min(0).max(1_000_000_000_000)
const satang = z.number().int().min(0).max(100_000_000_00)
const reason = z.string().trim().min(3).max(200)
const optText = (max: number) => z.string().trim().max(max).nullable().optional()

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SupplierDto {
  id: string
  name: string
  phone: string | null
  taxId: string | null
  note: string | null
}

export type PoStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled'

export interface PoLineDto {
  id: string
  ingredientId: string
  ingredientName: string
  baseUnit: 'ml' | 'g' | 'pcs'
  hasExpiry: boolean
  qtyOrderedMilli: number
  qtyReceivedMilli: number
  lineTotalSatang: number
}

export interface PurchaseOrderDto {
  id: string
  poNo: string
  status: PoStatus
  supplierId: string | null
  supplierName: string | null
  orderedAt: number | null
  expectedAt: number | null
  totalSatang: number
  note: string | null
  createdByName: string
  createdAt: number
  lines: PoLineDto[]
}

export type CountStatus = 'draft' | 'pending' | 'approved' | 'rejected'

export interface CountLineDto {
  id: string
  ingredientId: string
  ingredientName: string
  baseUnit: 'ml' | 'g' | 'pcs'
  /** what the system expected at count time: lots minus open shortages */
  systemQtyMilli: number
  countedQtyMilli: number | null
  diffMilli: number | null
  /** estimated value of the difference (latest lot unit cost) */
  diffValueSatang: number | null
  reason: string | null
}

export interface StockCountDto {
  id: string
  countNo: string
  kind: 'daily' | 'full'
  status: CountStatus
  note: string | null
  createdByName: string
  createdById: string
  createdAt: number
  submittedAt: number | null
  decidedByName: string | null
  decidedAt: number | null
  rejectReason: string | null
  lines: CountLineDto[]
  totalDiffValueSatang: number
}

export type WasteReason = 'expired' | 'wrong_made' | 'dropped' | 'customer_return' | 'other'

export interface WasteDto {
  id: string
  wasteNo: string
  kind: 'ingredient' | 'drink'
  itemName: string
  qtyMilli: number
  unit: string
  reason: WasteReason
  note: string | null
  valueSatang: number
  createdByName: string
  createdAt: number
  voided: boolean
}

export interface ExpiringLotDto {
  lotId: string
  ingredientId: string
  ingredientName: string
  baseUnit: 'ml' | 'g' | 'pcs'
  lotNo: string | null
  qtyRemainingMilli: number
  valueSatang: number
  expiresAt: number
}

export interface WasteSummaryDto {
  from: number
  to: number
  totalSatang: number
  byReason: Record<WasteReason, number>
  salesSatang: number
  /** waste ÷ sales in basis points (target ≤ 200 = 2%, Implement.md §6.8) */
  wasteRatioBp: number | null
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const poLine = z.object({ ingredientId: id, qtyOrderedMilli: milli.min(1), lineTotalSatang: satang })

export const stockApi = {
  'purchasing.suppliers': ep<SupplierDto[]>()('inventory:view', z.undefined()),
  'purchasing.saveSupplier': ep<SupplierDto>()(
    'inventory:update',
    z.object({ id: id.optional(), name: z.string().trim().min(1).max(120), phone: optText(30), taxId: optText(20), note: optText(200) }),
  ),
  'purchasing.orders': ep<PurchaseOrderDto[]>()('inventory:view', z.object({ status: z.enum(['open', 'all']).default('open') })),
  'purchasing.saveOrder': ep<PurchaseOrderDto>()(
    'inventory:create',
    z.object({ id: id.optional(), supplierId: id.nullable().default(null), expectedAt: z.number().int().nullable().default(null), note: optText(300), lines: z.array(poLine).min(1).max(100) }),
  ),
  'purchasing.setStatus': ep<PurchaseOrderDto>()('inventory:update', z.object({ id, status: z.enum(['ordered', 'cancelled']) })),
  /** Receive goods (with or without a PO): one lot per line, one transaction. */
  'purchasing.receive': ep<{ receiptId: string; receiptNo: string; lotIds: string[]; settledMilli: number }>()(
    'inventory:create',
    z.object({
      poId: id.nullable().default(null),
      supplierId: id.nullable().default(null),
      note: optText(300),
      lines: z
        .array(
          z.object({
            poLineId: id.nullable().default(null),
            ingredientId: id,
            qtyMilli: milli.min(1),
            totalCostSatang: satang,
            expiresAt: z.number().int().nullable().default(null),
            lotNo: optText(40),
          }),
        )
        .min(1)
        .max(100),
    }),
  ),

  'counts.list': ep<StockCountDto[]>()('inventory:view', z.object({ status: z.enum(['open', 'all']).default('open') })),
  'counts.get': ep<StockCountDto>()('inventory:view', z.object({ id })),
  'counts.create': ep<StockCountDto>()('inventory:create', z.object({ kind: z.enum(['daily', 'full']).default('full'), ingredientIds: z.array(id).max(500).default([]), note: optText(300) })),
  'counts.saveLines': ep<StockCountDto>()(
    'inventory:create',
    z.object({ id, lines: z.array(z.object({ ingredientId: id, countedQtyMilli: milli.nullable(), reason: optText(200) })).max(500) }),
  ),
  'counts.submit': ep<StockCountDto>()('inventory:create', z.object({ id })),
  'counts.approve': ep<StockCountDto>()('inventory:approve_count', z.object({ id })),
  'counts.reject': ep<StockCountDto>()('inventory:approve_count', z.object({ id, reason })),

  'waste.record': ep<WasteDto>()(
    'inventory:create',
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ingredient'), ingredientId: id, lotId: id.nullable().default(null), qtyMilli: milli.min(1), reason: z.enum(['expired', 'wrong_made', 'dropped', 'customer_return', 'other']), note: optText(200) }),
      z.object({ kind: z.literal('drink'), productId: id, sizeId: id.nullable().default(null), qty: z.number().int().min(1).max(999), optionIds: z.array(id).max(30).default([]), reason: z.enum(['expired', 'wrong_made', 'dropped', 'customer_return', 'other']), note: optText(200) }),
    ]),
  ),
  'waste.void': ep<WasteDto>()('inventory:update', z.object({ id, reason })),
  'waste.list': ep<{ items: WasteDto[]; total: number }>()(
    'inventory:view',
    z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(7), reason: z.enum(['all', 'expired', 'wrong_made', 'dropped', 'customer_return', 'other']).default('all') }),
  ),
  'waste.expiring': ep<ExpiringLotDto[]>()('inventory:view', z.object({ withinDays: z.number().int().min(0).max(60).default(3) })),
  'waste.summary': ep<WasteSummaryDto>()('inventory:view', z.object({ from: z.number().int(), to: z.number().int() })),

  /** Manual adjustment without a document — needs inventory:adjust, always audited (risk high). */
  'inventory.adjust': ep<{ ingredientId: string; onHandMilli: number }>()('inventory:adjust', z.object({ ingredientId: id, deltaMilli: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000).refine((v) => v !== 0), reason })),
} as const
