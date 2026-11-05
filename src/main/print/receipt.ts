import type { BillDetailDto } from '@shared/api-sales'
import { formatBaht } from '@shared/money'

/**
 * Receipt (ใบเสร็จรับเงิน) as self-contained HTML for 58/80 mm thermal printers via the OS driver.
 * This is NOT a tax invoice (full/abbreviated tax invoices come in phase 3 and must be reviewed by an
 * accountant before use — CLAUDE.md).
 */

export interface ReceiptContext {
  shopName: string
  branchName: string
  header: string
  footer: string
  paperMm: 58 | 80
  vatRateBp: number
  reprint: boolean
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const METHOD: Record<string, string> = {
  cash: 'เงินสด',
  promptpay: 'PromptPay',
  card: 'บัตร',
  transfer: 'โอนเงิน',
  delivery: 'เดลิเวอรี',
  other: 'อื่นๆ',
}
const ORDER: Record<string, string> = { dine_in: 'ทานที่ร้าน', takeaway: 'กลับบ้าน', delivery: 'เดลิเวอรี' }
const CHANNEL: Record<string, string> = { grab: 'Grab', lineman: 'LINE MAN', shopeefood: 'ShopeeFood', foodpanda: 'foodpanda', other: 'อื่นๆ' }

function dateTime(ms: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Bangkok' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`
}

export function renderReceipt(bill: BillDetailDto, ctx: ReceiptContext): string {
  const row = (l: string, r: string, cls = '') => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`
  const items = bill.items
    .map((i) => {
      const name = esc(i.productName + (i.sizeLabel ? ` (${i.sizeLabel})` : ''))
      const mods = i.modifiers.map((m) => `<div class="mod">+ ${esc(m.optionName)}${m.priceSatang ? ` ${formatBaht(m.priceSatang)}` : ''}</div>`).join('')
      return `${row(`${i.qty} × ${name}`, formatBaht(i.lineTotalSatang))}${mods}${i.note ? `<div class="mod">* ${esc(i.note)}</div>` : ''}`
    })
    .join('')
  const pay = bill.payments
    .map((p) =>
      [row(METHOD[p.method] ?? p.method, formatBaht(p.amountSatang)), p.tenderedSatang !== null ? row('รับเงิน', formatBaht(p.tenderedSatang)) : '', p.changeSatang !== null ? row('เงินทอน', formatBaht(p.changeSatang)) : ''].join(''),
    )
    .join('')
  const vatPct = (ctx.vatRateBp / 100).toFixed(ctx.vatRateBp % 100 ? 2 : 0)
  const status = bill.status === 'void' ? '<div class="big center">*** ยกเลิก (VOID) ***</div>' : bill.status === 'refunded' ? '<div class="big center">*** คืนเงินแล้ว ***</div>' : ''

  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(bill.billNo)}</title><style>
@page { size: ${ctx.paperMm}mm auto; margin: 0 }
body { margin: 0; padding: 3mm; width: ${ctx.paperMm - 6}mm; font: 12px/1.35 'Noto Sans Thai', 'Tahoma', sans-serif; color: #000 }
.center { text-align: center } .big { font-size: 15px; font-weight: 700 } .muted { font-size: 11px }
.row { display: flex; justify-content: space-between; gap: 6px } .row span:last-child { white-space: nowrap }
.mod { padding-left: 10px; font-size: 11px } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0 }
.total { font-size: 15px; font-weight: 700 }
</style></head><body>
<div class="center big">${esc(ctx.shopName)}</div>
<div class="center">${esc(ctx.branchName)}</div>
${ctx.header ? `<div class="center muted">${esc(ctx.header)}</div>` : ''}
<div class="center">ใบเสร็จรับเงิน${ctx.reprint ? ' (สำเนา)' : ''}</div>
${status}<hr>
${row('เลขที่', esc(bill.billNo))}
${row('วันที่', dateTime(bill.createdAt))}
${row('พนักงาน', esc(bill.createdByName))}
${row('ประเภท', ORDER[bill.orderType] + (bill.channel ? ` · ${CHANNEL[bill.channel]}` : ''))}
${bill.extOrderId ? row('Order ID', esc(bill.extOrderId)) : ''}<hr>
${items}<hr>
${row('รวม', formatBaht(bill.subtotalSatang))}
${bill.discountSatang ? row('ส่วนลด', '-' + formatBaht(bill.discountSatang)) : ''}
${row('ยอดชำระ', formatBaht(bill.totalSatang), 'total')}
${bill.vatMode === 'inclusive' ? row(`VAT ${vatPct}% (รวมในราคาแล้ว)`, formatBaht(bill.vatSatang), 'muted') + row('มูลค่าก่อน VAT', formatBaht(bill.totalSatang - bill.vatSatang), 'muted') : ''}
<hr>${pay}<hr>
<div class="center">${esc(ctx.footer)}</div>
</body></html>`
}
