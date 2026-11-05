import { describe, expect, it } from 'vitest'
import { th } from './th'

function leaves(obj: unknown): string[] {
  if (typeof obj === 'string') return [obj]
  if (obj && typeof obj === 'object') return Object.values(obj).flatMap(leaves)
  return []
}

describe('i18n th', () => {
  it('has no empty strings', () => {
    for (const s of leaves(th)) expect(s.trim().length).toBeGreaterThan(0)
  })
})
