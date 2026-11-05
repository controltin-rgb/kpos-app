import { isSuperAdmin, type Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { RolesRepo, type RoleRow } from '@main/db/repos/roles.repo'
import type { ParsedInput, RoleSummary } from '@shared/api'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { hasPermission, isPermission, normalizePermissions, SYSTEM_ROLES, type Permission } from '@shared/permissions'
import type { AuditService } from './audit.service'

/** Rank given to custom roles (between Head Barista 50 and Cashier 30). */
export const CUSTOM_ROLE_RANK = 40

const LOCKED_KEYS = new Set(SYSTEM_ROLES.filter((r) => r.locked).map((r) => r.key as string))

/**
 * Roles and their resource:action permissions.
 *  - locked roles (Super Admin, Owner) cannot be edited or deleted
 *  - an actor may only edit roles ranked below their own (Super Admin: any non-locked role)
 *  - an actor may only grant permissions they hold themselves (no privilege escalation)
 *  - system roles cannot be deleted; custom roles only when no user has them
 * Every change is audited with risk=high (Implement.md §7).
 */
export class RolesService {
  private readonly roles: RolesRepo

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.roles = new RolesRepo(db)
  }

  list(actor: Actor): RoleSummary[] {
    return this.roles.list().map((r) => this.toSummary(actor, r, r.user_count))
  }

  create(actor: Actor, input: ParsedInput<'roles.create'>): RoleSummary {
    if (!isSuperAdmin(actor) && CUSTOM_ROLE_RANK >= actor.rank) throw new AppError('RANK_FORBIDDEN')
    const perms = this.checkGrantable(actor, input.permissions)
    const id = uuidv7()
    const at = this.now()
    this.db.transaction(() => {
      this.roles.insert({
        id,
        key: null,
        name: input.name,
        description: input.description ?? null,
        is_system: 0,
        rank: CUSTOM_ROLE_RANK,
        max_discount_bp: input.maxDiscountBp ?? 0,
        created_at: at,
        updated_at: at,
      })
      this.roles.replacePermissions(id, perms)
      this.audit.append({
        action: 'roles.create',
        permission: 'roles:create',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'roles',
        entityId: id,
        after: this.snapshot(id),
        risk: 'high',
      })
    }).immediate()
    return this.toSummary(actor, this.roles.findById(id)!, 0)
  }

  update(actor: Actor, input: ParsedInput<'roles.update'>): RoleSummary {
    const role = this.mustFindEditable(actor, input.id)
    const perms = input.permissions === undefined ? undefined : this.checkGrantable(actor, input.permissions)
    const at = this.now()
    this.db.transaction(() => {
      const before = this.snapshot(role.id)
      const patch: Parameters<RolesRepo['update']>[1] = {}
      if (input.name !== undefined) patch.name = input.name
      if (input.description !== undefined) patch.description = input.description
      if (input.maxDiscountBp !== undefined) patch.max_discount_bp = input.maxDiscountBp
      this.roles.update(role.id, patch, at)
      if (perms) this.roles.replacePermissions(role.id, perms)
      const after = this.snapshot(role.id)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.audit.append({
          action: 'roles.update',
          permission: 'roles:update',
          userId: actor.userId,
          branchId: actor.branchId,
          entity: 'roles',
          entityId: role.id,
          before,
          after,
          risk: 'high',
        })
      }
    }).immediate()
    return this.toSummary(actor, this.roles.findById(role.id)!, this.roles.activeUserCount(role.id))
  }

  delete(actor: Actor, id: string): void {
    const role = this.mustFindEditable(actor, id)
    if (role.is_system === 1) throw new AppError('ROLE_LOCKED')
    const at = this.now()
    this.db.transaction(() => {
      if (this.roles.activeUserCount(role.id) > 0) throw new AppError('ROLE_IN_USE')
      const before = this.snapshot(role.id)
      this.roles.update(role.id, { deleted_at: at }, at)
      this.audit.append({
        action: 'roles.delete',
        permission: 'roles:delete',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'roles',
        entityId: role.id,
        before,
        risk: 'high',
      })
    }).immediate()
  }

  // -------------------------------------------------------------------------

  private isLocked(r: Pick<RoleRow, 'key'>): boolean {
    return r.key !== null && LOCKED_KEYS.has(r.key)
  }

  private mayEdit(actor: Actor, r: Pick<RoleRow, 'key' | 'rank'>): boolean {
    if (this.isLocked(r)) return false
    return isSuperAdmin(actor) || r.rank < actor.rank
  }

  private mustFindEditable(actor: Actor, id: string): RoleRow {
    const role = this.roles.findById(id)
    if (!role) throw new AppError('NOT_FOUND')
    if (this.isLocked(role)) throw new AppError('ROLE_LOCKED')
    if (!this.mayEdit(actor, role)) throw new AppError('RANK_FORBIDDEN')
    return role
  }

  /** Validates keys, adds implied :view, and rejects anything the actor does not hold. */
  private checkGrantable(actor: Actor, raw: readonly string[]): Permission[] {
    const invalid = raw.filter((p) => !isPermission(p))
    if (invalid.length) throw new AppError('INVALID_INPUT', { invalid })
    const perms = normalizePermissions(raw as Permission[])
    const escalation = perms.filter((p) => !hasPermission(actor.grants, p))
    if (escalation.length) throw new AppError('PRIVILEGE_ESCALATION', { permissions: escalation })
    return perms
  }

  private snapshot(id: string) {
    const r = this.roles.findById(id)!
    return {
      name: r.name,
      description: r.description,
      maxDiscountBp: r.max_discount_bp,
      permissions: this.roles.permissions(id),
    }
  }

  private toSummary(actor: Actor, r: RoleRow, userCount: number): RoleSummary {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      rank: r.rank,
      description: r.description,
      isSystem: r.is_system === 1,
      locked: this.isLocked(r),
      editable: this.mayEdit(actor, r),
      assignable: isSuperAdmin(actor) || r.rank < actor.rank,
      userCount,
      permissions: this.roles.permissions(r.id),
      maxDiscountBp: r.max_discount_bp,
    }
  }
}
