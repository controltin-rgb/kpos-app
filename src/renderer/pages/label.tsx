import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import QRCode from 'qrcode'
import type { ExpiringLotDto } from '@shared/api-stock'
import type { CategoryDto, ModifierGroupDto, ProductDto } from '@shared/api-sales'
import { useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort } from '@renderer/lib/format'

/**
 * Confirmed prototype docs/design/Label.dc.html — reproduced 1:1 in layout and copy.
 * The sample data is replaced by real products / expiring lots; filters that were tied to the
 * sample fields (cup size, sweetness, topping) map to sizes, modifier options and modifier groups.
 */
const L = t.label
type Kind = 'cup' | 'exp' | 'shelf'
type Sort = keyof typeof L.sorts
type Flag = keyof typeof L.toggles

const SIZES = [
  { w: 50, h: 30, cols: 3, rows: 8 },
  { w: 60, h: 40, cols: 3, rows: 6 },
  { w: 70, h: 40, cols: 2, rows: 6 },
  { w: 90, h: 60, cols: 2, rows: 4 },
]
const PALETTE = ['#F7791E', '#1BA56B', '#E23B76', '#6A47DB', '#14A094', '#E5A10C']
const RAW_COLOR = '#4C8DF6'
const PS = 6
const K = 560 / 210 // preview px per mm
const PT_MM = 0.3528

interface Item {
  key: string
  qr: string
  name: string
  cat: string
  catName: string
  color: string
  priceSatang: number | null
  active: boolean
  mods: string
  date: string
  hasExtras: boolean
  sizes: string[]
  optionIds: string[]
}

const baht = (s: number) => `฿${s % 100 ? (s / 100).toFixed(2) : String(s / 100)}`
const dmy = (ms: number) => formatDateTimeShort(ms).slice(0, 8)

/** Real QR (KPOSS:P:<productId> / KPOSS:L:<lotId>) rendered as an SVG path. */
function qrSvg(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  let d = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#1F2430"/></svg>`
}

const qrCache = new Map<string, string>()
function qrUrl(text: string): string {
  let v = qrCache.get(text)
  if (!v) {
    v = `url("data:image/svg+xml,${encodeURIComponent(qrSvg(text))}")`
    qrCache.set(text, v)
  }
  return v
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const inCls =
  'min-h-11 w-full box-border rounded-[14px] border-[1.5px] border-[#E6E1D9] bg-white px-3.5 font-[inherit] text-[15px] text-foreground focus:outline-2 focus:outline-offset-1 focus:outline-[#9776F6]'
const lbl = 'flex flex-[1_1_150px] flex-col gap-1.5 text-sm font-semibold'
const sectionTitle = 'text-[13px] font-bold tracking-[0.04em] text-[#6A47DB]'
const track = (on: boolean): CSSProperties => ({
  flex: '0 0 auto',
  position: 'relative',
  width: 52,
  height: 32,
  minHeight: 32,
  padding: 0,
  border: 0,
  borderRadius: 16,
  cursor: 'pointer',
  transition: 'background .15s',
  background: on ? 'linear-gradient(90deg,#6A47DB,#9776F6)' : '#D5D1CA',
})
const knob = (on: boolean): CSSProperties => ({ position: 'absolute', top: 3, left: on ? 23 : 3, width: 26, height: 26, borderRadius: '50%', background: '#FFFFFF', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left .15s' })

function Switch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} style={track(on)}>
      <span style={knob(on)} />
    </button>
  )
}

const DEFAULT_FILTERS = { q: '', cat: 'all', status: 'all' as 'all' | 'active' | 'off', cup: 'all', option: 'all', extras: 'all' as 'all' | 'yes' | 'no', sort: 'name' as Sort, maxPrice: null as number | null }

export function LabelPage() {
  const toast = useToast()
  const [products, setProducts] = useState<ProductDto[]>([])
  const [cats, setCats] = useState<CategoryDto[]>([])
  const [groups, setGroups] = useState<ModifierGroupDto[]>([])
  const [lots, setLots] = useState<ExpiringLotDto[]>([])
  const [s, setS] = useState({ page: 0, size: 0, font: 10, copies: 1, kind: 'cup' as Kind, off: {} as Record<string, boolean>, ...DEFAULT_FILTERS })
  const [flags, setFlags] = useState<Record<Flag, boolean>>({ showPrice: true, showQR: true, showMods: true, showDate: true })
  const set = (patch: Partial<typeof s>) => setS((x) => ({ ...x, ...patch }))

  useEffect(() => {
    const fail = (err: unknown) => toast(errorMessage(err), 'error')
    void call('catalog.products').then(setProducts, fail)
    void call('catalog.categories').then(setCats, fail)
    void call('catalog.groups').then(setGroups, fail)
    void call('waste.expiring', { withinDays: 60 }).then(setLots, fail)
  }, [toast])

  const options = useMemo(() => groups.flatMap((g) => g.options.map((o) => ({ id: o.id, name: o.name, groupId: g.id, group: g.name }))), [groups])
  const sizeNames = useMemo(() => [...new Set(products.flatMap((p) => p.sizes.map((z) => z.label)))], [products])

  const [now] = useState(() => Date.now())
  const items: Item[] = useMemo(() => {
    if (s.kind === 'exp')
      return lots.map((l) => ({
        key: `L:${l.lotId}`,
        qr: `KPOSS:L:${l.lotId}`,
        name: l.ingredientName,
        cat: 'raw',
        catName: L.tagRaw,
        color: RAW_COLOR,
        priceSatang: null,
        active: true,
        mods: l.lotNo ? L.lot(l.lotNo) : '',
        date: L.exp(dmy(l.expiresAt)),
        hasExtras: false,
        sizes: [],
        optionIds: [],
      }))
    const opt = options.find((o) => o.id === s.option)
    return products.map((p) => {
      const ci = cats.findIndex((c) => c.id === p.categoryId)
      const cat = cats[ci]
      const size = (s.cup !== 'all' && p.sizes.find((z) => z.label === s.cup)) || p.sizes.find((z) => z.isDefault) || p.sizes[0]
      const optHere = opt && p.modifierGroupIds.includes(opt.groupId) ? opt.name : null
      return {
        key: `P:${p.id}`,
        qr: `KPOSS:P:${p.id}`,
        name: p.name,
        cat: p.categoryId ?? '',
        catName: cat?.name ?? L.noCategory,
        color: cat?.color ?? PALETTE[(ci < 0 ? 0 : ci) % PALETTE.length]!,
        priceSatang: size?.priceSatang ?? null,
        active: p.active,
        mods: [p.sizes.length > 1 ? size?.label : null, optHere].filter(Boolean).join(' · '),
        date: L.printedOn(dmy(now)),
        hasExtras: p.modifierGroupIds.length > 0,
        sizes: p.sizes.map((z) => z.label),
        optionIds: p.modifierGroupIds.flatMap((g) => options.filter((o) => o.groupId === g).map((o) => o.id)),
      }
    })
  }, [s.kind, s.cup, s.option, lots, products, cats, options, now])

  const priceCap = useMemo(() => Math.max(2000, Math.ceil(Math.max(0, ...items.map((i) => i.priceSatang ?? 0)) / 500) * 500), [items])
  const maxPrice = s.maxPrice ?? priceCap

  const q = s.q.trim()
  const shown = items
    .filter((p) => {
      if (s.cat !== 'all' && p.cat !== s.cat) return false
      if (s.status === 'active' && !p.active) return false
      if (s.status === 'off' && p.active) return false
      if (s.cup !== 'all' && p.cat !== 'raw' && !p.sizes.includes(s.cup)) return false
      if (s.option !== 'all' && p.cat !== 'raw' && !p.optionIds.includes(s.option)) return false
      if (s.extras === 'yes' && !p.hasExtras) return false
      if (s.extras === 'no' && p.hasExtras) return false
      if (q && !p.name.includes(q)) return false
      if (p.priceSatang !== null && p.priceSatang > maxPrice) return false
      return true
    })
    .sort((a, b) => (s.sort === 'priceAsc' ? (a.priceSatang ?? 0) - (b.priceSatang ?? 0) : s.sort === 'priceDesc' ? (b.priceSatang ?? 0) - (a.priceSatang ?? 0) : a.name.localeCompare(b.name, 'th')))

  const sz = SIZES[s.size]!
  const capacity = sz.cols * sz.rows
  const pageCount = Math.max(1, Math.ceil(shown.length / PS))
  const page = Math.min(s.page, pageCount - 1)
  const pageItems = shown.slice(page * PS, page * PS + PS)
  const picked = shown.filter((p) => !s.off[p.key])
  const total = picked.length * s.copies
  const expanded = picked.flatMap((p) => Array.from({ length: s.copies }, () => p))
  const isShelf = s.kind === 'shelf'

  // layout maths shared by the preview (px) and the print sheet (mm)
  const layout = (unit: number) => {
    const cw = sz.w * unit
    const ch = sz.h * unit
    const px = (pt: number) => pt * PT_MM * unit
    const namePx = px(s.font)
    const pad = { y: (7 / K) * unit, x: (8 / K) * unit }
    const qrSize = flags.showQR ? Math.min(ch - 2 * pad.y, cw * 0.36) : 0
    const textW = cw - qrSize - (flags.showQR ? 30 / K : 22 / K) * unit
    return { cw, ch, px, namePx, pad, qrSize, textW }
  }

  const cell = (p: Item, unit: number) => {
    const { ch, px, namePx, pad, textW } = layout(unit)
    const lines = Math.ceil((p.name.length * namePx * 0.62) / textW)
    const price = p.priceSatang !== null ? baht(p.priceSatang) : ''
    const pricePx = px(s.font * (isShelf ? 1.9 : 1.25))
    const modsPx = px(6.5)
    const datePx = px(5.5)
    const showPrice = flags.showPrice && !!price
    const showMods = flags.showMods && !!p.mods
    const need = 2 * pad.y + (9 / K) * unit + lines * namePx * 1.25 + (showMods ? modsPx * 1.5 : 0) + (showPrice ? pricePx * 1.3 : 0) + (flags.showDate ? datePx * 1.4 : 0)
    return {
      tag: s.kind === 'exp' ? L.tagRaw : isShelf ? L.tagShelf : p.catName,
      price,
      showPrice,
      showMods,
      pricePx,
      modsPx,
      datePx,
      bad: need > ch || lines > 2,
    }
  }

  const cells = expanded.slice(0, capacity).map((p) => ({ p, c: cell(p, K) }))
  const anyBad = cells.some((x) => x.c.bad)
  const tooMany = total > capacity
  const statusBase: CSSProperties = { height: 36, display: 'inline-flex', alignItems: 'center', padding: '0 16px', borderRadius: 18, fontSize: 14, fontWeight: 600 }
  let status = { text: L.statusFit(cells.length), bg: '#DDF5E8', fg: '#11724A' }
  if (total === 0) status = { text: L.statusNone, bg: '#F0EDE8', fg: '#5C6270' }
  else if (tooMany) status = { text: L.statusOver(total, capacity), bg: '#FFE3E3', fg: '#A6232B' }
  else if (anyBad) status = { text: L.statusOverflow, bg: '#FFE3E3', fg: '#A6232B' }


  async function print() {
    if (!expanded.length) return
    // mm units; 1 unit = 1 mm. Same structure as the preview.
    const { cw, ch, namePx, pad, qrSize } = layout(1)
    const sheets: string[] = []
    for (let i = 0; i < expanded.length; i += capacity) {
      const cellsHtml = expanded
        .slice(i, i + capacity)
        .map((p) => {
          const c = cell(p, 1)
          return `<div class="c" style="width:${cw}mm;height:${ch}mm;padding:${pad.y}mm ${pad.x}mm"><span class="a" style="background:${esc(p.color)}"></span><div class="b"><div class="v"><span style="font-size:${PT_MM * 5.5}mm;font-weight:700;letter-spacing:.05em;color:${esc(p.color)}">${esc(c.tag)}</span><span style="font-size:${namePx}mm;font-weight:700;line-height:1.2;overflow:hidden">${esc(p.name)}</span>${c.showMods ? `<span style="font-size:${c.modsPx}mm;color:#5C6270;line-height:1.25">${esc(p.mods)}</span>` : ''}</div><div class="v">${c.showPrice ? `<span style="font-size:${c.pricePx}mm;font-weight:700;color:#4B2FB8;line-height:1.1">${esc(c.price)}</span>` : ''}${flags.showDate ? `<span style="font-size:${c.datePx}mm;${p.cat === 'raw' ? 'font-weight:700;color:#B42318' : 'color:#7A8090'}">${esc(p.date)}</span>` : ''}</div></div>${flags.showQR ? `<span class="q" style="width:${qrSize}mm;height:${qrSize}mm">${qrSvg(p.qr)}</span>` : ''}</div>`
        })
        .join('')
      sheets.push(`<section class="s" style="grid-template-columns:repeat(${sz.cols},${cw}mm);grid-auto-rows:${ch}mm">${cellsHtml}</section>`)
    }
    const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><style>
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans Thai',system-ui,sans-serif;color:#1F2430;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.s{width:210mm;height:297mm;padding:10mm;display:grid;align-content:start;page-break-after:always;break-after:page}.s:last-child{page-break-after:auto;break-after:auto}
.c{overflow:hidden;display:flex;align-items:stretch;gap:1.5mm;border:.2mm dashed #DDD7CE;border-radius:2mm}
.a{flex:0 0 .8mm;align-self:stretch;border-radius:.5mm}.b{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between}.v{display:flex;flex-direction:column}
.q{flex:0 0 auto;align-self:center}.q svg{width:100%;height:100%;display:block}
</style></head><body>${sheets.join('')}</body></html>`
    try {
      await call('labels.print', { html })
      toast(L.printed)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const prevOk = page > 0
  const nextOk = page < pageCount - 1
  const navStyle = (ok: boolean): CSSProperties => ({
    flex: '0 0 auto',
    minHeight: 44,
    padding: '0 16px',
    borderRadius: 14,
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 600,
    border: 0,
    ...(ok ? { background: '#EDE9FB', color: '#4B2FB8', cursor: 'pointer' } : { background: '#F0EDE8', color: '#A9A59E', cursor: 'not-allowed' }),
  })
  const pv = layout(K)

  return (
    <div className="box-border flex flex-wrap gap-5 text-foreground">
      <aside aria-label={L.aside} className="box-border flex max-w-full flex-[0_0_380px] flex-col gap-[18px] self-start rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-[14px] bg-[linear-gradient(135deg,#8B6CF0,#6A47DB)] shadow-[0_8px_16px_rgba(106,71,219,0.28)]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 8V3h10v5" />
              <rect x="4" y="8" width="16" height="9" rx="2" />
              <path d="M7 14h10v7H7z" />
            </svg>
          </div>
          <div className="flex flex-col">
            <h1 className="m-0 text-[22px] font-bold">{L.title}</h1>
            <span className="text-[13px] text-muted-foreground">{L.subtitle}</span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <span className={sectionTitle}>{L.format}</span>
          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            {L.kind}
            <select className={inCls} value={s.kind} onChange={(e) => set({ page: 0, kind: e.target.value as Kind, cat: 'all' })}>
              {(Object.keys(L.kinds) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {L.kinds[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            {L.size}
            <select className={inCls} value={s.size} onChange={(e) => set({ size: Number(e.target.value) })}>
              {SIZES.map((z, i) => (
                <option key={i} value={i}>
                  {L.sizeOpt(z.w, z.h, z.cols, z.rows)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <label className={lbl}>
              <span>{L.font(s.font)}</span>
              <input type="range" min={7} max={16} value={s.font} onChange={(e) => set({ font: Number(e.target.value) })} className="min-h-11 w-full accent-[#6A47DB]" />
            </label>
            <div className={lbl}>
              {L.copies}
              <div className="flex items-center gap-2">
                <button type="button" aria-label={L.dec} onClick={() => set({ copies: Math.max(1, s.copies - 1) })} className="size-11 cursor-pointer rounded-[14px] border-[1.5px] border-[#E6E1D9] bg-white text-xl">
                  −
                </button>
                <span className="min-w-9 text-center text-lg font-bold">{s.copies}</span>
                <button type="button" aria-label={L.inc} onClick={() => set({ copies: Math.min(10, s.copies + 1) })} className="size-11 cursor-pointer rounded-[14px] border-0 bg-[#EDE9FB] text-xl text-[#4B2FB8]">
                  +
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#EFEBE6] pt-4">
          <div className="flex items-center justify-between">
            <span className={sectionTitle}>{L.filters}</span>
            <button type="button" onClick={() => set({ page: 0, ...DEFAULT_FILTERS })} className="min-h-11 cursor-pointer border-0 bg-transparent px-2 font-[inherit] text-sm font-semibold text-[#6A47DB]">
              {L.clearFilters}
            </button>
          </div>
          <input className={inCls} type="search" placeholder={L.search} aria-label={L.search} value={s.q} onChange={(e) => set({ page: 0, q: e.target.value })} />
          <div className="flex flex-wrap gap-2.5">
            <label className={lbl}>
              {L.category}
              <select className={inCls} value={s.cat} disabled={s.kind === 'exp'} onChange={(e) => set({ page: 0, cat: e.target.value })}>
                <option value="all">{L.all}</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={lbl}>
              {L.status}
              <select className={inCls} value={s.status} onChange={(e) => set({ page: 0, status: e.target.value as typeof s.status })}>
                <option value="all">{L.all}</option>
                <option value="active">{L.active}</option>
                <option value="off">{L.inactive}</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <label className={lbl}>
              {L.sizeFilter}
              <select className={inCls} value={s.cup} onChange={(e) => set({ page: 0, cup: e.target.value })}>
                <option value="all">{L.allSizes}</option>
                {sizeNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className={lbl}>
              {L.option}
              <select className={inCls} value={s.option} onChange={(e) => set({ page: 0, option: e.target.value })}>
                <option value="all">{L.allOptions}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.group}: {o.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <label className={lbl}>
              {L.extras}
              <select className={inCls} value={s.extras} onChange={(e) => set({ page: 0, extras: e.target.value as typeof s.extras })}>
                <option value="all">{L.all}</option>
                <option value="yes">{L.hasExtras}</option>
                <option value="no">{L.noExtras}</option>
              </select>
            </label>
            <label className={lbl}>
              {L.sort}
              <select className={inCls} value={s.sort} onChange={(e) => set({ page: 0, sort: e.target.value as Sort })}>
                {(Object.keys(L.sorts) as Sort[]).map((k) => (
                  <option key={k} value={k}>
                    {L.sorts[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1.5 text-sm font-semibold">
            <span>{L.maxPrice(baht(maxPrice))}</span>
            <input type="range" min={2000} max={priceCap} step={500} value={maxPrice} onChange={(e) => set({ page: 0, maxPrice: Number(e.target.value) })} className="min-h-11 w-full accent-[#6A47DB]" />
          </label>
        </div>

        <div className="flex flex-col gap-2 border-t border-[#EFEBE6] pt-4">
          <span className={sectionTitle}>{L.picked(picked.length, shown.length)}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setS((x) => ({ ...x, off: Object.fromEntries(Object.entries(x.off).filter(([k]) => !shown.some((p) => p.key === k))) }))}
              className="min-h-11 flex-1 cursor-pointer rounded-[14px] border-0 bg-[#EDE9FB] font-[inherit] text-sm font-semibold text-[#4B2FB8]"
            >
              {L.pickAll(shown.length)}
            </button>
            <button
              type="button"
              onClick={() => setS((x) => ({ ...x, off: { ...x.off, ...Object.fromEntries(shown.map((p) => [p.key, true])) } }))}
              className="min-h-11 flex-1 cursor-pointer rounded-[14px] border-[1.5px] border-[#E6E1D9] bg-white font-[inherit] text-sm font-semibold text-[#2B3040]"
            >
              {L.pickNone}
            </button>
          </div>
          <div role="list" aria-label={L.list} className="flex flex-col gap-1.5">
            {pageItems.map((p) => {
              const on = !s.off[p.key]
              return (
                <div key={p.key} role="listitem" className="flex min-h-12 flex-[0_0_auto] items-center gap-3 rounded-[14px] bg-[#F7F5F2] px-3 py-1">
                  <span className="size-2.5 flex-[0_0_auto] rounded-full" style={{ background: p.color }} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-semibold">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.cat === 'raw' ? `${p.mods}${p.mods ? ' · ' : ''}${p.date}` : `${p.catName}${p.priceSatang !== null ? ` · ${baht(p.priceSatang)}` : ''}${p.active ? '' : L.inactiveSuffix}`}
                    </span>
                  </div>
                  <Switch on={on} label={p.name} onClick={() => setS((x) => ({ ...x, off: { ...x.off, [p.key]: on } }))} />
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button type="button" aria-label={L.prevLabel} disabled={!prevOk} onClick={() => set({ page: Math.max(0, page - 1) })} style={navStyle(prevOk)}>
              {L.prev}
            </button>
            <span className="text-center text-sm text-muted-foreground">
              {L.pageOf(page + 1, pageCount)}
              <br />
              <span className="text-xs">{shown.length ? L.range(page * PS + 1, page * PS + pageItems.length, shown.length) : L.noItems}</span>
            </span>
            <button type="button" aria-label={L.nextLabel} disabled={!nextOk} onClick={() => set({ page: Math.min(pageCount - 1, page + 1) })} style={navStyle(nextOk)}>
              {L.next}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1 border-t border-[#EFEBE6] pt-4">
          <span className={sectionTitle}>{L.fields}</span>
          {(Object.keys(L.toggles) as Flag[]).map((k) => (
            <div key={k} className="flex min-h-12 items-center justify-between">
              <span className="text-[15px]">{L.toggles[k]}</span>
              <Switch on={flags[k]} label={L.toggles[k]} onClick={() => setFlags((f) => ({ ...f, [k]: !f[k] }))} />
            </div>
          ))}
        </div>

        <button
          type="button"
          disabled={total === 0}
          onClick={() => void print()}
          className="min-h-[52px] cursor-pointer rounded-[26px] border-0 bg-[linear-gradient(90deg,#6A47DB,#9776F6)] font-[inherit] text-[17px] font-bold text-white shadow-[0_10px_20px_rgba(106,71,219,0.3)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {L.print(total)}
        </button>
      </aside>

      <main aria-label={L.preview} className="flex min-w-0 flex-[1_1_560px] flex-col items-center gap-3.5">
        <div className="box-border flex w-full flex-wrap items-center justify-between gap-2.5">
          <span className="text-lg font-bold">{L.preview}</span>
          <span style={{ ...statusBase, background: status.bg, color: status.fg }}>{status.text}</span>
        </div>
        <div
          className="box-border grid content-start bg-white p-[27px] shadow-[0_12px_34px_rgba(40,30,60,0.18)]"
          style={{ width: 560, height: 792, gridTemplateColumns: `repeat(${sz.cols}, ${pv.cw}px)`, gridAutoRows: `${pv.ch}px` }}
        >
          {cells.map(({ p, c }, i) => (
            <div
              key={`${p.key}-${i}`}
              className="box-border flex items-stretch gap-1.5 overflow-hidden rounded-lg"
              style={{ width: pv.cw, height: pv.ch, padding: '7px 8px', border: `1px ${c.bad ? 'solid #DC3A44' : 'dashed #DDD7CE'}`, background: c.bad ? '#FFF3F3' : '#FFFFFF' }}
            >
              <span className="flex-[0_0_3px] self-stretch rounded-sm" style={{ background: p.color }} />
              <div className="flex min-w-0 flex-1 flex-col justify-between gap-px">
                <div className="flex flex-col gap-px">
                  <span style={{ fontSize: pv.px(5.5), fontWeight: 700, letterSpacing: '0.05em', color: p.color }}>{c.tag}</span>
                  <span style={{ fontSize: pv.namePx, fontWeight: 700, lineHeight: 1.2, color: '#1F2430', overflow: 'hidden' }}>{p.name}</span>
                  {c.showMods && <span style={{ fontSize: c.modsPx, color: '#5C6270', lineHeight: 1.25 }}>{p.mods}</span>}
                </div>
                <div className="flex flex-col">
                  {c.showPrice && <span style={{ fontSize: c.pricePx, fontWeight: 700, color: '#4B2FB8', lineHeight: 1.1 }}>{c.price}</span>}
                  {flags.showDate && <span style={{ fontSize: c.datePx, color: p.cat === 'raw' ? '#B42318' : '#7A8090', fontWeight: p.cat === 'raw' ? 700 : 400 }}>{p.date}</span>}
                </div>
              </div>
              {flags.showQR && (
                <span
                  role="img"
                  aria-label={L.qr}
                  className="self-center rounded"
                  style={{ flex: `0 0 ${pv.qrSize}px`, width: pv.qrSize, height: pv.qrSize, backgroundImage: qrUrl(p.qr), backgroundSize: '100% 100%' }}
                />
              )}
            </div>
          ))}
        </div>
        <span className="text-[13px] text-muted-foreground">{L.previewNote}</span>
        {tooMany && <span className="text-[13px] text-muted-foreground">{L.morePages(Math.ceil(total / capacity))}</span>}
      </main>
    </div>
  )
}
