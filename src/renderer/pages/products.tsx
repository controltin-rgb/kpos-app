import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CategoryDto, IngredientDto, ModifierGroupDto, ProductDto, SizeModeDto } from '@shared/api-sales'
import { requirementPerUnit } from '@shared/bom'
import { uuidv7 } from '@shared/id'
import { MoneyInput, Segmented } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { useConfirm } from '@renderer/components/confirm'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { money, qty } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const pr = t.products
const PAGE = 7

interface SizeDraft {
  id: string
  label: string
  price: number | null
  mult: string
  isDefault: boolean
}
interface LineDraft {
  key: string
  ingredientId: string
  qty: string
  sizeMode: SizeModeDto
  perSize: Record<string, string>
}
interface Draft {
  id?: string
  name: string
  sku: string
  barcode: string
  categoryId: string
  kind: ProductDto['kind']
  vatType: ProductDto['vatType']
  active: boolean
  sizes: SizeDraft[]
  recipe: LineDraft[]
  groupIds: string[]
}

/** "1.375" → 1375 milli; null when invalid. */
function toMilli(s: string): number | null {
  if (!/^\d+(\.\d{1,3})?$/.test(s.trim())) return null
  const [i, f = ''] = s.trim().split('.')
  return Number(i) * 1000 + Number(f.padEnd(3, '0'))
}
const fromMilli = (m: number) => qty(m).replace(/,/g, '')

const newDraft = (): Draft => ({
  name: pr.newName,
  sku: '',
  barcode: '',
  categoryId: '',
  kind: 'drink',
  vatType: 'vat7',
  active: true,
  sizes: [{ id: uuidv7(), label: '16oz', price: null, mult: '1', isDefault: true }],
  recipe: [],
  groupIds: [],
})

function toDraft(p: ProductDto): Draft {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku ?? '',
    barcode: p.barcode ?? '',
    categoryId: p.categoryId ?? '',
    kind: p.kind,
    vatType: p.vatType,
    active: p.active,
    sizes: p.sizes.map((s) => ({ id: s.id, label: s.label, price: s.priceSatang, mult: fromMilli(s.multiplierMilli), isDefault: s.isDefault })),
    recipe: p.recipe.map((r) => ({
      key: uuidv7(),
      ingredientId: r.ingredientId,
      qty: fromMilli(r.qtyMilli),
      sizeMode: r.sizeMode,
      perSize: Object.fromEntries(Object.entries(r.perSize).map(([k, v]) => [k, fromMilli(v)])),
    })),
    groupIds: p.modifierGroupIds,
  }
}

/** docs/design/Products.dc.html (draft): products, sizes with multipliers, BOM with size modes. */
export function ProductsPage() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const [products, setProducts] = useState<ProductDto[]>([])
  const [categories, setCategories] = useState<CategoryDto[]>([])
  const [groups, setGroups] = useState<ModifierGroupDto[]>([])
  const [ingredients, setIngredients] = useState<IngredientDto[]>([])
  const [filter, setFilter] = useState({ cat: '', status: 'all', search: '', page: 1 })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tab, setTab] = useState<'general' | 'bom'>('general')
  const [previewSize, setPreviewSize] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const editable = can('products:update')

  const apply = useCallback((p: ProductDto[], c: CategoryDto[], g: ModifierGroupDto[], i: IngredientDto[]) => {
    setProducts(p)
    setCategories(c)
    setGroups(g)
    setIngredients(i)
  }, [])

  const load = useCallback(async () => {
    try {
      const [p, c, g, i] = await Promise.all([call('catalog.products'), call('catalog.categories'), call('catalog.groups'), call('inventory.ingredients').catch(() => [])])
      apply(p, c, g, i)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [apply, toast])

  useEffect(() => {
    let alive = true
    Promise.all([call('catalog.products'), call('catalog.categories'), call('catalog.groups'), call('inventory.ingredients').catch(() => [])]).then(
      ([p, c, g, i]) => alive && apply(p, c, g, i),
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [apply, toast])

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? pr.noCategory
  const ingById = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])
  const filtered = products.filter(
    (p) =>
      (!filter.cat || p.categoryId === filter.cat) &&
      (filter.status === 'all' || (filter.status === 'active') === p.active) &&
      (!filter.search || p.name.toLowerCase().includes(filter.search.toLowerCase()) || p.sku?.includes(filter.search)),
  )
  const rows = filtered.slice((filter.page - 1) * PAGE, filter.page * PAGE)
  const saved = products.find((p) => p.id === draft?.id) ?? null

  function open(d: Draft) {
    setDraft(d)
    setFields({})
    setPreviewSize(d.sizes.find((s) => s.isDefault)?.id ?? d.sizes[0]?.id ?? null)
  }

  const margin = (p: ProductDto) => (p.marginBp === null ? null : p.marginBp / 100)

  // ---- save ---------------------------------------------------------------
  async function save() {
    if (!draft) return
    const sizes = draft.sizes.map((s) => ({ id: s.id, label: s.label.trim(), priceSatang: s.price ?? -1, multiplierMilli: toMilli(s.mult) ?? 0, isDefault: s.isDefault }))
    const recipe = draft.recipe.map((r) => ({
      ingredientId: r.ingredientId,
      qtyMilli: toMilli(r.qty) ?? 0,
      sizeMode: r.sizeMode,
      perSize: r.sizeMode === 'custom' ? Object.fromEntries(Object.entries(r.perSize).map(([k, v]) => [k, toMilli(v) ?? 0])) : {},
    }))
    if (sizes.some((s) => s.priceSatang < 0 || s.multiplierMilli <= 0 || !s.label) || recipe.some((r) => !r.ingredientId || r.qtyMilli <= 0)) {
      toast(t.errors.INVALID_INPUT, 'error')
      return
    }
    setBusy(true)
    setFields({})
    try {
      const p = await call('catalog.saveProduct', {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name,
        sku: draft.sku || null,
        barcode: draft.barcode || null,
        categoryId: draft.categoryId || null,
        kind: draft.kind,
        vatType: draft.vatType,
        active: draft.active,
        sizes,
        recipe,
        modifierGroupIds: draft.groupIds,
      })
      toast(t.crud.saved)
      await load()
      open(toDraft(p))
    } catch (err) {
      setFields(fieldErrors(err))
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!draft?.id || !(await confirm({ kind: 'danger', title: t.confirmDialog.deleteTitle, message: t.crud.confirmDelete(draft.name), confirmLabel: t.confirmDialog.delete }))) return
    try {
      await call('catalog.deleteProduct', { id: draft.id })
      toast(t.crud.deleted)
      setDraft(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  function duplicate() {
    if (!draft) return
    const idMap = new Map(draft.sizes.map((s) => [s.id, uuidv7()]))
    open({
      ...draft,
      id: undefined,
      name: draft.name + pr.copySuffix,
      sku: '',
      barcode: '',
      sizes: draft.sizes.map((s) => ({ ...s, id: idMap.get(s.id)! })),
      recipe: draft.recipe.map((r) => ({ ...r, key: uuidv7(), perSize: Object.fromEntries(Object.entries(r.perSize).map(([k, v]) => [idMap.get(k) ?? k, v])) })),
    })
  }

  // ---- draft helpers --------------------------------------------------------
  const upd = (patch: Partial<Draft>) => draft && setDraft({ ...draft, ...patch })
  const updSize = (id: string, patch: Partial<SizeDraft>) =>
    draft && setDraft({ ...draft, sizes: draft.sizes.map((s) => (s.id === id ? { ...s, ...patch } : patch.isDefault ? { ...s, isDefault: false } : s)) })
  const updLine = (key: string, patch: Partial<LineDraft>) => draft && setDraft({ ...draft, recipe: draft.recipe.map((r) => (r.key === key ? { ...r, ...patch } : r)) })

  const preview = draft?.sizes.find((s) => s.id === previewSize) ?? draft?.sizes[0]
  const used = useMemo(() => {
    if (!draft || !preview) return new Map<string, number>()
    const lines = draft.recipe
      .filter((r) => r.ingredientId && toMilli(r.qty))
      .map((r) => ({
        ingredientId: r.ingredientId,
        qtyMilli: toMilli(r.qty)!,
        sizeMode: r.sizeMode,
        perSize: Object.fromEntries(Object.entries(r.perSize).map(([k, v]) => [k, toMilli(v) ?? 0])),
      }))
    return new Map(requirementPerUnit(lines, { id: preview.id, multiplierMilli: toMilli(preview.mult) ?? 1000 }, []).map((r) => [r.ingredientId, r.qtyMilli]))
  }, [draft, preview])

  const defSize = saved?.sizes.find((s) => s.isDefault) ?? saved?.sizes[0]
  const priceNet = saved?.netPriceSatang ?? 0

  return (
    <>
      <PageHeader icon="cup" tone="pink" title={pr.title} subtitle={pr.subtitle} actions={editable && <GradientButton onClick={() => open(newDraft())}>{pr.add}</GradientButton>} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_440px] flex-col gap-3.5">
          <div className="flex flex-wrap gap-2.5">
            <TextInput type="search" aria-label={t.crud.search} placeholder={t.crud.search} className="flex-[2_1_180px]" value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value, page: 1 })} />
            <SelectInput aria-label={pr.allCategories} className="flex-[1_1_120px]" value={filter.cat} onChange={(e) => setFilter({ ...filter, cat: e.target.value, page: 1 })}>
              <option value="">{pr.allCategories}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectInput>
            <SelectInput aria-label={pr.allStatus} className="flex-[1_1_110px]" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value, page: 1 })}>
              <option value="all">{pr.allStatus}</option>
              <option value="active">{pr.active}</option>
              <option value="inactive">{pr.inactive}</option>
            </SelectInput>
          </div>
          <div role="list" className="flex flex-col gap-1.5">
            {rows.map((p) => {
              const m = margin(p)
              return (
                <div
                  key={p.id}
                  role="listitem"
                  onClick={() => open(toDraft(p))}
                  className={cn('box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5', p.id === draft?.id ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]', !p.active && 'opacity-60')}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-semibold">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{pr.rowMeta(catName(p.categoryId), p.sizes.map((s) => money(s.priceSatang)).join(' / '), p.recipe.length)}</span>
                  </div>
                  {m !== null && (
                    <Chip bg={m >= 60 ? '#DDF5E8' : m >= 40 ? '#FFF4D6' : '#FFE3E3'} fg={m >= 60 ? '#11724A' : m >= 40 ? '#7A5200' : '#A6232B'}>
                      {pr.margin(String(m))}
                    </Chip>
                  )}
                </div>
              )
            })}
            {rows.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{t.crud.empty}</div>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-muted-foreground">{t.crud.showing(rows.length, filtered.length)}</span>
            <Pagination page={filter.page} pageSize={PAGE} total={filtered.length} onPage={(page) => setFilter({ ...filter, page })} />
          </div>
          <span className="text-xs text-muted-foreground">{pr.marginNote}</span>
        </Card>

        <aside className="box-border flex max-w-full min-w-0 flex-[1_1_560px] flex-col gap-3.5 rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
          {!draft ? (
            <p className="m-0 py-10 text-center text-sm text-muted-foreground">{t.crud.selectHint}</p>
          ) : (
            <>
              <div className="flex flex-col">
                <span className="text-lg font-bold">{draft.name}</span>
                <span className="text-[13px] text-muted-foreground">
                  {catName(draft.categoryId || null)}
                  {draft.sku ? ` · ${draft.sku}` : ''}
                </span>
              </div>
              <Segmented label={pr.title} value={tab} onChange={setTab} options={[{ value: 'general', label: pr.tabGeneral }, { value: 'bom', label: pr.tabBom }]} />

              {tab === 'general' && (
                <>
                  <Field label={pr.name} error={fields['name']}>
                    <TextInput value={draft.name} maxLength={120} disabled={!editable} onChange={(e) => upd({ name: e.target.value })} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={pr.sku} error={fields['sku']}>
                      <TextInput value={draft.sku} maxLength={40} disabled={!editable} onChange={(e) => upd({ sku: e.target.value })} />
                    </Field>
                    <Field label={pr.barcode}>
                      <TextInput value={draft.barcode} maxLength={40} disabled={!editable} onChange={(e) => upd({ barcode: e.target.value })} />
                    </Field>
                    <Field label={pr.category}>
                      <SelectInput value={draft.categoryId} disabled={!editable} onChange={(e) => upd({ categoryId: e.target.value })}>
                        <option value="">{pr.noCategory}</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                    <Field label={pr.kind}>
                      <SelectInput value={draft.kind} disabled={!editable} onChange={(e) => upd({ kind: e.target.value as Draft['kind'] })}>
                        {(Object.keys(pr.kinds) as Draft['kind'][]).map((k) => (
                          <option key={k} value={k}>
                            {pr.kinds[k]}
                          </option>
                        ))}
                      </SelectInput>
                    </Field>
                  </div>
                  <Field label={pr.vat}>
                    <SelectInput value={draft.vatType} disabled={!editable} onChange={(e) => upd({ vatType: e.target.value as Draft['vatType'] })}>
                      {(Object.keys(pr.vatTypes) as Draft['vatType'][]).map((k) => (
                        <option key={k} value={k}>
                          {pr.vatTypes[k]}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <div className="flex min-h-12 items-center justify-between">
                    <span className="text-[15px]">{pr.activeLabel}</span>
                    <Toggle checked={draft.active} label={pr.activeLabel} disabled={!editable} onChange={(v) => upd({ active: v })} />
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-bold">{pr.sizes}</span>
                    <div className="grid grid-cols-[1fr_1fr_90px_auto_auto] items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <span>{pr.sizeLabel}</span>
                      <span>{pr.sizePrice}</span>
                      <span>{pr.sizeMultiplier}</span>
                      <span>{pr.sizeDefault}</span>
                      <span />
                      {draft.sizes.map((s) => (
                        <div key={s.id} className="contents">
                          <TextInput aria-label={pr.sizeLabel} value={s.label} maxLength={30} disabled={!editable} onChange={(e) => updSize(s.id, { label: e.target.value })} />
                          <MoneyInput ariaLabel={pr.sizePrice} value={s.price} onChange={(v) => updSize(s.id, { price: v })} />
                          <TextInput aria-label={pr.sizeMultiplier} inputMode="decimal" value={s.mult} disabled={!editable} onChange={(e) => updSize(s.id, { mult: e.target.value })} />
                          <Toggle checked={s.isDefault} label={pr.sizeDefault} disabled={!editable} onChange={(v) => v && updSize(s.id, { isDefault: true })} />
                          <button
                            type="button"
                            aria-label={pr.removeSize}
                            disabled={!editable || draft.sizes.length <= 1}
                            onClick={() => upd({ sizes: draft.sizes.filter((x) => x.id !== s.id) })}
                            className="size-11 cursor-pointer rounded-xl border-0 bg-[#F7F5F2] text-lg disabled:opacity-40"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">{pr.baseNote}</span>
                    {editable && draft.sizes.length < 10 && (
                      <OutlineButton className="self-start" onClick={() => upd({ sizes: [...draft.sizes, { id: uuidv7(), label: '', price: null, mult: '1', isDefault: false }] })}>
                        {pr.addSize}
                      </OutlineButton>
                    )}
                  </div>

                  {groups.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-bold">{pr.groups}</span>
                      {groups.map((g) => (
                        <div key={g.id} className="flex min-h-12 items-center justify-between">
                          <span className="text-[15px]">
                            {g.name} <span className="text-xs text-muted-foreground">({g.options.map((o) => o.name).join(', ')})</span>
                          </span>
                          <Toggle
                            checked={draft.groupIds.includes(g.id)}
                            label={g.name}
                            disabled={!editable}
                            onChange={(v) => upd({ groupIds: v ? [...draft.groupIds, g.id] : draft.groupIds.filter((x) => x !== g.id) })}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab === 'bom' && (
                <>
                  {draft.sizes.length > 1 && (
                    <Segmented label={pr.previewSize} value={preview?.id ?? ''} onChange={setPreviewSize} options={draft.sizes.map((s) => ({ value: s.id, label: s.label || '—' }))} />
                  )}
                  <div className="grid grid-cols-[minmax(140px,1.4fr)_90px_minmax(120px,1fr)_90px_auto] items-center gap-2 text-xs font-semibold text-muted-foreground">
                    <span>{pr.ingredient}</span>
                    <span>{pr.baseQty}</span>
                    <span>{pr.mode}</span>
                    <span className="text-right">{pr.used(preview?.label ?? '')}</span>
                    <span />
                    {draft.recipe.map((r) => {
                      const ing = ingById.get(r.ingredientId)
                      const unit = ing ? t.units[ing.baseUnit] : ''
                      return (
                        <div key={r.key} className="contents">
                          <SelectInput aria-label={pr.ingredient} value={r.ingredientId} disabled={!editable} onChange={(e) => updLine(r.key, { ingredientId: e.target.value })}>
                            <option value="">{pr.pickIngredient}</option>
                            {ingredients.map((i) => (
                              <option key={i.id} value={i.id} disabled={i.id !== r.ingredientId && draft.recipe.some((x) => x.ingredientId === i.id)}>
                                {i.name} ({t.units[i.baseUnit]})
                              </option>
                            ))}
                          </SelectInput>
                          <TextInput aria-label={pr.baseQty} inputMode="decimal" value={r.qty} disabled={!editable} onChange={(e) => updLine(r.key, { qty: e.target.value })} />
                          <div className="flex flex-col gap-1">
                            <SelectInput aria-label={pr.mode} value={r.sizeMode} disabled={!editable} onChange={(e) => updLine(r.key, { sizeMode: e.target.value as SizeModeDto })}>
                              {(Object.keys(pr.modes) as SizeModeDto[]).map((m) => (
                                <option key={m} value={m}>
                                  {pr.modes[m]}
                                </option>
                              ))}
                            </SelectInput>
                            {r.sizeMode === 'custom' &&
                              draft.sizes.map((s) => (
                                <label key={s.id} className="flex items-center gap-1.5 text-xs font-normal text-foreground">
                                  <span className="w-12 shrink-0">{s.label}</span>
                                  <TextInput
                                    aria-label={`${pr.modes.custom} ${s.label}`}
                                    inputMode="decimal"
                                    className="min-h-9"
                                    value={r.perSize[s.id] ?? ''}
                                    disabled={!editable}
                                    onChange={(e) => updLine(r.key, { perSize: { ...r.perSize, [s.id]: e.target.value } })}
                                  />
                                </label>
                              ))}
                          </div>
                          <span className="text-right text-sm font-semibold text-foreground">{r.ingredientId && used.has(r.ingredientId) ? `${qty(used.get(r.ingredientId)!)} ${unit}` : '—'}</span>
                          <button
                            type="button"
                            aria-label={pr.removeLine}
                            disabled={!editable}
                            onClick={() => upd({ recipe: draft.recipe.filter((x) => x.key !== r.key) })}
                            className="size-11 cursor-pointer rounded-xl border-0 bg-[#F7F5F2] text-lg disabled:opacity-40"
                          >
                            ×
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  {editable && (
                    <OutlineButton
                      className="self-start"
                      onClick={() => upd({ recipe: [...draft.recipe, { key: uuidv7(), ingredientId: '', qty: '', sizeMode: 'scale', perSize: {} }] })}
                    >
                      {pr.addIngredient}
                    </OutlineButton>
                  )}
                  {saved && defSize && (
                    <div className="flex flex-col gap-1.5 rounded-2xl bg-[#F7F5F2] px-4 py-3 text-sm">
                      {saved.costSatang === null ? (
                        <span className="text-muted-foreground">{pr.costUnknown}</span>
                      ) : (
                        <>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{pr.costPerCup(defSize.label)}</span>
                            <span>{money(saved.costSatang)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{pr.price}</span>
                            <span>{money(defSize.priceSatang)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">{pr.beforeVat}</span>
                            <span>{money(priceNet)}</span>
                          </div>
                          <div className="flex justify-between font-bold">
                            <span>{pr.profit}</span>
                            <span>
                              {money(priceNet - saved.costSatang)} · {margin(saved) ?? '—'}%
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  <span className="text-xs text-muted-foreground">{pr.bomNote}</span>
                </>
              )}

              {editable && (
                <div className="flex flex-wrap gap-2.5">
                  <GradientButton className="flex-1" disabled={busy || !draft.name.trim()} onClick={() => void save()}>
                    {busy ? t.common.saving : pr.save}
                  </GradientButton>
                  {draft.id && <OutlineButton className="min-h-12" onClick={duplicate}>{pr.duplicate}</OutlineButton>}
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
