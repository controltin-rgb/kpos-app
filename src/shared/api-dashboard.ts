import { z } from 'zod'
import type { Access, Endpoint } from './api'

/** Phase 3 IPC contract — Dashboard (docs/design/Dashboard.dc.html, confirmed) and the notification bell. */

const ep =
  <O>() =>
  <I extends z.ZodType>(access: Access, input: I): Endpoint<I, O> => ({ access, input })

export type DashboardPeriod = 'today' | 'yesterday' | 'week' | 'month'

export interface DashboardDto {
  period: DashboardPeriod
  salesSatang: number
  /** % change vs the previous period (null when there was nothing to compare with) */
  deltaPct: number | null
  bills: number
  voids: number
  avgBillSatang: number
  /** items per bill × 10 (one decimal) */
  itemsPerBillX10: number
  /** null when the user may not see costs (reports:view_cost) */
  grossProfitSatang: number | null
  chart: { kind: 'hour' | 'weekday' | 'week'; labels: string[]; values: number[] }
  channels: { channel: 'dine_in' | 'takeaway' | 'grab' | 'lineman' | 'shopeefood' | 'foodpanda'; bills: number }[]
  deliveries: { grab: number; lineman: number; shopeefood: number; foodpanda: number }
  top: { name: string; qty: number; unit: 'cup' | 'piece' }[]
  stock: {
    lowCount: number
    exp3Count: number
    exp7Count: number
    low: { name: string; pct: number }[]
    expiring: { name: string; lotNo: string | null; days: number }[]
  }
  shift: { openedByName: string; expectedCashSatang: number; openingFloatSatang: number; lastOverShortSatang: number | null } | null
  pending: { counts: number; voids: number; licenseDaysLeft: number | null; lastBackupAt: number | null }
}

export interface NotificationDto {
  id: string
  kind: 'low_stock' | 'near_expiry' | 'pending_count'
  title: string
  body: string | null
  createdAt: number
  read: boolean
}

export const dashboardApi = {
  'dashboard.summary': ep<DashboardDto>()('dashboard:view', z.object({ period: z.enum(['today', 'yesterday', 'week', 'month']).default('today') })),
  'notifications.list': ep<{ items: NotificationDto[]; unread: number }>()('authenticated', z.undefined()),
  'notifications.read': ep<null>()('authenticated', z.object({ id: z.string().max(64).nullable().default(null) })),
} as const
