import type { Permission } from '@shared/permissions'
import { t } from '@renderer/i18n'
import type { IconName } from './icons'
import type { Tone } from './ui'

export interface NavLeaf {
  path: string
  label: string
  /** minimum permission to see the menu and open the page (main enforces again) */
  permission: Permission | null
  /** phase in docs/Implement.md §10 where the page is built (for placeholders) */
  phase: number
  breadcrumb?: string
}

export interface NavItem extends Partial<NavLeaf> {
  key: string
  label: string
  icon: IconName
  tone: Tone
  children?: NavLeaf[]
}

const n = t.nav

/** Sidebar order and icons follow docs/design/Dashboard.dc.html (Implement.md §8). */
export const NAV: NavItem[] = [
  { key: 'dashboard', label: n.dashboard, icon: 'home', tone: 'violet', path: '/', permission: 'dashboard:view', phase: 3, breadcrumb: 'Dashboard' },
  { key: 'pos', label: n.pos, icon: 'monitor', tone: 'orange', path: '/pos', permission: 'pos:view', phase: 2 },
  { key: 'orders', label: n.orders, icon: 'receipt', tone: 'blue', path: '/orders', permission: 'orders:view', phase: 2 },
  { key: 'shift', label: n.shift, icon: 'clock', tone: 'green', path: '/shift', permission: 'shift:view', phase: 2 },
  {
    key: 'prod',
    label: n.productsGroup,
    icon: 'cup',
    tone: 'pink',
    children: [
      { path: '/products', label: n.products, permission: 'products:view', phase: 2 },
      { path: '/categories', label: n.categories, permission: 'products:view', phase: 2 },
      { path: '/modifiers', label: n.modifiers, permission: 'products:view', phase: 2 },
    ],
  },
  {
    key: 'stock',
    label: n.stockGroup,
    icon: 'box',
    tone: 'violet',
    children: [
      { path: '/inventory', label: n.inventory, permission: 'inventory:view', phase: 2 },
      { path: '/receiving', label: n.receiving, permission: 'inventory:view', phase: 3 },
      { path: '/stock-count', label: n.stockCount, permission: 'inventory:view', phase: 3 },
    ],
  },
  { key: 'waste', label: n.waste, icon: 'trash', tone: 'red', path: '/waste', permission: 'inventory:view', phase: 3 },
  {
    key: 'promo',
    label: n.promoGroup,
    icon: 'tag',
    tone: 'amber',
    children: [
      { path: '/promo', label: n.promo, permission: 'promo:view', phase: 3 },
      { path: '/coupons', label: n.coupons, permission: 'promo:view', phase: 3 },
    ],
  },
  { key: 'expenses', label: n.expenses, icon: 'wallet', tone: 'teal', path: '/expenses', permission: 'expenses:view', phase: 3 },
  {
    key: 'rep',
    label: n.reportsGroup,
    icon: 'chart',
    tone: 'blue',
    children: [
      { path: '/reports', label: n.reports, permission: 'reports:view', phase: 3 },
      { path: '/z-report', label: n.zReport, permission: 'reports:view', phase: 3 },
      { path: '/delivery-commission', label: n.deliveryCommission, permission: 'reports:view', phase: 3 },
    ],
  },
  { key: 'label', label: n.label, icon: 'label', tone: 'orange', path: '/label', permission: 'inventory:view', phase: 3 },
  {
    key: 'sec',
    label: n.securityGroup,
    icon: 'lock',
    tone: 'violet',
    children: [
      { path: '/users', label: n.users, permission: 'users:view', phase: 1, breadcrumb: t.users.breadcrumb },
      { path: '/roles', label: n.roles, permission: 'roles:view', phase: 1, breadcrumb: t.roles.breadcrumb },
    ],
  },
  { key: 'audit', label: n.audit, icon: 'shield', tone: 'pink', path: '/audit', permission: 'audit:view', phase: 4 },
  { key: 'backup', label: n.backup, icon: 'cloud', tone: 'green', path: '/backup', permission: 'backup:view', phase: 4 },
  { key: 'settings', label: n.settings, icon: 'gear', tone: 'teal', path: '/settings', permission: 'settings:view', phase: 4 },
  { key: 'system', label: n.system, icon: 'info', tone: 'amber', path: '/system', permission: null, phase: 1 },
]

/** All leaf routes with their metadata. */
export const ROUTES: NavLeaf[] = NAV.flatMap((i) =>
  i.children ?? [{ path: i.path!, label: i.label, permission: i.permission ?? null, phase: i.phase ?? 1, ...(i.breadcrumb ? { breadcrumb: i.breadcrumb } : {}) }],
)
