import { useCallback, useEffect, useState } from 'react'
import type { CategoryDto, IngredientDto, ModifierGroupDto } from '@shared/api-sales'
import { uuidv7 } from '@shared/id'
import { MoneyInput } from '@renderer/components/modal'
import { Card, DangerButton, Field, GradientButton, OutlineButton, PageHeader, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { useConfirm } from '@renderer/components/confirm'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { money, qty } from '@renderer/lib/format'
import { useFeatures, useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const rowCls = (sel: boolean) => cn('box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5', sel ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]')
const panelCls = 'box-border flex max-w-full flex-[1_1_420px] flex-col gap-3.5 rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]'

function toMilli(s: string): number | null {
  if (!/^\d+(\.\d{1,3})?$/.test(s.trim())) return null
  const [i, f = ''] = s.trim().split('.')
  return Number(i) * 1000 + Number(f.padEnd(3, '0'))
}

// ---------------------------------------------------------------------------
// Categories (no prototype yet — follows the Products page style)
// ---------------------------------------------------------------------------

export function CategoriesPage() {
  const { can } = useSession()
  const features = useFeatures()
  const toast = useToast()
  const confirm = useConfirm()
  const c = t.categories
  const [items, setItems] = useState<CategoryDto[]>([])
  const [draft, setDraft] = useState<{ id?: string; name: string; kdsStation: string; skuPrefix: string; sortOrder: string } | null>(null)
  const editable = can('products:update')

  const load = useCallback(() => call('catalog.categories').then(setItems, (err: unknown) => toast(errorMessage(err), 'error')), [toast])
  useEffect(() => {
    let alive = true
    call('catalog.categories').then((v) => alive && setItems(v), (err: unknown) => toast(errorMessage(err), 'error'))
    return () => {
      alive = false
    }
  }, [toast])

  async function save() {
    if (!draft) return
    try {
      const saved = await call('catalog.saveCategory', { ...(draft.id ? { id: draft.id } : {}), name: draft.name, kdsStation: draft.kdsStation || null, skuPrefix: draft.skuPrefix || null, sortOrder: Number(draft.sortOrder) || 0 })
      toast(t.crud.saved)
      await load()
      setDraft({ id: saved.id, name: saved.name, kdsStation: saved.kdsStation ?? '', skuPrefix: saved.skuPrefix ?? '', sortOrder: String(saved.sortOrder) })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  async function remove() {
    if (!draft?.id || !(await confirm({ kind: 'danger', title: t.confirmDialog.deleteTitle, message: t.crud.confirmDelete(draft.name), confirmLabel: t.confirmDialog.delete }))) return
    try {
      await call('catalog.deleteCategory', { id: draft.id })
      toast(t.crud.deleted)
      setDraft(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <PageHeader icon="cup" tone="pink" title={c.title} subtitle={c.subtitle} actions={editable && <GradientButton onClick={() => setDraft({ name: '', kdsStation: 'bar', skuPrefix: '', sortOrder: String(items.length) })}>{c.add}</GradientButton>} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col gap-1.5">
          {items.map((it) => (
            <div key={it.id} role="listitem" className={rowCls(it.id === draft?.id)} onClick={() => setDraft({ id: it.id, name: it.name, kdsStation: it.kdsStation ?? '', skuPrefix: it.skuPrefix ?? '', sortOrder: String(it.sortOrder) })}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold">{it.name}</span>
                <span className="text-xs text-muted-foreground">
                  {c.count(it.productCount)} · {it.kdsStation ? (c.stations[it.kdsStation as keyof typeof c.stations] ?? it.kdsStation) : '—'}
                </span>
              </div>
            </div>
          ))}
          {items.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t.crud.empty}</div>}
        </Card>
        <aside className={panelCls}>
          {!draft ? (
            <p className="m-0 py-10 text-center text-sm text-muted-foreground">{t.crud.selectHint}</p>
          ) : (
            <>
              <Field label={c.name}>
                <TextInput value={draft.name} maxLength={120} autoFocus disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              {features.kds && (
              <Field label={c.station}>
                <SelectInput value={draft.kdsStation} disabled={!editable} onChange={(e) => setDraft({ ...draft, kdsStation: e.target.value })}>
                  {(Object.keys(c.stations) as (keyof typeof c.stations)[]).map((s) => (
                    <option key={s} value={s}>
                      {c.stations[s]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              )}
              <Field label={c.skuPrefix} hint={c.skuPrefixHint(draft.skuPrefix || 'P')}>
                <TextInput value={draft.skuPrefix} maxLength={6} placeholder="P" disabled={!editable} onChange={(e) => setDraft({ ...draft, skuPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
              </Field>
              <Field label={c.sort}>
                <TextInput inputMode="numeric" value={draft.sortOrder} disabled={!editable} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value.replace(/\D/g, '') })} />
              </Field>
              {editable && (
                <div className="flex gap-2.5">
                  <GradientButton className="flex-1" disabled={!draft.name.trim()} onClick={() => void save()}>
                    {t.crud.save}
                  </GradientButton>
                  {draft.id && can('products:delete') && (
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

// ---------------------------------------------------------------------------
// Modifier groups & toppings (no prototype yet)
// ---------------------------------------------------------------------------

interface OptionDraft {
  id: string
  name: string
  price: number | null
  isDefault: boolean
  items: { key: string; ingredientId: string; qty: string; sizeMode: 'scale' | 'fixed' }[]
}
interface GroupDraft {
  id?: string
  name: string
  min: string
  max: string
  kdsHighlight: boolean
  options: OptionDraft[]
}

const toGroupDraft = (g: ModifierGroupDto): GroupDraft => ({
  id: g.id,
  name: g.name,
  min: String(g.minSelect),
  max: String(g.maxSelect),
  kdsHighlight: g.kdsHighlight,
  options: g.options.map((o) => ({
    id: o.id,
    name: o.name,
    price: o.priceSatang,
    isDefault: o.isDefault,
    items: o.items.map((i) => ({ key: uuidv7(), ingredientId: i.ingredientId, qty: qty(i.qtyMilli).replace(/,/g, ''), sizeMode: i.sizeMode })),
  })),
})

export function ModifiersPage() {
  const { can } = useSession()
  const features = useFeatures()
  const toast = useToast()
  const confirm = useConfirm()
  const m = t.modifiers
  const [groups, setGroups] = useState<ModifierGroupDto[]>([])
  const [ingredients, setIngredients] = useState<IngredientDto[]>([])
  const [draft, setDraft] = useState<GroupDraft | null>(null)
  const editable = can('products:update')

  const load = useCallback(() => call('catalog.groups').then(setGroups, (err: unknown) => toast(errorMessage(err), 'error')), [toast])
  useEffect(() => {
    let alive = true
    Promise.all([call('catalog.groups'), call('inventory.ingredients').catch(() => [])]).then(
      ([g, i]) => {
        if (!alive) return
        setGroups(g)
        setIngredients(i)
      },
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [toast])

  const updOpt = (id: string, patch: Partial<OptionDraft>) => draft && setDraft({ ...draft, options: draft.options.map((o) => (o.id === id ? { ...o, ...patch } : o)) })

  async function save() {
    if (!draft) return
    const options = draft.options.map((o) => ({
      id: o.id,
      name: o.name.trim(),
      priceSatang: o.price ?? 0,
      isDefault: o.isDefault,
      items: o.items.filter((i) => i.ingredientId).map((i) => ({ ingredientId: i.ingredientId, qtyMilli: toMilli(i.qty) ?? 0, sizeMode: i.sizeMode })),
    }))
    if (options.some((o) => !o.name || o.items.some((i) => i.qtyMilli <= 0))) {
      toast(t.errors.INVALID_INPUT, 'error')
      return
    }
    try {
      const g = await call('catalog.saveGroup', { ...(draft.id ? { id: draft.id } : {}), name: draft.name, minSelect: Number(draft.min) || 0, maxSelect: Math.max(1, Number(draft.max) || 1), kdsHighlight: draft.kdsHighlight, options })
      toast(t.crud.saved)
      await load()
      setDraft(toGroupDraft(g))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  async function remove() {
    if (!draft?.id || !(await confirm({ kind: 'danger', title: t.confirmDialog.deleteTitle, message: t.crud.confirmDelete(draft.name), confirmLabel: t.confirmDialog.delete }))) return
    try {
      await call('catalog.deleteGroup', { id: draft.id })
      toast(t.crud.deleted)
      setDraft(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const newOption = (): OptionDraft => ({ id: uuidv7(), name: '', price: 0, isDefault: false, items: [] })

  return (
    <>
      <PageHeader icon="tag" tone="amber" title={m.title} subtitle={m.subtitle} actions={editable && <GradientButton onClick={() => setDraft({ name: m.newName, min: '0', max: '1', kdsHighlight: false, options: [newOption()] })}>{m.add}</GradientButton>} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_360px] flex-col gap-1.5">
          {groups.map((g) => (
            <div key={g.id} role="listitem" className={rowCls(g.id === draft?.id)} onClick={() => setDraft(toGroupDraft(g))}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold">{g.name}</span>
                <span className="text-xs text-muted-foreground">{m.rowMeta(g.options.length, g.minSelect, g.maxSelect)}</span>
              </div>
            </div>
          ))}
          {groups.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t.crud.empty}</div>}
        </Card>
        <aside className={cn(panelCls, 'flex-[1_1_560px]')}>
          {!draft ? (
            <p className="m-0 py-10 text-center text-sm text-muted-foreground">{t.crud.selectHint}</p>
          ) : (
            <>
              <Field label={m.name}>
                <TextInput value={draft.name} maxLength={120} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={m.min}>
                  <TextInput inputMode="numeric" value={draft.min} disabled={!editable} onChange={(e) => setDraft({ ...draft, min: e.target.value.replace(/\D/g, '') })} />
                </Field>
                <Field label={m.max}>
                  <TextInput inputMode="numeric" value={draft.max} disabled={!editable} onChange={(e) => setDraft({ ...draft, max: e.target.value.replace(/\D/g, '') })} />
                </Field>
              </div>
              {features.kds && (
              <div className="flex min-h-12 items-center justify-between">
                <span className="text-[15px]">{m.highlight}</span>
                <Toggle checked={draft.kdsHighlight} label={m.highlight} disabled={!editable} onChange={(v) => setDraft({ ...draft, kdsHighlight: v })} />
              </div>
              )}
              <span className="text-sm font-bold">{m.options}</span>
              {draft.options.map((o) => (
                <div key={o.id} className="flex flex-col gap-2 rounded-2xl bg-[#F7F5F2] p-3">
                  <div className="grid grid-cols-[1fr_130px_auto_auto] items-end gap-2">
                    <Field label={m.optionName}>
                      <TextInput value={o.name} maxLength={60} disabled={!editable} onChange={(e) => updOpt(o.id, { name: e.target.value })} />
                    </Field>
                    <Field label={m.optionPrice}>
                      <MoneyInput value={o.price} onChange={(v) => updOpt(o.id, { price: v })} ariaLabel={m.optionPrice} />
                    </Field>
                    <div className="flex flex-col items-center gap-1 text-xs font-semibold">
                      {m.optionDefault}
                      <Toggle checked={o.isDefault} label={m.optionDefault} disabled={!editable} onChange={(v) => updOpt(o.id, { isDefault: v })} />
                    </div>
                    <button
                      type="button"
                      aria-label={t.crud.delete}
                      disabled={!editable || draft.options.length <= 1}
                      onClick={() => setDraft({ ...draft, options: draft.options.filter((x) => x.id !== o.id) })}
                      className="size-11 cursor-pointer rounded-xl border-0 bg-white text-lg disabled:opacity-40"
                    >
                      ×
                    </button>
                  </div>
                  {features.inventory && (
                    <>
                  <span className="text-xs font-semibold text-muted-foreground">{m.optionBom}</span>
                  {o.items.map((it) => (
                    <div key={it.key} className="grid grid-cols-[1fr_90px_130px_auto] items-center gap-2">
                      <SelectInput aria-label={t.products.ingredient} value={it.ingredientId} disabled={!editable} onChange={(e) => updOpt(o.id, { items: o.items.map((x) => (x.key === it.key ? { ...x, ingredientId: e.target.value } : x)) })}>
                        <option value="">{t.products.pickIngredient}</option>
                        {ingredients.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name} ({t.units[i.baseUnit]})
                          </option>
                        ))}
                      </SelectInput>
                      <TextInput aria-label={t.products.baseQty} inputMode="decimal" value={it.qty} disabled={!editable} onChange={(e) => updOpt(o.id, { items: o.items.map((x) => (x.key === it.key ? { ...x, qty: e.target.value } : x)) })} />
                      <SelectInput aria-label={t.products.mode} value={it.sizeMode} disabled={!editable} onChange={(e) => updOpt(o.id, { items: o.items.map((x) => (x.key === it.key ? { ...x, sizeMode: e.target.value as 'scale' | 'fixed' } : x)) })}>
                        <option value="fixed">{t.products.modes.fixed}</option>
                        <option value="scale">{t.products.modes.scale}</option>
                      </SelectInput>
                      <button type="button" aria-label={t.products.removeLine} disabled={!editable} onClick={() => updOpt(o.id, { items: o.items.filter((x) => x.key !== it.key) })} className="size-11 cursor-pointer rounded-xl border-0 bg-white text-lg">
                        ×
                      </button>
                    </div>
                  ))}
                  {editable && (
                    <button type="button" onClick={() => updOpt(o.id, { items: [...o.items, { key: uuidv7(), ingredientId: '', qty: '', sizeMode: 'fixed' }] })} className="self-start border-0 bg-transparent text-sm font-semibold text-accent-foreground">
                      {t.products.addIngredient}
                    </button>
                  )}
                    </>
                  )}
                  {o.price ? <span className="text-xs text-muted-foreground">+{money(o.price)}</span> : null}
                </div>
              ))}
              {editable && (
                <OutlineButton className="self-start" onClick={() => setDraft({ ...draft, options: [...draft.options, newOption()] })}>
                  {m.addOption}
                </OutlineButton>
              )}
              {editable && (
                <div className="flex gap-2.5">
                  <GradientButton className="flex-1" disabled={!draft.name.trim()} onClick={() => void save()}>
                    {t.crud.save}
                  </GradientButton>
                  {draft.id && can('products:delete') && (
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
