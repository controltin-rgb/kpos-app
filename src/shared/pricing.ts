import { requirementPerUnit, type ModifierLine, type RecipeLine, type Requirement } from './bom'
import { AppError } from './errors'
import type { VatType } from './sale-totals'

/**
 * Everything needed to price one product and compute its BOM — plain JSON so a Client can keep a
 * copy for selling while the Host is down (D36). The Host prices from the same structure, so an
 * offline sale and an online one can never disagree on the rules.
 */
export interface SaleableSnapshot {
  id: string
  name: string
  categoryId: string | null
  kind: 'drink' | 'food' | 'retail'
  vatType: VatType
  /** KDS station of the product's category (null = no ticket, e.g. retail) */
  kdsStation: string | null
  sizes: { id: string; label: string; priceSatang: number; multiplierMilli: number; isDefault: boolean }[]
  recipe: RecipeLine[]
  groups: {
    id: string
    name: string
    minSelect: number
    maxSelect: number
    kdsHighlight: boolean
    options: { id: string; name: string; priceSatang: number; items: ModifierLine[] }[]
  }[]
}

export interface CartItem {
  productId: string
  sizeId: string | null
  qty: number
  optionIds: readonly string[]
  note?: string | null | undefined
}

export interface PricedLine {
  productId: string
  sizeId: string | null
  productName: string
  sizeLabel: string | null
  qty: number
  unitPriceSatang: number
  vatType: VatType
  note: string | null
  kdsStation: string | null
  categoryId: string | null
  modifiers: { optionId: string; groupName: string; optionName: string; priceSatang: number; highlight: boolean }[]
  requirementPerUnit: Requirement[]
}

/** Prices one cart line and computes its per-unit BOM. Throws PRODUCT_UNAVAILABLE / INVALID_MODIFIERS. */
export function priceLine(p: SaleableSnapshot | null | undefined, item: CartItem): PricedLine {
  if (!p) throw new AppError('PRODUCT_UNAVAILABLE', { productId: item.productId })
  const size = item.sizeId ? p.sizes.find((s) => s.id === item.sizeId) : (p.sizes.find((s) => s.isDefault) ?? p.sizes[0])
  if (item.sizeId && !size) throw new AppError('PRODUCT_UNAVAILABLE', { sizeId: item.sizeId })
  if (!size) throw new AppError('PRODUCT_UNAVAILABLE', { productId: item.productId })

  const chosen = new Set(item.optionIds)
  if (chosen.size !== item.optionIds.length) throw new AppError('INVALID_MODIFIERS')
  const modifiers: PricedLine['modifiers'] = []
  const modBoms: ModifierLine[][] = []
  let found = 0
  for (const g of p.groups) {
    const picked = g.options.filter((o) => chosen.has(o.id))
    if (picked.length < g.minSelect || picked.length > g.maxSelect) throw new AppError('INVALID_MODIFIERS', { group: g.name })
    for (const o of picked) {
      modifiers.push({ optionId: o.id, groupName: g.name, optionName: o.name, priceSatang: o.priceSatang, highlight: g.kdsHighlight })
      modBoms.push(o.items)
      found++
    }
  }
  if (found !== chosen.size) throw new AppError('INVALID_MODIFIERS') // option not offered for this product

  return {
    productId: p.id,
    sizeId: size.id,
    productName: p.name,
    sizeLabel: p.sizes.length > 1 ? size.label : null,
    qty: item.qty,
    unitPriceSatang: size.priceSatang + modifiers.reduce((s, m) => s + m.priceSatang, 0),
    vatType: p.vatType,
    note: item.note ?? null,
    kdsStation: p.kdsStation,
    categoryId: p.categoryId,
    modifiers,
    requirementPerUnit: requirementPerUnit(p.recipe, { id: size.id, multiplierMilli: size.multiplierMilli }, modBoms),
  }
}
