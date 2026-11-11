import { useEffect, useMemo, useState } from 'react'
import type { Customer, LicenseRow, LicenseStatus, Plan } from '../../../scripts/license-types'
import { Modal, Segmented } from '@renderer/components/modal'
import { Chip, Field, GradientButton, OutlineButton, SelectInput, TextInput, useToast } from '@renderer/components/ui'
import { resolveFeatures, type LicenseFeatures } from '../../../src/shared/license'
import { FeatureEditor } from './features-editor'
import { api, download } from './api'
import { daysText, date, expiryText, STATUS_COLORS } from './format'
import { lm } from './i18n'
import { useManager } from './store'

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function StatusChip({ status, daysLeft }: { status: LicenseStatus; daysLeft?: number | null }) {
  const c = STATUS_COLORS[status]
  const extra = daysLeft !== undefined ? daysText(status, daysLeft) : ''
  return (
    <Chip bg={c.bg} fg={c.fg}>
      {lm.status[status]}
      {extra ? ` · ${extra}` : ''}
    </Chip>
  )
}

// ---------------------------------------------------------------------------
// Issue / renew dialog
// ---------------------------------------------------------------------------

type TermKind = 'days' | 'until' | 'perpetual'
type RenewMode = 'from_expiry' | 'from_now'
const CUSTOM = '__custom__'
const DEFAULT_FEATURES = resolveFeatures({ maxEmployees: 10, maxClients: 0, cloudBackup: false })
const featuresOf = ({ name: _name, ...f }: Plan): LicenseFeatures => f
const sameFeatures = (a: LicenseFeatures, b: LicenseFeatures) => (Object.keys(a) as (keyof LicenseFeatures)[]).every((k) => a[k] === b[k])

/** Issues a license for a customer; with `from` it renews that license (same machine, fields pre-filled). */
export function IssueDialog({ customer, from, onClose, onDone }: { customer?: { id: string; name: string } | null; from?: LicenseRow | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const { state } = useManager()
  const plans = state?.plans ?? []
  const customers: Pick<Customer, 'id' | 'name'>[] = state?.customers ?? []
  const [customerId, setCustomerId] = useState(from?.customerId ?? customer?.id ?? '')
  const [licensee, setLicensee] = useState(from?.licensee ?? customer?.name ?? '')
  const [hw, setHw] = useState(from?.hardwareId ?? '')
  const [plan, setPlan] = useState(from?.plan ?? plans[0]?.name ?? 'Standard')
  const [features, setFeatures] = useState<LicenseFeatures>(() => (from ? resolveFeatures(from.features) : plans[0] ? featuresOf(plans[0]) : DEFAULT_FEATURES))
  const [kind, setKind] = useState<TermKind>('days')
  const [days, setDays] = useState('365')
  const [until, setUntil] = useState('')
  const [mode, setMode] = useState<RenewMode>('from_expiry')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ term: Parameters<typeof api.issue>[0]['term']; expiresAt: number | null } | null>(null)

  const renewing = !!from
  // the package label follows the switches: any change away from the preset makes it "custom"
  const planChoice = plans.some((p) => p.name === plan && sameFeatures(featuresOf(p), features)) ? plan : CUSTOM

  // renewal: show the new expiry date for the chosen mode and number of days
  useEffect(() => {
    if (!from) return
    const n = Number(days)
    if (!Number.isInteger(n) || n < 1 || n > 3650) return
    let alive = true
    api.renewPreview(from.licenseId, n, mode).then(
      (p) => alive && setPreview(p),
      () => alive && setPreview(null),
    )
    return () => {
      alive = false
    }
  }, [from, days, mode])

  function pickPlan(name: string) {
    if (name === CUSTOM) return setPlan('')
    setPlan(name)
    const p = plans.find((x) => x.name === name)
    if (p) setFeatures(featuresOf(p))
  }

  const term = useMemo(() => {
    if (renewing) return preview?.term ?? null
    if (kind === 'perpetual') return { kind: 'perpetual' as const }
    if (kind === 'until') return until ? { kind: 'until' as const, date: until } : null
    const n = Number(days)
    return Number.isInteger(n) && n >= 1 && n <= 3650 ? { kind: 'days' as const, days: n } : null
  }, [renewing, preview, kind, until, days])

  const ok = !!licensee.trim() && /^HW-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(hw.trim().toUpperCase()) && term !== null && features.maxEmployees >= 1

  async function submit() {
    if (!term) return
    setBusy(true)
    try {
      const r = await api.issue({
        hardwareId: hw.trim().toUpperCase(),
        licensee: licensee.trim(),
        plan: plan.trim() || 'Standard',
        term,
        ...features,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(customerId ? { customerId } : {}),
      })
      download(r.fileName, r.content)
      toast(lm.issue.done(r.fileName))
      onDone()
    } catch (err) {
      toast(errText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={renewing ? lm.issue.titleRenew : lm.issue.titleNew}
      subtitle={renewing ? `${from.licensee} · ${from.hardwareId}` : undefined}
      onClose={onClose}
      width={600}
      footer={
        <div className="flex justify-end gap-2.5">
          <OutlineButton onClick={onClose}>{lm.cancel}</OutlineButton>
          <GradientButton disabled={!ok || busy} onClick={() => void submit()}>
            {lm.issue.submit}
          </GradientButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label={lm.issue.customer}>
            <SelectInput
              value={customerId}
              disabled={renewing}
              onChange={(e) => {
                setCustomerId(e.target.value)
                const c = customers.find((x) => x.id === e.target.value)
                if (c && !licensee.trim()) setLicensee(c.name)
              }}
            >
              <option value="">{lm.issue.noCustomer}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label={lm.issue.licensee}>
            <TextInput value={licensee} maxLength={160} onChange={(e) => setLicensee(e.target.value)} />
          </Field>
        </div>
        <Field label={lm.issue.hw} hint={lm.issue.hwHint}>
          <TextInput value={hw} disabled={renewing} className="font-mono" placeholder="HW-XXXX-XXXX-XXXX-XXXX" onChange={(e) => setHw(e.target.value.toUpperCase())} />
        </Field>
        <Field label={lm.issue.plan}>
          <SelectInput value={planChoice} onChange={(e) => pickPlan(e.target.value)}>
            {plans.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            <option value={CUSTOM}>{lm.issue.custom}</option>
          </SelectInput>
        </Field>
        <FeatureEditor value={features} onChange={setFeatures} />
        {planChoice === CUSTOM && (
          <Field label={lm.issue.plan}>
            <TextInput value={plan} maxLength={60} onChange={(e) => setPlan(e.target.value)} />
          </Field>
        )}

        {renewing ? (
          <div className="flex flex-col gap-2.5 rounded-2xl bg-[#F7F5F2] p-3.5">
            <span className="text-sm font-semibold">{lm.issue.mode}</span>
            <Segmented<RenewMode> label={lm.issue.mode} value={mode} onChange={setMode} options={[{ value: 'from_expiry', label: lm.issue.fromExpiry }, { value: 'from_now', label: lm.issue.fromNow }]} />
            <div className="grid grid-cols-[1fr_2fr] items-end gap-3">
              <Field label={lm.issue.days}>
                <TextInput inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
              </Field>
              <span className="pb-3 text-sm font-semibold text-accent-foreground">
                {preview ? lm.issue.newExpiry(expiryText(preview.expiresAt)) : ''} {from.expiresAt !== null ? <span className="font-normal text-muted-foreground">{lm.issue.oldExpiry(date(from.expiresAt))}</span> : null}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 rounded-2xl bg-[#F7F5F2] p-3.5">
            <span className="text-sm font-semibold">{lm.issue.term}</span>
            <Segmented<TermKind>
              label={lm.issue.term}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'days', label: lm.issue.termDays },
                { value: 'until', label: lm.issue.termUntil },
                { value: 'perpetual', label: lm.issue.termPerpetual },
              ]}
            />
            {kind === 'days' && (
              <Field label={lm.issue.days}>
                <TextInput inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
              </Field>
            )}
            {kind === 'until' && (
              <Field label={lm.issue.date}>
                <TextInput type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        <Field label={lm.issue.note}>
          <TextInput value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <span className="text-xs text-muted-foreground">{lm.issue.replaces}</span>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Void dialog
// ---------------------------------------------------------------------------

export function VoidDialog({ license, onClose, onDone }: { license: LicenseRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true)
    try {
      await api.setStatus(license.licenseId, 'void', reason.trim())
      toast(lm.registry.voided)
      onDone()
    } catch (err) {
      toast(errText(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={lm.registry.voidTitle}
      subtitle={`${license.licensee} · ${license.hardwareId}`}
      onClose={onClose}
      width={480}
      footer={
        <div className="flex justify-end gap-2.5">
          <OutlineButton onClick={onClose}>{lm.cancel}</OutlineButton>
          <GradientButton disabled={reason.trim().length < 3 || busy} onClick={() => void submit()}>
            {lm.voidAction}
          </GradientButton>
        </div>
      }
    >
      <Field label={lm.registry.reason}>
        <TextInput value={reason} maxLength={200} autoFocus onChange={(e) => setReason(e.target.value)} />
      </Field>
      <span className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{lm.offlineNote}</span>
    </Modal>
  )
}
