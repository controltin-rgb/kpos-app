import type { LicenseStatus } from '../../../scripts/license-types'
import { lm } from './i18n'

const dateParts = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Asia/Bangkok' })

/** "05/11/69" — Buddhist year, Asia/Bangkok. */
export const date = (ms: number): string => dateParts.format(new Date(ms))
export const expiryText = (ms: number | null): string => (ms === null ? lm.perpetual : date(ms))

export const STATUS_COLORS: Record<LicenseStatus, { bg: string; fg: string }> = {
  active: { bg: '#DDF5E8', fg: '#11724A' },
  expiring: { bg: '#FFF4D6', fg: '#7A5200' },
  grace: { bg: '#FFE9D2', fg: '#7A5200' },
  expired: { bg: '#FFE3E3', fg: '#A6232B' },
  void: { bg: '#F3F0EC', fg: '#5C6270' },
  superseded: { bg: '#EDE9FB', fg: '#4B2FB8' },
}

/** "เหลือ 12 วัน" for licenses still in force; empty otherwise. */
export function daysText(status: LicenseStatus, daysLeft: number | null): string {
  if (status === 'void' || status === 'superseded' || status === 'expired' || daysLeft === null) return ''
  return lm.daysLeft(daysLeft)
}
