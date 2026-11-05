/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp + version/variant + random.
 * Sortable by creation time and safe to generate offline on any device.
 * Within the same millisecond a 12-bit counter (rand_a) keeps ids monotonic per process.
 */
let lastMs = -1
let counter = 0

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  if (now <= lastMs) {
    // same (or clock moved back) millisecond: bump the counter, stay on lastMs
    counter++
    if (counter > 0xfff) {
      lastMs++
      counter = 0
    }
    now = lastMs
  } else {
    lastMs = now
    counter = (bytes[6]! & 0x07) << 8 // random start, leave headroom for increments
  }

  bytes[0] = Math.floor(now / 2 ** 40) & 0xff
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff
  bytes[2] = (now >>> 24) & 0xff
  bytes[3] = (now >>> 16) & 0xff
  bytes[4] = (now >>> 8) & 0xff
  bytes[5] = now & 0xff
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f) // version 7
  bytes[7] = counter & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f) // variant 10xx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isUuidv7(value: string): boolean {
  return UUIDV7_RE.test(value)
}

/** Extracts the embedded epoch-ms timestamp. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}
