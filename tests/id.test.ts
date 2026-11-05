import { describe, expect, it } from 'vitest'
import { isUuidv7, uuidv7, uuidv7Time } from '@shared/id'

describe('uuidv7', () => {
  it('produces valid v7 ids that embed the timestamp', () => {
    const t = Date.UTC(2026, 10, 5, 10, 0, 0)
    const id = uuidv7(t + 10_000)
    expect(isUuidv7(id)).toBe(true)
    expect(uuidv7Time(id)).toBe(t + 10_000)
  })

  it('is strictly increasing even within the same millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7())
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('stays monotonic when the clock moves backwards', () => {
    const a = uuidv7(Date.now() + 60_000)
    const b = uuidv7(Date.now())
    expect(b > a).toBe(true)
  })
})
