import { useCallback, useEffect, useState } from 'react'
import type { IngredientDto, ProductDto } from '@shared/api-sales'
import type { ExpiringLotDto, WasteDto, WasteReason, WasteSummaryDto } from '@shared/api-stock'
import { Modal, Segmented } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, inputClass, PageHeader, Pagination, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money, qty } from '@renderer/lib/format'
import { bangkokToday, panelClass, parseQty, rowClass } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const w = t.waste
const REASONS: WasteReason[] = ['expired', 'wrong_made', 'dropped', 'customer_return', 'other']
const REASON_COLOR: Record<WasteReason, string> = { expired: '#DC3A44', wrong_made: '#F7791E', dropped: '#E5A10C', customer_return: '#6A47DB', other: '#5C6270' }

/** docs/design/Waste.dc.html (draft): near-expiry lots, record waste (ingredient / made drink), history. */
export function WastePage() {
  const { can } = useSession()
  const toast = useToast()
  const [expiring, setExpiring] = useState<ExpiringLotDto[]>([])
  const [list, setList] = useState<{ items: WasteDto[]; total: number }>({ items: [], total: 0 })
  const [summary, setSummary] = useState<WasteSummaryDto | null>(null)
  const [reason, setReason] = useState<'all' | WasteReason>('all')
  const [page, setPage] = useState(1)
  const [ingredients, setIngredients] = useState<IngredientDto[]>([])
  const [products, setProducts] = useState<ProductDto[]>([])
  const [form, setForm] = useState({ kind: 'ingredient' as 'ingredient' | 'drink', itemId: '', sizeId: '', lotId: null as string | null, qty: '', reason: 'expired' as WasteReason, note: '' })
  const [voiding, setVoiding] = useState<WasteDto | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const now = Date.now()
    try {
      const [e, l, s] = await Promise.all([call('waste.expiring', { withinDays: 3 }), call('waste.list', { page, reason }), call('waste.summary', { from: bangkokToday(now) - 29 * 86_400_000, to: bangkokToday(now) + 86_400_000 })])
      setExpiring(e)
      setList(l)
      setSummary(s)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [page, reason, toast])
  useEffect(() => {
    const h = setTimeout(() => void load(), 0)
    return () => clearTimeout(h)
  }, [load])
  useEffect(() => {
    void Promise.all([call('inventory.ingredients'), call('catalog.products').catch(() => [] as ProductDto[])]).then(([i, p]) => {
      setIngredients(i)
      setProducts(p.filter((x) => x.active))
    }, () => {})
  }, [])

  const product = products.find((p) => p.id === form.itemId)
  const ing = ingredients.find((i) => i.id === form.itemId)

  async function record() {
    const q = form.kind === 'ingredient' ? parseQty(form.qty) : Number(form.qty)
    if (!form.itemId || !q || q <= 0 || (form.kind === 'drink' && !Number.isInteger(q))) return toast(t.errors.INVALID_INPUT, 'error')
    setBusy(true)
    try {
      const res =
        form.kind === 'ingredient'
          ? await call('waste.record', { kind: 'ingredient', ingredientId: form.itemId, lotId: form.lotId, qtyMilli: q, reason: form.reason, note: form.note.trim() || null })
          : await call('waste.record', {
              kind: 'drink',
              productId: form.itemId,
              sizeId: form.sizeId || null,
              qty: q,
              optionIds: [],
              reason: form.reason,
              note: form.note.trim() || null,
            })
      toast(w.saved(res.wasteNo, money(res.valueSatang)))
      setForm({ ...form, itemId: '', lotId: null, qty: '', note: '' })
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const maxReason = Math.max(1, ...Object.values(summary?.byReason ?? {}))

  return (
    <>
      <PageHeader icon="trash" tone="red" title={w.title} subtitle={w.subtitle} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[1.4_1_520px] flex-col gap-[18px]">
          <Card className="flex flex-col gap-2.5">
            <h2 className="m-0 text-base font-bold">{w.expiring}</h2>
            {expiring.length === 0 && <span className="text-sm text-muted-foreground">{w.noExpiring}</span>}
            {expiring.map((l) => (
              <div key={l.lotId} className="flex flex-wrap items-center gap-3 rounded-2xl bg-warning px-3.5 py-2.5 text-warning-foreground">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">
                    {l.ingredientName}
                    {l.lotNo ? ` · Lot ${l.lotNo}` : ''}
                  </span>
                  <span className="text-xs">{w.lotLine(qty(l.qtyRemainingMilli), t.units[l.baseUnit], money(l.valueSatang), t.inventory.expires(formatDateTimeShort(l.expiresAt).slice(0, 8)))}</span>
                </div>
                {can('inventory:create') && (
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, kind: 'ingredient', itemId: l.ingredientId, lotId: l.lotId, qty: qty(l.qtyRemainingMilli).replace(/,/g, ''), reason: 'expired' })}
                    className="min-h-11 cursor-pointer rounded-full border-0 bg-white px-4 text-sm font-semibold text-danger-foreground"
                  >
                    {w.writeOff}
                  </button>
                )}
              </div>
            ))}
          </Card>

          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 flex-1 text-base font-bold">{w.history}</h2>
              <SelectInput aria-label={w.allReasons} className="w-auto" value={reason} onChange={(e) => (setReason(e.target.value as typeof reason), setPage(1))}>
                <option value="all">{w.allReasons}</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {w.reasons[r]}
                  </option>
                ))}
              </SelectInput>
            </div>
            {list.items.map((x) => (
              <div key={x.id} className={rowClass(false, x.voided)}>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-semibold">
                    {x.wasteNo} · {x.itemName} · {x.kind === 'ingredient' ? `${qty(x.qtyMilli)} ${t.units[x.unit as keyof typeof t.units] ?? x.unit}` : `${x.qtyMilli / 1000} ×`}
                  </span>
                  <span className="text-xs text-muted-foreground">{w.rowMeta(x.createdByName, formatDateTimeShort(x.createdAt), w.reasons[x.reason])}</span>
                </div>
                <span className="font-semibold">{money(x.valueSatang)}</span>
                {x.voided ? (
                  <Chip bg="#FFE3E3" fg="#A6232B">
                    {w.voided}
                  </Chip>
                ) : (
                  can('inventory:update') && (
                    <button type="button" onClick={() => setVoiding(x)} className="min-h-10 cursor-pointer rounded-full border-0 bg-white px-3 text-[13px] font-semibold text-danger-foreground">
                      {w.void}
                    </button>
                  )
                )}
              </div>
            ))}
            {list.items.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
            <Pagination page={page} pageSize={7} total={list.total} onPage={setPage} />
          </Card>

          {summary && (
            <Card className="flex flex-col gap-2.5">
              <h2 className="m-0 text-base font-bold">{w.byReason}</h2>
              {REASONS.map((r) => (
                <div key={r} className="flex flex-col gap-1">
                  <div className="flex justify-between text-sm">
                    <span>{w.reasons[r]}</span>
                    <span className="font-semibold">{money(summary.byReason[r])}</span>
                  </div>
                  <div className="h-2 rounded bg-border">
                    <div className="h-2 rounded" style={{ width: `${(summary.byReason[r] / maxReason) * 100}%`, background: REASON_COLOR[r] }} />
                  </div>
                </div>
              ))}
              {summary.wasteRatioBp !== null && (
                <Chip className="mt-1 self-start" bg={summary.wasteRatioBp <= 200 ? '#DDF5E8' : '#FFE3E3'} fg={summary.wasteRatioBp <= 200 ? '#11724A' : '#A6232B'}>
                  {w.ratio((summary.wasteRatioBp / 100).toFixed(2))}
                </Chip>
              )}
            </Card>
          )}
        </div>

        {can('inventory:create') && (
          <aside className={cn(panelClass, 'flex-[1_1_380px]')}>
            <h2 className="m-0 text-lg font-bold">{w.record}</h2>
            <Segmented
              label={w.record}
              value={form.kind}
              onChange={(k) => setForm({ ...form, kind: k, itemId: '', sizeId: '', lotId: null, qty: '', reason: k === 'drink' ? 'wrong_made' : 'expired' })}
              options={[{ value: 'ingredient', label: w.kindIngredient }, { value: 'drink', label: w.kindDrink }]}
            />
            <Field label={w.item}>
              <SelectInput value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value, lotId: null, sizeId: '' })}>
                <option value="">—</option>
                {form.kind === 'ingredient'
                  ? ingredients.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({qty(i.onHandMilli)} {t.units[i.baseUnit]})
                      </option>
                    ))
                  : products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
              </SelectInput>
            </Field>
            {form.kind === 'drink' && product && product.sizes.length > 1 && (
              <Field label={t.pos.size}>
                <SelectInput value={form.sizeId} onChange={(e) => setForm({ ...form, sizeId: e.target.value })}>
                  {product.sizes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            )}
            <Field label={form.kind === 'ingredient' ? `${w.qty}${ing ? ` (${t.units[ing.baseUnit]})` : ''}` : w.cups}>
              <TextInput inputMode="decimal" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </Field>
            {form.lotId && <Chip bg="#FFF4D6" fg="#7A5200">Lot · {expiring.find((l) => l.lotId === form.lotId)?.lotNo ?? form.lotId.slice(-6)}</Chip>}
            <Field label={w.reason}>
              <SelectInput value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value as WasteReason })}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {w.reasons[r]}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={w.note}>
              <TextInput value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <GradientButton size="lg" disabled={busy} onClick={() => void record()}>
              {w.save}
            </GradientButton>
            <span className="text-xs text-muted-foreground">{w.drinkHint}</span>
          </aside>
        )}
      </div>
      {voiding && <VoidDialog item={voiding} onClose={() => setVoiding(null)} onDone={() => (setVoiding(null), void load())} />}
    </>
  )
}

function VoidDialog({ item, onClose, onDone }: { item: WasteDto; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  return (
    <Modal title={`${t.waste.void} ${item.wasteNo}`} onClose={onClose} width={420}>
      <input className={inputClass} placeholder={t.waste.voidReason} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      <DangerButton
        disabled={reason.trim().length < 3}
        onClick={() =>
          void call('waste.void', { id: item.id, reason: reason.trim() }).then(
            () => onDone(),
            (err: unknown) => toast(errorMessage(err), 'error'),
          )
        }
      >
        {t.waste.void}
      </DangerButton>
    </Modal>
  )
}
