import { useCallback, useEffect, useState } from 'react'
import type { ExpenseCategoryDto, ExpenseDto, ExpenseSource, ExpenseSummaryDto } from '@shared/api-expenses'
import { MoneyInput, Modal } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, inputClass, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, money } from '@renderer/lib/format'
import { bangkokMonthStart, bangkokToday, dateToMs, msToDateInput, panelClass, rowClass } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const e_ = t.expenses
const SOURCES: ExpenseSource[] = ['drawer', 'petty_cash', 'bank']
const BAR = ['#4C8DF6', '#1BA56B', '#F7791E', '#6A47DB', '#E23B76', '#E5A10C']

/** docs/design/Expenses.dc.html (draft): list, monthly share by category, new expense. */
export function ExpensesPage() {
  const { can } = useSession()
  const toast = useToast()
  const [cats, setCats] = useState<ExpenseCategoryDto[]>([])
  const [filter, setFilter] = useState({ categoryId: '', source: '' as '' | ExpenseSource, page: 1 })
  const [list, setList] = useState<{ items: ExpenseDto[]; total: number }>({ items: [], total: 0 })
  const [summary, setSummary] = useState<ExpenseSummaryDto | null>(null)
  const [form, setForm] = useState(() => ({ categoryId: '', description: '', vendor: '', amount: null as number | null, source: 'drawer' as ExpenseSource, date: msToDateInput(Date.now()), hasTaxInvoice: false, vat: null as number | null, receiptFile: null as string | null }))
  const [voiding, setVoiding] = useState<ExpenseDto | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const now = Date.now()
    try {
      const [c, l, s] = await Promise.all([
        call('expenses.categories'),
        call('expenses.list', { page: filter.page, ...(filter.categoryId ? { categoryId: filter.categoryId } : {}), ...(filter.source ? { source: filter.source } : {}) }),
        call('expenses.summary', { from: bangkokMonthStart(now), to: bangkokToday(now) + 86_400_000 }),
      ])
      setCats(c)
      setList(l)
      setSummary(s)
      setForm((f) => (f.categoryId ? f : { ...f, categoryId: c[0]?.id ?? '' }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [filter, toast])
  useEffect(() => {
    const h = setTimeout(() => void load(), 0)
    return () => clearTimeout(h)
  }, [load])

  async function save() {
    if (!form.amount || !form.description.trim() || !form.categoryId) return toast(t.errors.INVALID_INPUT, 'error')
    setBusy(true)
    try {
      const spentAt = dateToMs(form.date, false)
      const res = await call('expenses.create', {
        categoryId: form.categoryId,
        amountSatang: form.amount,
        vatSatang: form.hasTaxInvoice ? (form.vat ?? 0) : 0,
        source: form.source,
        hasTaxInvoice: form.hasTaxInvoice,
        vendor: form.vendor.trim() || null,
        description: form.description.trim(),
        ...(spentAt ? { spentAt: Math.min(spentAt + 12 * 3_600_000, Date.now()) } : {}),
        receiptFile: form.receiptFile,
      })
      toast(e_.saved(res.expenseNo))
      setForm({ ...form, description: '', vendor: '', amount: null, vat: null, hasTaxInvoice: false, receiptFile: null })
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function attach() {
    try {
      const f = await call('expenses.pickReceipt')
      if (f) setForm((x) => ({ ...x, receiptFile: f }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const max = Math.max(1, ...(summary?.byCategory.map((c) => c.totalSatang) ?? [1]))

  return (
    <>
      <PageHeader icon="wallet" tone="teal" title={e_.title} subtitle={e_.subtitle} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[1.4_1_520px] flex-col gap-[18px]">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2.5">
              <SelectInput aria-label={e_.allCategories} className="flex-1" value={filter.categoryId} onChange={(e) => setFilter({ ...filter, categoryId: e.target.value, page: 1 })}>
                <option value="">{e_.allCategories}</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectInput>
              <SelectInput aria-label={e_.allSources} className="flex-1" value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value as ExpenseSource | '', page: 1 })}>
                <option value="">{e_.allSources}</option>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {e_.sources[s]}
                  </option>
                ))}
              </SelectInput>
            </div>
            <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
              <span className="flex-[2_1_0]">{e_.colItem}</span>
              <span className="flex-[1_1_0]">{e_.colSource}</span>
              <span className="flex-[1_1_0] text-right">{e_.colAmount}</span>
              <span className="w-[86px]" />
            </div>
            {list.items.map((x) => (
              <div key={x.id} className={rowClass(false, x.voided)}>
                <div className="flex min-w-0 flex-[2_1_0] flex-col">
                  <span className="text-[15px] font-semibold">{x.description}</span>
                  <span className="text-xs text-muted-foreground">
                    {x.expenseNo} · {x.categoryName} · {formatDateTimeShort(x.spentAt).slice(0, 8)}
                    {x.hasTaxInvoice ? ` · VAT ${money(x.vatSatang)}` : ''}
                  </span>
                </div>
                <span className="flex-[1_1_0] text-[13px]">{e_.sources[x.source]}</span>
                <span className="flex-[1_1_0] text-right font-semibold">{money(x.amountSatang)}</span>
                <span className="flex w-[86px] justify-end gap-1">
                  {x.hasReceipt && (
                    <button type="button" aria-label={e_.viewReceipt} onClick={() => void call('expenses.receipt', { id: x.id }).then(setReceipt)} className="size-9 cursor-pointer rounded-full border-0 bg-white">
                      📎
                    </button>
                  )}
                  {x.voided ? (
                    <Chip bg="#FFE3E3" fg="#A6232B">
                      {e_.voided}
                    </Chip>
                  ) : (
                    can('expenses:update') && (
                      <button type="button" onClick={() => setVoiding(x)} className="min-h-9 cursor-pointer rounded-full border-0 bg-white px-3 text-[13px] font-semibold text-danger-foreground">
                        {e_.void}
                      </button>
                    )
                  )}
                </span>
              </div>
            ))}
            {list.items.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
            <Pagination page={filter.page} pageSize={7} total={list.total} onPage={(page) => setFilter({ ...filter, page })} />
          </Card>

          {summary && (
            <Card className="flex flex-col gap-2.5">
              <h2 className="m-0 text-base font-bold">{e_.share}</h2>
              {summary.byCategory.map((c, i) => (
                <div key={c.categoryId} className="flex flex-col gap-1">
                  <div className="flex justify-between text-sm">
                    <span>{c.name}</span>
                    <span className="font-semibold">{money(c.totalSatang)}</span>
                  </div>
                  <div className="h-2 rounded bg-border">
                    <div className="h-2 rounded" style={{ width: `${(c.totalSatang / max) * 100}%`, background: BAR[i % BAR.length] }} />
                  </div>
                </div>
              ))}
              <div className="flex justify-between border-t border-border pt-2 text-sm font-bold">
                <span>{t.receiving.total}</span>
                <span>{money(summary.totalSatang)}</span>
              </div>
              {summary.inputVatSatang > 0 && <span className="text-xs text-muted-foreground">{e_.inputVat(money(summary.inputVatSatang))}</span>}
            </Card>
          )}
        </div>

        {can('expenses:create') && (
          <aside className={cn(panelClass, 'flex-[1_1_380px]')}>
            <h2 className="m-0 text-lg font-bold">{e_.newTitle}</h2>
            <Field label={e_.category}>
              <SelectInput value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label={e_.description}>
              <TextInput value={form.description} maxLength={200} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <Field label={e_.vendor}>
              <TextInput value={form.vendor} maxLength={120} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={e_.amount}>
                <MoneyInput value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} ariaLabel={e_.amount} />
              </Field>
              <Field label={e_.date}>
                <TextInput type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </Field>
            </div>
            <div className="flex flex-col gap-1.5">
              {SOURCES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={form.source === s}
                  onClick={() => setForm({ ...form, source: s })}
                  className={cn('min-h-12 cursor-pointer rounded-2xl border-2 px-3.5 text-left text-sm font-semibold', form.source === s ? 'border-[#9776F6] bg-[#F5F2FE] text-accent-foreground' : 'border-transparent bg-[#F7F5F2]')}
                >
                  {s === 'drawer' ? e_.sourceDrawer : e_.sources[s]}
                </button>
              ))}
            </div>
            <div className="flex min-h-12 items-center justify-between gap-3">
              <span className="flex flex-col text-[15px]">
                {e_.taxInvoice}
                <span className="text-xs text-muted-foreground">{e_.taxInvoiceHint}</span>
              </span>
              <Toggle checked={form.hasTaxInvoice} label={e_.taxInvoice} onChange={(v) => setForm({ ...form, hasTaxInvoice: v })} />
            </div>
            {form.hasTaxInvoice && (
              <Field label={e_.vat}>
                <MoneyInput value={form.vat} onChange={(v) => setForm({ ...form, vat: v })} ariaLabel={e_.vat} />
              </Field>
            )}
            <OutlineButton onClick={() => void attach()}>{form.receiptFile ? `✓ ${e_.attached}` : e_.attach}</OutlineButton>
            <GradientButton size="lg" disabled={busy} onClick={() => void save()}>
              {e_.save}
            </GradientButton>
            <span className="text-xs text-muted-foreground">{e_.immutable}</span>
          </aside>
        )}
      </div>
      {voiding && (
        <ReasonDialog
          title={`${e_.void} ${voiding.expenseNo}`}
          placeholder={e_.voidReason}
          onClose={() => setVoiding(null)}
          onSubmit={(reason) =>
            call('expenses.void', { id: voiding.id, reason }).then(
              () => {
                setVoiding(null)
                void load()
              },
              (err: unknown) => toast(errorMessage(err), 'error'),
            )
          }
        />
      )}
      {receipt && (
        <Modal title={e_.viewReceipt} onClose={() => setReceipt(null)} width={640}>
          <img src={receipt} alt={e_.viewReceipt} className="max-h-[70vh] w-full object-contain" />
        </Modal>
      )}
    </>
  )
}

export function ReasonDialog({ title, placeholder, onClose, onSubmit }: { title: string; placeholder: string; onClose: () => void; onSubmit: (reason: string) => unknown }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <input className={inputClass} placeholder={placeholder} autoFocus value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      <DangerButton disabled={reason.trim().length < 3} onClick={() => void onSubmit(reason.trim())}>
        {t.common.confirm}
      </DangerButton>
    </Modal>
  )
}
