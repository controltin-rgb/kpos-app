import { cn } from './utils'

/** "1.5" (display units) → 1500 milli; null when not a valid non-negative number with ≤ 3 decimals. */
export function parseQty(s: string): number | null {
  const v = s.trim().replace(/,/g, '')
  if (!/^\d+(\.\d{1,3})?$/.test(v)) return null
  const [i, f = ''] = v.split('.')
  return Number(i) * 1000 + Number(f.padEnd(3, '0'))
}

/** yyyy-mm-dd (date input) → end of that day in Bangkok, epoch ms. */
export function dateToMs(d: string, endOfDay = true): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  return Date.parse(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}+07:00`)
}

/** epoch ms → yyyy-mm-dd in Bangkok (for date inputs). */
export function msToDateInput(ms: number): string {
  const d = new Date(ms + 7 * 3_600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const DAY = 86_400_000

/** Start of today in Bangkok. */
export function bangkokToday(now: number): number {
  const d = new Date(now + 7 * 3_600_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 7 * 3_600_000
}

export function bangkokMonthStart(now: number): number {
  const d = new Date(now + 7 * 3_600_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 7 * 3_600_000
}

export function periodFrom(period: 'today' | 'week' | 'month', now: number): { from: number; to: number } {
  const today = bangkokToday(now)
  if (period === 'today') return { from: today, to: today + DAY }
  if (period === 'week') return { from: today - 6 * DAY, to: today + DAY }
  return { from: bangkokMonthStart(now), to: today + DAY }
}

/** Selectable list row used by the list + editor pages. */
export const rowClass = (selected: boolean, dim = false) =>
  cn('box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5', selected ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]', dim && 'opacity-60')

export const panelClass = 'box-border flex max-w-full flex-col gap-3.5 rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]'

/** "2026-11" → Bangkok month [from, to). */
export function monthRange(key: string): { from: number; to: number } {
  const [y, m] = key.split('-').map(Number) as [number, number]
  return { from: Date.UTC(y, m - 1, 1) - 7 * 3_600_000, to: Date.UTC(y, m, 1) - 7 * 3_600_000 }
}

const monthLabel = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' })

/** The current Bangkok month and the `count - 1` before it, newest first: { key: "2026-11", label: "พฤศจิกายน 2569" }. */
export function recentMonths(now: number, count = 24): { key: string; label: string }[] {
  const d = new Date(now + 7 * 3_600_000)
  const out: { key: string; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15)
    const x = new Date(at)
    out.push({ key: `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`, label: monthLabel.format(at) })
  }
  return out
}

export const currentMonthKey = (now: number) => recentMonths(now, 1)[0]!.key
