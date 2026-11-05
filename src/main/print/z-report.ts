import type { ShiftSummaryDto } from '@shared/api-sales'
import { formatBaht } from '@shared/money'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function dt(ms: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Bangkok' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`
}

/** Shift summary slip (Z-Report) for the thermal printer. */
export function renderZReport(s: ShiftSummaryDto, ctx: { shopName: string; branchName: string; paperMm: 58 | 80; printedBy: string; printedAt: number }): string {
  const row = (l: string, r: string, b = false) => `<div class="row${b ? ' b' : ''}"><span>${l}</span><span>${r}</span></div>`
  const signed = (n: number) => (n < 0 ? '-' : n > 0 ? '+' : '') + formatBaht(Math.abs(n))
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Z-Report ${esc(s.shiftNo)}</title><style>
@page { size: ${ctx.paperMm}mm auto; margin: 0 }
body { margin: 0; padding: 3mm; width: ${ctx.paperMm - 6}mm; font: 12px/1.4 'Noto Sans Thai', Tahoma, sans-serif; color: #000 }
.c { text-align: center } .big { font-size: 15px; font-weight: 700 } .row { display: flex; justify-content: space-between } .b { font-weight: 700 }
hr { border: 0; border-top: 1px dashed #000; margin: 4px 0 }
</style></head><body>
<div class="c big">${esc(ctx.shopName)}</div><div class="c">${esc(ctx.branchName)}</div>
<div class="c big">Z-Report · ${s.status === 'closed' ? 'ปิดกะแล้ว' : 'ระหว่างกะ'}</div><hr>
${row('กะ', esc(s.shiftNo))}${row('เปิดกะ', `${dt(s.openedAt)} ${esc(s.openedByName)}`)}
${s.closedAt ? row('ปิดกะ', `${dt(s.closedAt)} ${esc(s.closedByName ?? '')}`) : ''}<hr>
${row('เงินสด', formatBaht(s.byMethod.cash))}${row('PromptPay', formatBaht(s.byMethod.promptpay))}
${row('Delivery', formatBaht(s.byMethod.delivery))}${s.byMethod.card ? row('บัตร', formatBaht(s.byMethod.card)) : ''}
${s.byMethod.transfer ? row('โอนเงิน', formatBaht(s.byMethod.transfer)) : ''}
${row('รวมทั้งกะ', formatBaht(s.totalSalesSatang), true)}
${row('จำนวนบิล', String(s.billCount))}${row('ยกเลิก (Void)', String(s.voidCount))}${row('คืนเงิน', String(s.refundCount))}<hr>
${row('เงินทอนเริ่มต้น', formatBaht(s.openingFloatSatang))}${row('ยอดขายเงินสด', signed(s.cashSalesSatang))}
${s.cashInSatang ? row('Cash In', signed(s.cashInSatang)) : ''}${s.cashOutSatang ? row('Cash Out', signed(-s.cashOutSatang)) : ''}
${s.cashRefundsSatang ? row('คืนเงินสด', signed(-s.cashRefundsSatang)) : ''}${s.expensesSatang ? row('ค่าใช้จ่าย', signed(-s.expensesSatang)) : ''}
${row('เงินสดที่ควรมี', formatBaht(s.expectedCashSatang), true)}
${s.countedCashSatang !== null ? row('เงินสดที่นับได้', formatBaht(s.countedCashSatang)) + row('Over/Short', signed(s.overShortSatang ?? 0), true) : ''}<hr>
<div class="c">พิมพ์โดย ${esc(ctx.printedBy)} · ${dt(ctx.printedAt)}</div>
</body></html>`
}
