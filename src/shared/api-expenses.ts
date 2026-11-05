import { z } from 'zod'
import type { Access, Endpoint } from './api'

/** Phase 3 IPC contract — expenses / petty cash (Implement.md §6.6). */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

const id = z.string().min(1).max(64)
const satang = z.number().int().min(0).max(100_000_000_00)

export type ExpenseSource = 'drawer' | 'petty_cash' | 'bank'

export interface ExpenseCategoryDto {
  id: string
  name: string
  icon: string | null
}

export interface ExpenseDto {
  id: string
  expenseNo: string
  categoryId: string
  categoryName: string
  amountSatang: number
  vatSatang: number
  source: ExpenseSource
  hasTaxInvoice: boolean
  vendor: string | null
  description: string | null
  hasReceipt: boolean
  spentAt: number
  createdByName: string
  voided: boolean
  voidReason: string | null
}

export interface ExpenseSummaryDto {
  totalSatang: number
  byCategory: { categoryId: string; name: string; totalSatang: number }[]
  bySource: Record<ExpenseSource, number>
  inputVatSatang: number
}

export const expensesApi = {
  'expenses.categories': ep<ExpenseCategoryDto[]>()('expenses:view', z.undefined()),
  'expenses.saveCategory': ep<ExpenseCategoryDto>()('expenses:update', z.object({ id: id.optional(), name: z.string().trim().min(1).max(60), icon: z.string().max(40).nullable().optional() })),
  'expenses.list': ep<{ items: ExpenseDto[]; total: number }>()(
    'expenses:view',
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(7),
      categoryId: id.optional(),
      source: z.enum(['drawer', 'petty_cash', 'bank']).optional(),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
    }),
  ),
  'expenses.create': ep<ExpenseDto>()(
    'expenses:create',
    z.object({
      categoryId: id,
      amountSatang: satang.min(1),
      vatSatang: satang.default(0),
      source: z.enum(['drawer', 'petty_cash', 'bank']),
      hasTaxInvoice: z.boolean().default(false),
      vendor: z.string().trim().max(120).nullable().optional(),
      description: z.string().trim().min(1).max(200),
      spentAt: z.number().int().optional(),
      /** file name returned by expenses.pickReceipt */
      receiptFile: z.string().regex(/^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$/).nullable().optional(),
    }),
  ),
  'expenses.void': ep<ExpenseDto>()('expenses:update', z.object({ id, reason: z.string().trim().min(3).max(200) })),
  'expenses.summary': ep<ExpenseSummaryDto>()('expenses:view', z.object({ from: z.number().int(), to: z.number().int() })),
  /** Opens a file picker in main, copies the image into userData/receipts and returns the stored file name. */
  'expenses.pickReceipt': ep<string | null>()('expenses:create', z.undefined()),
  /** Receipt image as a data URL (read from userData/receipts only). */
  'expenses.receipt': ep<string | null>()('expenses:view', z.object({ id })),
} as const
