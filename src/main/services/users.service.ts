import { isSuperAdmin, type Actor } from '@main/auth/actor'
import type { AuthService } from '@main/auth/auth.service'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import { RolesRepo, type RoleRow } from '@main/db/repos/roles.repo'
import { UsersRepo, type UserWithRole } from '@main/db/repos/users.repo'
import type { ParsedInput, RoleOption, UserDetail, UserList, UserListItem } from '@shared/api'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import type { AuditService } from './audit.service'
import { DEFAULT_EMPLOYEE_CAP } from './setup.service'

/**
 * User accounts. Permission (users:*) is checked by the IPC router; this service enforces the
 * rules that depend on data:
 *  - an actor may only manage users whose role ranks below their own (Super Admin: everyone)
 *  - an actor may only assign roles ranked below their own (Super Admin: any)
 *  - nobody can disable, delete or change the role of their own account
 *  - at least one active Super Admin must remain
 *  - active users per branch may not exceed the employee cap (license; default 10)
 */
export class UsersService {
  private readonly users: UsersRepo
  private readonly roles: RolesRepo
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
    /** employee cap from the license (D13/D29); falls back to the setting / default 10 */
    private readonly cap?: () => number,
  ) {
    this.users = new UsersRepo(db)
    this.roles = new RolesRepo(db)
    this.org = new OrgRepo(db)
  }

  employeeCap(branchId: string): number {
    if (this.cap) return this.cap()
    return this.org.getSetting<number>('license.employee_cap', branchId) ?? DEFAULT_EMPLOYEE_CAP
  }

  list(actor: Actor, q: ParsedInput<'users.list'>): UserList {
    const { rows, total } = this.users.list({
      branchId: actor.branchId,
      search: q.search || undefined,
      roleId: q.roleId,
      status: q.status,
      limit: q.pageSize,
      offset: (q.page - 1) * q.pageSize,
    })
    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page: q.page,
      pageSize: q.pageSize,
      activeCount: this.users.countActive(actor.branchId),
      employeeCap: this.employeeCap(actor.branchId),
    }
  }

  get(actor: Actor, id: string): UserDetail {
    return this.toDetail(actor, this.mustFind(actor, id))
  }

  roleOptions(actor: Actor): RoleOption[] {
    return this.roles.list().map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      rank: r.rank,
      description: r.description,
      permissions: this.roles.permissions(r.id),
      assignable: this.mayAssign(actor, r),
    }))
  }

  async create(actor: Actor, input: ParsedInput<'users.create'>): Promise<UserDetail> {
    const role = this.roles.findById(input.roleId)
    if (!role) throw new AppError('NOT_FOUND', { entity: 'roles' })
    if (!this.mayAssign(actor, role)) throw new AppError('RANK_FORBIDDEN')
    if (this.users.usernameExists(input.username)) throw new AppError('USERNAME_TAKEN')
    this.assertCap(actor.branchId)

    const id = uuidv7()
    const pinHash = input.pin ? this.authService.hashPin(input.pin) : null
    const authUserId = await this.authService.createCredentials(id, input.displayName, input.password)
    try {
      const at = this.now()
      this.db.transaction(() => {
        // re-check what may have changed while credentials were being created
        if (this.users.usernameExists(input.username)) throw new AppError('USERNAME_TAKEN')
        this.assertCap(actor.branchId)
        this.users.insert({
          id,
          branch_id: actor.branchId,
          role_id: role.id,
          username: input.username,
          display_name: input.displayName,
          email: null,
          phone: null,
          pin_hash: pinHash,
          active: 1,
          auth_user_id: authUserId,
          must_change_password: input.mustChangePassword ? 1 : 0,
          created_at: at,
          updated_at: at,
        })
        this.audit.append({
          action: 'users.create',
          permission: 'users:create',
          userId: actor.userId,
          branchId: actor.branchId,
          entity: 'users',
          entityId: id,
          after: this.snapshot(this.users.findById(id)!),
          risk: 'medium',
        })
      }).immediate()
    } catch (err) {
      await this.authService.deleteCredentials(authUserId)
      throw err
    }
    return this.get(actor, id)
  }

  async update(actor: Actor, input: ParsedInput<'users.update'>): Promise<UserDetail> {
    const target = this.mustFindEditable(actor, input.id)
    const self = target.id === actor.userId
    const patch: Parameters<UsersRepo['update']>[1] = {}

    if (input.displayName !== undefined && input.displayName !== target.display_name) patch.display_name = input.displayName
    if (input.username !== undefined && input.username !== target.username) {
      if (this.users.usernameExists(input.username, target.id)) throw new AppError('USERNAME_TAKEN')
      patch.username = input.username
    }
    if (input.mustChangePassword !== undefined) patch.must_change_password = input.mustChangePassword ? 1 : 0

    let newRole: RoleRow | undefined
    if (input.roleId !== undefined && input.roleId !== target.role_id) {
      if (self) throw new AppError('CANNOT_MODIFY_SELF')
      newRole = this.roles.findById(input.roleId)
      if (!newRole) throw new AppError('NOT_FOUND', { entity: 'roles' })
      if (!this.mayAssign(actor, newRole)) throw new AppError('RANK_FORBIDDEN')
      patch.role_id = newRole.id
    }
    if (input.active !== undefined && (input.active ? 1 : 0) !== target.active) {
      if (self) throw new AppError('CANNOT_MODIFY_SELF')
      patch.active = input.active ? 1 : 0
    }

    const leavesSuperAdmin =
      target.role_key === 'super_admin' && target.active === 1 && (patch.active === 0 || (newRole && newRole.key !== 'super_admin'))
    const reactivates = patch.active === 1

    const at = this.now()
    this.db.transaction(() => {
      if (leavesSuperAdmin && this.users.countActiveWithRoleKey('super_admin') <= 1) throw new AppError('LAST_SUPER_ADMIN')
      if (reactivates) this.assertCap(target.branch_id)
      const before = this.snapshot(target)
      this.users.update(target.id, patch, at)
      const after = this.snapshot(this.users.findById(target.id)!)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        this.audit.append({
          action: 'users.update',
          permission: 'users:update',
          userId: actor.userId,
          branchId: actor.branchId,
          entity: 'users',
          entityId: target.id,
          before,
          after,
          risk: patch.role_id || patch.active !== undefined ? 'high' : 'medium',
        })
      }
    }).immediate()

    // disabling or changing the role ends the target's sessions immediately
    if ((patch.active === 0 || patch.role_id) && target.auth_user_id) await this.authService.revokeSessions(target.auth_user_id)
    return this.get(actor, target.id)
  }

  async resetPassword(actor: Actor, id: string, newPassword: string): Promise<UserDetail> {
    const target = this.mustFindEditable(actor, id)
    if (!target.auth_user_id) throw new AppError('NOT_FOUND')
    await this.authService.setPassword(target.auth_user_id, newPassword)
    const self = target.id === actor.userId
    const at = this.now()
    this.db.transaction(() => {
      this.users.update(
        target.id,
        { must_change_password: self ? 0 : 1, failed_login_count: 0, locked_until: null },
        at,
      )
      this.audit.append({
        action: 'users.reset_password',
        permission: 'users:update',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'users',
        entityId: target.id,
        risk: 'high',
      })
    }).immediate()
    if (!self) await this.authService.revokeSessions(target.auth_user_id)
    return this.get(actor, target.id)
  }

  setPin(actor: Actor, id: string, pin: string): UserDetail {
    const target = this.mustFindEditable(actor, id)
    const pinHash = this.authService.hashPin(pin)
    const at = this.now()
    this.db.transaction(() => {
      this.users.update(target.id, { pin_hash: pinHash }, at)
      this.audit.append({
        action: 'users.set_pin',
        permission: 'users:update',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'users',
        entityId: target.id,
        before: { hasPin: target.pin_hash !== null },
        after: { hasPin: true },
        risk: 'medium',
      })
    }).immediate()
    return this.get(actor, target.id)
  }

  async delete(actor: Actor, id: string): Promise<void> {
    const target = this.mustFindEditable(actor, id)
    if (target.id === actor.userId) throw new AppError('CANNOT_MODIFY_SELF')
    const at = this.now()
    this.db.transaction(() => {
      if (target.role_key === 'super_admin' && target.active === 1 && this.users.countActiveWithRoleKey('super_admin') <= 1)
        throw new AppError('LAST_SUPER_ADMIN')
      this.users.update(target.id, { active: 0, deleted_at: at }, at)
      this.audit.append({
        action: 'users.delete',
        permission: 'users:delete',
        userId: actor.userId,
        branchId: actor.branchId,
        entity: 'users',
        entityId: target.id,
        before: this.snapshot(target),
        risk: 'high',
      })
    }).immediate()
    if (target.auth_user_id) await this.authService.revokeSessions(target.auth_user_id)
  }

  // -------------------------------------------------------------------------

  private mayManage(actor: Actor, target: Pick<UserWithRole, 'id' | 'role_rank'>): boolean {
    return isSuperAdmin(actor) || target.id === actor.userId || target.role_rank < actor.rank
  }

  private mayAssign(actor: Actor, role: Pick<RoleRow, 'rank'>): boolean {
    return isSuperAdmin(actor) || role.rank < actor.rank
  }

  private mustFind(actor: Actor, id: string): UserWithRole {
    const u = this.users.findById(id)
    // users of other branches are invisible until multi-branch access is implemented
    if (!u || (u.branch_id !== actor.branchId && !isSuperAdmin(actor))) throw new AppError('NOT_FOUND')
    return u
  }

  private mustFindEditable(actor: Actor, id: string): UserWithRole {
    const u = this.mustFind(actor, id)
    if (!this.mayManage(actor, u)) throw new AppError('RANK_FORBIDDEN')
    return u
  }

  private assertCap(branchId: string): void {
    const cap = this.employeeCap(branchId)
    if (this.users.countActive(branchId) >= cap) throw new AppError('EMPLOYEE_CAP_REACHED', { cap })
  }

  private toListItem(u: UserWithRole): UserListItem {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      roleId: u.role_id,
      roleName: u.role_name,
      active: u.active === 1,
      locked: u.locked_until !== null && u.locked_until > this.now(),
      lastLoginAt: u.last_login_at,
    }
  }

  private toDetail(actor: Actor, u: UserWithRole): UserDetail {
    return {
      ...this.toListItem(u),
      roleKey: u.role_key,
      mustChangePassword: u.must_change_password === 1,
      hasPin: u.pin_hash !== null,
      createdAt: u.created_at,
      editable: this.mayManage(actor, u),
    }
  }

  /** Audit snapshot — never includes hashes or secrets. */
  private snapshot(u: UserWithRole) {
    return {
      username: u.username,
      displayName: u.display_name,
      roleId: u.role_id,
      roleKey: u.role_key,
      active: u.active === 1,
      mustChangePassword: u.must_change_password === 1,
      hasPin: u.pin_hash !== null,
    }
  }
}
