const dateTimeParts = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Bangkok',
})

/** "05/11/69 09:12" — Buddhist year, Asia/Bangkok, as used in the design prototypes. */
export function formatDateTimeShort(ms: number): string {
  const p = Object.fromEntries(dateTimeParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`
}

/** "09:12" in Asia/Bangkok. */
export function formatTime(ms: number): string {
  return formatDateTimeShort(ms).slice(-5)
}

/** Avatar initials as in the prototype: first two characters, spaces removed. */
export function initials(name: string): string {
  return (name || '?').replace(/\s+/g, '').slice(0, 2)
}

/** "฿ 55" / "฿ 45.50" / "-฿ 12" — prices as shown in the POS prototypes (decimals only when needed). */
export function money(satang: number): string {
  const neg = satang < 0
  const abs = Math.abs(satang)
  const baht = Math.floor(abs / 100)
  const st = abs % 100
  const intStr = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}฿ ${intStr}${st ? '.' + String(st).padStart(2, '0') : ''}`
}

/** Milli-units → display quantity: 165000 → "165", 68750 → "68.75". */
export function qty(milli: number): string {
  const v = milli / 1000
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

/** "mm:ss" or "h:mm:ss" elapsed since `from`. */
export function elapsed(from: number, now: number): string {
  const s = Math.max(0, Math.floor((now - from) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** "7" for 700 bp, "7.5" for 750 bp. */
export function vatPct(bp: number): string {
  return String(bp / 100)
}
