const ICT_OFFSET = 7 * 3_600_000

/** Month key in Asia/Bangkok (e.g. "2026-11"). */
export function bangkokMonth(ms: number): string {
  return new Date(ms + ICT_OFFSET).toISOString().slice(0, 7)
}

/**
 * D25 retention for scheduled snapshots: keep the newest `keepDaily`, plus the earliest snapshot
 * of each of the newest `keepMonthly` months. Returns the ids to delete.
 * Manual / pre-migrate / pre-restore backups are not passed in here and are never pruned.
 */
export function selectForPrune(snapshots: readonly { id: string; startedAt: number }[], keepDaily: number, keepMonthly: number): string[] {
  const desc = [...snapshots].sort((a, b) => b.startedAt - a.startedAt)
  const keep = new Set(desc.slice(0, keepDaily).map((s) => s.id))

  const firstOfMonth = new Map<string, { id: string; startedAt: number }>()
  for (const s of desc) {
    const m = bangkokMonth(s.startedAt)
    const cur = firstOfMonth.get(m)
    if (!cur || s.startedAt < cur.startedAt) firstOfMonth.set(m, s)
  }
  const months = [...firstOfMonth.keys()].sort().reverse().slice(0, keepMonthly)
  for (const m of months) keep.add(firstOfMonth.get(m)!.id)

  return desc.filter((s) => !keep.has(s.id)).map((s) => s.id)
}

/**
 * The most recent scheduled moment at or before `now` for a daily time "HH:MM" (Asia/Bangkok).
 * A snapshot is due when the last one started before this moment — so a backup missed while the
 * app was closed runs at the next start.
 */
export function lastScheduledAt(now: number, dailyTime: string): number {
  const [h, m] = dailyTime.split(':').map(Number) as [number, number]
  const dayStart = Math.floor((now + ICT_OFFSET) / 86_400_000) * 86_400_000 - ICT_OFFSET
  const today = dayStart + (h * 60 + m) * 60_000
  return now >= today ? today : today - 86_400_000
}

/** File-name timestamp in Asia/Bangkok: 20261107-030000. */
export function fileStamp(ms: number): string {
  const iso = new Date(ms + ICT_OFFSET).toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}
