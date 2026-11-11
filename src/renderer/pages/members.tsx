import { useCallback, useEffect, useState } from 'react'
import type { MemberContactDto, MemberDetailDto, MemberDto, PointsRulesDto, TierDto } from '@shared/api-promo'
import { Modal, MoneyInput } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, inputClass, OutlineButton, Pagination, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { useConfirm } from '@renderer/components/confirm'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { formatDateTimeShort, money } from '@renderer/lib/format'
import { panelClass, rowClass } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const pr = t.promo
const mb = t.members
const HISTORY_PAGE = 6

/** "12/04/2538" style date for a YYYY-MM-DD birthday (Thai Buddhist year as on the rest of the UI). */
function birthday(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${Number(y) + 543}`
}

/** Members tab of docs/design/Promo.dc.html: list + profile, purchase history, points (D46). */
export function MembersTab() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const [q, setQ] = useState({ search: '', tierId: '', page: 1 })
  const [list, setList] = useState<{ items: MemberDto[]; total: number }>({ items: [], total: 0 })
  const [tiers, setTiers] = useState<TierDto[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MemberDetailDto | null>(null)
  const [histPage, setHistPage] = useState(1)
  const [contact, setContact] = useState<MemberContactDto | null>(null)
  const [form, setForm] = useState<{ member: MemberDto | null; contact: MemberContactDto | null } | null>(null)
  const [reason, setReason] = useState<string>(pr.adjustReasons[0])
  const [rules, setRules] = useState<PointsRulesDto | null>(null)
  const manage = can('promo:update')

  const load = useCallback(
    () =>
      call('members.list', { page: q.page, ...(q.search ? { search: q.search } : {}), ...(q.tierId ? { tierId: q.tierId } : {}) }).then(setList, (err: unknown) => toast(errorMessage(err), 'error')),
    [q, toast],
  )
  const loadDetail = useCallback(() => {
    if (!selId) return Promise.resolve()
    return call('members.detail', { id: selId, page: histPage, pageSize: HISTORY_PAGE }).then(setDetail, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [selId, histPage, toast])

  useEffect(() => {
    const h = setTimeout(() => void load(), q.search ? 250 : 0)
    return () => clearTimeout(h)
  }, [load, q.search])
  useEffect(() => {
    void loadDetail()
  }, [loadDetail])
  useEffect(() => {
    void call('members.tiers').then(setTiers, () => {})
    void call('members.pointsRules').then(setRules, () => {})
  }, [])

  const select = (id: string) => {
    setSelId(id)
    setHistPage(1)
    setContact(null)
  }
  const refresh = () => Promise.all([load(), loadDetail()])
  const sel = detail?.member.id === selId ? detail.member : null

  async function reveal(): Promise<MemberContactDto | null> {
    if (!sel) return null
    try {
      const c = await call('members.revealContact', { id: sel.id })
      setContact(c)
      return c
    } catch (err) {
      toast(errorMessage(err), 'error')
      return null
    }
  }
  async function edit() {
    if (!sel) return
    // the form needs the real numbers (the list only has masked ones); the reveal is audited
    const c = contact ?? (await reveal())
    if (c) setForm({ member: sel, contact: c })
  }
  async function adjust(delta: number) {
    if (!sel) return
    try {
      await call('members.adjustPoints', { id: sel.id, delta, reason })
      void refresh()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  async function erase() {
    if (!sel || !(await confirm({ kind: 'danger', title: t.confirmDialog.eraseTitle, message: pr.eraseConfirm, confirmLabel: t.confirmDialog.erase }))) return
    try {
      await call('members.erase', { id: sel.id, reason: 'ลูกค้าขอลบข้อมูล (PDPA)' })
      setSelId(null)
      setDetail(null)
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

  const info = (label: string, value: string | null) => (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold break-all">{value || '—'}</span>
    </div>
  )

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <Card className="flex min-w-0 flex-[1.3_1_480px] flex-col gap-3">
        <div className="flex flex-wrap gap-2.5">
          <TextInput type="search" placeholder={mb.search} aria-label={mb.search} className="flex-[2_1_200px]" value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value, page: 1 })} />
          <SelectInput aria-label={pr.allTiers} className="flex-[1_1_120px]" value={q.tierId} onChange={(e) => setQ({ ...q, tierId: e.target.value, page: 1 })}>
            <option value="">{pr.allTiers}</option>
            {tiers.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.name}
              </option>
            ))}
          </SelectInput>
          {manage && <GradientButton onClick={() => setForm({ member: null, contact: null })}>{mb.add}</GradientButton>}
        </div>
        <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
          <span className="flex-[2_1_0]">{t.pos.memberTitle}</span>
          <span className="flex-[1_1_0]">{pr.tier}</span>
          <span className="flex-[1_1_0] text-right">{pr.points}</span>
          <span className="flex-[1.2_1_0] text-right">{pr.lifetime}</span>
        </div>
        {list.items.map((m) => (
          <div key={m.id} role="listitem" className={rowClass(m.id === selId)} onClick={() => select(m.id)}>
            <div className="flex min-w-0 flex-[2_1_0] flex-col">
              <span className="text-[15px] font-semibold">{m.name ?? m.phoneMasked}</span>
              <span className="text-xs text-muted-foreground">{m.phoneMasked}</span>
            </div>
            <span className="flex-[1_1_0]">
              <Chip>{m.tierName ?? '—'}</Chip>
            </span>
            <span className="flex-[1_1_0] text-right font-semibold">{m.pointsBalance.toLocaleString('en-US')}</span>
            <span className="flex-[1.2_1_0] text-right text-muted-foreground">{money(m.totalSpentSatang)}</span>
          </div>
        ))}
        {list.items.length === 0 && <span className="text-sm text-muted-foreground">{t.crud.empty}</span>}
        <Pagination page={q.page} pageSize={7} total={list.total} onPage={(page) => setQ({ ...q, page })} />
        <span className="text-xs text-muted-foreground">{mb.pdpa}</span>
      </Card>

      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-[18px]">
        {sel && detail && (
          <aside className={panelClass}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-lg font-bold">{sel.name ?? sel.phoneMasked}</span>
                <span className="text-[13px] text-muted-foreground">
                  {contact?.phone ?? sel.phoneMasked} · {pr.memberSince(formatDateTimeShort(sel.createdAt).slice(0, 8))}
                </span>
              </div>
              {sel.tierName && <Chip>{sel.tierName}</Chip>}
            </div>
            {manage && (
              <div className="flex gap-2">
                <OutlineButton className="min-h-11 flex-1" onClick={() => void edit()}>
                  {mb.edit}
                </OutlineButton>
                {!contact && (
                  <OutlineButton className="min-h-11 flex-1" onClick={() => void reveal()}>
                    {mb.reveal}
                  </OutlineButton>
                )}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {[
                [pr.balance, sel.pointsBalance.toLocaleString('en-US')],
                [mb.spent, money(sel.totalSpentSatang)],
                [mb.visits, String(sel.visitCount)],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-0.5 rounded-2xl bg-[#F7F5F2] px-3 py-2.5">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <span className="text-lg font-bold text-accent-foreground">{value}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {info(mb.phone2, contact ? contact.phone2 : sel.phone2Masked)}
              {info(mb.birthDate, sel.birthDate ? birthday(sel.birthDate) : null)}
              {info(mb.email, sel.email)}
              {info(mb.lineId, sel.lineId)}
              {info(mb.lastVisit, sel.lastVisitAt ? formatDateTimeShort(sel.lastVisitAt) : null)}
              {info(mb.lifetimePoints, sel.lifetimePoints.toLocaleString('en-US'))}
              {sel.note && <div className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{sel.note}</div>}
            </div>

            <span className="text-sm font-bold">{mb.history}</span>
            <div className="flex flex-col gap-1.5">
              {detail.bills.items.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 rounded-xl bg-[#FAF8F5] px-3 py-2 text-sm">
                  <span className="flex min-w-0 flex-col">
                    <span className={cn('font-semibold', b.status !== 'paid' && 'line-through opacity-60')}>{b.billNo}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTimeShort(b.paidAt)}
                      {b.status !== 'paid' ? ` · ${mb.billStatus[b.status]}` : ''}
                      {b.pointsEarned ? ` · +${b.pointsEarned}` : ''}
                      {b.pointsRedeemed ? ` · −${b.pointsRedeemed}` : ''}
                    </span>
                  </span>
                  <span className="font-bold">{money(b.totalSatang)}</span>
                </div>
              ))}
              {detail.bills.items.length === 0 && <span className="text-sm text-muted-foreground">{mb.noHistory}</span>}
              {detail.bills.total > HISTORY_PAGE && <Pagination page={histPage} pageSize={HISTORY_PAGE} total={detail.bills.total} onPage={setHistPage} />}
            </div>

            {manage && (
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
            {manage && <GradientButton onClick={() => void saveRules()}>{pr.saveRules}</GradientButton>}
          </aside>
        )}
      </div>

      {form && (
        <MemberForm
          member={form.member}
          contact={form.contact}
          onClose={() => setForm(null)}
          onSaved={(m) => {
            setForm(null)
            toast(t.crud.saved)
            if (m.id === selId) {
              setContact(null)
              void refresh()
            } else {
              select(m.id)
              void load()
            }
          }}
        />
      )}
    </div>
  )
}

/** Add / edit a member's profile (promo:update). New members need the customer's PDPA consent. */
function MemberForm({ member, contact, onClose, onSaved }: { member: MemberDto | null; contact: MemberContactDto | null; onClose: () => void; onSaved: (m: MemberDto) => void }) {
  const toast = useToast()
  const [d, setD] = useState({
    phone: contact?.phone ?? '',
    name: member?.name ?? '',
    birthDate: member?.birthDate ?? '',
    email: member?.email ?? '',
    lineId: member?.lineId ?? '',
    phone2: contact?.phone2 ?? '',
    note: member?.note ?? '',
  })
  const [consent, setConsent] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof d>) => setD({ ...d, ...patch })
  const phoneOk = /^0\d{8,9}$/.test(d.phone)
  const phone2Ok = !d.phone2 || /^0\d{8,9}$/.test(d.phone2)
  const ok = phoneOk && phone2Ok && (member !== null || consent)

  async function save() {
    setBusy(true)
    setFields({})
    try {
      onSaved(
        await call('members.save', {
          ...(member ? { id: member.id } : { consent: true as const }),
          phone: d.phone,
          name: d.name.trim() || null,
          birthDate: d.birthDate,
          email: d.email,
          lineId: d.lineId,
          phone2: d.phone2,
          note: d.note,
        }),
      )
    } catch (err) {
      setFields(fieldErrors(err))
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const err = (k: string) => (fields[k] ? (fields[k] === 'duplicate' ? mb.duplicate : t.errors.INVALID_INPUT) : undefined)
  return (
    <Modal
      title={member ? mb.editTitle : mb.addTitle}
      onClose={onClose}
      width={560}
      footer={
        <div className="flex gap-2.5">
          <OutlineButton className="min-h-12 flex-1" onClick={onClose}>
            {t.common.cancel}
          </OutlineButton>
          <GradientButton className="flex-[2]" disabled={!ok || busy} onClick={() => void save()}>
            {mb.save}
          </GradientButton>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={mb.phone} error={err('phone') ?? (d.phone && !phoneOk ? t.errors.INVALID_INPUT : undefined)}>
          <TextInput inputMode="numeric" autoFocus value={d.phone} maxLength={10} onChange={(e) => set({ phone: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label={mb.name}>
          <TextInput value={d.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={mb.phone2} error={err('phone2') ?? (phone2Ok ? undefined : t.errors.INVALID_INPUT)}>
          <TextInput inputMode="numeric" value={d.phone2} maxLength={10} onChange={(e) => set({ phone2: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <Field label={mb.birthDate} error={err('birthDate')}>
          <TextInput type="date" value={d.birthDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ birthDate: e.target.value })} />
        </Field>
        <Field label={mb.email} error={err('email')}>
          <TextInput type="email" value={d.email} maxLength={120} onChange={(e) => set({ email: e.target.value.trim() })} />
        </Field>
        <Field label={mb.lineId} error={err('lineId')}>
          <TextInput value={d.lineId} maxLength={60} onChange={(e) => set({ lineId: e.target.value })} />
        </Field>
      </div>
      <Field label={mb.note} hint={mb.noteHint}>
        <textarea className={cn(inputClass, 'min-h-20 py-2')} value={d.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      {!member && (
        <div className="flex min-h-12 items-center justify-between gap-3 rounded-2xl bg-[#F7F5F2] px-3.5 py-2">
          <span className="text-[13px]">{t.pos.memberConsent}</span>
          <Toggle checked={consent} label={t.pos.memberConsent} onChange={setConsent} />
        </div>
      )}
    </Modal>
  )
}
