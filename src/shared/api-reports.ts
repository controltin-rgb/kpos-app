import { z } from 'zod'
import type { Access, Endpoint } from './api'

/** Phase 3 IPC contract — reports and tax invoices (Implement.md §6.3, D19/D20). */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

const id = z.string().min(1).max(64)
const range = { from: z.number().int(), to: z.number().int() }

export type ChannelKey = 'dine_in' | 'takeaway' | 'grab' | 'lineman' | 'shopeefood' | 'foodpanda' | 'other'

export interface SalesReportDto {
  from: number
  to: number
  billCount: number
  grossSatang: number
  discountSatang: number
  totalSatang: number
  vatSatang: number
  netSatang: number
  avgBillSatang: number
  voidCount: number
  refundCount: number
  refundSatang: number
  buckets: { start: number; label: string; totalSatang: number; billCount: number }[]
  channels: { channel: ChannelKey; totalSatang: number; commissionSatang: number; netSatang: number; billCount: number }[]
  methods: { method: string; totalSatang: number }[]
  topProducts: { name: string; qty: number; totalSatang: number }[]
}

export interface ProfitReportDto {
  from: number
  to: number
  /** sales excluding VAT */
  netSalesSatang: number
  /** ingredient cost from the stock ledger (lot costs, FEFO/FIFO) */
  cogsSatang: number
  grossProfitSatang: number
  marginBp: number | null
  wasteSatang: number
  products: { name: string; qty: number; netSatang: number; cogsSatang: number; profitSatang: number }[]
}

export interface ZListItemDto {
  shiftId: string
  shiftNo: string
  openedAt: number
  closedAt: number | null
  openedByName: string
  totalSalesSatang: number
  expectedCashSatang: number
  countedCashSatang: number | null
  overShortSatang: number | null
}

export interface TaxInvoiceDto {
  id: string
  type: 'abbreviated' | 'full'
  invoiceNo: string
  billId: string
  billNo: string
  issuedAt: number
  issuedByName: string
  customerName: string | null
  customerTaxId: string | null
  customerBranch: string | null
  customerAddress: string | null
  totalSatang: number
  vatSatang: number
  cancelled: boolean
  cancelReason: string | null
  replacesNo: string | null
}

export const reportsApi = {
  'reports.sales': ep<SalesReportDto>()('reports:view', z.object({ ...range, bucket: z.enum(['hour', 'day']).default('day') })),
  'reports.profit': ep<ProfitReportDto>()('reports:view_cost', z.object(range)),
  'reports.zList': ep<ZListItemDto[]>()('reports:view', z.object(range)),
  /** Saves a CSV (opens in Excel, UTF-8 with BOM) through the OS save dialog. Returns the path or null. */
  'reports.export': ep<string | null>()('reports:export', z.object({ report: z.enum(['sales', 'profit', 'waste', 'expenses', 'tax']), ...range })),

  'tax.list': ep<TaxInvoiceDto[]>()('orders:view', z.object({ ...range, billId: id.optional() })),
  /** D19/D20: issued on request; numbering per document type, yearly reset. */
  'tax.issue': ep<TaxInvoiceDto>()(
    'orders:tax_invoice',
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('abbreviated'), billId: id, replacesId: id.nullable().default(null) }),
      z.object({
        type: z.literal('full'),
        billId: id,
        replacesId: id.nullable().default(null),
        customer: z.object({
          name: z.string().trim().min(1).max(160),
          taxId: z.string().trim().max(20),
          branch: z.string().trim().regex(/^\d{5}$/),
          address: z.string().trim().min(5).max(300),
        }),
      }),
    ]),
  ),
  'tax.cancel': ep<TaxInvoiceDto>()('orders:tax_invoice', z.object({ id, reason: z.string().trim().min(3).max(200) })),
  'tax.print': ep<null>()('orders:view', z.object({ id })),

  /** Prints an A4 label sheet rendered by the label screen (JavaScript is disabled in the print window). */
  'labels.print': ep<null>()('inventory:view', z.object({ html: z.string().min(1).max(8_000_000) })),
} as const
