import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import type { IngredientStock } from '@main/db/repos/stock.repo'
import type { ParsedInput } from '@shared/api'
import type { IngredientDto, LotDto } from '@shared/api-sales'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import type { AuditService } from './audit.service'
import type { StockService } from './stock/stock.service'

/** Ingredients and lots. Receiving with purchase orders and stock counts come in phase 3. */
export class InventoryService {
  constructor(
    private readonly db: Db,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {}

  ingredients(actor: Actor): IngredientDto[] {
    return this.stock.repo.ingredientsWithStock(actor.branchId).map(toDto)
  }

  saveIngredient(actor: Actor, input: ParsedInput<'inventory.saveIngredient'>): IngredientDto {
    const at = this.now()
    const row = {
      name: input.name,
      base_unit: input.baseUnit,
      pack_size_milli: input.packSizeMilli,
      min_qty_milli: input.minQtyMilli,
      has_expiry: (input.hasExpiry ? 1 : 0) as 0 | 1,
      default_size_mode: input.defaultSizeMode,
      is_daily_count: (input.isDailyCount ? 1 : 0) as 0 | 1,
    }
    let id = input.id
    this.db.transaction(() => {
      if (id) {
        const before = this.stock.repo.ingredient(id)
        if (!before || before.branch_id !== actor.branchId || before.deleted_at) throw new AppError('NOT_FOUND')
        // changing the unit would silently reinterpret every stored quantity
        if (before.base_unit !== row.base_unit && this.stock.repo.lotsOf(id).length > 0) throw new AppError('IN_USE', { field: 'baseUnit' })
        this.stock.repo.updateIngredient(id, row, at)
        this.audit.append({ action: 'inventory.ingredient_update', permission: 'inventory:update', userId: actor.userId, branchId: actor.branchId, entity: 'ingredients', entityId: id, before, after: row })
      } else {
        id = uuidv7(at)
        this.stock.repo.insertIngredient({ id, branch_id: actor.branchId, ...row, created_at: at, updated_at: at })
        this.audit.append({ action: 'inventory.ingredient_create', permission: 'inventory:update', userId: actor.userId, branchId: actor.branchId, entity: 'ingredients', entityId: id, after: row })
      }
    }).immediate()
    return this.ingredients(actor).find((i) => i.id === id)!
  }

  deleteIngredient(actor: Actor, id: string): void {
    const ing = this.stock.repo.ingredient(id)
    if (!ing || ing.branch_id !== actor.branchId || ing.deleted_at) throw new AppError('NOT_FOUND')
    const usedIn = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM recipe_items WHERE ingredient_id = ? AND deleted_at IS NULL)
              + (SELECT count(*) FROM modifier_option_items WHERE ingredient_id = ? AND deleted_at IS NULL)`,
      )
      .pluck()
      .get(id, id) as number
    if (usedIn > 0) throw new AppError('IN_USE')
    const at = this.now()
    this.db.transaction(() => {
      this.stock.repo.updateIngredient(id, { deleted_at: at }, at)
      this.audit.append({ action: 'inventory.ingredient_delete', permission: 'inventory:delete', userId: actor.userId, branchId: actor.branchId, entity: 'ingredients', entityId: id, before: ing, risk: 'medium' })
    }).immediate()
  }

  lots(actor: Actor, ingredientId: string): LotDto[] {
    const ing = this.stock.repo.ingredient(ingredientId)
    if (!ing || ing.branch_id !== actor.branchId) throw new AppError('NOT_FOUND')
    return this.stock.repo.lotsOf(ingredientId).map((l) => ({
      id: l.id,
      lotNo: l.lot_no,
      source: l.source,
      qtyReceivedMilli: l.qty_received_milli,
      qtyRemainingMilli: l.qty_remaining_milli,
      totalCostSatang: l.total_cost_satang,
      receivedAt: l.received_at,
      expiresAt: l.expires_at,
    }))
  }

  /** Receives stock without a PO; settles open shortages first (D16). One transaction. */
  addLot(actor: Actor, deviceId: string | null, input: ParsedInput<'inventory.addLot'>): { lotId: string; settledMilli: number } {
    const ing = this.stock.repo.ingredient(input.ingredientId)
    if (!ing || ing.branch_id !== actor.branchId || ing.deleted_at) throw new AppError('NOT_FOUND')
    if (ing.has_expiry === 1 && input.expiresAt === null) throw new AppError('INVALID_INPUT', { fields: { expiresAt: ['required'] } })
    const at = this.now()
    return this.db.transaction(() => {
      const res = this.stock.receive(
        { branchId: actor.branchId, userId: actor.userId, deviceId, at },
        {
          ingredientId: ing.id,
          qtyMilli: input.qtyMilli,
          totalCostSatang: input.totalCostSatang,
          expiresAt: input.expiresAt,
          lotNo: input.lotNo ?? null,
          receivedAt: input.receivedAt ?? at,
        },
      )
      this.audit.append({
        action: 'inventory.receive',
        permission: 'inventory:create',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'stock_lots',
        entityId: res.lotId,
        after: { ingredientId: ing.id, qtyMilli: input.qtyMilli, totalCostSatang: input.totalCostSatang, expiresAt: input.expiresAt, settledShortageMilli: res.settledMilli },
      })
      return res
    }).immediate()
  }
}

function toDto(i: IngredientStock): IngredientDto {
  const available = i.on_hand_milli - i.shortage_milli
  return {
    id: i.id,
    name: i.name,
    baseUnit: i.base_unit,
    packSizeMilli: i.pack_size_milli,
    minQtyMilli: i.min_qty_milli,
    hasExpiry: i.has_expiry === 1,
    defaultSizeMode: i.default_size_mode,
    isDailyCount: i.is_daily_count === 1,
    onHandMilli: i.on_hand_milli,
    shortageMilli: i.shortage_milli,
    nextExpiry: i.next_expiry,
    lotCount: i.lot_count,
    status: available <= 0 ? 'out' : available <= i.min_qty_milli ? 'low' : 'ok',
  }
}
