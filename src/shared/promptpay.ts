import { formatBaht, type Satang } from './money'

/**
 * Thai PromptPay QR payload (EMVCo merchant-presented, AID A000000677010111).
 * Phase 1 of payments: staff confirm receipt manually (CLAUDE.md) — this only builds the QR text.
 */

const AID = 'A000000677010111'

const tlv = (tag: string, value: string) => `${tag}${String(value.length).padStart(2, '0')}${value}`

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), 4 uppercase hex digits. */
export function crc16(data: string): string {
  let crc = 0xffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/** Normalises a PromptPay id. Phone (10 digits) → tag 01, tax/citizen id (13) → 02, e-wallet (15) → 03. */
export function promptPayTarget(id: string): { tag: '01' | '02' | '03'; value: string } {
  const digits = id.replace(/\D/g, '')
  if (digits.length === 10 && digits.startsWith('0')) return { tag: '01', value: ('0000000000000' + '66' + digits.slice(1)).slice(-13) }
  if (digits.length === 13) return { tag: '02', value: digits }
  if (digits.length === 15) return { tag: '03', value: digits }
  throw new RangeError('PromptPay id must be a 10-digit phone, 13-digit tax id or 15-digit e-wallet id')
}

export function isValidPromptPayId(id: string): boolean {
  try {
    promptPayTarget(id)
    return true
  } catch {
    return false
  }
}

/** Static QR when amount is omitted (customer types the amount), dynamic otherwise. */
export function buildPromptPayPayload(opts: { id: string; amountSatang?: Satang }): string {
  const target = promptPayTarget(opts.id)
  const dynamic = opts.amountSatang !== undefined
  const parts = [
    tlv('00', '01'),
    tlv('01', dynamic ? '12' : '11'),
    tlv('29', tlv('00', AID) + tlv(target.tag, target.value)),
    tlv('58', 'TH'),
    tlv('53', '764'),
  ]
  if (dynamic) {
    if (!Number.isSafeInteger(opts.amountSatang) || opts.amountSatang! <= 0) throw new RangeError('amount must be > 0')
    parts.push(tlv('54', formatBaht(opts.amountSatang!).replace(/,/g, '')))
  }
  const body = parts.join('') + '6304'
  return body + crc16(body)
}
