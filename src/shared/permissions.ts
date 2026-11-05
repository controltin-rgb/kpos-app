/**
 * RBAC catalogue — `resource:action` (Implement.md §7, matrix shape from docs/design/Roles.dc.html).
 * Page permissions: view / create / update / delete; special actions are listed separately.
 * Thai labels live in the renderer i18n files, not here.
 */

export const CRUD = ['view', 'create', 'update', 'delete'] as const
export type CrudAction = (typeof CRUD)[number]

/** Pages/resources and which CRUD actions apply to each (from the Roles prototype). */
export const RESOURCES = {
  dashboard: ['view'],
  pos: ['view', 'create'], // create = open a sale
  kds: ['view', 'update'], // update = change order status
  orders: ['view', 'create', 'update'],
  shift: ['view', 'create', 'update'], // create = open shift, update = close/count
  products: ['view', 'create', 'update', 'delete'],
  inventory: ['view', 'create', 'update', 'delete'], // receiving, counts, waste, labels
  promo: ['view', 'create', 'update', 'delete'],
  expenses: ['view', 'create', 'update', 'delete'],
  reports: ['view'],
  users: ['view', 'create', 'update', 'delete'],
  roles: ['view', 'create', 'update', 'delete'],
  audit: ['view'],
  backup: ['view', 'create'], // create = run a backup
  settings: ['view', 'update'],
} as const satisfies Record<string, readonly CrudAction[]>

export type Resource = keyof typeof RESOURCES

/** Sensitive actions outside CRUD. */
export const SPECIAL_PERMISSIONS = [
  'pos:void',
  'pos:discount',
  'pos:edit_price',
  'orders:refund',
  'orders:tax_invoice',
  'shift:open_drawer',
  'shift:view_all', // see/close other users' shifts (Design-Spec §2: cashier = own shift only)
  'reports:view_cost',
  'reports:export',
  'inventory:adjust',
  'inventory:approve_count',
  'backup:restore', // Implement.md §6.10: highest privilege
  'license:manage', // Super Admin only (D6)
] as const

type CrudPermission = { [R in Resource]: `${R}:${(typeof RESOURCES)[R][number]}` }[Resource]
export type Permission = CrudPermission | (typeof SPECIAL_PERMISSIONS)[number]

/** Wildcard granted to Super Admin: matches every permission, including ones added in future versions. */
export const WILDCARD = '*'

export const ALL_PERMISSIONS: readonly Permission[] = [
  ...(Object.entries(RESOURCES) as [Resource, readonly CrudAction[]][]).flatMap(([r, acts]) =>
    acts.map((a) => `${r}:${a}` as Permission),
  ),
  ...SPECIAL_PERMISSIONS,
]

const ALL_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return ALL_SET.has(value)
}

/** Adds the implied `:view` for any create/update/delete, removes duplicates, sorts. */
export function normalizePermissions(perms: readonly Permission[]): Permission[] {
  const out = new Set<Permission>(perms)
  for (const p of perms) {
    const [res, act] = p.split(':') as [string, string]
    if ((CRUD as readonly string[]).includes(act) && act !== 'view' && res in RESOURCES) {
      out.add(`${res}:view` as Permission)
    }
  }
  return [...out].sort()
}

export function hasPermission(granted: ReadonlySet<string>, perm: Permission): boolean {
  return granted.has(WILDCARD) || granted.has(perm)
}

// ---------------------------------------------------------------------------
// Default system roles (D6). Seeded on first run; is_system roles cannot be deleted.
// ---------------------------------------------------------------------------

export type SystemRoleKey = 'super_admin' | 'owner' | 'branch_manager' | 'head_barista' | 'cashier'

export interface SystemRoleDef {
  key: SystemRoleKey
  rank: number
  /** locked roles cannot have their permissions edited */
  locked: boolean
  permissions: typeof WILDCARD | readonly Permission[]
  maxDiscountBp: number
}

const all = (...except: Permission[]) => ALL_PERMISSIONS.filter((p) => !except.includes(p))
const crud = (r: Resource, acts: readonly CrudAction[] = RESOURCES[r]) => acts.map((a) => `${r}:${a}` as Permission)

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  { key: 'super_admin', rank: 100, locked: true, permissions: WILDCARD, maxDiscountBp: 10_000 },
  { key: 'owner', rank: 90, locked: true, permissions: normalizePermissions(all('license:manage')), maxDiscountBp: 10_000 },
  {
    key: 'branch_manager',
    rank: 70,
    locked: false,
    // Roles prototype "ผู้จัดการ": everything except managing roles/settings; restore is Owner-only (Design-Spec §2)
    permissions: normalizePermissions([
      ...all(
        'license:manage',
        'backup:restore',
        'users:delete',
        'roles:create',
        'roles:update',
        'roles:delete',
        'backup:create',
        'settings:update',
      ),
    ]),
    maxDiscountBp: 10_000,
  },
  {
    key: 'head_barista',
    rank: 50,
    locked: false,
    // Design-Spec §2: menu/BOM/stock VAED, receiving & counts without approving, POS/promo view only
    permissions: normalizePermissions([
      'dashboard:view',
      'pos:view',
      ...crud('kds'),
      ...crud('products'),
      ...crud('inventory', ['view', 'create', 'update']),
      'promo:view',
      'reports:view',
    ]),
    maxDiscountBp: 0,
  },
  {
    key: 'cashier',
    rank: 30,
    locked: false,
    // Roles prototype "แคชเชียร์" + Design-Spec §2 (expenses during own shift)
    permissions: normalizePermissions([
      'dashboard:view',
      ...crud('pos'),
      'orders:view',
      ...crud('shift'),
      'shift:open_drawer',
      'promo:view',
      'expenses:create',
    ]),
    maxDiscountBp: 0,
  },
]

export function grantsFor(role: Pick<SystemRoleDef, 'permissions'>): ReadonlySet<string> {
  return new Set(role.permissions === WILDCARD ? [WILDCARD] : role.permissions)
}
