import type { Actor } from '@main/auth/actor'
import type { SaleableSnapshot } from '@shared/pricing'
import type { Db } from '@main/db/connection'
import { CatalogRepo, type GroupRow, type ProductRow } from '@main/db/repos/catalog.repo'
import { StockRepo } from '@main/db/repos/stock.repo'
import type { ParsedInput } from '@shared/api'
import type { CategoryDto, ModifierGroupDto, PosCatalog, ProductDto, SizeDto } from '@shared/api-sales'
import { requirementPerUnit, type ModifierLine, type RecipeLine } from '@shared/bom'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { vatInclusive } from '@shared/money'
import type { AuditService } from './audit.service'
import { consumedCost } from './stock/allocate'

/** Catalog data needed to price a sale and compute its BOM, read from the DB (never from the client). */
export interface SaleableProduct {
  product: ProductRow
  sizes: SizeDto[]
  recipe: RecipeLine[]
  groups: (GroupRow & { options: { id: string; name: string; priceSatang: number; items: ModifierLine[] }[] })[]
}

/**
 * Products, sizes, recipes (BOM), categories and modifier groups.
 * Catalog edits are audited (price/recipe changes affect money and stock).
 */
export class CatalogService {
  readonly repo: CatalogRepo
  private readonly stock: StockRepo

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.repo = new CatalogRepo(db)
    this.stock = new StockRepo(db)
  }

  // ---- categories ---------------------------------------------------------

  categories(actor: Actor): CategoryDto[] {
    return this.repo.categories(actor.branchId).map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      kdsStation: c.kds_station,
      skuPrefix: c.sku_prefix,
      sortOrder: c.sort_order,
      productCount: this.repo.productsInCategory(c.id),
    }))
  }

  saveCategory(actor: Actor, input: ParsedInput<'catalog.saveCategory'>): CategoryDto {
    const at = this.now()
    const row = { name: input.name, icon: input.icon ?? null, color: input.color ?? null, kds_station: input.kdsStation ?? null, sku_prefix: input.skuPrefix ?? null, sort_order: input.sortOrder }
    let id = input.id
    this.db.transaction(() => {
      if (id) {
        const before = this.repo.category(id)
        if (!before || before.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
        this.repo.updateCategory(id, row, at)
        this.log(actor, 'catalog.category_update', 'categories', id, before, row, 'low')
      } else {
        id = uuidv7(at)
        this.repo.insertCategory({ id, branch_id: actor.branchId, ...row, now: at })
        this.log(actor, 'catalog.category_create', 'categories', id, null, row, 'low')
      }
    }).immediate()
    return this.categories(actor).find((c) => c.id === id)!
  }

  deleteCategory(actor: Actor, id: string): void {
    const c = this.repo.category(id)
    if (!c || c.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    if (this.repo.productsInCategory(id) > 0) throw new AppError('IN_USE')
    const at = this.now()
    this.db.transaction(() => {
      this.repo.updateCategory(id, { deleted_at: at }, at)
      this.log(actor, 'catalog.category_delete', 'categories', id, c, null, 'medium')
    }).immediate()
  }

  // ---- products -----------------------------------------------------------

  /**
   * Next automatic SKU: <category prefix or "P">-<running number, 4+ digits> (D47).
   * Numbers are never reused, even after a product is deleted. Call inside the write transaction.
   */
  nextSku(actor: Pick<Actor, 'branchId'>, categoryId: string | null): string {
    const c = categoryId ? this.repo.category(categoryId) : undefined
    const prefix = `${(c?.branch_id === actor.branchId && c.sku_prefix) || 'P'}-`
    let max = 0
    for (const sku of this.repo.skusLike(actor.branchId, prefix)) {
      const m = /^(\d+)$/.exec(sku.slice(prefix.length))
      if (m) max = Math.max(max, Number(m[1]))
    }
    for (let n = max + 1; ; n++) {
      const sku = `${prefix}${String(n).padStart(4, '0')}`
      if (!this.repo.skuTaken(actor.branchId, sku, null)) return sku
    }
  }

  products(actor: Pick<Actor, 'branchId'>, vatRateBp = 0): ProductDto[] {
    const products = this.repo.products(actor.branchId)
    const ids = products.map((p) => p.id)
    const sizes = this.repo.sizesForProducts(ids)
    const recipe = this.repo.recipeForProducts(ids)
    const perSize = this.repo.recipeSizeQty(recipe.map((r) => r.id))
    const links = this.repo.productGroupLinks(ids)
    return products.map((p) => {
      const ps = sizes.filter((s) => s.product_id === p.id).map(toSizeDto)
      const pr = recipe
        .filter((r) => r.product_id === p.id)
        .map((r) => ({
          ingredientId: r.ingredient_id,
          qtyMilli: r.qty_milli,
          sizeMode: r.size_mode,
          perSize: Object.fromEntries(perSize.filter((q) => q.recipe_item_id === r.id).map((q) => [q.size_id, q.qty_milli])),
        }))
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        categoryId: p.category_id,
        kind: p.kind,
        vatType: p.vat_type,
        active: p.active === 1,
        sortOrder: p.sort_order,
        sizes: ps,
        recipe: pr,
        modifierGroupIds: links.filter((l) => l.product_id === p.id).map((l) => l.group_id),
        ...this.pricing(pr, ps.find((s) => s.isDefault) ?? ps[0] ?? null, p.vat_type, vatRateBp),
      }
    })
  }

  saveProduct(actor: Actor, input: ParsedInput<'catalog.saveProduct'>): ProductDto {
    if (input.categoryId && this.repo.category(input.categoryId)?.branch_id !== actor.branchId) throw new AppError('NOT_FOUND', { entity: 'categories' })
    if (input.sku && this.repo.skuTaken(actor.branchId, input.sku, input.id ?? null)) throw new AppError('SKU_TAKEN')
    for (const r of input.recipe) {
      if (this.stock.ingredient(r.ingredientId)?.branch_id !== actor.branchId) throw new AppError('NOT_FOUND', { entity: 'ingredients' })
    }
    if (new Set(input.recipe.map((r) => r.ingredientId)).size !== input.recipe.length) throw new AppError('INVALID_INPUT', { invalid: ['recipe'] })
    for (const g of input.modifierGroupIds) if (this.repo.group(g)?.branch_id !== actor.branchId) throw new AppError('NOT_FOUND', { entity: 'modifier_groups' })

    const at = this.now()
    const sizes = input.sizes.map((s, i) => ({ ...s, id: s.id ?? uuidv7(at) , sortOrder: i }))
    if (!sizes.some((s) => s.isDefault)) sizes[0]!.isDefault = true
    const sizeIds = new Set(sizes.map((s) => s.id))
    let id = input.id

    this.db.transaction(() => {
      const before = id ? this.snapshot(actor, id) : null
      const row = {
        category_id: input.categoryId ?? null,
        // empty SKU → automatic code (inside the transaction, so two tills never get the same number)
        sku: input.sku ?? this.nextSku(actor, input.categoryId ?? null),
        barcode: input.barcode ?? null,
        name: input.name,
        kind: input.kind,
        vat_type: input.vatType,
        active: (input.active ? 1 : 0) as 0 | 1,
        sort_order: input.sortOrder,
      }
      if (id) {
        const p = this.repo.product(id)
        if (!p || p.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
        this.repo.updateProduct(id, row, at)
      } else {
        id = uuidv7(at)
        this.repo.insertProduct({ id, branch_id: actor.branchId, ...row, now: at })
      }
      const pid = id
      for (const s of sizes) {
        const existing = this.repo.size(s.id)
        if (existing && existing.product_id !== pid) throw new AppError('INVALID_INPUT', { invalid: ['sizes'] })
        this.repo.upsertSize(
          { id: s.id, product_id: pid, label: s.label, price_satang: s.priceSatang, size_multiplier_milli: s.multiplierMilli, is_default: s.isDefault ? 1 : 0, sort_order: s.sortOrder },
          at,
        )
      }
      this.repo.deleteSizesExcept(pid, [...sizeIds], at)
      this.repo.replaceRecipe(
        pid,
        input.recipe.map((r, i) => ({
          id: uuidv7(at),
          product_id: pid,
          ingredient_id: r.ingredientId,
          qty_milli: r.qtyMilli,
          size_mode: r.sizeMode,
          sort_order: i,
          perSize: r.sizeMode === 'custom' ? Object.fromEntries(Object.entries(r.perSize).filter(([k]) => sizeIds.has(k))) : {},
        })),
        at,
      )
      this.repo.replaceProductGroups(pid, input.modifierGroupIds)
      this.log(actor, before ? 'catalog.product_update' : 'catalog.product_create', 'products', pid, before, this.snapshot(actor, pid), 'medium')
    }).immediate()
    return this.products(actor).find((p) => p.id === id)!
  }

  deleteProduct(actor: Actor, id: string): void {
    const p = this.repo.product(id)
    if (!p || p.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    const at = this.now()
    this.db.transaction(() => {
      const before = this.snapshot(actor, id)
      this.repo.updateProduct(id, { deleted_at: at, active: 0 }, at)
      this.log(actor, 'catalog.product_delete', 'products', id, before, null, 'medium')
    }).immediate()
  }

  // ---- modifier groups ----------------------------------------------------

  groups(actor: Pick<Actor, 'branchId'>): ModifierGroupDto[] {
    const groups = this.repo.groups(actor.branchId)
    const options = this.repo.options(groups.map((g) => g.id))
    const items = this.repo.optionItems(options.map((o) => o.id))
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      minSelect: g.min_select,
      maxSelect: g.max_select,
      kdsHighlight: g.kds_highlight === 1,
      sortOrder: g.sort_order,
      options: options
        .filter((o) => o.group_id === g.id)
        .map((o) => ({
          id: o.id,
          name: o.name,
          priceSatang: o.price_satang,
          isDefault: o.is_default === 1,
          items: items.filter((i) => i.option_id === o.id).map((i) => ({ ingredientId: i.ingredient_id, qtyMilli: i.qty_milli, sizeMode: i.size_mode })),
        })),
    }))
  }

  saveGroup(actor: Actor, input: ParsedInput<'catalog.saveGroup'>): ModifierGroupDto {
    if (input.maxSelect < input.minSelect) throw new AppError('INVALID_INPUT', { invalid: ['maxSelect'] })
    for (const o of input.options) for (const i of o.items) if (this.stock.ingredient(i.ingredientId)?.branch_id !== actor.branchId) throw new AppError('NOT_FOUND', { entity: 'ingredients' })
    const at = this.now()
    let id = input.id
    this.db.transaction(() => {
      const row = { name: input.name, min_select: input.minSelect, max_select: input.maxSelect, kds_highlight: (input.kdsHighlight ? 1 : 0) as 0 | 1, sort_order: input.sortOrder }
      const before = id ? this.groups(actor).find((g) => g.id === id) ?? null : null
      if (id) {
        const g = this.repo.group(id)
        if (!g || g.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
        this.repo.updateGroup(id, row, at)
      } else {
        id = uuidv7(at)
        this.repo.insertGroup({ id, branch_id: actor.branchId, ...row, now: at })
      }
      const gid = id
      const keep: string[] = []
      input.options.forEach((o, i) => {
        const oid = o.id ?? uuidv7(at)
        keep.push(oid)
        const existing = this.repo.optionsByIds([oid])[0]
        if (existing && existing.group_id !== gid) throw new AppError('INVALID_INPUT', { invalid: ['options'] })
        this.repo.upsertOption({ id: oid, group_id: gid, name: o.name, price_satang: o.priceSatang, is_default: o.isDefault ? 1 : 0, sort_order: i }, at)
        this.repo.replaceOptionItems(
          oid,
          o.items.map((it) => ({ id: uuidv7(at), option_id: oid, ingredient_id: it.ingredientId, qty_milli: it.qtyMilli, size_mode: it.sizeMode })),
          at,
        )
      })
      this.repo.deleteOptionsExcept(gid, keep, at)
      this.log(actor, before ? 'catalog.group_update' : 'catalog.group_create', 'modifier_groups', gid, before, this.groups(actor).find((g) => g.id === gid), 'medium')
    }).immediate()
    return this.groups(actor).find((g) => g.id === id)!
  }

  deleteGroup(actor: Actor, id: string): void {
    const g = this.repo.group(id)
    if (!g || g.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    const at = this.now()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM product_modifier_groups WHERE group_id = ?').run(id)
      this.repo.updateGroup(id, { deleted_at: at }, at)
      this.log(actor, 'catalog.group_delete', 'modifier_groups', id, g, null, 'medium')
    }).immediate()
  }

  // ---- POS ----------------------------------------------------------------

  posCatalog(actor: Pick<Actor, 'branchId'>): Omit<PosCatalog, 'vatRateBp' | 'deliveryEnabled' | 'promptPayId' | 'device' | 'branchName'> {
    const products = this.products(actor).filter((p) => p.active)
    const stockOut = new Set(
      this.stock
        .ingredientsWithStock(actor.branchId)
        .filter((i) => i.on_hand_milli - i.shortage_milli <= 0)
        .map((i) => i.id),
    )
    return {
      categories: this.repo.categories(actor.branchId).map((c) => ({ id: c.id, name: c.name, icon: c.icon, color: c.color })),
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        categoryId: p.categoryId,
        kind: p.kind,
        barcode: p.barcode,
        vatType: p.vatType,
        sizes: p.sizes,
        modifierGroupIds: p.modifierGroupIds,
        lowStock: p.recipe.some((r) => stockOut.has(r.ingredientId)),
      })),
      groups: this.groups(actor).map((g) => ({
        id: g.id,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        options: g.options.map((o) => ({ id: o.id, name: o.name, priceSatang: o.priceSatang, isDefault: o.isDefault })),
      })),
    }
  }

  /** Everything needed to price and deduct a product, from the DB. */
  saleable(branchId: string, productId: string): SaleableProduct | null {
    const product = this.repo.product(productId)
    if (!product || product.branch_id !== branchId || product.active !== 1) return null
    const recipeRows = this.repo.recipe(productId)
    const perSize = this.repo.recipeSizeQty(recipeRows.map((r) => r.id))
    const groupIds = this.repo.productGroups(productId)
    const groups = groupIds.map((g) => this.repo.group(g)).filter((g): g is GroupRow => !!g)
    const options = this.repo.options(groups.map((g) => g.id))
    const items = this.repo.optionItems(options.map((o) => o.id))
    return {
      product,
      sizes: this.repo.sizes(productId).map(toSizeDto),
      recipe: recipeRows.map((r) => ({
        ingredientId: r.ingredient_id,
        qtyMilli: r.qty_milli,
        sizeMode: r.size_mode,
        perSize: Object.fromEntries(perSize.filter((q) => q.recipe_item_id === r.id).map((q) => [q.size_id, q.qty_milli])),
      })),
      groups: groups.map((g) => ({
        ...g,
        options: options
          .filter((o) => o.group_id === g.id)
          .map((o) => ({
            id: o.id,
            name: o.name,
            priceSatang: o.price_satang,
            items: items.filter((i) => i.option_id === o.id).map((i) => ({ ingredientId: i.ingredient_id, qtyMilli: i.qty_milli, sizeMode: i.size_mode })),
          })),
      })),
    }
  }

  /** Plain-JSON pricing data of one product (shared/pricing.ts) — also copied to Clients for offline sales. */
  saleSnapshot(branchId: string, productId: string): SaleableSnapshot | null {
    const p = this.saleable(branchId, productId)
    if (!p) return null
    const category = p.product.category_id ? this.repo.category(p.product.category_id) : undefined
    return {
      id: p.product.id,
      name: p.product.name,
      categoryId: p.product.category_id,
      kind: p.product.kind,
      vatType: p.product.vat_type,
      kdsStation: p.product.kind === 'retail' ? null : (category?.kds_station ?? 'bar'),
      sizes: p.sizes.map((x) => ({ id: x.id, label: x.label, priceSatang: x.priceSatang, multiplierMilli: x.multiplierMilli, isDefault: x.isDefault })),
      recipe: p.recipe,
      groups: p.groups.map((g) => ({ id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, kdsHighlight: g.kds_highlight === 1, options: g.options })),
    }
  }

  /** Every active product of the branch as snapshots (Client offline copy, D36). */
  saleSnapshots(branchId: string): SaleableSnapshot[] {
    const ids = this.db.prepare('SELECT id FROM products WHERE branch_id = ? AND active = 1 AND deleted_at IS NULL').pluck().all(branchId) as string[]
    return ids.map((id) => this.saleSnapshot(branchId, id)).filter((x): x is SaleableSnapshot => x !== null)
  }

  // -------------------------------------------------------------------------

  private pricing(recipe: RecipeLine[], size: SizeDto | null, vatType: string, vatRateBp: number) {
    const costSatang = this.estimateCost(recipe, size)
    const price = size?.priceSatang ?? 0
    const netPriceSatang = vatType === 'vat7' && vatRateBp > 0 ? vatInclusive(price, vatRateBp).net : price
    const marginBp = costSatang === null || netPriceSatang <= 0 ? null : Math.round(((netPriceSatang - costSatang) * 10_000) / netPriceSatang)
    return { costSatang, netPriceSatang, marginBp }
  }

  /** Cost of one unit from the lots that would be used now (oldest lot's unit cost per ingredient). */
  private estimateCost(recipe: RecipeLine[], size: SizeDto | null): number | null {
    if (!recipe.length) return null
    let total = 0
    for (const r of requirementPerUnit(recipe, size ? { id: size.id, multiplierMilli: size.multiplierMilli } : null, [])) {
      const lot = this.stock.lotsOf(r.ingredientId).find((l) => l.qty_remaining_milli > 0) ?? this.stock.lotsOf(r.ingredientId)[0]
      if (!lot) return null
      total += consumedCost({ qtyReceivedMilli: lot.qty_received_milli, totalCostSatang: lot.total_cost_satang }, lot.qty_received_milli - r.qtyMilli)
    }
    return total
  }

  private snapshot(actor: Actor, id: string) {
    const p = this.products(actor).find((x) => x.id === id)
    if (!p) return null
    const { costSatang: _c, netPriceSatang: _n, marginBp: _m, ...rest } = p
    return rest
  }

  private log(actor: Actor, action: string, entity: string, entityId: string, before: unknown, after: unknown, risk: 'low' | 'medium') {
    this.audit.append({
      action,
      permission: action.endsWith('_delete') ? 'products:delete' : 'products:update',
      userId: actor.userId,
      branchId: actor.branchId,
      entity,
      entityId,
      before,
      after,
      risk,
    })
  }
}

function toSizeDto(s: { id: string; label: string; price_satang: number; size_multiplier_milli: number; is_default: 0 | 1 }): SizeDto {
  return { id: s.id, label: s.label, priceSatang: s.price_satang, multiplierMilli: s.size_multiplier_milli, isDefault: s.is_default === 1 }
}
