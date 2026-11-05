import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DeliveryChannel, OrderType, PosCatalog, SaleResult, ShiftSummaryDto } from '@shared/api-sales'
import { uuidv7 } from '@shared/id'
import { percentOfSatang } from '@shared/money'
import { computeBillTotals } from '@shared/sale-totals'
import { Icon } from '@renderer/components/icons'
import { Segmented } from '@renderer/components/modal'
import { GRADIENTS, inputClass, SelectInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent } from '@renderer/lib/events'
import { money, vatPct } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'
import { CashDialog, CashMoveDialog, OpenShiftDialog, PromptPayDialog, ResultDialog } from './dialogs'
import { ModifierSheet, type SheetResult } from './modifier-sheet'

const p = t.pos
type Product = PosCatalog['products'][number]

interface CartLine {
  key: string
  productId: string
  sizeId: string | null
  optionIds: string[]
  qty: number
  name: string
  detail: string
  note: string
  unitPriceSatang: number
  vatType: Product['vatType']
}

// tile colours from docs/design/POS.dc.html, cycled per category ("ทั้งหมด" = purple)
const TONES = ['violet', 'orange', 'blue', 'pink', 'green', 'teal', 'amber', 'red'] as const
const PASTEL: Record<(typeof TONES)[number], string> = {
  violet: '#EDE9FB',
  orange: '#FFE9D2',
  blue: '#E4EEFF',
  pink: '#FDE3EC',
  green: '#DDF5E8',
  teal: '#DDF5F3',
  amber: '#FFF4D6',
  red: '#FFE3E3',
}

const chipBtn = 'flex min-h-12 cursor-pointer items-center gap-2.5 rounded-3xl border-0 py-0 pr-4 pl-2 text-sm'

/** docs/design/POS.dc.html (confirmed design). */
export function PosPage() {
  const { user, can } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const searchRef = useRef<HTMLInputElement>(null)

  const [catalog, setCatalog] = useState<PosCatalog | null>(null)
  const [shift, setShift] = useState<ShiftSummaryDto | null | undefined>(undefined)
  const [cat, setCat] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [orderType, setOrderType] = useState<OrderType>('dine_in')
  const [delivery, setDelivery] = useState<{ channel: DeliveryChannel; extOrderId: string; commissionPct: string }>({ channel: 'grab', extOrderId: '', commissionPct: '' })
  const [sheet, setSheet] = useState<Product | null>(null)
  const [pay, setPay] = useState<null | { kind: 'cash' } | { kind: 'promptpay'; payload: string }>(null)
  const [requestId, setRequestId] = useState(() => uuidv7())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ sale: SaleResult; change: number | null } | null>(null)
  const [cashMove, setCashMove] = useState(false)

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([call('pos.catalog'), call('shift.current')])
      setCatalog(c)
      setShift(s)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [toast])

  useEffect(() => {
    let alive = true
    Promise.all([call('pos.catalog'), call('shift.current')]).then(
      ([c, s]) => {
        if (!alive) return
        setCatalog(c)
        setShift(s)
      },
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [toast])

  useAppEvent((e) => {
    if (e.type === 'shift.changed') void call('shift.current').then(setShift)
  })

  const toneOf = useMemo(() => {
    const m = new Map<string | null, (typeof TONES)[number]>()
    catalog?.categories.forEach((c, i) => m.set(c.id, TONES[(i + 1) % TONES.length]!))
    return (id: string | null) => m.get(id) ?? 'violet'
  }, [catalog])

  const products = useMemo(() => {
    if (!catalog) return []
    const q = search.trim().toLowerCase()
    return catalog.products.filter((pr) => (cat === 'all' || pr.categoryId === cat) && (!q || pr.name.toLowerCase().includes(q) || pr.barcode === search.trim()))
  }, [catalog, cat, search])

  const vatRateBp = catalog?.vatRateBp ?? 0
  const totals = useMemo(
    () => computeBillTotals({ lines: cart.map((l) => ({ unitPriceSatang: l.unitPriceSatang, qty: l.qty, vatType: l.vatType })), vatRateBp }),
    [cart, vatRateBp],
  )
  const commissionBp = orderType === 'delivery' && delivery.commissionPct ? Math.round(Number(delivery.commissionPct) * 100) : null
  const deliveryValid = orderType !== 'delivery' || (commissionBp === null || (commissionBp >= 0 && commissionBp <= 10_000))

  // ---- cart -----------------------------------------------------------------
  function addLine(pr: Product, r: SheetResult) {
    if (!catalog) return
    const size = pr.sizes.find((s) => s.id === r.sizeId)
    const opts = catalog.groups.flatMap((g) => g.options).filter((o) => r.optionIds.includes(o.id))
    const key = [pr.id, r.sizeId, [...r.optionIds].sort().join('+'), r.note].join('|')
    const detail = [pr.sizes.length > 1 ? size?.label : null, ...opts.map((o) => o.name), r.note ? `“${r.note}”` : null].filter(Boolean).join(' · ')
    setCart((c) => {
      const ex = c.find((l) => l.key === key)
      if (ex) return c.map((l) => (l.key === key ? { ...l, qty: l.qty + r.qty } : l))
      return [
        ...c,
        {
          key,
          productId: pr.id,
          sizeId: r.sizeId,
          optionIds: r.optionIds,
          qty: r.qty,
          name: pr.name,
          detail,
          note: r.note,
          unitPriceSatang: (size?.priceSatang ?? 0) + opts.reduce((s, o) => s + o.priceSatang, 0),
          vatType: pr.vatType,
        },
      ]
    })
  }

  function pick(pr: Product) {
    const needsSheet = pr.sizes.length > 1 || pr.modifierGroupIds.length > 0
    if (needsSheet) setSheet(pr)
    else addLine(pr, { sizeId: pr.sizes[0]?.id ?? null, optionIds: [], qty: 1, note: '' })
  }

  function onSearchEnter() {
    const code = search.trim()
    if (!code || !catalog) return
    const hit = catalog.products.find((pr) => pr.barcode === code) ?? (products.length === 1 ? products[0] : undefined)
    if (hit) {
      pick(hit)
      setSearch('')
    } else toast(p.notFound(code), 'error')
  }

  const setQty = (key: string, d: number) => setCart((c) => c.map((l) => (l.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0))

  // ---- customer display ------------------------------------------------------
  const cfdState = pay ? 'awaiting_payment' : cart.length ? 'cart' : 'idle'
  useEffect(() => {
    if (!can('pos:view')) return
    const h = setTimeout(() => {
      void call('pos.showOnCfd', {
        orderLabel: t.orderTypes[orderType],
        lines: cart.map((l) => ({ qty: l.qty, name: l.name, mods: l.detail, priceSatang: l.unitPriceSatang * l.qty })),
        discountSatang: totals.discount,
        vatSatang: totals.vat,
        totalSatang: totals.total,
        vatRateBp,
        promptPayPayload: pay?.kind === 'promptpay' ? pay.payload : null,
        state: result ? 'paid' : cfdState,
        changeSatang: result?.change ?? null,
      }).catch(() => {})
    }, 120)
    return () => clearTimeout(h)
  }, [cart, totals, orderType, pay, result, cfdState, vatRateBp, can])

  // ---- payment ---------------------------------------------------------------
  async function openPromptPay() {
    try {
      const payload = await call('pos.promptPayPayload', { amountSatang: totals.total })
      setPay({ kind: 'promptpay', payload })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function checkout(payment: Parameters<typeof call<'pos.checkout'>>[1]['payment'], change: number | null) {
    setBusy(true)
    try {
      const sale = await call('pos.checkout', {
        requestId,
        orderType,
        channel: orderType === 'delivery' ? delivery.channel : null,
        extOrderId: orderType === 'delivery' && delivery.extOrderId.trim() ? delivery.extOrderId.trim() : null,
        commissionBp,
        items: cart.map((l) => ({ productId: l.productId, sizeId: l.sizeId, qty: l.qty, optionIds: l.optionIds, note: l.note || null })),
        payment,
      })
      setPay(null)
      setResult({ sale, change })
      void call('shift.current').then(setShift)
    } catch (err) {
      toast(errorMessage(err), 'error')
      if (err instanceof Error && /PRODUCT_UNAVAILABLE/.test(err.message)) void load()
    } finally {
      setBusy(false)
    }
  }

  function finishSale() {
    setResult(null)
    setCart([])
    setRequestId(uuidv7())
    setDelivery((d) => ({ ...d, extOrderId: '' }))
    void load()
  }

  const empty = cart.length === 0
  const canSell = !!shift && can('pos:create')

  return (
    <div className="box-border flex min-h-full flex-col bg-background text-foreground">
      <header className="box-border flex min-h-16 flex-wrap items-center gap-3 border-b border-border bg-white px-6 py-2.5">
        <button
          type="button"
          aria-label={p.backToMenu}
          title={p.backToMenu}
          onClick={() => navigate('/')}
          className="flex size-11 cursor-pointer items-center justify-center rounded-[13px] border-0 shadow-[0_6px_14px_rgba(247,121,30,0.3)]"
          style={{ background: GRADIENTS.orange }}
        >
          <Icon name="cup" size={24} color="#FFFFFF" />
        </button>
        <div className="flex flex-col leading-tight">
          <span className="text-base font-bold">{p.title}</span>
          <span className="text-xs text-muted-foreground">{p.subtitle(catalog?.branchName ?? user?.branchName ?? '', catalog?.device.name ?? '')}</span>
        </div>
        <div className="flex-1" />
        <span className="inline-flex h-[38px] items-center gap-2 rounded-[19px] bg-success px-3.5 text-[13px] font-semibold text-success-foreground">
          <span className="inline-block size-2 rounded-full bg-[#1BA56B]" />
          {t.common.online}
        </span>
        <span className={cn('inline-flex h-[38px] items-center gap-2 rounded-[19px] px-3.5 text-[13px] font-semibold', shift ? 'bg-accent text-accent-foreground' : 'bg-warning text-warning-foreground')}>
          {shift ? p.shiftOpen(shift.openedByName) : p.shiftClosed}
        </span>
        {can('shift:update') && (
          <button type="button" disabled={!shift} onClick={() => setCashMove(true)} className="min-h-11 cursor-pointer rounded-[22px] border-0 bg-white px-4 text-sm font-semibold shadow-[0_1px_3px_rgba(40,30,60,0.15)] disabled:cursor-not-allowed disabled:opacity-50">
            {p.cashInOut}
          </button>
        )}
        {can('shift:update') && (
          <button type="button" onClick={() => navigate('/shift')} className="min-h-11 cursor-pointer rounded-[22px] border-0 bg-white px-4 text-sm font-semibold shadow-[0_1px_3px_rgba(40,30,60,0.15)]">
            {p.closeShift}
          </button>
        )}
      </header>

      <div className="flex flex-auto flex-wrap items-stretch gap-4 px-6 pt-4 pb-6">
        <section className="flex min-w-0 flex-[1_1_560px] flex-col gap-3.5">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-[1_1_260px]">
              <Icon name="search" color="#6B7280" className="absolute top-[15px] left-3.5" />
              <input
                ref={searchRef}
                type="text"
                aria-label={p.searchLabel}
                placeholder={p.search}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSearchEnter()}
                className="box-border h-12 w-full rounded-[14px] border border-[#E8E4DF] bg-white pr-3.5 pl-11 text-[15px] text-foreground focus:outline-2 focus:outline-[#9776F6]"
              />
            </div>
            <button type="button" onClick={() => searchRef.current?.focus()} className="flex min-h-12 cursor-pointer items-center gap-2 rounded-[14px] border-0 bg-white px-[18px] text-sm font-semibold shadow-[0_1px_3px_rgba(40,30,60,0.12)]">
              <Icon name="scan" />
              {p.scan}
            </button>
          </div>

          <div role="group" aria-label={p.categories} className="flex flex-wrap gap-2.5">
            {[{ id: 'all', name: p.all }, ...(catalog?.categories ?? [])].map((c) => {
              const on = cat === c.id
              const tone = c.id === 'all' ? 'violet' : toneOf(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setCat(c.id)}
                  className={cn(chipBtn, on ? 'bg-accent font-semibold text-accent-foreground' : 'bg-white text-foreground shadow-[0_1px_3px_rgba(40,30,60,0.12)]')}
                >
                  <span className="flex size-8 items-center justify-center rounded-[10px]" style={{ background: GRADIENTS[tone] }}>
                    <Icon name="cup" size={16} color="#FFFFFF" />
                  </span>
                  {c.name}
                </button>
              )
            })}
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3.5">
            {products.map((pr) => {
              const tone = toneOf(pr.categoryId)
              const def = pr.sizes.find((s) => s.isDefault) ?? pr.sizes[0]
              const sub = pr.sizes.length > 1 ? pr.sizes.map((s) => s.label).join(' / ') : pr.modifierGroupIds.length ? p.hasOptions : p.perPiece
              return (
                <button
                  key={pr.id}
                  type="button"
                  disabled={!canSell}
                  onClick={() => pick(pr)}
                  className="relative flex min-h-[148px] cursor-pointer flex-col gap-2 overflow-hidden rounded-[20px] border border-border bg-white p-4 text-left text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="absolute -top-[30px] -right-[30px] size-24 rounded-full" style={{ background: PASTEL[tone] }} />
                  <span className="relative flex size-10 items-center justify-center rounded-xl" style={{ background: GRADIENTS[tone] }}>
                    <Icon name="cup" size={20} color="#FFFFFF" />
                  </span>
                  <span className="relative mt-1 text-[15px] font-semibold">{pr.name}</span>
                  <span className="relative text-[13px] text-muted-foreground">
                    {sub}
                    {pr.lowStock && <span className="block font-semibold text-danger-foreground">{p.lowStock}</span>}
                  </span>
                  <span className="relative mt-auto text-lg font-bold">{def ? money(def.priceSatang) : '—'}</span>
                </button>
              )
            })}
          </div>
          {catalog && products.length === 0 && <div className="text-sm text-muted-foreground">{search ? p.notFound(search) : p.noProducts}</div>}
        </section>

        <aside className="box-border flex min-w-[320px] flex-[0_1_400px] flex-col gap-3.5 rounded-3xl border border-border bg-white p-5 shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-lg font-bold">{p.currentOrder}</h2>
            <button type="button" disabled={empty} onClick={() => setCart([])} className="min-h-10 cursor-pointer rounded-[20px] border-0 bg-[#FDE3E5] px-3.5 text-[13px] font-semibold text-danger-foreground disabled:opacity-50">
              {p.clearCart}
            </button>
          </div>
          <Segmented
            label={p.orderType}
            value={orderType}
            onChange={setOrderType}
            options={(['dine_in', 'takeaway', 'delivery'] as const).map((v) => ({ value: v, label: t.orderTypes[v] }))}
          />
          {orderType === 'delivery' && (
            <div className="grid grid-cols-2 gap-2">
              <SelectInput aria-label={p.channel} value={delivery.channel} onChange={(e) => setDelivery({ ...delivery, channel: e.target.value as DeliveryChannel })}>
                {(Object.keys(t.channels) as DeliveryChannel[]).map((c) => (
                  <option key={c} value={c}>
                    {t.channels[c]}
                  </option>
                ))}
              </SelectInput>
              <input className={inputClass} aria-label={p.extOrderId} placeholder={p.extOrderId} value={delivery.extOrderId} maxLength={60} onChange={(e) => setDelivery({ ...delivery, extOrderId: e.target.value })} />
              <input
                className={cn(inputClass, 'col-span-2')}
                aria-label={p.commission}
                placeholder={p.commission}
                inputMode="decimal"
                value={delivery.commissionPct}
                onChange={(e) => setDelivery({ ...delivery, commissionPct: e.target.value.replace(/[^\d.]/g, '') })}
              />
              {commissionBp !== null && deliveryValid && (
                <span className="col-span-2 text-[13px] text-muted-foreground">{p.deliveryNet(money(totals.total - percentOfSatang(totals.total, commissionBp)))}</span>
              )}
            </div>
          )}
          <button type="button" onClick={() => toast(p.memberSoon, 'info')} className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-[14px] border border-dashed border-[#CFC8BF] bg-[#FAF8F5] px-3.5 text-sm text-[#4A5060]">
            <Icon name="user" />
            {p.memberSearch}
          </button>

          <div className="flex min-h-[180px] flex-auto flex-col gap-2.5 overflow-y-auto">
            {empty && <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">{p.emptyCart}</div>}
            {cart.map((l) => (
              <div key={l.key} className="flex items-center gap-2.5 rounded-2xl bg-[#FAF8F5] px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{l.name}</span>
                  {l.detail && <span className="text-xs text-muted-foreground">{l.detail}</span>}
                  <span className="text-[13px] font-semibold">{money(l.unitPriceSatang * l.qty)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" aria-label={p.dec} onClick={() => setQty(l.key, -1)} className="size-9 cursor-pointer rounded-xl border-0 bg-white text-lg shadow-[0_1px_2px_rgba(40,30,60,0.15)]">
                    −
                  </button>
                  <span className="min-w-[22px] text-center font-bold">{l.qty}</span>
                  <button type="button" aria-label={p.inc} onClick={() => setQty(l.key, 1)} className="size-9 cursor-pointer rounded-xl border-0 bg-accent text-lg text-accent-foreground">
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{p.subtotalNet}</span>
              <span>{money(totals.net)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{totals.vatMode === 'inclusive' ? p.vatIncluded(vatPct(vatRateBp)) : p.noVat}</span>
              <span>{money(totals.vat)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{p.discount}</span>
              <span>{money(totals.discount)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-base font-bold">{p.total}</span>
              <span className="text-[30px] font-bold text-accent-foreground">{money(totals.total)}</span>
            </div>
          </div>
          {orderType === 'delivery' ? (
            <button
              type="button"
              disabled={empty || !canSell || busy || !deliveryValid}
              onClick={() => void checkout({ method: 'delivery' }, null)}
              className="min-h-14 cursor-pointer rounded-2xl border-0 bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-base font-bold text-white shadow-[0_10px_22px_rgba(106,71,219,0.32)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {p.payDelivery}
            </button>
          ) : (
            <div className="flex gap-2.5">
              <button
                type="button"
                disabled={empty || !canSell}
                onClick={() => setPay({ kind: 'cash' })}
                className="min-h-14 flex-1 cursor-pointer rounded-2xl border-0 bg-[linear-gradient(135deg,#34C98A,#1BA56B)] text-base font-bold text-white shadow-[0_10px_20px_rgba(27,165,107,0.3)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {p.payCash}
              </button>
              <button
                type="button"
                disabled={empty || !canSell}
                onClick={() => void openPromptPay()}
                className="min-h-14 flex-1 cursor-pointer rounded-2xl border-0 bg-[linear-gradient(90deg,#6A47DB,#9776F6)] text-base font-bold text-white shadow-[0_10px_22px_rgba(106,71,219,0.32)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {p.payPromptPay}
              </button>
            </div>
          )}
        </aside>
      </div>

      {sheet && catalog && (
        <ModifierSheet
          product={sheet}
          groups={catalog.groups}
          onClose={() => setSheet(null)}
          onAdd={(r) => {
            addLine(sheet, r)
            setSheet(null)
          }}
        />
      )}
      {pay?.kind === 'cash' && <CashDialog total={totals.total} busy={busy} onClose={() => setPay(null)} onPay={(tendered) => void checkout({ method: 'cash', tenderedSatang: tendered }, tendered - totals.total)} />}
      {pay?.kind === 'promptpay' && (
        <PromptPayDialog
          total={totals.total}
          payload={pay.payload}
          busy={busy}
          onClose={() => setPay(null)}
          onConfirm={(reference) => void checkout({ method: 'promptpay', confirmed: true, reference: reference || null }, null)}
        />
      )}
      {result && <ResultDialog result={result.sale} changeSatang={result.change} onClose={finishSale} />}
      {shift === null && <OpenShiftDialog canOpen={can('shift:create')} onOpened={() => void load()} />}
      {cashMove && <CashMoveDialog onClose={() => setCashMove(false)} onDone={() => setCashMove(false)} />}
    </div>
  )
}
