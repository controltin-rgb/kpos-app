import { useCallback, useEffect, useState } from 'react'
import type { CustomerRow, LicenseRow, TimelineItem } from '../../../../scripts/license-types'
import { Modal } from '@renderer/components/modal'
import { Card, Chip, Field, GradientButton, OutlineButton, PageHeader, TextInput, useToast } from '@renderer/components/ui'
import { cn } from '@renderer/lib/utils'
import { api, downloadLicense } from '../api'
import { errText, IssueDialog, StatusChip, VoidDialog } from '../components'
import { date, expiryText } from '../format'
import { lm } from '../i18n'
import { useManager } from '../store'

const c = lm.customers

type Draft = { id?: string; name: string; contact: string; phone: string; email: string; taxId: string; branch: string; note: string }
const EMPTY: Draft = { name: '', contact: '', phone: '', email: '', taxId: '', branch: '', note: '' }

function CustomerDialog({ initial, onClose, onSaved }: { initial: Draft; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast()
  const [d, setD] = useState(initial)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value })
  async function save() {
    setBusy(true)
    try {
      const saved = await api.saveCustomer(d)
      toast(c.saved)
      onSaved(saved.id)
    } catch (err) {
      toast(errText(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={initial.id ? c.editTitle : c.addTitle}
      onClose={onClose}
      width={560}
      footer={
        <div className="flex justify-end gap-2.5">
          <OutlineButton onClick={onClose}>{lm.cancel}</OutlineButton>
          <GradientButton disabled={!d.name.trim() || busy} onClick={() => void save()}>
            {lm.save}
          </GradientButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={c.name}>
          <TextInput value={d.name} maxLength={160} autoFocus onChange={set('name')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={c.contact}>
            <TextInput value={d.contact} maxLength={120} onChange={set('contact')} />
          </Field>
          <Field label={c.phone}>
            <TextInput value={d.phone} maxLength={40} onChange={set('phone')} />
          </Field>
          <Field label={c.email}>
            <TextInput value={d.email} maxLength={120} onChange={set('email')} />
          </Field>
          <Field label={c.taxId}>
            <TextInput value={d.taxId} maxLength={20} onChange={set('taxId')} />
          </Field>
        </div>
        <Field label={c.branch}>
          <TextInput value={d.branch} maxLength={120} onChange={set('branch')} />
        </Field>
        <Field label={c.note}>
          <TextInput value={d.note} maxLength={500} onChange={set('note')} />
        </Field>
      </div>
    </Modal>
  )
}

function Detail({ id, onEdit, onChanged }: { id: string; onEdit: (c: CustomerRow) => void; onChanged: () => void }) {
  const toast = useToast()
  const [data, setData] = useState<{ customer: CustomerRow; licenses: LicenseRow[]; timeline: TimelineItem[] } | null>(null)
  const [issueFor, setIssueFor] = useState<LicenseRow | 'new' | null>(null)
  const [voiding, setVoiding] = useState<LicenseRow | null>(null)
  const load = useCallback(() => api.customer(id).then(setData, (err: unknown) => toast(errText(err), 'error')), [id, toast])
  useEffect(() => {
    void load()
  }, [load])
  if (!data) return null
  const { customer, licenses, timeline } = data
  const done = () => {
    setIssueFor(null)
    setVoiding(null)
    void load()
    onChanged()
  }
  const info = [customer.contact, customer.phone, customer.email].filter(Boolean).join(' · ')

  return (
    <Card className="flex min-w-0 flex-[1.4_1_480px] flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
          <h2 className="m-0 text-xl font-bold">{customer.name}</h2>
          {info && <span className="text-sm text-muted-foreground">{info}</span>}
          {(customer.branch || customer.taxId) && <span className="text-xs text-muted-foreground">{[customer.branch, customer.taxId && `${c.taxId} ${customer.taxId}`].filter(Boolean).join(' · ')}</span>}
          {customer.note && <span className="mt-1 text-sm">{customer.note}</span>}
        </div>
        <OutlineButton onClick={() => onEdit(customer)}>{c.edit}</OutlineButton>
        <GradientButton onClick={() => setIssueFor('new')}>{lm.issueNew}</GradientButton>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-bold">{c.licensesTitle}</h3>
        {licenses.map((l) => (
          <div key={l.licenseId} className={cn('flex flex-wrap items-center gap-3 rounded-2xl bg-[#F7F5F2] px-3 py-2', !l.current && 'opacity-70')}>
            <div className="flex min-w-[200px] flex-1 flex-col">
              <span className="text-[15px] font-semibold">{l.plan}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {l.hardwareId} · {date(l.issuedAt)} → {expiryText(l.expiresAt)}
              </span>
              {l.statusReason && <span className="text-xs text-muted-foreground">{l.statusReason}</span>}
            </div>
            <StatusChip status={l.status} daysLeft={l.daysLeft} />
            <OutlineButton className="px-3.5" onClick={() => void downloadLicense(l.licenseId).catch((err: unknown) => toast(errText(err), 'error'))}>
              {lm.download}
            </OutlineButton>
            {l.current && <OutlineButton className="px-3.5" onClick={() => setIssueFor(l)}>{lm.renew}</OutlineButton>}
            {l.current && <OutlineButton className="px-3.5 text-danger-foreground" onClick={() => setVoiding(l)}>{lm.voidAction}</OutlineButton>}
          </div>
        ))}
        {licenses.length === 0 && <span className="text-sm text-muted-foreground">{c.noLicense}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-bold">{c.history}</h3>
        {timeline.map((t, i) => (
          <div key={`${t.licenseId}-${t.kind}-${i}`} className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0 text-muted-foreground">{date(t.at)}</span>
            <Chip bg={t.kind === 'issued' ? '#DDF5E8' : t.kind === 'void' ? '#FFE3E3' : '#EDE9FB'} fg={t.kind === 'issued' ? '#11724A' : t.kind === 'void' ? '#A6232B' : '#4B2FB8'}>
              {c.timeline[t.kind]}
            </Chip>
            <span className="truncate text-muted-foreground">{t.text}</span>
          </div>
        ))}
      </div>

      {issueFor && <IssueDialog customer={customer} from={issueFor === 'new' ? null : issueFor} onClose={() => setIssueFor(null)} onDone={done} />}
      {voiding && <VoidDialog license={voiding} onClose={() => setVoiding(null)} onDone={done} />}
    </Card>
  )
}

export function CustomersPage() {
  const toast = useToast()
  const { state, reload } = useManager()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [edit, setEdit] = useState<Draft | null>(null)
  const list = (state?.customers ?? []).filter((x) => !q.trim() || `${x.name} ${x.phone} ${x.contact} ${x.email}`.toLowerCase().includes(q.trim().toLowerCase()))

  async function importOld() {
    try {
      const r = await api.importCustomers()
      toast(c.imported(r.created, r.assigned))
      await reload()
    } catch (err) {
      toast(errText(err), 'error')
    }
  }

  return (
    <>
      <PageHeader
        icon="users"
        tone="orange"
        title={c.title}
        subtitle={c.subtitle}
        actions={
          <div className="flex flex-wrap gap-2.5">
            <OutlineButton onClick={() => void importOld()}>{c.import}</OutlineButton>
            <GradientButton onClick={() => setEdit(EMPTY)}>{c.add}</GradientButton>
          </div>
        }
      />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_320px] flex-col gap-3">
          <TextInput type="search" aria-label={c.search} placeholder={c.search} value={q} onChange={(e) => setQ(e.target.value)} />
          {list.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setSel(x.id)}
              className={cn('box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5 text-left', x.id === sel ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]')}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-semibold">{x.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {c.licenses(x.licenseCount)}
                  {x.status ? ` · ${expiryText(x.expiresAt)}` : ''}
                </span>
              </div>
              {x.status && <StatusChip status={x.status} />}
            </button>
          ))}
          {list.length === 0 && <span className="py-4 text-center text-sm text-muted-foreground">{c.none}</span>}
        </Card>
        {sel ? (
          <Detail key={sel} id={sel} onEdit={(x) => setEdit({ ...x })} onChanged={() => void reload()} />
        ) : (
          <Card className="flex min-w-0 flex-[1.4_1_480px] items-center justify-center py-16 text-sm text-muted-foreground">{c.pick}</Card>
        )}
      </div>
      {edit && (
        <CustomerDialog
          initial={edit}
          onClose={() => setEdit(null)}
          onSaved={(id) => {
            setEdit(null)
            setSel(id)
            void reload()
          }}
        />
      )}
    </>
  )
}
