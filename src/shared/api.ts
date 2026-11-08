import { z } from 'zod'
import { salesApi, type CfdState } from './api-sales'
import { expensesApi } from './api-expenses'
import { promoApi } from './api-promo'
import { reportsApi } from './api-reports'
import { dashboardApi } from './api-dashboard'
import { stockApi } from './api-stock'
import { aboutApi, licenseApi, opsApi, systemApi } from './api-system'
import { lanApi } from './api-lan'
import type { Permission } from './permissions'
import type { UpdateStatusDto } from './api-system'

/**
 * IPC contract: every renderer → main call is listed here with
 *  - access: 'public' | 'authenticated' | a resource:action permission (enforced in main, CLAUDE.md rule 5)
 *  - input: zod schema (validated in main before the handler runs)
 *  - output type (compile-time only)
 */

export type Access = 'public' | 'authenticated' | Permission

export interface Endpoint<I extends z.ZodType, O> {
  access: Access
  input: I
  /** phantom field carrying the output type */
  readonly __out?: O
}

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64)
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/)
export const passwordSchema = z.string().min(8).max(128)
export const pinSchema = z.string().regex(/^\d{4,6}$/)
export const displayNameSchema = z.string().trim().min(1).max(80)
const pageSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(7),
})

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SessionUser {
  userId: string
  username: string
  displayName: string
  branchId: string
  branchName: string
  roleId: string
  roleKey: string | null
  roleName: string
  /** '*' for Super Admin, otherwise the explicit list */
  permissions: string[]
  mustChangePassword: boolean
}

export interface SystemInfo {
  /** Standalone / Host / Client (D33) */
  deviceRole: 'standalone' | 'host' | 'client'
  deviceName: string
  /** Client: the Host it works through and whether it is reachable now */
  hostName: string | null
  hostConnected: boolean | null
  /** Client: offline bills still waiting for the Host (D36) */
  offlinePending: number | null
  appVersion: string
  electron: string
  node: string
  chrome: string
  sqlite: string
  schemaVersion: number
  platform: string
}

export interface SetupStatus {
  setupRequired: boolean
  shopName: string | null
  branchName: string | null
}

export interface UserListItem {
  id: string
  username: string
  displayName: string
  roleId: string
  roleName: string
  active: boolean
  locked: boolean
  lastLoginAt: number | null
}

export interface UserDetail extends UserListItem {
  roleKey: string | null
  mustChangePassword: boolean
  hasPin: boolean
  createdAt: number
  /** whether the current actor may edit this user (rank rules) */
  editable: boolean
}

export interface UserList {
  items: UserListItem[]
  total: number
  page: number
  pageSize: number
  activeCount: number
  employeeCap: number
}

export interface RoleOption {
  id: string
  key: string | null
  name: string
  rank: number
  description: string | null
  /** '*' for Super Admin */
  permissions: string[]
  /** actor may assign this role to a user */
  assignable: boolean
}

export interface RoleSummary extends RoleOption {
  isSystem: boolean
  locked: boolean
  /** actor may edit this role's permissions */
  editable: boolean
  userCount: number
  maxDiscountBp: number
}

export type AuditVerifyResult = (
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAtSeq?: number; reason: string }
) & {
  /** the newest verified backup's recorded audit head still matches the live log (null = no backup yet) */
  anchor?: { ok: boolean; seq: number; at: number } | null
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const roleInput = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).nullable().optional(),
  permissions: z.array(z.string()).max(200),
  maxDiscountBp: z.number().int().min(0).max(10_000).optional(),
}

export const api = {
  'system.info': ep<SystemInfo>()('public', z.undefined()),

  'setup.status': ep<SetupStatus>()('public', z.undefined()),
  'setup.complete': ep<SessionUser>()(
    'public',
    z.object({
      shopName: z.string().trim().min(1).max(120),
      branchName: z.string().trim().min(1).max(120),
      username: usernameSchema,
      displayName: displayNameSchema,
      password: passwordSchema,
    }),
  ),

  'auth.me': ep<SessionUser | null>()('public', z.undefined()),
  'auth.login': ep<SessionUser>()('public', z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) })),
  'auth.logout': ep<null>()('authenticated', z.undefined()),
  'auth.changePassword': ep<SessionUser>()(
    'authenticated',
    z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }),
  ),

  'users.list': ep<UserList>()(
    'users:view',
    pageSchema.extend({
      search: z.string().trim().max(64).optional(),
      roleId: id.optional(),
      status: z.enum(['all', 'active', 'inactive']).default('all'),
    }),
  ),
  'users.get': ep<UserDetail>()('users:view', z.object({ id })),
  'users.roleOptions': ep<RoleOption[]>()('users:view', z.undefined()),
  'users.create': ep<UserDetail>()(
    'users:create',
    z.object({
      username: usernameSchema,
      displayName: displayNameSchema,
      roleId: id,
      password: passwordSchema,
      pin: pinSchema.optional(),
      mustChangePassword: z.boolean().default(true),
    }),
  ),
  'users.update': ep<UserDetail>()(
    'users:update',
    z.object({
      id,
      username: usernameSchema.optional(),
      displayName: displayNameSchema.optional(),
      roleId: id.optional(),
      active: z.boolean().optional(),
      mustChangePassword: z.boolean().optional(),
    }),
  ),
  'users.resetPassword': ep<UserDetail>()('users:update', z.object({ id, newPassword: passwordSchema })),
  'users.setPin': ep<UserDetail>()('users:update', z.object({ id, pin: pinSchema })),
  'users.delete': ep<null>()('users:delete', z.object({ id })),

  'roles.list': ep<RoleSummary[]>()('roles:view', z.undefined()),
  'roles.create': ep<RoleSummary>()('roles:create', z.object(roleInput)),
  'roles.update': ep<RoleSummary>()(
    'roles:update',
    z.object({
      id,
      name: roleInput.name.optional(),
      description: roleInput.description,
      permissions: roleInput.permissions.optional(),
      maxDiscountBp: roleInput.maxDiscountBp,
    }),
  ),
  'roles.delete': ep<null>()('roles:delete', z.object({ id })),

  'audit.verify': ep<AuditVerifyResult>()('audit:view', z.undefined()),

  ...salesApi,
  ...stockApi,
  ...systemApi,
  ...licenseApi,
  ...aboutApi,
  ...opsApi,
  ...lanApi,
  ...expensesApi,
  ...promoApi,
  ...reportsApi,
  ...dashboardApi,
} as const

export type Api = typeof api
export type Channel = keyof Api
export type Input<C extends Channel> = z.input<Api[C]['input']>
export type ParsedInput<C extends Channel> = z.output<Api[C]['input']>
export type Output<C extends Channel> = Exclude<Api[C]['__out'], undefined>

/** The single Electron IPC channel all calls go through. */
export const RPC_CHANNEL = 'kposs:rpc'

/** Channel used by main to push AppEvents to every window. */
export const EVENT_CHANNEL = 'kposs:event'

/** Events pushed from main to all windows (KDS / CFD / POS refresh). */
export type AppEvent =
  | { type: 'kds.changed' }
  | { type: 'bill.changed'; billId: string }
  | { type: 'shift.changed' }
  | { type: 'cfd.state'; payload: CfdState }
  /** Client: connection to the Host changed (D33) */
  | { type: 'lan.state'; connected: boolean; error: string | null }
  /** Client: offline bills waiting for / refused by the Host (D36) */
  | { type: 'sync.state'; pending: number; rejected: number }
  /** auto-update progress (D42) */
  | { type: 'update.state'; status: UpdateStatusDto }

/** API surface exposed on window.kposs by the preload script. */
export interface KpossBridge {
  invoke(channel: string, input: unknown): Promise<unknown>
  /** subscribe to AppEvents; returns an unsubscribe function */
  onEvent(listener: (event: AppEvent) => void): () => void
}
