import { z } from 'zod'
import type { Access, Endpoint } from './api'
import { BILL_RESET_POLICIES, type BillResetPolicy } from './bill-number'
import { type BillDiscountDto, discountInputs } from './api-promo'
import { DENOMINATIONS_SATANG } from './cash'
import { PAYMENT_PROVIDERS, PAYMENT_VERIFY_MODES, type PaymentProvider, type PaymentVerifyMode } from './payment-verify'

/** Phase 2 IPC contract: catalog, inventory, POS, shifts, orders, KDS, settings. */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

const id = z.string().min(1).max(64)
const satang = z.number().int().min(0).max(100_000_000_00)
const milli = z.number().int().min(0).max(1_000_000_000_000)
const name = z.string().trim().min(1).max(120)
const optText = (max: number) => z.string().trim().max(max).nullable().optional()

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type BaseUnit = 'ml' | 'g' | 'pcs'
export type SizeModeDto = 'scale' | 'fixed' | 'custom'

export interface CategoryDto {
  id: string
  name: string
  icon: string | null
  color: string | null
  kdsStation: string | null
  /** SKU prefix for auto codes (COF → COF-0001); null → "P" */
  skuPrefix: string | null
  sortOrder: number
  productCount: number
}

export interface SizeDto {
  id: string
  label: string
  priceSatang: number
  multiplierMilli: number
  isDefault: boolean
}

export interface RecipeLineDto {
  ingredientId: string
  qtyMilli: number
  sizeMode: SizeModeDto
  perSize: Record<string, number>
}

export interface ProductDto {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  categoryId: string | null
  kind: 'drink' | 'food' | 'retail'
  vatType: 'vat7' | 'vat0' | 'exempt'
  active: boolean
  sortOrder: number
  sizes: SizeDto[]
  recipe: RecipeLineDto[]
  modifierGroupIds: string[]
  /** estimated ingredient cost of the default size (satang), from current lots */
  costSatang: number | null
  /** default size price without VAT (current VAT setting and the product's VAT type) */
  netPriceSatang: number
  /** gross margin of the default size in basis points, null when the cost is unknown */
  marginBp: number | null
}

export interface OptionItemDto {
  ingredientId: string
  qtyMilli: number
  sizeMode: 'scale' | 'fixed'
}

export interface OptionDto {
  id: string
  name: string
  priceSatang: number
  isDefault: boolean
  items: OptionItemDto[]
}

export interface ModifierGroupDto {
  id: string
  name: string
  minSelect: number
  maxSelect: number
  kdsHighlight: boolean
  sortOrder: number
  options: OptionDto[]
}

export interface IngredientDto {
  id: string
  name: string
  baseUnit: BaseUnit
  packSizeMilli: number
  minQtyMilli: number
  hasExpiry: boolean
  defaultSizeMode: SizeModeDto
  isDailyCount: boolean
  onHandMilli: number
  shortageMilli: number
  nextExpiry: number | null
  lotCount: number
  status: 'ok' | 'low' | 'out'
}

export interface LotDto {
  id: string
  lotNo: string | null
  source: string
  qtyReceivedMilli: number
  qtyRemainingMilli: number
  totalCostSatang: number
  receivedAt: number
  expiresAt: number | null
}

/** What the POS screen needs to sell (no BOM details). */
export interface PosCatalog {
  categories: { id: string; name: string; icon: string | null; color: string | null }[]
  products: {
    id: string
    name: string
    categoryId: string | null
    kind: ProductDto['kind']
    barcode: string | null
    vatType: ProductDto['vatType']
    sizes: SizeDto[]
    modifierGroupIds: string[]
    /** at least one ingredient has no stock left (sale still allowed, D16) */
    lowStock: boolean
  }[]
  groups: { id: string; name: string; minSelect: number; maxSelect: number; options: { id: string; name: string; priceSatang: number; isDefault: boolean }[] }[]
  vatRateBp: number
  /** settings: sales.delivery_enabled */
  deliveryEnabled: boolean
  branchName: string
  promptPayId: string
  device: { id: string; name: string }
}

export interface ShortageNoticeDto {
  ingredientName: string
  baseUnit: string
  qtyMilli: number
}

export interface BillItemDto {
  id: string
  lineNo: number
  productName: string
  sizeLabel: string | null
  qty: number
  unitPriceSatang: number
  discountSatang: number
  lineTotalSatang: number
  modifiers: { groupName: string; optionName: string; priceSatang: number }[]
  note: string | null
}

export interface PaymentDto {
  method: PaymentMethod
  amountSatang: number
  tenderedSatang: number | null
  changeSatang: number | null
  reference: string | null
  confirmedByName: string | null
}

export type PaymentMethod = 'cash' | 'promptpay' | 'card' | 'transfer' | 'delivery' | 'other'
export type OrderType = 'dine_in' | 'takeaway' | 'delivery'
export type DeliveryChannel = 'grab' | 'lineman' | 'shopeefood' | 'foodpanda' | 'other'
export type BillStatus = 'open' | 'paid' | 'void' | 'refunded'

export interface BillSummaryDto {
  id: string
  billNo: string
  status: BillStatus
  orderType: OrderType
  channel: DeliveryChannel | null
  totalSatang: number
  paymentMethod: PaymentMethod | null
  createdAt: number
  createdByName: string
  itemCount: number
}

export interface BillDetailDto extends BillSummaryDto {
  shiftId: string
  extOrderId: string | null
  subtotalSatang: number
  discountSatang: number
  vatSatang: number
  vatMode: 'inclusive' | 'none'
  commissionBp: number | null
  commissionSatang: number | null
  items: BillItemDto[]
  payments: PaymentDto[]
  events: { event: string; at: number; userName: string; approverName: string | null; reason: string | null }[]
  voidReason: string | null
  /** whether this bill can still be voided (its shift is open) */
  voidable: boolean
  discounts: BillDiscountDto[]
  member: { name: string | null; phoneMasked: string; pointsEarned: number; pointsRedeemed: number } | null
}

export interface SaleResult {
  bill: BillDetailDto
  shortages: ShortageNoticeDto[]
}

export interface BillList {
  items: BillSummaryDto[]
  total: number
  page: number
  pageSize: number
}

export interface ShiftSummaryDto {
  id: string
  shiftNo: string
  status: 'open' | 'closed'
  openedAt: number
  openedByName: string
  closedAt: number | null
  closedByName: string | null
  openingFloatSatang: number
  /** cash sales net of voids */
  cashSalesSatang: number
  cashRefundsSatang: number
  cashInSatang: number
  cashOutSatang: number
  expensesSatang: number
  expectedCashSatang: number
  countedCashSatang: number | null
  overShortSatang: number | null
  byMethod: Record<PaymentMethod, number>
  billCount: number
  voidCount: number
  refundCount: number
  totalSalesSatang: number
}

export interface KdsTicketDto {
  billId: string
  billNo: string
  orderType: OrderType
  channel: DeliveryChannel | null
  status: 'new' | 'preparing' | 'ready'
  createdAt: number
  items: { qty: number; name: string; sizeLabel: string | null; mods: { text: string; highlight: boolean }[]; note: string | null }[]
}

export interface SettingsDto {
  'vat.rate_bp': number
  'bill.reset_policy': BillResetPolicy
  'promptpay.id': string
  'receipt.header': string
  'receipt.footer': string
  'receipt.paper_mm': 58 | 80
  'license.employee_cap': number
  'stock.count_separate_approver': boolean
  'tax.seller_name': string
  'tax.seller_tax_id': string
  'tax.seller_branch': string
  'tax.seller_address': string
  'kds.complete_on_pay': boolean
  'sales.delivery_enabled': boolean
  'promptpay.verify_mode': PaymentVerifyMode
  'promptpay.provider': PaymentProvider
  'promptpay.merchant_id': string
  'promptpay.provider_branch': string
  'promptpay.provider_endpoint': string
  'update.feed_url': string
  'update.auto_check': boolean
  /** read-only info for the settings page */
  branchCode: string
  billNoExample: string
}

export const cfdStateSchema = z.object({
  orderLabel: z.string().max(60),
  lines: z.array(z.object({ qty: z.number().int(), name: z.string().max(120), mods: z.string().max(300), priceSatang: z.number().int() })).max(100),
  discountSatang: z.number().int(),
  vatSatang: z.number().int(),
  totalSatang: z.number().int(),
  vatRateBp: z.number().int(),
  promptPayPayload: z.string().max(512).nullable(),
  state: z.enum(['idle', 'cart', 'awaiting_payment', 'paid']),
  changeSatang: z.number().int().nullable().default(null),
})
export type CfdState = z.infer<typeof cfdStateSchema>

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const sizeInput = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(30),
  priceSatang: satang,
  multiplierMilli: z.number().int().min(1).max(100_000),
  isDefault: z.boolean().default(false),
})

const productInput = z.object({
  name,
  sku: optText(40),
  barcode: optText(40),
  categoryId: id.nullable().optional(),
  kind: z.enum(['drink', 'food', 'retail']).default('drink'),
  vatType: z.enum(['vat7', 'vat0', 'exempt']).default('vat7'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  sizes: z.array(sizeInput).min(1).max(10),
  recipe: z
    .array(
      z.object({
        ingredientId: id,
        qtyMilli: milli.min(1),
        sizeMode: z.enum(['scale', 'fixed', 'custom']),
        perSize: z.record(z.string(), milli).default({}),
      }),
    )
    .max(50)
    .default([]),
  modifierGroupIds: z.array(id).max(20).default([]),
})

const groupInput = z.object({
  name,
  minSelect: z.number().int().min(0).max(20).default(0),
  maxSelect: z.number().int().min(1).max(20).default(1),
  kdsHighlight: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  options: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(60),
        priceSatang: satang.default(0),
        isDefault: z.boolean().default(false),
        items: z
          .array(z.object({ ingredientId: id, qtyMilli: milli.min(1), sizeMode: z.enum(['scale', 'fixed']).default('fixed') }))
          .max(20)
          .default([]),
      }),
    )
    .min(1)
    .max(30),
})

const categoryInput = z.object({
  name,
  icon: optText(40),
  color: optText(20),
  kdsStation: optText(30),
  /** '' or null → no prefix; letters are upper-cased */
  skuPrefix: z
    .string()
    .trim()
    .max(6)
    .transform((v) => v.toUpperCase() || null)
    .pipe(z.string().regex(/^[A-Z0-9]{1,6}$/).nullable())
    .nullable()
    .optional(),
  sortOrder: z.number().int().default(0),
})

const ingredientInput = z.object({
  name,
  baseUnit: z.enum(['ml', 'g', 'pcs']),
  packSizeMilli: milli.min(1).default(1000),
  minQtyMilli: milli.default(0),
  hasExpiry: z.boolean().default(false),
  defaultSizeMode: z.enum(['scale', 'fixed', 'custom']).default('scale'),
  isDailyCount: z.boolean().default(false),
})

const approver = z.object({ username: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) })

const paymentInput = z.discriminatedUnion('method', [
  z.object({ method: z.literal('cash'), tenderedSatang: satang }),
  /** staff confirm the transfer manually in phase 1 of payments (CLAUDE.md) */
  z.object({ method: z.literal('promptpay'), confirmed: z.literal(true), reference: optText(60) }),
  z.object({ method: z.enum(['card', 'transfer', 'other']), reference: optText(60) }),
  z.object({ method: z.literal('delivery') }),
])

export const salesApi = {
  // ---- catalog ------------------------------------------------------------
  'catalog.categories': ep<CategoryDto[]>()('products:view', z.undefined()),
  'catalog.saveCategory': ep<CategoryDto>()('products:update', categoryInput.extend({ id: id.optional() })),
  'catalog.deleteCategory': ep<null>()('products:delete', z.object({ id })),
  /** the code a new product gets when its SKU is left empty (preview; saving assigns it for real) */
  'catalog.nextSku': ep<string>()('products:view', z.object({ categoryId: id.nullable() })),
  'catalog.products': ep<ProductDto[]>()('products:view', z.undefined()),
  'catalog.saveProduct': ep<ProductDto>()('products:update', productInput.extend({ id: id.optional() })),
  'catalog.deleteProduct': ep<null>()('products:delete', z.object({ id })),
  'catalog.groups': ep<ModifierGroupDto[]>()('products:view', z.undefined()),
  'catalog.saveGroup': ep<ModifierGroupDto>()('products:update', groupInput.extend({ id: id.optional() })),
  'catalog.deleteGroup': ep<null>()('products:delete', z.object({ id })),

  // ---- inventory ----------------------------------------------------------
  'inventory.ingredients': ep<IngredientDto[]>()('inventory:view', z.undefined()),
  'inventory.saveIngredient': ep<IngredientDto>()('inventory:update', ingredientInput.extend({ id: id.optional() })),
  'inventory.deleteIngredient': ep<null>()('inventory:delete', z.object({ id })),
  'inventory.lots': ep<LotDto[]>()('inventory:view', z.object({ ingredientId: id })),
  'inventory.addLot': ep<{ lotId: string; settledMilli: number }>()(
    'inventory:create',
    z.object({
      ingredientId: id,
      qtyMilli: milli.min(1),
      totalCostSatang: satang,
      expiresAt: z.number().int().nullable().default(null),
      lotNo: optText(40),
      receivedAt: z.number().int().optional(),
    }),
  ),

  // ---- POS ----------------------------------------------------------------
  'pos.catalog': ep<PosCatalog>()('pos:view', z.undefined()),
  'pos.checkout': ep<SaleResult>()(
    'pos:create',
    z.object({
      /** client-generated UUIDv7: retrying the same checkout never creates a second bill */
      requestId: z.string().uuid(),
      orderType: z.enum(['dine_in', 'takeaway', 'delivery']),
      channel: z.enum(['grab', 'lineman', 'shopeefood', 'foodpanda', 'other']).nullable().default(null),
      extOrderId: optText(60),
      commissionBp: z.number().int().min(0).max(10_000).nullable().default(null),
      items: z
        .array(
          z.object({
            productId: id,
            sizeId: id.nullable().default(null),
            qty: z.number().int().min(1).max(999),
            optionIds: z.array(id).max(30).default([]),
            note: optText(120),
          }),
        )
        .min(1)
        .max(100),
      payment: paymentInput,
      ...discountInputs,
    }),
  ),
  /** Pushes the current cart to customer-facing displays (no DB write). */
  'pos.showOnCfd': ep<null>()('pos:view', cfdStateSchema),
  /** Last cart shown on the customer display — public: the CFD window has no login. */
  'cfd.state': ep<CfdState | null>()('public', z.undefined()),
  'pos.openWindow': ep<null>()('pos:view', z.object({ kind: z.enum(['kds', 'cfd']) })),
  'pos.promptPayPayload': ep<string>()('pos:view', z.object({ amountSatang: satang.min(1) })),

  // ---- bills --------------------------------------------------------------
  'orders.list': ep<BillList>()(
    'orders:view',
    z.object({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(7),
      search: z.string().trim().max(40).optional(),
      status: z.enum(['all', 'paid', 'void', 'refunded']).default('all'),
      from: z.number().int().optional(),
      to: z.number().int().optional(),
    }),
  ),
  'orders.get': ep<BillDetailDto>()('orders:view', z.object({ id })),
  /** access is pos:create; the service requires pos:void from the actor OR from an approver's PIN */
  'orders.void': ep<BillDetailDto>()('pos:create', z.object({ id, reason: z.string().trim().min(3).max(200), approver: approver.optional() })),
  /** access is orders:view; the service requires orders:refund from the actor OR an approver */
  'orders.refund': ep<BillDetailDto>()('orders:view', z.object({ id, reason: z.string().trim().min(3).max(200), approver: approver.optional() })),
  'orders.print': ep<null>()('orders:view', z.object({ id })),

  // ---- shifts -------------------------------------------------------------
  'shift.current': ep<ShiftSummaryDto | null>()('shift:view', z.undefined()),
  'shift.open': ep<ShiftSummaryDto>()('shift:create', z.object({ openingFloatSatang: satang })),
  'shift.cashMove': ep<ShiftSummaryDto>()(
    'shift:update',
    z.object({ kind: z.enum(['cash_in', 'cash_out']), amountSatang: satang.min(1), reason: z.string().trim().min(3).max(200) }),
  ),
  'shift.printZ': ep<null>()('shift:view', z.object({ shiftId: id })),
  'shift.close': ep<ShiftSummaryDto>()(
    'shift:update',
    z.object({
      shiftId: id,
      counts: z
        .array(z.object({ denominationSatang: z.number().int().refine((d) => (DENOMINATIONS_SATANG as readonly number[]).includes(d)), count: z.number().int().min(0).max(100_000) }))
        .max(DENOMINATIONS_SATANG.length),
      note: optText(300),
    }),
  ),

  // ---- KDS ----------------------------------------------------------------
  'kds.tickets': ep<KdsTicketDto[]>()('kds:view', z.object({ station: z.string().max(30).default('bar') })),
  'kds.advance': ep<null>()('kds:update', z.object({ billId: id, station: z.string().max(30).default('bar') })),

  // ---- settings -----------------------------------------------------------
  'settings.get': ep<SettingsDto>()('settings:view', z.undefined()),
  'settings.update': ep<SettingsDto>()(
    'settings:update',
    z
      .object({
        'vat.rate_bp': z.number().int().min(0).max(10_000),
        'bill.reset_policy': z.enum(BILL_RESET_POLICIES),
        'promptpay.id': z.string().trim().max(20),
        'receipt.header': z.string().trim().max(200),
        'receipt.footer': z.string().trim().max(200),
        'receipt.paper_mm': z.union([z.literal(58), z.literal(80)]),
        'stock.count_separate_approver': z.boolean(),
        'tax.seller_name': z.string().trim().max(160),
        'tax.seller_tax_id': z.string().trim().max(20),
        'tax.seller_branch': z.string().trim().max(5),
        'tax.seller_address': z.string().trim().max(300),
        'kds.complete_on_pay': z.boolean(),
        'sales.delivery_enabled': z.boolean(),
        'promptpay.verify_mode': z.enum(PAYMENT_VERIFY_MODES),
        'promptpay.provider': z.enum(PAYMENT_PROVIDERS),
        'promptpay.merchant_id': z.string().trim().max(80),
        'promptpay.provider_branch': z.string().trim().max(80),
        'promptpay.provider_endpoint': z.string().trim().max(300),
        'update.feed_url': z.string().trim().max(300),
        'update.auto_check': z.boolean(),
      })
      .partial(),
  ),
} as const
