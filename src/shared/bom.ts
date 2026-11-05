/**
 * BOM (recipe) requirements — Implement.md §6.1.
 * Quantities are integer milli-units of the ingredient's base unit (D3); size multipliers are milli too (1.0× = 1000).
 *
 * size modes per recipe line:
 *  - scale  : qty × size multiplier (milk, syrup …)
 *  - fixed  : qty regardless of size (lid, straw …)
 *  - custom : explicit qty per size (16oz cup vs 22oz cup); falls back to `scale` if a size has no value
 */

export type SizeMode = 'scale' | 'fixed' | 'custom'

export interface RecipeLine {
  ingredientId: string
  qtyMilli: number
  sizeMode: SizeMode
  /** for sizeMode = 'custom': sizeId → qtyMilli */
  perSize?: Record<string, number>
}

export interface ModifierLine {
  ingredientId: string
  qtyMilli: number
  sizeMode: 'scale' | 'fixed'
}

export interface SizeRef {
  id: string
  multiplierMilli: number
}

export interface Requirement {
  ingredientId: string
  qtyMilli: number
}

/** a × m / 1000 rounded half up (non-negative inputs). */
function scale(qtyMilli: number, multiplierMilli: number): number {
  return Math.floor((qtyMilli * multiplierMilli * 2 + 1000) / 2000)
}

function lineQty(line: RecipeLine | ModifierLine, size: SizeRef | null): number {
  const mult = size?.multiplierMilli ?? 1000
  if (line.sizeMode === 'fixed') return line.qtyMilli
  if (line.sizeMode === 'custom') {
    const custom = size ? (line as RecipeLine).perSize?.[size.id] : undefined
    if (custom !== undefined) return custom
  }
  return scale(line.qtyMilli, mult)
}

/**
 * Ingredients needed for ONE unit of a product in a given size with the chosen modifiers.
 * Merged by ingredient, sorted by ingredient id, zero lines dropped. Stored as bill_items.bom_snapshot_json.
 */
export function requirementPerUnit(recipe: readonly RecipeLine[], size: SizeRef | null, modifiers: readonly (readonly ModifierLine[])[]): Requirement[] {
  const total = new Map<string, number>()
  const add = (id: string, q: number) => total.set(id, (total.get(id) ?? 0) + q)
  for (const line of recipe) add(line.ingredientId, lineQty(line, size))
  for (const mod of modifiers) for (const line of mod) add(line.ingredientId, lineQty(line, size))
  return [...total.entries()]
    .filter(([, q]) => q > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ingredientId, qtyMilli]) => ({ ingredientId, qtyMilli }))
}

/** Requirement for `qty` units. */
export function scaleRequirement(perUnit: readonly Requirement[], qty: number): Requirement[] {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer')
  return perUnit.map((r) => ({ ingredientId: r.ingredientId, qtyMilli: r.qtyMilli * qty }))
}
