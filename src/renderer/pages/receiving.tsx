import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { IngredientDto } from '@shared/api-sales'
import type { PurchaseOrderDto, StockCountDto, SupplierDto } from '@shared/api-stock'
import { MoneyInput, Segmented } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, inputClass, OutlineButton, PageHeader, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money, qty } from '@renderer/lib/format'
import { dateToMs, panelClass, parseQty, rowClass } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const r = t.receiving
const PO_CHIP: Record<string, [string, string]> = {
  draft: ['#EDE9FB', '#4B2FB8'],
  ordered: ['#E3EEFE', '#1D4FA8'],
  partial: ['#FFF4D6', '#7A5200'],
  received: ['#DDF5E8', '#11724A'],
  cancelled: ['#FFE3E3', '#A6232B'],
}
const COUNT_CHIP: Record<string, [string, string]> = { draft: ['#EDE9FB', '#4B2FB8'], pending: ['#FFF4D6', '#7A5200'], approved: ['#DDF5E8', '#11724A'], rejected: ['#FFE3E3', '#A6232B'] }

interface LineDraft {
  key: string
  poLineId: string | null
  ingredientId: string
  ordered: string
  receive: string
  cost: number | null
  expiry: string
  lotNo: string
}

/** docs/design/Receiving.dc.html (draft): purchase orders & receiving, and stock counts. */
export function ReceivingPage() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const tab = pathname === '/stock-count' ? 'count' : 'po'
  return (
    <>
      <PageHeader icon="box" title={r.title} subtitle={r.subtitle} />
      <div className="max-w-md">
        <Segmented label={r.title} value={tab} onChange={(v) => navigate(v === 'count' ? '/stock-count' : '/receiving')} options={[{ value: 'po', label: r.tabPo }, { value: 'count', label: r.tabCount }]} />
      </div>
      {tab === 'po' ? <PurchasingTab /> : <CountTab />}
    </>
  )
}

// ---------------------------------------------------------------------------
// purchase orders & receiving
// ---------------------------------------------------------------------------

function PurchasingTab() {
  const { can } = useSession()
  const toast = useToast()
  const [orders, setOrders] = useState<PurchaseOrderDto[]>([])
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([])
  const [ingredients, setIngredients] = useState<IngredientDto[]>([])
  const [openOnly, setOpenOnly] = useState(true)
  const [sel, setSel] = useState<PurchaseOrderDto | null>(null)
  const [mode, setMode] = useState<'view' | 'edit' | 'receive'>('view')
  const [supplierId, setSupplierId] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [newSupplier, setNewSupplier] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [o, s, i] = await Promise.all([call('purchasing.orders', { status: openOnly ? 'open' : 'all' }), call('purchasing.suppliers'), call('inventory.ingredients')])
      setOrders(o)
      setSuppliers(s)
      setIngredients(i)
      return o
    } catch (err) {
      toast(errorMessage(err), 'error')
      return []
    }
  }, [openOnly, toast])
  useEffect(() => {
    const h = setTimeout(() => void load(), 0)
    return () => clearTimeout(h)
  }, [load])

  const ingById = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])
  const key = () => Math.random().toString(36).slice(2)

  function startEdit(po: PurchaseOrderDto | null) {
    setSel(po)
    setMode('edit')
    setSupplierId(po?.supplierId ?? '')
    setLines(
      po
        ? po.lines.map((l) => ({ key: key(), poLineId: l.id, ingredientId: l.ingredientId, ordered: qty(l.qtyOrderedMilli).replace(/,/g, ''), receive: '', cost: l.lineTotalSatang, expiry: '', lotNo: '' }))
        : [{ key: key(), poLineId: null, ingredientId: '', ordered: '', receive: '', cost: null, expiry: '', lotNo: '' }],
    )
  }

  function startReceive(po: PurchaseOrderDto | null) {
    setSel(po)
    setMode('receive')
    setSupplierId(po?.supplierId ?? '')
    setLines(
      po
        ? po.lines
            .filter((l) => l.qtyReceivedMilli < l.qtyOrderedMilli)
            .map((l) => {
              const left = l.qtyOrderedMilli - l.qtyReceivedMilli
              return { key: key(), poLineId: l.id, ingredientId: l.ingredientId, ordered: '', receive: qty(left).replace(/,/g, ''), cost: Math.round((l.lineTotalSatang * left) / l.qtyOrderedMilli), expiry: '', lotNo: '' }
            })
        : [{ key: key(), poLineId: null, ingredientId: '', ordered: '', receive: '', cost: null, expiry: '', lotNo: '' }],
    )
  }

  const upd = (k: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)))

  async function savePo() {
    const ls = lines.map((l) => ({ ingredientId: l.ingredientId, qtyOrderedMilli: parseQty(l.ordered) ?? 0, lineTotalSatang: l.cost ?? 0 }))
    if (ls.some((l) => !l.ingredientId || l.qtyOrderedMilli <= 0)) return toast(t.errors.INVALID_INPUT, 'error')
    setBusy(true)
    try {
      const po = await call('purchasing.saveOrder', { ...(sel ? { id: sel.id } : {}), supplierId: supplierId || null, lines: ls })
      toast(t.crud.saved)
      await load()
      setSel(po)
      setMode('view')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function receive() {
    for (const l of lines) {
      const ing = ingById.get(l.ingredientId)
      if (!ing || !parseQty(l.receive) || l.cost === null) return toast(t.errors.INVALID_INPUT, 'error')
      if (ing.hasExpiry && !dateToMs(l.expiry)) return toast(r.expiryRequired, 'error')
    }
    setBusy(true)
    try {
      const res = await call('purchasing.receive', {
        poId: sel?.id ?? null,
        supplierId: supplierId || null,
        lines: lines.map((l) => ({ poLineId: l.poLineId, ingredientId: l.ingredientId, qtyMilli: parseQty(l.receive)!, totalCostSatang: l.cost!, expiresAt: l.expiry ? dateToMs(l.expiry) : null, lotNo: l.lotNo.trim() || null })),
      })
      toast(r.received_(res.receiptNo))
      const o = await load()
      setSel(sel ? (o.find((x) => x.id === sel.id) ?? null) : null)
      setMode('view')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function setStatus(status: 'ordered' | 'cancelled') {
    if (!sel) return
    try {
      const po = await call('purchasing.setStatus', { id: sel.id, status })
      setSel(po)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function addSupplier() {
    if (!newSupplier?.trim()) return
    try {
      const s = await call('purchasing.saveSupplier', { name: newSupplier.trim() })
      setSuppliers((x) => [...x, s])
      setSupplierId(s.id)
      setNewSupplier(null)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const total = lines.reduce((s, l) => s + (l.cost ?? 0), 0)

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <Card className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 flex-1 text-lg font-bold">{r.poList}</h2>
          <SelectInput aria-label={r.allStatus} className="w-auto" value={openOnly ? 'open' : 'all'} onChange={(e) => setOpenOnly(e.target.value === 'open')}>
            <option value="open">{r.openOnly}</option>
            <option value="all">{r.allStatus}</option>
          </SelectInput>
        </div>
        {can('inventory:create') && (
          <div className="flex flex-wrap gap-2">
            <GradientButton onClick={() => startEdit(null)}>{r.newPo}</GradientButton>
            <OutlineButton className="min-h-12" onClick={() => startReceive(null)}>
              {r.directReceive}
            </OutlineButton>
          </div>
        )}
        {orders.map((o) => (
          <div key={o.id} role="listitem" className={rowClass(o.id === sel?.id)} onClick={() => (setSel(o), setMode('view'))}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold">{o.poNo}</span>
              <span className="text-xs text-muted-foreground">{r.poMeta(o.supplierName ?? r.noSupplier, money(o.totalSatang), o.lines.length)}</span>
            </div>
            <Chip bg={PO_CHIP[o.status]![0]} fg={PO_CHIP[o.status]![1]}>
              {r.status[o.status]}
            </Chip>
          </div>
        ))}
        {orders.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
      </Card>

      <aside className={cn(panelClass, 'flex-[1.6_1_560px]')}>
        {mode === 'view' && !sel && <p className="m-0 py-10 text-center text-sm text-muted-foreground">{r.selectHint}</p>}
        {mode === 'view' && sel && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className="text-lg font-bold">{sel.poNo}</span>
                <span className="text-[13px] text-muted-foreground">
                  {sel.supplierName ?? r.noSupplier} · {sel.createdByName} · {formatDateTimeShort(sel.createdAt)}
                </span>
              </div>
              <Chip bg={PO_CHIP[sel.status]![0]} fg={PO_CHIP[sel.status]![1]}>
                {r.status[sel.status]}
              </Chip>
            </div>
            <div className="grid grid-cols-[1fr_100px_100px_110px] gap-2 text-xs font-semibold text-muted-foreground">
              <span>{r.ingredient}</span>
              <span className="text-right">{r.ordered}</span>
              <span className="text-right">{r.received}</span>
              <span className="text-right">{r.lineCost}</span>
            </div>
            {sel.lines.map((l) => (
              <div key={l.id} className="grid grid-cols-[1fr_100px_100px_110px] gap-2 rounded-xl bg-[#F7F5F2] px-3 py-2 text-sm">
                <span>{l.ingredientName}</span>
                <span className="text-right">
                  {qty(l.qtyOrderedMilli)} {t.units[l.baseUnit]}
                </span>
                <span className={cn('text-right', l.qtyReceivedMilli >= l.qtyOrderedMilli && 'font-semibold text-success-foreground')}>{qty(l.qtyReceivedMilli)}</span>
                <span className="text-right">{money(l.lineTotalSatang)}</span>
              </div>
            ))}
            <div className="flex justify-between text-base font-bold">
              <span>{r.total}</span>
              <span>{money(sel.totalSatang)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {sel.status === 'draft' && can('inventory:create') && <OutlineButton className="min-h-12" onClick={() => startEdit(sel)}>{t.crud.edit}</OutlineButton>}
              {sel.status === 'draft' && can('inventory:update') && <OutlineButton className="min-h-12" onClick={() => void setStatus('ordered')}>{r.markOrdered}</OutlineButton>}
              {['draft', 'ordered', 'partial'].includes(sel.status) && can('inventory:create') && <GradientButton onClick={() => startReceive(sel)}>{r.receiveBtn}</GradientButton>}
              {['draft', 'ordered'].includes(sel.status) && can('inventory:update') && <DangerButton className="min-h-12" onClick={() => void setStatus('cancelled')}>{r.cancelPo}</DangerButton>}
            </div>
          </>
        )}
        {mode !== 'view' && (
          <>
            <h2 className="m-0 text-lg font-bold">{mode === 'edit' ? (sel ? `${t.crud.edit} ${sel.poNo}` : r.newPo.replace('+ ', '')) : sel ? `${r.receiveTitle} · ${sel.poNo}` : r.directReceive.replace('+ ', '')}</h2>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <Field label={r.supplier}>
                  <SelectInput value={supplierId} disabled={mode === 'receive' && !!sel} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">{r.noSupplier}</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              </div>
              {newSupplier === null ? (
                <OutlineButton className="rounded-[14px]" onClick={() => setNewSupplier('')}>
                  {r.newSupplier}
                </OutlineButton>
              ) : (
                <div className="flex gap-2">
                  <input className={inputClass} placeholder={r.supplierName} autoFocus value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} />
                  <OutlineButton className="rounded-[14px]" onClick={() => void addSupplier()}>
                    {t.crud.save}
                  </OutlineButton>
                </div>
              )}
            </div>
            <div className={cn('grid items-center gap-2 text-xs font-semibold text-muted-foreground', mode === 'edit' ? 'grid-cols-[1fr_110px_120px_44px]' : 'grid-cols-[1fr_95px_110px_130px_90px_44px]')}>
              <span>{r.ingredient}</span>
              <span>{mode === 'edit' ? r.ordered : r.receiveNow}</span>
              <span>{r.lineCost}</span>
              {mode === 'receive' && <span>{r.expiry}</span>}
              {mode === 'receive' && <span>{t.inventory.lotNo}</span>}
              <span />
              {lines.map((l) => {
                const ing = ingById.get(l.ingredientId)
                return (
                  <div key={l.key} className="contents">
                    <SelectInput aria-label={r.ingredient} value={l.ingredientId} disabled={!!l.poLineId} onChange={(e) => upd(l.key, { ingredientId: e.target.value })}>
                      <option value="">{t.products.pickIngredient}</option>
                      {ingredients.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name} ({t.units[i.baseUnit]})
                        </option>
                      ))}
                    </SelectInput>
                    <TextInput inputMode="decimal" aria-label={mode === 'edit' ? r.ordered : r.receiveNow} value={mode === 'edit' ? l.ordered : l.receive} onChange={(e) => upd(l.key, mode === 'edit' ? { ordered: e.target.value } : { receive: e.target.value })} />
                    <MoneyInput ariaLabel={r.lineCost} value={l.cost} onChange={(v) => upd(l.key, { cost: v })} />
                    {mode === 'receive' && <TextInput type="date" aria-label={r.expiry} value={l.expiry} onChange={(e) => upd(l.key, { expiry: e.target.value })} invalid={!!ing?.hasExpiry && !l.expiry} />}
                    {mode === 'receive' && <TextInput aria-label={t.inventory.lotNo} value={l.lotNo} maxLength={40} onChange={(e) => upd(l.key, { lotNo: e.target.value })} />}
                    <button type="button" aria-label={t.products.removeLine} disabled={lines.length <= 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="size-11 cursor-pointer rounded-xl border-0 bg-[#F7F5F2] text-lg disabled:opacity-40">
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            {(mode === 'edit' || !sel) && (
              <OutlineButton className="self-start" onClick={() => setLines((ls) => [...ls, { key: key(), poLineId: null, ingredientId: '', ordered: '', receive: '', cost: null, expiry: '', lotNo: '' }])}>
                {r.addLine}
              </OutlineButton>
            )}
            <div className="flex justify-between text-base font-bold">
              <span>{r.total}</span>
              <span>{money(total)}</span>
            </div>
            {mode === 'receive' && <span className="text-xs text-muted-foreground">{r.receiveHint}</span>}
            <div className="flex gap-2.5">
              <GradientButton className="flex-1" disabled={busy} onClick={() => void (mode === 'edit' ? savePo() : receive())}>
                {mode === 'edit' ? r.savePo : r.receiveBtn}
              </GradientButton>
              <OutlineButton className="min-h-12" onClick={() => setMode('view')}>
                {t.common.cancel}
              </OutlineButton>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// stock counts
// ---------------------------------------------------------------------------

function CountTab() {
  const { can, user } = useSession()
  const toast = useToast()
  const [counts, setCounts] = useState<StockCountDto[]>([])
  const [openOnly, setOpenOnly] = useState(true)
  const [sel, setSel] = useState<StockCountDto | null>(null)
  const [draft, setDraft] = useState<Record<string, { counted: string; reason: string }>>({})
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => call('counts.list', { status: openOnly ? 'open' : 'all' }).then(setCounts, (err: unknown) => toast(errorMessage(err), 'error')), [openOnly, toast])
  useEffect(() => {
    void load()
  }, [load])

  function select(c: StockCountDto) {
    setSel(c)
    setDraft(Object.fromEntries(c.lines.map((l) => [l.ingredientId, { counted: l.countedQtyMilli === null ? '' : qty(l.countedQtyMilli).replace(/,/g, ''), reason: l.reason ?? '' }])))
  }

  async function run(fn: () => Promise<StockCountDto>, ok = t.crud.saved) {
    setBusy(true)
    try {
      const c = await fn()
      select(c)
      toast(ok)
      void load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    sel
      ? call('counts.saveLines', {
          id: sel.id,
          lines: sel.lines.map((l) => {
            const d = draft[l.ingredientId]!
            return { ingredientId: l.ingredientId, countedQtyMilli: d.counted.trim() === '' ? null : parseQty(d.counted), reason: d.reason.trim() || null }
          }),
        })
      : Promise.reject(new Error('no count'))

  const editable = sel?.status === 'draft' && can('inventory:create')
  const diffOf = (l: StockCountDto['lines'][number]) => {
    const c = parseQty(draft[l.ingredientId]?.counted ?? '')
    return c === null ? null : c - l.systemQtyMilli
  }

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <Card className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 flex-1 text-lg font-bold">{r.countList}</h2>
          <SelectInput aria-label={r.allStatus} className="w-auto" value={openOnly ? 'open' : 'all'} onChange={(e) => setOpenOnly(e.target.value === 'open')}>
            <option value="open">{r.openOnly}</option>
            <option value="all">{r.allStatus}</option>
          </SelectInput>
        </div>
        {can('inventory:create') && (
          <div className="flex flex-wrap gap-2">
            <GradientButton disabled={busy} onClick={() => void run(() => call('counts.create', { kind: 'full' }), t.crud.saved)}>
              {r.newCount}
            </GradientButton>
            <OutlineButton className="min-h-12" disabled={busy} onClick={() => void run(() => call('counts.create', { kind: 'daily' }), t.crud.saved)}>
              {r.newCountDaily}
            </OutlineButton>
          </div>
        )}
        {counts.map((c) => (
          <div key={c.id} role="listitem" className={rowClass(c.id === sel?.id)} onClick={() => select(c)}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold">
                {c.countNo} · {r.countKinds[c.kind]}
              </span>
              <span className="text-xs text-muted-foreground">{r.countMeta(c.createdByName, formatDateTimeShort(c.createdAt), c.lines.length)}</span>
            </div>
            <Chip bg={COUNT_CHIP[c.status]![0]} fg={COUNT_CHIP[c.status]![1]}>
              {r.countStatus[c.status]}
            </Chip>
          </div>
        ))}
        {counts.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
      </Card>

      <aside className={cn(panelClass, 'flex-[1.8_1_620px]')}>
        {!sel ? (
          <p className="m-0 py-10 text-center text-sm text-muted-foreground">{t.crud.selectHint}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-bold">
                {sel.countNo} · {r.countKinds[sel.kind]}
              </span>
              <Chip bg={COUNT_CHIP[sel.status]![0]} fg={COUNT_CHIP[sel.status]![1]}>
                {r.countStatus[sel.status]}
              </Chip>
            </div>
            {sel.status === 'rejected' && <span className="rounded-xl bg-danger px-3 py-2 text-sm text-danger-foreground">{r.rejectedBy(sel.decidedByName ?? '', sel.rejectReason ?? '')}</span>}
            {sel.status === 'approved' && <span className="rounded-xl bg-success px-3 py-2 text-sm text-success-foreground">{r.approvedBy(sel.decidedByName ?? '')}</span>}
            <div className="grid grid-cols-[1fr_95px_110px_90px_1.2fr] items-center gap-2 text-xs font-semibold text-muted-foreground">
              <span>{r.ingredient}</span>
              <span className="text-right">{r.inSystem}</span>
              <span>{r.counted}</span>
              <span className="text-right">{r.diff}</span>
              <span>{r.reason}</span>
              {sel.lines.map((l) => {
                const d = draft[l.ingredientId] ?? { counted: '', reason: '' }
                const diff = editable ? diffOf(l) : l.diffMilli
                const unit = t.units[l.baseUnit]
                return (
                  <div key={l.id} className="contents text-sm font-normal text-foreground">
                    <span>{l.ingredientName}</span>
                    <span className="text-right">
                      {qty(l.systemQtyMilli)} {unit}
                    </span>
                    {editable ? (
                      <TextInput inputMode="decimal" aria-label={`${r.counted} ${l.ingredientName}`} value={d.counted} onChange={(e) => setDraft({ ...draft, [l.ingredientId]: { ...d, counted: e.target.value } })} />
                    ) : (
                      <span>{l.countedQtyMilli === null ? '—' : `${qty(l.countedQtyMilli)} ${unit}`}</span>
                    )}
                    <span className={cn('text-right font-semibold', diff !== null && diff < 0 ? 'text-danger-foreground' : diff ? 'text-success-foreground' : '')}>{diff === null ? '—' : `${diff > 0 ? '+' : ''}${qty(diff)}`}</span>
                    {editable ? (
                      <SelectInput aria-label={`${r.reason} ${l.ingredientName}`} value={d.reason} onChange={(e) => setDraft({ ...draft, [l.ingredientId]: { ...d, reason: e.target.value } })} invalid={!!diff && !d.reason}>
                        <option value="">{r.pickReason}</option>
                        {[...r.reasons, r.otherReason].map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </SelectInput>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">{l.reason ?? ''}</span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex justify-between rounded-2xl bg-[#F7F5F2] px-4 py-3 text-sm font-semibold">
              <span>{r.diffValue}</span>
              <span className={sel.totalDiffValueSatang < 0 ? 'text-danger-foreground' : ''}>{money(sel.totalDiffValueSatang)}</span>
            </div>
            {editable && (
              <div className="flex flex-wrap gap-2.5">
                <OutlineButton className="min-h-12" disabled={busy} onClick={() => void run(save)}>
                  {r.saveCount}
                </OutlineButton>
                <GradientButton className="flex-1" disabled={busy} onClick={() => void run(async () => (await save(), call('counts.submit', { id: sel.id })))}>
                  {r.submit}
                </GradientButton>
              </div>
            )}
            {sel.status === 'pending' && can('inventory:approve_count') && (
              <div className="flex flex-col gap-2.5">
                <div className="flex gap-2.5">
                  <GradientButton className="flex-1" disabled={busy} onClick={() => void run(() => call('counts.approve', { id: sel.id }))}>
                    {r.approve}
                  </GradientButton>
                  <DangerButton className="min-h-12" disabled={busy || rejectReason.trim().length < 3} onClick={() => void run(() => call('counts.reject', { id: sel.id, reason: rejectReason.trim() }))}>
                    {r.reject}
                  </DangerButton>
                </div>
                <input className={inputClass} placeholder={r.rejectReason} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                {sel.createdById === user?.userId && <span className="text-xs text-warning-foreground">{t.errors.SAME_APPROVER}</span>}
              </div>
            )}
            <span className="text-xs text-muted-foreground">{r.flow}</span>
          </>
        )}
      </aside>
    </div>
  )
}
