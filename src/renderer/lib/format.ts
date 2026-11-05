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
