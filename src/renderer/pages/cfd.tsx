import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import type { CfdState } from '@shared/api-sales'
import { IconTile } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call } from '@renderer/lib/api'
import { useAppEvent } from '@renderer/lib/events'
import { money, vatPct } from '@renderer/lib/format'

const c = t.cfd

/**
 * docs/design/CFD.dc.html (confirmed design). Customer-facing display: no login; it only listens to
 * the cart pushed by the POS ('cfd.state' events) and shows the PromptPay QR while payment is pending.
 */
export function CfdPage() {
  const [state, setState] = useState<CfdState | null>(null)
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void call('cfd.state').then((s) => alive && setState(s), () => undefined) // refused when the license has no CFD (D51)
    return () => {
      alive = false
    }
  }, [])
  useAppEvent((e) => {
    if (e.type === 'cfd.state') setState(e.payload)
  })

  const payload = state?.state === 'awaiting_payment' ? state.promptPayPayload : null
  useEffect(() => {
    let alive = true
    if (payload) void QRCode.toDataURL(payload, { margin: 1, width: 400, errorCorrectionLevel: 'M' }).then((url) => alive && setQr(url))
    return () => {
      alive = false
    }
  }, [payload])

  const idle = !state || state.state === 'idle' || state.lines.length === 0
  const paid = state?.state === 'paid'
  const total = state?.totalSatang ?? 0
  const totalText = money(total).replace('฿ ', '')

  return (
    <div
      className="box-border flex min-h-full flex-wrap gap-6 p-8 text-foreground"
      style={{ background: 'radial-gradient(circle at 12% 10%, #FFE9D6 0, transparent 45%), radial-gradient(circle at 90% 90%, #E6E1FB 0, transparent 45%), #F7F5F2' }}
    >
      <section aria-label={c.title} className="flex min-w-0 flex-[1_1_520px] flex-col gap-4 rounded-[28px] bg-white p-7 shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
        <div className="flex items-center gap-3.5">
          <IconTile icon="cup" tone="orange" size={56} iconSize={28} radius={16} shadow />
          <div className="flex flex-col">
            <h1 className="m-0 text-[28px] font-bold">{idle && !paid ? c.welcome : c.title}</h1>
            <span className="text-[15px] text-muted-foreground">{idle && !paid ? c.welcomeSub : state?.orderLabel}</span>
          </div>
        </div>
        {!idle &&
          state.lines.map((l, i) => (
            <div key={i} className="flex items-center gap-4 rounded-[20px] bg-[#F7F5F2] p-4">
              <span className="flex h-11 min-w-11 items-center justify-center rounded-[14px] bg-accent text-xl font-bold text-accent-foreground">{l.qty}×</span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[22px] font-bold">{l.name}</span>
                {l.mods && <span className="text-[15px] text-muted-foreground">{l.mods}</span>}
              </div>
              <span className="text-[22px] font-bold">{money(l.priceSatang)}</span>
            </div>
          ))}
        {!idle && (
          <div className="mt-auto flex flex-col gap-2 border-t border-dashed border-[#D9D2C9] pt-4">
            {state.discountSatang > 0 && (
              <div className="flex justify-between text-[17px] text-muted-foreground">
                <span>{c.discount}</span>
                <span>-{money(state.discountSatang)}</span>
              </div>
            )}
            {state.vatRateBp > 0 && (
              <div className="flex justify-between text-[17px] text-muted-foreground">
                <span>{c.vat(vatPct(state.vatRateBp))}</span>
                <span>{money(state.vatSatang)}</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-label={c.due} className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
        <div className="relative overflow-hidden rounded-[28px] bg-[linear-gradient(135deg,#6A47DB,#9776F6)] p-8 text-white shadow-[0_14px_30px_rgba(106,71,219,0.3)]">
          <div className="absolute -top-[50px] -right-[50px] size-[180px] rounded-full bg-white/15" />
          <div className="relative flex flex-col gap-1.5">
            <span className="text-lg opacity-90">{paid ? c.thanks : c.due}</span>
            <span className="text-[72px] leading-[1.1] font-bold">{paid && state.changeSatang !== null ? money(state.changeSatang).replace('฿ ', '') : totalText}</span>
            <span className="text-base opacity-90">{paid && state.changeSatang !== null ? c.change('') : c.baht}</span>
          </div>
        </div>

        {payload && (
          <div className="flex flex-1 flex-col items-center gap-3.5 rounded-[28px] bg-white p-7 shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
            <span className="text-xl font-bold">{c.scan}</span>
            <div className="box-border flex size-[300px] items-center justify-center rounded-[20px] border-2 border-border bg-white p-3.5">{qr && <img src={qr} alt="PromptPay QR" width={270} height={270} />}</div>
            <span className="text-center text-sm text-muted-foreground">{c.qrNote}</span>
            <div className="inline-flex h-10 items-center gap-2 rounded-[20px] bg-[#FFF1E3] px-[18px] text-[15px] font-semibold text-[#8A3F05]">
              <span className="inline-block size-2 rounded-full bg-[#F7791E]" />
              {c.waiting}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
