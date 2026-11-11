import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BaseUnit, IngredientDto, LotDto } from '@shared/api-sales'
import { MoneyInput } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, IconTile, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, Toggle, useToast, type Tone } from '@renderer/components/ui'
import { useConfirm } from '@renderer/components/confirm'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { formatDateTimeShort, money, qty } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/events'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const iv = t.inventory
const PAGE = 7
const DAY = 86_400_000

const STATUS_CHIP: Record<IngredientDto['status'], { bg: string; fg: string }> = {
  ok: { bg: '#DDF5E8', fg: '#11724A' },
  low: { bg: '#FFF4D6', fg: '#7A5200' },
  out: { bg: '#FFE3E3', fg: '#A6232B' },
}

/** "1.5" (display units) → milli; null when invalid. */
function parseQty(s: string): number | null {
  if (!/^\d+(\.\d{1,3})?$/.test(s.trim())) return null
  const [i, f = ''] = s.trim().split('.')
  return Number(i) * 1000 + Number(f.padEnd(3, '0'))
}

/** yyyy-mm-dd (input type=date) → end of that day in Bangkok, epoch ms. */
function dateToMs(d: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  return Date.parse(`${d}T23:59:59+07:00`)
}

const emptyIngredient = { name: '', baseUnit: 'ml' as BaseUnit, pack: '1000', min: '0', hasExpiry: false, isDailyCount: false }

/** docs/design/Inventory.dc.html (draft): ingredients, lots in picking order (FEFO/FIFO), receive stock. */
export function InventoryPage() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<IngredientDto[]>([])
  const [filter, setFilter] = useState<'all' | IngredientDto['status']>('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selId, setSelId] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view')
  const [form, setForm] = useState(emptyIngredient)
  const [lots, setLots] = useState<LotDto[]>([])
  const [recv, setRecv] = useState<{ qty: string; cost: number | null; expiry: string; lotNo: string } | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setItems(await call('inventory.ingredients'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [toast])

  useEffect(() => {
    let alive = true
    call('inventory.ingredients').then(
      (v) => alive && setItems(v),
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [toast])

  useEffect(() => {
    let alive = true
    if (selId) call('inventory.lots', { ingredientId: selId }).then((v) => alive && setLots(v), () => {})
    return () => {
      alive = false
    }
  }, [selId, items])

  const now = useNow(60_000)
  const cards: { label: string; value: number; tone: Tone }[] = [
    { label: iv.cards.total, value: items.length, tone: 'blue' },
    { label: iv.cards.low, value: items.filter((i) => i.status === 'low').length, tone: 'amber' },
    { label: iv.cards.out, value: items.filter((i) => i.status === 'out').length, tone: 'red' },
    { label: iv.cards.expiring, value: items.filter((i) => i.nextExpiry !== null && i.nextExpiry - now <= 3 * DAY).length, tone: 'pink' },
  ]
  const filtered = useMemo(
    () => items.filter((i) => (filter === 'all' || i.status === filter) && (!search || i.name.toLowerCase().includes(search.toLowerCase()))),
    [items, filter, search],
  )
  const rows = filtered.slice((page - 1) * PAGE, page * PAGE)
  const cur = items.find((i) => i.id === selId) ?? null
  const unit = cur ? t.units[cur.baseUnit] : ''

  function select(i: IngredientDto) {
    setSelId(i.id)
    setMode('view')
    setRecv(null)
    setFields({})
  }

  function startEdit(i: IngredientDto | null) {
    setFields({})
    setRecv(null)
    if (i) {
      setMode('edit')
      setForm({ name: i.name, baseUnit: i.baseUnit, pack: qty(i.packSizeMilli).replace(/,/g, ''), min: qty(i.minQtyMilli).replace(/,/g, ''), hasExpiry: i.hasExpiry, isDailyCount: i.isDailyCount })
    } else {
      setMode('create')
      setSelId(null)
      setForm(emptyIngredient)
    }
  }

  async function saveIngredient() {
    const pack = parseQty(form.pack)
    const min = parseQty(form.min)
    if (pack === null || pack <= 0 || min === null) {
      setFields({ ...(pack === null || pack <= 0 ? { packSizeMilli: t.errors.INVALID_INPUT } : {}), ...(min === null ? { minQtyMilli: t.errors.INVALID_INPUT } : {}) })
      return
    }
    setBusy(true)
    try {
      const saved = await call('inventory.saveIngredient', {
        ...(mode === 'edit' && selId ? { id: selId } : {}),
        name: form.name,
        baseUnit: form.baseUnit,
        packSizeMilli: pack,
        minQtyMilli: min,
        hasExpiry: form.hasExpiry,
        isDailyCount: form.isDailyCount,
      })
      toast(t.crud.saved)
      await load()
      setSelId(saved.id)
      setMode('view')
    } catch (err) {
      setFields(fieldErrors(err))
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!cur || !(await confirm({ kind: 'danger', title: t.confirmDialog.deleteTitle, message: t.crud.confirmDelete(cur.name), confirmLabel: t.confirmDialog.delete }))) return
    try {
      await call('inventory.deleteIngredient', { id: cur.id })
      toast(t.crud.deleted)
      setSelId(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function receive() {
    if (!cur || !recv) return
    const q = parseQty(recv.qty)
    const exp = recv.expiry ? dateToMs(recv.expiry) : null
    if (q === null || q <= 0 || recv.cost === null || (cur.hasExpiry && exp === null)) {
      setFields({
        ...(q === null || q <= 0 ? { qty: t.errors.INVALID_INPUT } : {}),
        ...(recv.cost === null ? { cost: t.errors.INVALID_INPUT } : {}),
        ...(cur.hasExpiry && exp === null ? { expiry: iv.expiryRequired } : {}),
      })
      return
    }
    setBusy(true)
    try {
      const r = await call('inventory.addLot', { ingredientId: cur.id, qtyMilli: q, totalCostSatang: recv.cost, expiresAt: exp, lotNo: recv.lotNo.trim() || null })
      toast(iv.received(r.settledMilli ? `${qty(r.settledMilli)} ${unit}` : ''))
      setRecv(null)
      setFields({})
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        icon="box"
        title={iv.title}
        subtitle={iv.subtitle}
        actions={can('inventory:update') && <GradientButton onClick={() => startEdit(null)}>{iv.add}</GradientButton>}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {cards.map((c) => (
          <div key={c.label} className="relative flex flex-col gap-2 overflow-hidden rounded-[20px] border border-border bg-white p-5">
            <IconTile icon="box" tone={c.tone} size={40} iconSize={20} radius={12} />
            <span className="text-[13px] text-muted-foreground">{c.label}</span>
            <span className="text-[26px] font-bold">{c.value}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_520px] flex-col gap-3.5">
          <div className="flex flex-wrap gap-2.5">
            <TextInput type="search" aria-label={t.crud.search} placeholder={t.crud.search} className="flex-[2_1_200px]" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
            <SelectInput aria-label={iv.allStatus} className="flex-[1_1_140px]" value={filter} onChange={(e) => (setFilter(e.target.value as typeof filter), setPage(1))}>
              <option value="all">{iv.allStatus}</option>
              {(['ok', 'low', 'out'] as const).map((s) => (
                <option key={s} value={s}>
                  {iv.status[s]}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
            <span className="flex-[2_1_0]">{iv.colName}</span>
            <span className="flex-[1_1_0] text-right">{iv.colOnHand}</span>
            <span className="flex-[0_0_60px] text-center">{iv.colRule}</span>
            <span className="flex-[0_0_84px]">{iv.colStatus}</span>
          </div>
          <div role="list" className="flex flex-col gap-1.5">
            {rows.map((i) => (
              <div
                key={i.id}
                role="listitem"
                onClick={() => select(i)}
                className={cn('box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5', i.id === selId ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]')}
              >
                <div className="flex min-w-0 flex-[2_1_0] flex-col">
                  <span className="text-[15px] font-semibold">{i.name}</span>
                  <span className="text-xs text-muted-foreground">{iv.rowMeta(qty(i.minQtyMilli), t.units[i.baseUnit], i.lotCount)}</span>
                </div>
                <span className="flex-[1_1_0] text-right text-[15px] font-semibold">
                  {qty(i.onHandMilli)} {t.units[i.baseUnit]}
                </span>
                <span className="flex-[0_0_60px] text-center text-xs font-bold text-accent-foreground">{i.hasExpiry ? iv.fefo : iv.fifo}</span>
                <span className="flex-[0_0_84px]">
                  <Chip bg={STATUS_CHIP[i.status].bg} fg={STATUS_CHIP[i.status].fg}>
                    {iv.status[i.status]}
                  </Chip>
                </span>
              </div>
            ))}
            {rows.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t.crud.empty}</div>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-muted-foreground">{t.crud.showing(rows.length, filtered.length)}</span>
            <Pagination page={page} pageSize={PAGE} total={filtered.length} onPage={setPage} />
          </div>
          <span className="text-xs text-muted-foreground">{iv.phase3}</span>
        </Card>

        <aside className="box-border flex max-w-full flex-[0_0_400px] flex-col gap-3.5 rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
          {mode !== 'view' ? (
            <>
              <h2 className="m-0 text-lg font-bold">{mode === 'create' ? iv.add.replace('+ ', '') : t.crud.edit}</h2>
              <Field label={iv.name} error={fields['name']}>
                <TextInput value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={iv.unit}>
                <SelectInput value={form.baseUnit} onChange={(e) => setForm({ ...form, baseUnit: e.target.value as BaseUnit })}>
                  {(['ml', 'g', 'pcs'] as const).map((u) => (
                    <option key={u} value={u}>
                      {iv.units[u]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`${iv.pack} (${t.units[form.baseUnit]})`} error={fields['packSizeMilli']}>
                  <TextInput inputMode="decimal" value={form.pack} onChange={(e) => setForm({ ...form, pack: e.target.value })} />
                </Field>
                <Field label={`${iv.min} (${t.units[form.baseUnit]})`} error={fields['minQtyMilli']}>
                  <TextInput inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
                </Field>
              </div>
              <div className="flex min-h-12 items-center justify-between">
                <span className="text-[15px]">{iv.hasExpiry}</span>
                <Toggle checked={form.hasExpiry} label={iv.hasExpiry} onChange={(v) => setForm({ ...form, hasExpiry: v })} />
              </div>
              <div className="flex min-h-12 items-center justify-between">
                <span className="text-[15px]">{iv.dailyCount}</span>
                <Toggle checked={form.isDailyCount} label={iv.dailyCount} onChange={(v) => setForm({ ...form, isDailyCount: v })} />
              </div>
              <div className="flex gap-2.5">
                <GradientButton className="flex-1" disabled={busy || !form.name.trim()} onClick={() => void saveIngredient()}>
                  {t.crud.save}
                </GradientButton>
                <OutlineButton className="min-h-12" onClick={() => setMode('view')}>
                  {t.common.cancel}
                </OutlineButton>
              </div>
            </>
          ) : !cur ? (
            <p className="m-0 py-10 text-center text-sm text-muted-foreground">{t.crud.selectHint}</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <h2 className="m-0 text-lg font-bold">{cur.name}</h2>
                <Chip bg={STATUS_CHIP[cur.status].bg} fg={STATUS_CHIP[cur.status].fg}>
                  {iv.status[cur.status]}
                </Chip>
              </div>
              <div className="flex flex-col gap-0.5 rounded-2xl bg-[#F7F5F2] px-4 py-3">
                <span className="text-[13px] text-muted-foreground">{iv.onHand}</span>
                <span className="text-[26px] font-bold">
                  {qty(cur.onHandMilli)} {unit}
                </span>
                {cur.shortageMilli > 0 && <span className="text-[13px] font-semibold text-danger-foreground">{iv.shortage(qty(cur.shortageMilli), unit)}</span>}
              </div>
              <div className="rounded-2xl bg-accent px-4 py-2.5 text-[13px] text-accent-foreground">
                <strong>{cur.hasExpiry ? iv.fefo : iv.fifo}</strong> · {cur.hasExpiry ? iv.fefoDesc : iv.fifoDesc}
              </div>
              <span className="text-sm font-bold">{iv.lots}</span>
              <div className="flex flex-col gap-1.5">
                {lots.length === 0 && <span className="text-sm text-muted-foreground">{iv.noLots}</span>}
                {lots.map((l, idx) => (
                  <div key={l.id} className={cn('flex items-center gap-3 rounded-2xl px-3 py-2', l.qtyRemainingMilli > 0 ? 'bg-[#F7F5F2]' : 'bg-[#F7F5F2] opacity-55')}>
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-white text-sm font-bold text-accent-foreground">{idx + 1}</span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-semibold">
                        {qty(l.qtyRemainingMilli)} / {qty(l.qtyReceivedMilli)} {unit}
                        {l.lotNo ? ` · ${l.lotNo}` : ''}
                      </span>
                      <span className="text-xs text-muted-foreground">{iv.lotLine(formatDateTimeShort(l.receivedAt).slice(0, 8), money(l.totalCostSatang))}</span>
                    </div>
                    <span className="text-xs font-semibold text-muted-foreground">
                      {l.qtyRemainingMilli === 0 ? iv.usedUp : l.expiresAt ? iv.expires(formatDateTimeShort(l.expiresAt).slice(0, 8)) : iv.noExpiry}
                    </span>
                  </div>
                ))}
              </div>

              {recv ? (
                <div className="flex flex-col gap-3 rounded-2xl border border-border p-3.5">
                  <strong>{iv.receiveTitle}</strong>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={iv.qty(unit)} error={fields['qty']}>
                      <TextInput inputMode="decimal" autoFocus value={recv.qty} onChange={(e) => setRecv({ ...recv, qty: e.target.value })} />
                    </Field>
                    <Field label={iv.cost} error={fields['cost']}>
                      <MoneyInput value={recv.cost} onChange={(v) => setRecv({ ...recv, cost: v })} ariaLabel={iv.cost} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={iv.expiry} error={fields['expiry']}>
                      <TextInput type="date" value={recv.expiry} onChange={(e) => setRecv({ ...recv, expiry: e.target.value })} />
                    </Field>
                    <Field label={iv.lotNo}>
                      <TextInput value={recv.lotNo} maxLength={40} onChange={(e) => setRecv({ ...recv, lotNo: e.target.value })} />
                    </Field>
                  </div>
                  <div className="flex gap-2.5">
                    <GradientButton className="flex-1" disabled={busy} onClick={() => void receive()}>
                      {iv.saveReceive}
                    </GradientButton>
                    <OutlineButton className="min-h-12" onClick={() => setRecv(null)}>
                      {t.common.close}
                    </OutlineButton>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2.5">
                  {can('inventory:create') && (
                    <GradientButton className="flex-1" onClick={() => setRecv({ qty: '', cost: null, expiry: '', lotNo: '' })}>
                      {iv.receive}
                    </GradientButton>
                  )}
                  {can('inventory:update') && (
                    <OutlineButton className="min-h-12" onClick={() => startEdit(cur)}>
                      {t.crud.edit}
                    </OutlineButton>
                  )}
                  {can('inventory:delete') && (
                    <DangerButton className="min-h-12" onClick={() => void remove()}>
                      {t.crud.delete}
                    </DangerButton>
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  )
}
