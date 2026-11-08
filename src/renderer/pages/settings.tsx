import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SettingsDto } from '@shared/api-sales'
import { BILL_RESET_POLICIES, formatBillNo, periodKey, type BillResetPolicy } from '@shared/bill-number'
import { isValidPromptPayId } from '@shared/promptpay'
import { PAYMENT_PROVIDERS, PAYMENT_VERIFY_MODES, PROVIDER_DEFS, type PaymentProvider, type PaymentVerifyMode } from '@shared/payment-verify'
import { isValidBranchNo, isValidThaiTaxId } from '@shared/tax-id'
import { Segmented } from '@renderer/components/modal'
import { Card, Chip, Field, GradientButton, OutlineButton, PageHeader, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useNow } from '@renderer/lib/events'
import { useSession } from '@renderer/lib/session'
import { LicenseSection } from './license'
import { LanSection } from './lan'

const st = t.settings
type Tab = keyof typeof st.tabs
type Draft = Pick<
  SettingsDto,
  | 'vat.rate_bp'
  | 'bill.reset_policy'
  | 'promptpay.id'
  | 'receipt.header'
  | 'receipt.footer'
  | 'receipt.paper_mm'
  | 'stock.count_separate_approver'
  | 'tax.seller_name'
  | 'tax.seller_tax_id'
  | 'tax.seller_branch'
  | 'tax.seller_address'
  | 'kds.complete_on_pay'
  | 'promptpay.verify_mode'
  | 'promptpay.provider'
  | 'promptpay.merchant_id'
  | 'promptpay.provider_branch'
  | 'promptpay.provider_endpoint'
  | 'update.feed_url'
  | 'update.auto_check'
>
const DRAFT_KEYS: (keyof Draft)[] = [
  'vat.rate_bp',
  'bill.reset_policy',
  'promptpay.id',
  'receipt.header',
  'receipt.footer',
  'receipt.paper_mm',
  'stock.count_separate_approver',
  'tax.seller_name',
  'tax.seller_tax_id',
  'tax.seller_branch',
  'tax.seller_address',
  'kds.complete_on_pay',
  'promptpay.verify_mode',
  'promptpay.provider',
  'promptpay.merchant_id',
  'promptpay.provider_branch',
  'promptpay.provider_endpoint',
  'update.feed_url',
  'update.auto_check',
]

/** docs/design/Settings.dc.html (draft) — sections available in phase 2. */
export function SettingsPage() {
  const { can, system } = useSession()
  const toast = useToast()
  const [params] = useSearchParams()
  const [tab, setTab] = useState<Tab>(() => {
    const q = params.get('tab')
    return q && q in st.tabs ? (q as Tab) : 'tax'
  })
  const [saved, setSaved] = useState<SettingsDto | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [vatText, setVatText] = useState('')
  const [busy, setBusy] = useState(false)
  const editable = can('settings:update')
  const now = useNow(60_000)

  useEffect(() => {
    let alive = true
    call('settings.get').then(
      (s) => {
        if (!alive) return
        setSaved(s)
        setDraft(s)
        setVatText(String(s['vat.rate_bp'] / 100))
      },
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [toast])

  // a Client whose Host is down cannot load the shop settings — still show its own connection / offline queue
  if (!saved || !draft)
    return (
      <>
        <PageHeader icon="gear" tone="teal" title={st.title} subtitle={st.subtitle} />
        {system?.deviceRole === 'client' && (
          <Card className="flex max-w-3xl flex-col gap-6">
            <LanSection />
          </Card>
        )}
      </>
    )

  const vatBp = /^\d{1,2}(\.\d{1,2})?$/.test(vatText) ? Math.round(Number(vatText) * 100) : null
  const ppValid = draft['promptpay.id'] === '' || isValidPromptPayId(draft['promptpay.id'])
  const example = formatBillNo(saved.branchCode, draft['bill.reset_policy'], periodKey(draft['bill.reset_policy'], now), 1)
  const patch: Partial<Draft> = {}
  DRAFT_KEYS.forEach((k) => {
    const v = k === 'vat.rate_bp' ? vatBp : draft[k]
    if (v !== null && v !== saved[k]) (patch as Record<string, unknown>)[k] = v
  })
  const dirty = Object.keys(patch).length > 0
  const taxIdOk = draft['tax.seller_tax_id'] === '' || isValidThaiTaxId(draft['tax.seller_tax_id'])
  const branchOk = isValidBranchNo(draft['tax.seller_branch'])
  const feedOk = draft['update.feed_url'] === '' || /^https?:\/\//.test(draft['update.feed_url'])
  const endpointOk = draft['promptpay.provider_endpoint'] === '' || /^https:\/\//.test(draft['promptpay.provider_endpoint'])

  async function save() {
    setBusy(true)
    try {
      const s = await call('settings.update', patch)
      setSaved(s)
      setDraft(s)
      setVatText(String(s['vat.rate_bp'] / 100))
      toast(st.saved)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v })

  return (
    <>
      <PageHeader
        icon="gear"
        tone="teal"
        title={st.title}
        subtitle={st.subtitle}
        actions={
          editable && (
            <GradientButton disabled={!dirty || busy || vatBp === null || !ppValid || !taxIdOk || !branchOk || !feedOk || !endpointOk} onClick={() => void save()}>
              {busy ? t.common.saving : st.save}
            </GradientButton>
          )
        }
      />
      {!editable && <Chip bg="#FFF4D6" fg="#7A5200" className="self-start">{st.readOnly}</Chip>}
      <div className="max-w-3xl">
        <Segmented label={st.title} value={tab} onChange={setTab} options={(Object.keys(st.tabs) as Tab[]).map((k) => ({ value: k, label: st.tabs[k] }))} />
      </div>

      {tab === 'tax' && (
        <div className="flex max-w-3xl flex-col gap-[18px]">
          <Card className="relative flex flex-col gap-3 overflow-hidden">
            <div className="absolute -top-10 -right-10 size-[140px] rounded-full bg-accent" />
            <h2 className="relative m-0 text-lg font-bold">{st.vatTitle}</h2>
            <div className="relative max-w-xs">
              <Field label={st.vatRate} hint={st.vatHint} error={vatBp === null ? t.errors.INVALID_INPUT : undefined}>
                <TextInput inputMode="decimal" value={vatText} disabled={!editable} onChange={(e) => setVatText(e.target.value.trim())} />
              </Field>
            </div>
            <span className="relative rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{st.accountantNote}</span>
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-bold">{st.billTitle}</h2>
            <span className="text-sm text-muted-foreground">{st.branchCode(saved.branchCode)}</span>
            <div className="max-w-xs">
              <Field label={st.reset}>
                <SelectInput value={draft['bill.reset_policy']} disabled={!editable} onChange={(e) => set('bill.reset_policy', e.target.value as BillResetPolicy)}>
                  {BILL_RESET_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {st.resets[p]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            </div>
            <Chip className="self-start" bg="#DDF5E8" fg="#11724A">
              {st.example(example)}
            </Chip>
            <span className="text-xs text-muted-foreground">{st.resetWarn}</span>
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-bold">{st.sellerTitle}</h2>
            <Field label={st.sellerName}>
              <TextInput value={draft['tax.seller_name']} maxLength={160} disabled={!editable} onChange={(e) => set('tax.seller_name', e.target.value)} />
            </Field>
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              <Field label={st.sellerTaxId} error={taxIdOk ? undefined : st.taxIdInvalid}>
                <TextInput inputMode="numeric" invalid={!taxIdOk} value={draft['tax.seller_tax_id']} maxLength={17} disabled={!editable} onChange={(e) => set('tax.seller_tax_id', e.target.value.replace(/\D/g, ''))} />
              </Field>
              <Field label={st.sellerBranch} error={branchOk ? undefined : st.branchInvalid}>
                <TextInput inputMode="numeric" invalid={!branchOk} value={draft['tax.seller_branch']} maxLength={5} disabled={!editable} onChange={(e) => set('tax.seller_branch', e.target.value.replace(/\D/g, ''))} />
              </Field>
            </div>
            <Field label={st.sellerAddress} hint={st.sellerHint}>
              <TextInput value={draft['tax.seller_address']} maxLength={300} disabled={!editable} onChange={(e) => set('tax.seller_address', e.target.value)} />
            </Field>
            <span className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{st.accountantNote}</span>
          </Card>
        </div>
      )}

      {tab === 'payment' && (
        <Card className="flex max-w-3xl flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{st.ppTitle}</h2>
          <Field label={st.ppId} hint={st.ppHint} error={ppValid ? undefined : t.errors.INVALID_INPUT}>
            <TextInput inputMode="numeric" value={draft['promptpay.id']} disabled={!editable} maxLength={20} onChange={(e) => set('promptpay.id', e.target.value)} />
          </Field>
          <span className="rounded-xl bg-accent px-3 py-2 text-[13px] text-accent-foreground">{st.ppManual}</span>
        </Card>
      )}
      {tab === 'payment' && <PayVerifyCard draft={draft} set={set} editable={editable} endpointOk={endpointOk} />}

      {tab === 'printer' && (
        <Card className="flex max-w-3xl flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{st.printerTitle}</h2>
          <div className="max-w-xs">
            <Segmented
              label={st.paper}
              value={String(draft['receipt.paper_mm']) as '80' | '58'}
              onChange={(v) => editable && set('receipt.paper_mm', Number(v) as 58 | 80)}
              options={[
                { value: '80', label: st.paperMm(80) },
                { value: '58', label: st.paperMm(58) },
              ]}
            />
          </div>
          <Field label={st.header}>
            <TextInput value={draft['receipt.header']} maxLength={200} disabled={!editable} onChange={(e) => set('receipt.header', e.target.value)} />
          </Field>
          <Field label={st.footer}>
            <TextInput value={draft['receipt.footer']} maxLength={200} disabled={!editable} onChange={(e) => set('receipt.footer', e.target.value)} />
          </Field>
          <span className="text-xs text-muted-foreground">{st.printerNote}</span>
        </Card>
      )}
      {tab === 'printer' && (
        <Card className="flex max-w-3xl flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{t.kdsSetting.title}</h2>
          <div className="flex min-h-12 items-center justify-between gap-3">
            <span className="flex flex-col text-[15px]">
              {t.kdsSetting.completeOnPay}
              <span className="text-xs text-muted-foreground">{t.kdsSetting.completeOnPayHint}</span>
            </span>
            <Toggle checked={draft['kds.complete_on_pay']} label={t.kdsSetting.completeOnPay} disabled={!editable} onChange={(v) => set('kds.complete_on_pay', v)} />
          </div>
        </Card>
      )}

      {tab === 'stock' && (
        <Card className="flex max-w-3xl flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{st.stockTitle}</h2>
          <div className="flex min-h-12 items-center justify-between gap-3">
            <span className="flex flex-col text-[15px]">
              {st.separateApprover}
              <span className="text-xs text-muted-foreground">{st.separateApproverHint}</span>
            </span>
            <Toggle checked={draft['stock.count_separate_approver']} label={st.separateApprover} disabled={!editable} onChange={(v) => set('stock.count_separate_approver', v)} />
          </div>
        </Card>
      )}

      {tab === 'device' && (
        <Card className="flex max-w-3xl flex-col gap-6">
          <LanSection />
          <div className="border-t border-border" />
          <LicenseSection />
        </Card>
      )}
      {tab === 'device' && system?.deviceRole !== 'client' && (
        <Card className="flex max-w-3xl flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{t.update.feedTitle}</h2>
          <Field label={t.update.feedUrl} hint={t.update.feedHint} error={feedOk ? undefined : t.update.feedInvalid}>
            <TextInput value={draft['update.feed_url']} invalid={!feedOk} maxLength={300} disabled={!editable} placeholder="https://" onChange={(e) => set('update.feed_url', e.target.value.trim())} />
          </Field>
          <div className="flex min-h-12 items-center justify-between gap-3">
            <span className="flex flex-col text-[15px]">
              {t.update.autoCheck}
              <span className="text-xs text-muted-foreground">{t.update.autoCheckHint}</span>
            </span>
            <Toggle checked={draft['update.auto_check']} label={t.update.autoCheck} disabled={!editable} onChange={(v) => set('update.auto_check', v)} />
          </div>
        </Card>
      )}
    </>
  )
}

function PayVerifyCard({ draft, set, editable, endpointOk }: { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; editable: boolean; endpointOk: boolean }) {
  const toast = useToast()
  const p = t.payVerify
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  useEffect(() => {
    call('payments.verifyInfo').then((r) => setHasKey(r.hasApiKey), () => setHasKey(null))
  }, [])
  const def = PROVIDER_DEFS[draft['promptpay.provider']]
  const auto = draft['promptpay.verify_mode'] === 'auto'
  async function saveKey(apiKey: string | null) {
    try {
      const r = await call('payments.saveApiKey', { apiKey })
      setHasKey(r.hasApiKey)
      setKey('')
      toast(p.keySaved)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  return (
    <Card className="flex max-w-3xl flex-col gap-3">
      <h2 className="m-0 text-lg font-bold">{p.title}</h2>
      <span className="text-sm text-muted-foreground">{p.desc}</span>
      <div className="max-w-md">
        <Segmented
          label={p.mode}
          value={draft['promptpay.verify_mode']}
          onChange={(v) => editable && set('promptpay.verify_mode', v as PaymentVerifyMode)}
          options={PAYMENT_VERIFY_MODES.map((m) => ({ value: m, label: p.modes[m] }))}
        />
      </div>
      {auto && (
        <>
          <div className="max-w-md">
            <Field label={p.provider}>
              <SelectInput value={draft['promptpay.provider']} disabled={!editable} onChange={(e) => set('promptpay.provider', e.target.value as PaymentProvider)}>
                {PAYMENT_PROVIDERS.map((x) => (
                  <option key={x} value={x}>
                    {p.providers[x]}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          {draft['promptpay.provider'] === 'mock' && <span className="rounded-xl bg-danger px-3 py-2 text-[13px] text-danger-foreground">{p.mockWarn}</span>}
          {!def.connected && <span className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{p.notConnected}</span>}
          <div className="grid grid-cols-2 gap-3">
            {def.fields.includes('merchantId') && (
              <Field label={p.merchantId}>
                <TextInput value={draft['promptpay.merchant_id']} maxLength={80} disabled={!editable} onChange={(e) => set('promptpay.merchant_id', e.target.value)} />
              </Field>
            )}
            {def.fields.includes('branchId') && (
              <Field label={p.branchId}>
                <TextInput value={draft['promptpay.provider_branch']} maxLength={80} disabled={!editable} onChange={(e) => set('promptpay.provider_branch', e.target.value)} />
              </Field>
            )}
            {def.fields.includes('endpoint') && (
              <div className="col-span-2">
                <Field label={p.endpoint} error={endpointOk ? undefined : t.update.feedInvalid}>
                  <TextInput value={draft['promptpay.provider_endpoint']} maxLength={300} disabled={!editable} onChange={(e) => set('promptpay.provider_endpoint', e.target.value.trim())} />
                </Field>
              </div>
            )}
          </div>
          {def.needsSecret && editable && (
            <div className="flex flex-wrap items-end gap-2.5">
              <div className="min-w-[260px] flex-1">
                <Field label={p.apiKey} hint={hasKey ? p.apiKeySet : undefined}>
                  <TextInput type="password" autoComplete="off" value={key} maxLength={256} onChange={(e) => setKey(e.target.value)} />
                </Field>
              </div>
              <OutlineButton disabled={!key} onClick={() => void saveKey(key)}>
                {p.saveKey}
              </OutlineButton>
              {hasKey && <OutlineButton onClick={() => void saveKey(null)}>{p.removeKey}</OutlineButton>}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
