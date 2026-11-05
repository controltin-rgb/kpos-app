import { useState } from 'react'
import type { PosCatalog } from '@shared/api-sales'
import { Modal } from '@renderer/components/modal'
import { GradientButton, inputClass } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { money } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

type Product = PosCatalog['products'][number]
type Group = PosCatalog['groups'][number]

export interface SheetResult {
  sizeId: string | null
  optionIds: string[]
  qty: number
  note: string
}

const chip = (on: boolean) =>
  cn(
    'min-h-12 cursor-pointer rounded-2xl border-2 px-4 text-sm font-semibold',
    on ? 'border-[#9776F6] bg-[#F5F2FE] text-accent-foreground' : 'border-transparent bg-[#F7F5F2] text-foreground',
  )

/** Modifier Sheet (Design-Spec §9.3): size, options per group (min/max), quantity, note to the bar. */
export function ModifierSheet({ product, groups, onAdd, onClose }: { product: Product; groups: Group[]; onAdd: (r: SheetResult) => void; onClose: () => void }) {
  const p = t.pos
  const myGroups = product.modifierGroupIds.map((id) => groups.find((g) => g.id === id)).filter((g): g is Group => !!g)
  const [sizeId, setSizeId] = useState(product.sizes.find((s) => s.isDefault)?.id ?? product.sizes[0]?.id ?? null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(myGroups.flatMap((g) => g.options.filter((o) => o.isDefault).slice(0, g.maxSelect).map((o) => o.id))))
  const [count, setCount] = useState(1)
  const [note, setNote] = useState('')

  const toggle = (g: Group, optionId: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(optionId)) next.delete(optionId)
      else {
        if (g.maxSelect === 1) g.options.forEach((o) => next.delete(o.id))
        else if (g.options.filter((o) => next.has(o.id)).length >= g.maxSelect) return prev
        next.add(optionId)
      }
      return next
    })

  const size = product.sizes.find((s) => s.id === sizeId)
  const unit = (size?.priceSatang ?? 0) + myGroups.flatMap((g) => g.options).filter((o) => picked.has(o.id)).reduce((s, o) => s + o.priceSatang, 0)
  const valid = myGroups.every((g) => {
    const n = g.options.filter((o) => picked.has(o.id)).length
    return n >= g.minSelect && n <= g.maxSelect
  })

  return (
    <Modal title={product.name} onClose={onClose} width={560}>
      {product.sizes.length > 1 && (
        <section className="flex flex-col gap-2">
          <span className="text-sm font-bold">{p.size}</span>
          <div className="flex flex-wrap gap-2">
            {product.sizes.map((s) => (
              <button key={s.id} type="button" aria-pressed={s.id === sizeId} className={chip(s.id === sizeId)} onClick={() => setSizeId(s.id)}>
                {s.label} · {money(s.priceSatang)}
              </button>
            ))}
          </div>
        </section>
      )}
      {myGroups.map((g) => (
        <section key={g.id} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold">{g.name}</span>
            <span className={cn('text-xs', g.minSelect > 0 ? 'font-semibold text-danger-foreground' : 'text-muted-foreground')}>
              {g.minSelect > 0 ? `${p.required} · ` : ''}
              {g.minSelect === g.maxSelect ? p.chooseExactly(g.maxSelect) : p.chooseUpTo(g.maxSelect)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {g.options.map((o) => (
              <button key={o.id} type="button" aria-pressed={picked.has(o.id)} className={chip(picked.has(o.id))} onClick={() => toggle(g, o.id)}>
                {o.name}
                {o.priceSatang ? ` +${money(o.priceSatang)}` : ''}
              </button>
            ))}
          </div>
        </section>
      ))}
      <section className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-bold">{p.qty}</span>
          <div className="flex items-center gap-2">
            <button type="button" aria-label={p.dec} onClick={() => setCount((c) => Math.max(1, c - 1))} className="size-11 cursor-pointer rounded-xl border-0 bg-[#F7F5F2] text-xl">
              −
            </button>
            <span className="min-w-8 text-center text-lg font-bold">{count}</span>
            <button type="button" aria-label={p.inc} onClick={() => setCount((c) => Math.min(999, c + 1))} className="size-11 cursor-pointer rounded-xl border-0 bg-accent text-xl text-accent-foreground">
              +
            </button>
          </div>
        </div>
        <label className="flex flex-1 flex-col gap-2 text-sm font-bold">
          {p.note}
          <input className={inputClass} value={note} maxLength={120} placeholder={p.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
        </label>
      </section>
      <GradientButton size="lg" disabled={!valid} onClick={() => onAdd({ sizeId, optionIds: [...picked], qty: count, note: note.trim() })}>
        {p.addToOrder(money(unit * count))}
      </GradientButton>
    </Modal>
  )
}
