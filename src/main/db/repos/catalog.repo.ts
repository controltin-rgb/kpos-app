import type { Db } from '../connection'

export interface CategoryRow {
  id: string
  branch_id: string
  name: string
  icon: string | null
  color: string | null
  kds_station: string | null
  sku_prefix: string | null
  sort_order: number
  deleted_at: number | null
}

export interface ProductRow {
  id: string
  branch_id: string
  category_id: string | null
  sku: string | null
  barcode: string | null
  name: string
  kind: 'drink' | 'food' | 'retail'
  vat_type: 'vat7' | 'vat0' | 'exempt'
  image_path: string | null
  active: 0 | 1
  sort_order: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface SizeRow {
  id: string
  product_id: string
  label: string
  price_satang: number
  size_multiplier_milli: number
  is_default: 0 | 1
  sort_order: number
  deleted_at: number | null
}

export interface RecipeRow {
  id: string
  product_id: string
  ingredient_id: string
  qty_milli: number
  size_mode: 'scale' | 'fixed' | 'custom'
  sort_order: number
}

export interface GroupRow {
  id: string
  branch_id: string
  name: string
  min_select: number
  max_select: number
  kds_highlight: 0 | 1
  sort_order: number
  deleted_at: number | null
}

export interface OptionRow {
  id: string
  group_id: string
  name: string
  price_satang: number
  is_default: 0 | 1
  sort_order: number
  deleted_at: number | null
}

export interface OptionItemRow {
  id: string
  option_id: string
  ingredient_id: string
  qty_milli: number
  size_mode: 'scale' | 'fixed'
}

const live = 'deleted_at IS NULL'

/** Categories, products, sizes, recipes (BOM), modifier groups/options and their BOM. */
export class CatalogRepo {
  constructor(private readonly db: Db) {}

  private update(table: string, id: string, patch: Record<string, unknown>, now: number) {
    const keys = Object.keys(patch)
    if (!keys.length) return
    this.db
      .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @__now, rev = rev + 1 WHERE id = @__id`)
      .run({ ...patch, __now: now, __id: id })
  }

  // ---- categories ---------------------------------------------------------
  categories(branchId: string): CategoryRow[] {
    return this.db.prepare(`SELECT * FROM categories WHERE branch_id = ? AND ${live} ORDER BY sort_order, name`).all(branchId) as CategoryRow[]
  }
  category(id: string): CategoryRow | undefined {
    return this.db.prepare(`SELECT * FROM categories WHERE id = ? AND ${live}`).get(id) as CategoryRow | undefined
  }
  insertCategory(r: Omit<CategoryRow, 'deleted_at'> & { now: number }) {
    this.db
      .prepare(
        `INSERT INTO categories (id, branch_id, name, icon, color, kds_station, sku_prefix, sort_order, created_at, updated_at)
         VALUES (@id, @branch_id, @name, @icon, @color, @kds_station, @sku_prefix, @sort_order, @now, @now)`,
      )
      .run(r)
  }
  updateCategory(id: string, patch: Partial<Omit<CategoryRow, 'id' | 'branch_id'>>, now: number) {
    this.update('categories', id, patch, now)
  }
  productsInCategory(categoryId: string): number {
    return this.db.prepare(`SELECT count(*) FROM products WHERE category_id = ? AND ${live}`).pluck().get(categoryId) as number
  }

  // ---- products -----------------------------------------------------------
  products(branchId: string): ProductRow[] {
    return this.db.prepare(`SELECT * FROM products WHERE branch_id = ? AND ${live} ORDER BY sort_order, name`).all(branchId) as ProductRow[]
  }
  product(id: string): ProductRow | undefined {
    return this.db.prepare(`SELECT * FROM products WHERE id = ? AND ${live}`).get(id) as ProductRow | undefined
  }
  skuTaken(branchId: string, sku: string, exceptId: string | null): boolean {
    return !!this.db.prepare(`SELECT 1 FROM products WHERE branch_id = ? AND sku = ? AND ${live} AND id IS NOT ?`).get(branchId, sku, exceptId)
  }
  /** every SKU starting with `prefix` in the branch, deleted products included (codes are never reused) */
  skusLike(branchId: string, prefix: string): string[] {
    return this.db.prepare(`SELECT sku FROM products WHERE branch_id = ? AND sku IS NOT NULL AND substr(sku, 1, ?) = ?`).pluck().all(branchId, prefix.length, prefix) as string[]
  }
  insertProduct(r: Omit<ProductRow, 'deleted_at' | 'created_at' | 'updated_at' | 'image_path'> & { now: number }) {
    this.db
      .prepare(
        `INSERT INTO products (id, branch_id, category_id, sku, barcode, name, kind, vat_type, active, sort_order, created_at, updated_at)
         VALUES (@id, @branch_id, @category_id, @sku, @barcode, @name, @kind, @vat_type, @active, @sort_order, @now, @now)`,
      )
      .run(r)
  }
  updateProduct(id: string, patch: Partial<Omit<ProductRow, 'id' | 'branch_id' | 'created_at' | 'updated_at'>>, now: number) {
    this.update('products', id, patch, now)
  }

  sizes(productId: string): SizeRow[] {
    return this.db.prepare(`SELECT * FROM product_sizes WHERE product_id = ? AND ${live} ORDER BY sort_order, price_satang`).all(productId) as SizeRow[]
  }
  sizesForProducts(productIds: readonly string[]): SizeRow[] {
    return this.db
      .prepare(`SELECT * FROM product_sizes WHERE product_id IN (SELECT value FROM json_each(?)) AND ${live} ORDER BY sort_order, price_satang`)
      .all(JSON.stringify(productIds)) as SizeRow[]
  }
  size(id: string): SizeRow | undefined {
    return this.db.prepare('SELECT * FROM product_sizes WHERE id = ?').get(id) as SizeRow | undefined
  }
  upsertSize(r: Omit<SizeRow, 'deleted_at'>, now: number) {
    this.db
      .prepare(
        `INSERT INTO product_sizes (id, product_id, label, price_satang, size_multiplier_milli, is_default, sort_order, created_at, updated_at)
         VALUES (@id, @product_id, @label, @price_satang, @size_multiplier_milli, @is_default, @sort_order, @now, @now)
         ON CONFLICT (id) DO UPDATE SET label = excluded.label, price_satang = excluded.price_satang,
           size_multiplier_milli = excluded.size_multiplier_milli, is_default = excluded.is_default,
           sort_order = excluded.sort_order, deleted_at = NULL, updated_at = excluded.updated_at, rev = rev + 1
         WHERE product_sizes.product_id = excluded.product_id`,
      )
      .run({ ...r, now })
  }
  deleteSizesExcept(productId: string, keepIds: readonly string[], now: number) {
    this.db
      .prepare(`UPDATE product_sizes SET deleted_at = ?, updated_at = ? WHERE product_id = ? AND ${live} AND id NOT IN (SELECT value FROM json_each(?))`)
      .run(now, now, productId, JSON.stringify(keepIds))
  }

  recipe(productId: string): RecipeRow[] {
    return this.db.prepare(`SELECT * FROM recipe_items WHERE product_id = ? AND ${live} ORDER BY sort_order`).all(productId) as RecipeRow[]
  }
  recipeForProducts(productIds: readonly string[]): RecipeRow[] {
    return this.db
      .prepare(`SELECT * FROM recipe_items WHERE product_id IN (SELECT value FROM json_each(?)) AND ${live} ORDER BY sort_order`)
      .all(JSON.stringify(productIds)) as RecipeRow[]
  }
  recipeSizeQty(recipeItemIds: readonly string[]): { recipe_item_id: string; size_id: string; qty_milli: number }[] {
    return this.db
      .prepare('SELECT * FROM recipe_item_size_qty WHERE recipe_item_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(recipeItemIds)) as { recipe_item_id: string; size_id: string; qty_milli: number }[]
  }
  replaceRecipe(productId: string, rows: (RecipeRow & { perSize: Record<string, number> })[], now: number) {
    this.db.prepare(`UPDATE recipe_items SET deleted_at = ?, updated_at = ? WHERE product_id = ? AND ${live}`).run(now, now, productId)
    const ins = this.db.prepare(
      `INSERT INTO recipe_items (id, product_id, ingredient_id, qty_milli, size_mode, sort_order, created_at, updated_at)
       VALUES (@id, @product_id, @ingredient_id, @qty_milli, @size_mode, @sort_order, @now, @now)`,
    )
    const insQty = this.db.prepare('INSERT INTO recipe_item_size_qty (recipe_item_id, size_id, qty_milli) VALUES (?, ?, ?)')
    for (const r of rows) {
      const { perSize, ...row } = r
      ins.run({ ...row, now })
      for (const [sizeId, q] of Object.entries(perSize)) insQty.run(r.id, sizeId, q)
    }
  }

  productGroups(productId: string): string[] {
    return this.db
      .prepare('SELECT group_id FROM product_modifier_groups WHERE product_id = ? ORDER BY sort_order')
      .pluck()
      .all(productId) as string[]
  }
  productGroupLinks(productIds: readonly string[]): { product_id: string; group_id: string }[] {
    return this.db
      .prepare('SELECT product_id, group_id FROM product_modifier_groups WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY sort_order')
      .all(JSON.stringify(productIds)) as { product_id: string; group_id: string }[]
  }
  replaceProductGroups(productId: string, groupIds: readonly string[]) {
    this.db.prepare('DELETE FROM product_modifier_groups WHERE product_id = ?').run(productId)
    const ins = this.db.prepare('INSERT INTO product_modifier_groups (product_id, group_id, sort_order) VALUES (?, ?, ?)')
    groupIds.forEach((g, i) => ins.run(productId, g, i))
  }

  // ---- modifier groups ----------------------------------------------------
  groups(branchId: string): GroupRow[] {
    return this.db.prepare(`SELECT * FROM modifier_groups WHERE branch_id = ? AND ${live} ORDER BY sort_order, name`).all(branchId) as GroupRow[]
  }
  group(id: string): GroupRow | undefined {
    return this.db.prepare(`SELECT * FROM modifier_groups WHERE id = ? AND ${live}`).get(id) as GroupRow | undefined
  }
  insertGroup(r: Omit<GroupRow, 'deleted_at'> & { now: number }) {
    this.db
      .prepare(
        `INSERT INTO modifier_groups (id, branch_id, name, min_select, max_select, kds_highlight, sort_order, created_at, updated_at)
         VALUES (@id, @branch_id, @name, @min_select, @max_select, @kds_highlight, @sort_order, @now, @now)`,
      )
      .run(r)
  }
  updateGroup(id: string, patch: Partial<Omit<GroupRow, 'id' | 'branch_id'>>, now: number) {
    this.update('modifier_groups', id, patch, now)
  }
  options(groupIds: readonly string[]): OptionRow[] {
    return this.db
      .prepare(`SELECT * FROM modifier_options WHERE group_id IN (SELECT value FROM json_each(?)) AND ${live} ORDER BY sort_order, name`)
      .all(JSON.stringify(groupIds)) as OptionRow[]
  }
  optionsByIds(ids: readonly string[]): OptionRow[] {
    return this.db
      .prepare(`SELECT * FROM modifier_options WHERE id IN (SELECT value FROM json_each(?)) AND ${live}`)
      .all(JSON.stringify(ids)) as OptionRow[]
  }
  upsertOption(r: Omit<OptionRow, 'deleted_at'>, now: number) {
    this.db
      .prepare(
        `INSERT INTO modifier_options (id, group_id, name, price_satang, is_default, sort_order, created_at, updated_at)
         VALUES (@id, @group_id, @name, @price_satang, @is_default, @sort_order, @now, @now)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, price_satang = excluded.price_satang, is_default = excluded.is_default,
           sort_order = excluded.sort_order, deleted_at = NULL, updated_at = excluded.updated_at, rev = rev + 1
         WHERE modifier_options.group_id = excluded.group_id`,
      )
      .run({ ...r, now })
  }
  deleteOptionsExcept(groupId: string, keepIds: readonly string[], now: number) {
    this.db
      .prepare(`UPDATE modifier_options SET deleted_at = ?, updated_at = ? WHERE group_id = ? AND ${live} AND id NOT IN (SELECT value FROM json_each(?))`)
      .run(now, now, groupId, JSON.stringify(keepIds))
  }
  optionItems(optionIds: readonly string[]): OptionItemRow[] {
    return this.db
      .prepare(`SELECT * FROM modifier_option_items WHERE option_id IN (SELECT value FROM json_each(?)) AND ${live}`)
      .all(JSON.stringify(optionIds)) as OptionItemRow[]
  }
  replaceOptionItems(optionId: string, rows: OptionItemRow[], now: number) {
    this.db.prepare(`UPDATE modifier_option_items SET deleted_at = ?, updated_at = ? WHERE option_id = ? AND ${live}`).run(now, now, optionId)
    const ins = this.db.prepare(
      `INSERT INTO modifier_option_items (id, option_id, ingredient_id, qty_milli, size_mode, created_at, updated_at)
       VALUES (@id, @option_id, @ingredient_id, @qty_milli, @size_mode, @now, @now)`,
    )
    for (const r of rows) ins.run({ ...r, now })
  }
}
