import type { BillDetailDto } from '@shared/api-sales'
import type { TaxInvoiceDto } from '@shared/api-reports'
import { formatBaht } from '@shared/money'
import { formatTaxId } from '@shared/tax-id'

/**
 * Tax invoice documents (ประมวลรัษฎากร ม.86/4 full, ม.86/6 abbreviated). Layout and wording are a
 * starting point only — they MUST be reviewed by an accountant before real use (CLAUDE.md, D19/D20).
 * Full invoices print on A4; abbreviated ones on the receipt printer.
 */

export interface SellerInfo {
  name: string
  taxId: string
  branch: string
  address: string
  vatRateBp: number
  paperMm: 58 | 80
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const branchText = (b: string) => (b === '00000' ? 'สำนักงานใหญ่' : `สาขาที่ ${b}`)

function thaiDate(ms: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Bangkok' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return `${p['day']}/${p['month']}/${p['year']}`
}

export function renderTaxInvoice(inv: TaxInvoiceDto, bill: BillDetailDto, seller: SellerInfo): string {
  const vatPct = (seller.vatRateBp / 100).toString()
  const net = bill.totalSatang - bill.vatSatang
  const cancelled = inv.cancelled ? `<div class="stamp">ยกเลิก · ${esc(inv.cancelReason ?? '')}</div>` : ''
  const items = bill.items.map((i) => ({
    name: i.productName + (i.sizeLabel ? ` (${i.sizeLabel})` : '') + (i.modifiers.length ? ` + ${i.modifiers.map((m) => m.optionName).join(', ')}` : ''),
    qty: i.qty,
    unit: i.unitPriceSatang,
    total: i.lineTotalSatang + i.discountSatang,
  }))

  if (inv.type === 'abbreviated') {
    const row = (l: string, r: string, b = false) => `<div class="row${b ? ' b' : ''}"><span>${l}</span><span>${r}</span></div>`
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(inv.invoiceNo)}</title><style>
@page { size: ${seller.paperMm}mm auto; margin: 0 }
body { margin: 0; padding: 3mm; width: ${seller.paperMm - 6}mm; font: 12px/1.4 'Noto Sans Thai', Tahoma, sans-serif; color: #000 }
.c { text-align: center } .b { font-weight: 700 } .row { display: flex; justify-content: space-between; gap: 6px } hr { border: 0; border-top: 1px dashed #000; margin: 4px 0 }
.stamp { border: 2px solid #000; padding: 2px; text-align: center; font-weight: 700; margin: 4px 0 }
</style></head><body>
<div class="c b">${esc(seller.name)}</div>
<div class="c">เลขประจำตัวผู้เสียภาษี ${formatTaxId(seller.taxId)} (${branchText(seller.branch)})</div>
<div class="c b">ใบกำกับภาษีอย่างย่อ</div>${cancelled}<hr>
${row('เลขที่', esc(inv.invoiceNo))}${row('วันที่', thaiDate(inv.issuedAt))}${row('อ้างอิงบิล', esc(bill.billNo))}<hr>
${items.map((i) => row(`${i.qty} × ${esc(i.name)}`, formatBaht(i.total))).join('')}
${bill.discountSatang ? row('ส่วนลด', '-' + formatBaht(bill.discountSatang)) : ''}<hr>
${row('รวมเงิน (ราคารวมภาษีมูลค่าเพิ่มแล้ว)', formatBaht(bill.totalSatang), true)}
${row(`ภาษีมูลค่าเพิ่ม ${vatPct}%`, formatBaht(bill.vatSatang))}
</body></html>`
  }

  const rows = items
    .map((i, n) => `<tr><td class="c">${n + 1}</td><td>${esc(i.name)}</td><td class="r">${i.qty}</td><td class="r">${formatBaht(i.unit)}</td><td class="r">${formatBaht(i.total)}</td></tr>`)
    .join('')
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(inv.invoiceNo)}</title><style>
@page { size: A4; margin: 15mm }
body { margin: 0; font: 13px/1.5 'Noto Sans Thai', Tahoma, sans-serif; color: #000 }
h1 { font-size: 20px; margin: 0 } .r { text-align: right } .c { text-align: center } .muted { color: #333 }
.head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #000; padding-bottom: 8px }
.box { border: 1px solid #000; padding: 8px 10px; margin-top: 10px }
table { width: 100%; border-collapse: collapse; margin-top: 10px } th, td { border: 1px solid #000; padding: 4px 6px } th { background: #eee }
.sum td { border: 0; padding: 2px 6px } .stamp { border: 3px solid #000; padding: 4px 10px; font-size: 18px; font-weight: 700; display: inline-block; margin-top: 8px }
</style></head><body>
<div class="head">
  <div><h1>${esc(seller.name)}</h1><div>${esc(seller.address)}</div><div>เลขประจำตัวผู้เสียภาษี ${formatTaxId(seller.taxId)} · ${branchText(seller.branch)}</div></div>
  <div class="r"><h1>ใบกำกับภาษี / ใบเสร็จรับเงิน</h1><div>เลขที่ <b>${esc(inv.invoiceNo)}</b></div><div>วันที่ ${thaiDate(inv.issuedAt)}</div><div class="muted">อ้างอิงบิล ${esc(bill.billNo)}</div>
  ${inv.replacesNo ? `<div>ออกแทนฉบับเลขที่ ${esc(inv.replacesNo)}</div>` : ''}</div>
</div>
${cancelled ? `<div class="stamp">ยกเลิก</div> <span>${esc(inv.cancelReason ?? '')}</span>` : ''}
<div class="box"><b>ผู้ซื้อ</b> ${esc(inv.customerName ?? '')}<br>${esc(inv.customerAddress ?? '')}<br>
เลขประจำตัวผู้เสียภาษี ${formatTaxId(inv.customerTaxId ?? '')} · ${branchText(inv.customerBranch ?? '00000')}</div>
<table><thead><tr><th>#</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคาต่อหน่วย</th><th class="r">จำนวนเงิน</th></tr></thead><tbody>${rows}</tbody></table>
<table class="sum">
${bill.discountSatang ? `<tr><td class="r" style="width:80%">ส่วนลด</td><td class="r">-${formatBaht(bill.discountSatang)}</td></tr>` : ''}
<tr><td class="r" style="width:80%">มูลค่าก่อนภาษี</td><td class="r">${formatBaht(net)}</td></tr>
<tr><td class="r">ภาษีมูลค่าเพิ่ม ${vatPct}%</td><td class="r">${formatBaht(bill.vatSatang)}</td></tr>
<tr><td class="r"><b>รวมทั้งสิ้น</b></td><td class="r"><b>${formatBaht(bill.totalSatang)}</b></td></tr>
</table>
</body></html>`
}
