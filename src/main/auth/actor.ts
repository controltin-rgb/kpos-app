import type { OrgRepo } from '@main/db/repos/org.repo'
import type { RolesRepo } from '@main/db/repos/roles.repo'
import type { UserWithRole } from '@main/db/repos/users.repo'
import type { SessionUser } from '@shared/api'
import { hasPermission, WILDCARD, type Permission } from '@shared/permissions'

/** The authenticated user performing an action, with permissions loaded fresh from the DB. */
export interface Actor {
  userId: string
  username: string
  displayName: string
  branchId: string
  branchName: string
  roleId: string
  roleKey: string | null
  roleName: string
  rank: number
  grants: ReadonlySet<string>
  mustChangePassword: boolean
}

export function buildActor(user: UserWithRole, roles: RolesRepo, org: OrgRepo): Actor {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    branchId: user.branch_id,
    branchName: org.branch(user.branch_id)?.name ?? '',
    roleId: user.role_id,
    roleKey: user.role_key,
    roleName: user.role_name,
    rank: user.role_rank,
    grants: new Set(roles.permissions(user.role_id)),
    mustChangePassword: user.must_change_password === 1,
  }
}

export const can = (actor: Actor, p: Permission) => hasPermission(actor.grants, p)
export const isSuperAdmin = (actor: Actor) => actor.grants.has(WILDCARD)

export function toSessionUser(a: Actor): SessionUser {
  return {
    userId: a.userId,
    username: a.username,
    displayName: a.displayName,
    branchId: a.branchId,
    branchName: a.branchName,
    roleId: a.roleId,
    roleKey: a.roleKey,
    roleName: a.roleName,
    permissions: [...a.grants].sort(),
    mustChangePassword: a.mustChangePassword,
  }
}
