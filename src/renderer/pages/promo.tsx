import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CouponDto, MemberDto, PointsRulesDto, PromotionDto, TierDto } from '@shared/api-promo'
import type { CategoryDto } from '@shared/api-sales'
import { discountFor, type PromoRules, type PromoType } from '@shared/promotions'
import { MoneyInput, Segmented } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, inputClass, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money } from '@renderer/lib/format'
import { dateToMs, msToDateInput, panelClass, rowClass } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const pr = t.promo

interface PromoDraft {
  id?: string
  name: string
  type: PromoType
  percent: string
  amount: number | null
  maxDiscount: number | null
  buy: string
  get: string
  minSpend: number | null
  categoryIds: string[]
  start: string
  end: string
  startTime: string
  endTime: string
  days: number[]
  combinable: boolean
  couponOnly: boolean
  active: boolean
}

const toDraft = (p: PromotionDto | null): PromoDraft => ({
  ...(p ? { id: p.id } : {}),
  name: p?.name ?? pr.newName,
  type: p?.type ?? 'percent',
  percent: p?.type === 'percent' ? String(p.value / 100) : '10',
  amount: p?.type === 'amount' ? p.value : null,
  maxDiscount: p?.rules.maxDiscountSatang ?? null,
  buy: String(p?.rules.buyQty ?? 2),
  get: String(p?.rules.getQty ?? 1),
  minSpend: p?.rules.minSpendSatang ?? null,
  categoryIds: p?.rules.categoryIds ?? [],
  start: p?.startsAt ? msToDateInput(p.startsAt) : '',
  end: p?.endsAt ? msToDateInput(p.endsAt - 1) : '',
  startTime: p?.rules.startTime ?? '',
  endTime: p?.rules.endTime ?? '',
  days: p?.rules.daysOfWeek ?? [],
  combinable: p?.rules.combinable ?? false,
  couponOnly: p?.rules.couponOnly ?? false,
  active: p?.active ?? true,
})

/** docs/design/Promo.dc.html (draft): promotions tab and members tab. */
export function PromoPage() {
  const [tab, setTab] = useState<'promo' | 'members'>('promo')
  return (
    <>
      <PageHeader icon="tag" tone="amber" title={pr.title} subtitle={pr.subtitle} />
      <div className="max-w-md">
        <Segmented label={pr.title} value={tab} onChange={setTab} options={[{ value: 'promo', label: pr.tabPromo }, { value: 'members', label: pr.tabMembers }]} />
      </div>
      {tab === 'promo' ? <PromotionsTab /> : <MembersTab />}
    </>
  )
}

function PromotionsTab() {
  const { can } = useSession()
  const toast = useToast()
  const [promos, setPromos] = useState<PromotionDto[]>([])
  const [cats, setCats] = useState<CategoryDto[]>([])
  const [draft, setDraft] = useState<PromoDraft | null>(null)
  const editable = can('promo:update')

  const load = useCallback(() => call('promo.list').then(setPromos, (err: unknown) => toast(errorMessage(err), 'error')), [toast])
  useEffect(() => {
    void load()
    void call('catalog.categories').then(setCats, () => {})
  }, [load])

  function build(d: PromoDraft) {
    const rules: PromoRules = {
      ...(d.minSpend ? { minSpendSatang: d.minSpend } : {}),
      ...(d.categoryIds.length ? { categoryIds: d.categoryIds } : {}),
      ...(d.type === 'buy_x_get_y' ? { buyQty: Number(d.buy) || 1, getQty: Number(d.get) || 1 } : {}),
      ...(d.type === 'percent' && d.maxDiscount ? { maxDiscountSatang: d.maxDiscount } : {}),
      ...(d.combinable ? { combinable: true } : {}),
      ...(d.couponOnly ? { couponOnly: true } : {}),
      ...(d.startTime ? { startTime: d.startTime } : {}),
      ...(d.endTime ? { endTime: d.endTime } : {}),
      ...(d.days.length ? { daysOfWeek: d.days } : {}),
    }
    const value = d.type === 'percent' ? Math.round(Number(d.percent) * 100) : d.type === 'amount' ? (d.amount ?? 0) : 0
    return { name: d.name.trim(), type: d.type, value, rules, active: d.active, startsAt: d.start ? dateToMs(d.start, false) : null, endsAt: d.end ? dateToMs(d.end) : null }
  }

  async function save() {
    if (!draft) return
    try {
      const p = await call('promo.save', { ...(draft.id ? { id: draft.id } : {}), ...build(draft) })
      toast(t.crud.saved)
      await load()
      setDraft(toDraft(p))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function remove() {
    if (!draft?.id || !window.confirm(t.crud.confirmDelete(draft.name))) return
    try {
      await call('promo.delete', { id: draft.id })
      setDraft(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  // sample cart of 200 baht (as in the prototype) — two 100-baht items in the first category
  const sample = draft ? discountFor({ id: 'x', ...build(draft), value: build(draft).value, active: true, startsAt: null, endsAt: null }, [{ productId: 'p', categoryId: draft.categoryIds[0] ?? null, qty: 2, unitPriceSatang: 10_000 }]) : 0
  const period = (p: PromotionDto) => (p.startsAt || p.endsAt ? `${p.startsAt ? formatDateTimeShort(p.startsAt).slice(0, 8) : '…'} – ${p.endsAt ? formatDateTimeShort(p.endsAt - 1).slice(0, 8) : '…'}` : pr.always)

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <Card className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-lg font-bold">{pr.list}</h2>
          {editable && <GradientButton onClick={() => setDraft(toDraft(null))}>{pr.add}</GradientButton>}
        </div>
        {promos.map((p) => (
          <div key={p.id} role="listitem" className={rowClass(p.id === draft?.id, !p.active)} onClick={() => setDraft(toDraft(p))}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold">{p.name}</span>
              <span className="text-xs text-muted-foreground">{pr.rowMeta(pr.types[p.type], period(p))}</span>
            </div>
            <Chip bg="#EDE9FB" fg="#4B2FB8">
              {pr.used(p.usedCount)}
            </Chip>
          </div>
        ))}
        {promos.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
        <span className="text-xs text-muted-foreground">{pr.autoNote}</span>
      </Card>

      <aside className={cn(panelClass, 'flex-[1.3_1_480px]')}>
        {!draft ? (
          <p className="m-0 py-10 text-center text-sm text-muted-foreground">{t.crud.selectHint}</p>
        ) : (
          <>
            <h2 className="m-0 text-lg font-bold">{pr.edit}</h2>
            <Field label={pr.name}>
              <TextInput value={draft.name} maxLength={120} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Segmented label={pr.type} value={draft.type} onChange={(v) => setDraft({ ...draft, type: v })} options={(Object.keys(pr.types) as PromoType[]).map((k) => ({ value: k, label: pr.types[k] }))} />
            {draft.type === 'percent' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={pr.percent}>
                  <TextInput inputMode="decimal" value={draft.percent} disabled={!editable} onChange={(e) => setDraft({ ...draft, percent: e.target.value })} />
                </Field>
                <Field label={pr.maxDiscount}>
                  <MoneyInput value={draft.maxDiscount} onChange={(v) => setDraft({ ...draft, maxDiscount: v })} ariaLabel={pr.maxDiscount} />
                </Field>
              </div>
            )}
            {draft.type === 'amount' && (
              <Field label={pr.amount}>
                <MoneyInput value={draft.amount} onChange={(v) => setDraft({ ...draft, amount: v })} ariaLabel={pr.amount} />
              </Field>
            )}
            {draft.type === 'buy_x_get_y' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={pr.buy}>
                  <TextInput inputMode="numeric" value={draft.buy} onChange={(e) => setDraft({ ...draft, buy: e.target.value.replace(/\D/g, '') })} />
                </Field>
                <Field label={pr.get}>
                  <TextInput inputMode="numeric" value={draft.get} onChange={(e) => setDraft({ ...draft, get: e.target.value.replace(/\D/g, '') })} />
                </Field>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={pr.minSpend}>
                <MoneyInput value={draft.minSpend} onChange={(v) => setDraft({ ...draft, minSpend: v })} ariaLabel={pr.minSpend} />
              </Field>
              <Field label={pr.categories}>
                <SelectInput value={draft.categoryIds[0] ?? ''} onChange={(e) => setDraft({ ...draft, categoryIds: e.target.value ? [e.target.value] : [] })}>
                  <option value="">{pr.allCategories}</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label={pr.start}>
                <TextInput type="date" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
              </Field>
              <Field label={pr.end}>
                <TextInput type="date" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
              </Field>
            </div>
            <div className="flex flex-col gap-2 rounded-2xl bg-[#F7F5F2] p-3">
              <span className="text-sm font-bold">{pr.happyHour}</span>
              <div className="grid grid-cols-2 gap-2">
                <Field label={pr.from}>
                  <TextInput type="time" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} />
                </Field>
                <Field label={pr.to}>
                  <TextInput type="time" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} />
                </Field>
              </div>
              <span className="text-xs font-semibold">{pr.days}</span>
              <div className="flex flex-wrap gap-1.5">
                {pr.dayNames.map((n, i) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={draft.days.includes(i)}
                    onClick={() => setDraft({ ...draft, days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
                    className={cn('size-11 cursor-pointer rounded-full border-2 text-sm font-semibold', draft.days.includes(i) ? 'border-[#9776F6] bg-[#F5F2FE] text-accent-foreground' : 'border-transparent bg-white')}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            {[
              { k: 'combinable' as const, label: pr.combinable, hint: pr.combinableHint },
              { k: 'couponOnly' as const, label: pr.couponOnly, hint: '' },
              { k: 'active' as const, label: pr.active, hint: '' },
            ].map((o) => (
              <div key={o.k} className="flex min-h-12 items-center justify-between gap-3">
                <span className="flex flex-col text-[15px]">
                  {o.label}
                  {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                </span>
                <Toggle checked={draft[o.k]} label={o.label} disabled={!editable} onChange={(v) => setDraft({ ...draft, [o.k]: v })} />
              </div>
            ))}
            <Chip className="self-start" bg="#DDF5E8" fg="#11724A">
              {pr.test(money(20_000))} · {pr.testResult(money(sample))}
            </Chip>
            {editable && (
              <div className="flex gap-2.5">
                <GradientButton className="flex-1" disabled={!draft.name.trim()} onClick={() => void save()}>
                  {pr.save}
                </GradientButton>
                {draft.id && can('promo:delete') && (
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
  )
}

function MembersTab() {
  const { can } = useSession()
  const toast = useToast()
  const [q, setQ] = useState({ search: '', tierId: '', page: 1 })
  const [list, setList] = useState<{ items: MemberDto[]; total: number }>({ items: [], total: 0 })
  const [tiers, setTiers] = useState<TierDto[]>([])
  const [sel, setSel] = useState<MemberDto | null>(null)
  const [reason, setReason] = useState<string>(pr.adjustReasons[0])
  const [rules, setRules] = useState<PointsRulesDto | null>(null)

  const load = useCallback(
    () =>
      call('members.list', { page: q.page, ...(q.search ? { search: q.search } : {}), ...(q.tierId ? { tierId: q.tierId } : {}) }).then(
        (r) => {
          setList(r)
          setSel((s) => (s ? (r.items.find((m) => m.id === s.id) ?? s) : s))
        },
        (err: unknown) => toast(errorMessage(err), 'error'),
      ),
    [q, toast],
  )
  useEffect(() => {
    const h = setTimeout(() => void load(), q.search ? 250 : 0)
    return () => clearTimeout(h)
  }, [load, q.search])
  useEffect(() => {
    void call('members.tiers').then(setTiers, () => {})
    void call('members.pointsRules').then(setRules, () => {})
  }, [])

  async function adjust(delta: number) {
    if (!sel) return
    try {
      setSel(await call('members.adjustPoints', { id: sel.id, delta, reason }))
      void load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function erase() {
    if (!sel || !window.confirm(pr.eraseConfirm)) return
    try {
      await call('members.erase', { id: sel.id, reason: 'ลูกค้าขอลบข้อมูล (PDPA)' })
      setSel(null)
      void load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function saveRules() {
    if (!rules) return
    try {
      setRules(await call('members.savePointsRules', rules))
      toast(t.crud.saved)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <Card className="flex min-w-0 flex-[1.3_1_480px] flex-col gap-3">
        <div className="flex flex-wrap gap-2.5">
          <TextInput type="search" placeholder={pr.memberSearch} aria-label={pr.memberSearch} className="flex-[2_1_200px]" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value, page: 1 })} />
          <SelectInput aria-label={pr.allTiers} className="flex-[1_1_120px]" value={q.tierId} onChange={(e) => setQ({ ...q, tierId: e.target.value, page: 1 })}>
            <option value="">{pr.allTiers}</option>
            {tiers.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.name}
              </option>
            ))}
          </SelectInput>
        </div>
        <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
          <span className="flex-[2_1_0]">{t.pos.memberTitle}</span>
          <span className="flex-[1_1_0]">{pr.tier}</span>
          <span className="flex-[1_1_0] text-right">{pr.points}</span>
          <span className="flex-[1_1_0] text-right">{pr.lifetime}</span>
        </div>
        {list.items.map((m) => (
          <div key={m.id} role="listitem" className={rowClass(m.id === sel?.id)} onClick={() => setSel(m)}>
            <div className="flex min-w-0 flex-[2_1_0] flex-col">
              <span className="text-[15px] font-semibold">{m.name ?? m.phoneMasked}</span>
              <span className="text-xs text-muted-foreground">{m.phoneMasked}</span>
            </div>
            <span className="flex-[1_1_0]">
              <Chip>{m.tierName ?? '—'}</Chip>
            </span>
            <span className="flex-[1_1_0] text-right font-semibold">{m.pointsBalance.toLocaleString('en-US')}</span>
            <span className="flex-[1_1_0] text-right text-muted-foreground">{m.lifetimePoints.toLocaleString('en-US')}</span>
          </div>
        ))}
        {list.items.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
        <Pagination page={q.page} pageSize={7} total={list.total} onPage={(page) => setQ({ ...q, page })} />
        <span className="text-xs text-muted-foreground">{pr.pdpa}</span>
      </Card>

      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-[18px]">
        {sel && (
          <aside className={panelClass}>
            <div className="flex flex-col">
              <span className="text-lg font-bold">{sel.name ?? sel.phoneMasked}</span>
              <span className="text-[13px] text-muted-foreground">
                {sel.phoneMasked} · {pr.memberSince(formatDateTimeShort(sel.createdAt).slice(0, 8))}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-2xl bg-[#F7F5F2] px-4 py-3">
              <span className="text-[13px] text-muted-foreground">{pr.balance}</span>
              <span className="text-[28px] font-bold text-accent-foreground">{sel.pointsBalance.toLocaleString('en-US')}</span>
            </div>
            {can('promo:update') && (
              <>
                <span className="text-sm font-bold">{pr.adjust}</span>
                <SelectInput value={reason} onChange={(e) => setReason(e.target.value)}>
                  {pr.adjustReasons.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </SelectInput>
                <div className="flex gap-2">
                  <OutlineButton className="min-h-12 flex-1" onClick={() => void adjust(-10)}>
                    −10
                  </OutlineButton>
                  <OutlineButton className="min-h-12 flex-1" onClick={() => void adjust(10)}>
                    +10
                  </OutlineButton>
                </div>
                <span className="text-xs text-muted-foreground">{pr.adjustNote}</span>
              </>
            )}
            {can('promo:delete') && (
              <DangerButton className="min-h-12" onClick={() => void erase()}>
                {pr.erase}
              </DangerButton>
            )}
          </aside>
        )}
        {rules && (
          <aside className={panelClass}>
            <h2 className="m-0 text-base font-bold">{pr.rules}</h2>
            <Field label={pr.earnEvery}>
              <MoneyInput value={rules.earnEverySatang} onChange={(v) => v && setRules({ ...rules, earnEverySatang: v })} ariaLabel={pr.earnEvery} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={pr.redeemPoints}>
                <input className={inputClass} inputMode="numeric" value={rules.redeemPoints} onChange={(e) => setRules({ ...rules, redeemPoints: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
              </Field>
              <Field label={pr.redeemValue}>
                <MoneyInput value={rules.redeemValueSatang} onChange={(v) => v && setRules({ ...rules, redeemValueSatang: v })} ariaLabel={pr.redeemValue} />
              </Field>
            </div>
            {can('promo:update') && <GradientButton onClick={() => void saveRules()}>{pr.saveRules}</GradientButton>}
          </aside>
        )}
      </div>
    </div>
  )
}

/** Coupons (no prototype yet — follows the Promo page style). */
export function CouponsPage() {
  const { can } = useSession()
  const toast = useToast()
  const c = t.coupons
  const [coupons, setCoupons] = useState<CouponDto[]>([])
  const [promos, setPromos] = useState<PromotionDto[]>([])
  const [draft, setDraft] = useState<{ id?: string; code: string; promotionId: string; maxUses: string; expires: string } | null>(null)
  const navigate = useNavigate()

  const load = useCallback(() => Promise.all([call('coupons.list'), call('promo.list')]).then(([a, b]) => (setCoupons(a), setPromos(b)), (err: unknown) => toast(errorMessage(err), 'error')), [toast])
  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    if (!draft) return
    try {
      await call('coupons.save', {
        ...(draft.id ? { id: draft.id } : {}),
        code: draft.code.trim(),
        promotionId: draft.promotionId,
        maxUses: draft.maxUses ? Number(draft.maxUses) : null,
        expiresAt: draft.expires ? dateToMs(draft.expires) : null,
      })
      toast(t.crud.saved)
      setDraft(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <PageHeader icon="tag" tone="amber" title={c.title} subtitle={c.subtitle} actions={can('promo:update') && promos.length > 0 && <GradientButton onClick={() => setDraft({ code: '', promotionId: promos[0]!.id, maxUses: '', expires: '' })}>{c.add}</GradientButton>} />
      {promos.length === 0 && (
        <Card className="flex items-center justify-between gap-3">
          <span className="text-sm">{c.noPromo}</span>
          <OutlineButton onClick={() => navigate('/promo')}>{t.promo.add}</OutlineButton>
        </Card>
      )}
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col gap-2">
          {coupons.map((x) => (
            <div key={x.id} role="listitem" className={rowClass(x.id === draft?.id)} onClick={() => setDraft({ id: x.id, code: x.code, promotionId: x.promotionId, maxUses: x.maxUses ? String(x.maxUses) : '', expires: x.expiresAt ? msToDateInput(x.expiresAt) : '' })}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-[15px] font-semibold">{x.code}</span>
                <span className="text-xs text-muted-foreground">
                  {x.promotionName}
                  {x.expiresAt ? ` · ${t.inventory.expires(formatDateTimeShort(x.expiresAt).slice(0, 8))}` : ''}
                </span>
              </div>
              <Chip>{c.usage(x.usedCount, x.maxUses)}</Chip>
            </div>
          ))}
          {coupons.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
        </Card>
        {draft && (
          <aside className={cn(panelClass, 'flex-[1_1_360px]')}>
            <Field label={c.code}>
              <TextInput className="uppercase" value={draft.code} maxLength={40} onChange={(e) => setDraft({ ...draft, code: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
            </Field>
            <Field label={c.promotion} hint={c.hint}>
              <SelectInput value={draft.promotionId} onChange={(e) => setDraft({ ...draft, promotionId: e.target.value })}>
                {promos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={c.maxUses}>
                <TextInput inputMode="numeric" value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label={c.expires}>
                <TextInput type="date" value={draft.expires} onChange={(e) => setDraft({ ...draft, expires: e.target.value })} />
              </Field>
            </div>
            <div className="flex gap-2.5">
              <GradientButton className="flex-1" disabled={draft.code.length < 3} onClick={() => void save()}>
                {c.save}
              </GradientButton>
              {draft.id && can('promo:delete') && (
                <DangerButton className="min-h-12" onClick={() => void call('coupons.delete', { id: draft.id! }).then(() => (setDraft(null), void load()), (err: unknown) => toast(errorMessage(err), 'error'))}>
                  {t.crud.delete}
                </DangerButton>
              )}
            </div>
          </aside>
        )}
      </div>
    </>
  )
}
