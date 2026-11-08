import { useEffect, useState } from 'react'
import type { CloudOverviewDto } from '@shared/api-system'
import { useConfirm } from '@renderer/components/confirm'
import { Modal } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, IconTile, OutlineButton, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'

const c = t.cloud

function cloudStatusChip(ov: CloudOverviewDto) {
  if (!ov.enabled) return <Chip bg="#F3F0EC" fg="#5C6270">{c.statusOff}</Chip>
  if (!ov.configured || !ov.licensed) return <Chip bg="#FFF4D6" fg="#7A5200">{c.statusIncomplete}</Chip>
  if (ov.lastError) return <Chip bg="#FFE3E3" fg="#A6232B">{c.statusError}</Chip>
  return <Chip bg="#DDF5E8" fg="#11724A">{c.statusOk}</Chip>
}

/** Encrypted cloud copy (D43): S3-compatible bucket settings, test, sync now, download on a new machine. */
export function CloudCard({ onChanged }: { onChanged: () => void }) {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const editable = can('settings:update')
  const [ov, setOv] = useState<CloudOverviewDto | null>(null)
  const [d, setD] = useState({ enabled: false, endpoint: '', region: 'auto', bucket: '', prefix: 'kposs', accessKeyId: '' })
  const [secret, setSecret] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const apply = (o: CloudOverviewDto) => {
    setOv(o)
    setD({ enabled: o.enabled, endpoint: o.endpoint, region: o.region, bucket: o.bucket, prefix: o.prefix, accessKeyId: o.accessKeyId })
  }
  useEffect(() => {
    call('cloud.overview').then(apply, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [toast])
  if (!ov) return null

  const endpointOk = d.endpoint === '' || /^https:\/\//.test(d.endpoint)
  const prefixOk = /^[A-Za-z0-9._/-]*$/.test(d.prefix)
  const passOk = pass === '' || pass.length >= 8

  async function run<T>(name: string, fn: () => Promise<T>, ok?: (r: T) => string) {
    setBusy(name)
    try {
      const r = await fn()
      if (ok) toast(ok(r))
      return r
    } catch (err) {
      toast(errorMessage(err), 'error')
      return null
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    const r = await run(
      'save',
      () => call('cloud.save', { ...d, ...(secret ? { secretAccessKey: secret } : {}), ...(pass ? { passphrase: pass } : {}) }),
      () => c.saved,
    )
    if (r) {
      apply(r)
      setSecret('')
      setPass('')
    }
  }

  return (
    <Card className="relative flex flex-col gap-3 overflow-hidden">
      <div className="absolute -top-10 -right-10 size-[140px] rounded-full bg-[#E4F1FF]" />
      <div className="relative flex items-center gap-3">
        <IconTile icon="cloud" tone="blue" size={40} iconSize={20} radius={12} />
        <h2 className="m-0 flex-1 text-lg font-bold">{c.title}</h2>
        {cloudStatusChip(ov)}
      </div>
      <span className="relative text-sm text-muted-foreground">{c.desc}</span>
      {!ov.licensed && <span className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{c.notLicensed}</span>}
      <div className="flex min-h-12 items-center justify-between gap-3">
        <span className="text-[15px]">{c.enabled}</span>
        <Toggle checked={d.enabled} label={c.enabled} disabled={!editable} onChange={(v) => setD({ ...d, enabled: v })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label={c.endpoint} hint={c.endpointHint} error={endpointOk ? undefined : t.update.feedInvalid}>
            <TextInput value={d.endpoint} invalid={!endpointOk} maxLength={300} disabled={!editable} placeholder="https://" onChange={(e) => setD({ ...d, endpoint: e.target.value.trim() })} />
          </Field>
        </div>
        <Field label={c.bucket}>
          <TextInput value={d.bucket} maxLength={63} disabled={!editable} onChange={(e) => setD({ ...d, bucket: e.target.value.trim() })} />
        </Field>
        <Field label={c.region}>
          <TextInput value={d.region} maxLength={40} disabled={!editable} onChange={(e) => setD({ ...d, region: e.target.value.trim() })} />
        </Field>
        <Field label={c.prefix} error={prefixOk ? undefined : t.errors.INVALID_INPUT}>
          <TextInput value={d.prefix} maxLength={120} disabled={!editable} onChange={(e) => setD({ ...d, prefix: e.target.value.trim() })} />
        </Field>
        <Field label={c.accessKey}>
          <TextInput value={d.accessKeyId} maxLength={128} autoComplete="off" disabled={!editable} onChange={(e) => setD({ ...d, accessKeyId: e.target.value.trim() })} />
        </Field>
        {editable && (
          <>
            <Field label={c.secretKey} hint={ov.hasSecretKey ? c.keepSecret : undefined}>
              <TextInput type="password" autoComplete="off" value={secret} maxLength={256} onChange={(e) => setSecret(e.target.value)} />
            </Field>
            <Field label={c.passphrase} hint={ov.hasPassphrase ? c.keepSecret : c.passphraseHint} error={passOk ? undefined : t.errors.INVALID_INPUT}>
              <TextInput type="password" autoComplete="new-password" value={pass} maxLength={256} onChange={(e) => setPass(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        <span>{ov.lastSyncAt ? c.lastSync(formatDateTimeShort(ov.lastSyncAt)) : c.never}</span>
        <span>{c.files(ov.uploadedFiles, ov.pendingFiles)}</span>
        {ov.lastError && <span className="text-danger-foreground">{c.error(ov.lastError)}</span>}
      </div>
      <div className="flex flex-wrap gap-2.5">
        {editable && (
          <GradientButton disabled={busy !== null || !endpointOk || !prefixOk || !passOk} onClick={() => void save()}>
            {busy === 'save' ? t.common.saving : c.save}
          </GradientButton>
        )}
        {editable && (
          <OutlineButton disabled={busy !== null || !ov.configured} onClick={() => void run('test', () => call('cloud.test'), (r) => c.testOk(r.objects))}>
            {c.test}
          </OutlineButton>
        )}
        {can('backup:create') && (
          <OutlineButton
            disabled={busy !== null || !ov.configured || !ov.licensed}
            onClick={async () => {
              const r = await run('sync', () => call('cloud.syncNow'), () => c.synced)
              if (r) setOv(r)
            }}
          >
            {busy === 'sync' ? t.common.loading : c.syncNow}
          </OutlineButton>
        )}
        {can('backup:restore') && (
          <OutlineButton
            disabled={busy !== null || !ov.configured}
            onClick={async () => {
              if (!(await confirm({ kind: 'warning', icon: 'cloud', title: c.download, message: c.downloadConfirm, confirmLabel: c.download }))) return
              const r = await run('download', () => call('cloud.download', { confirm: 'DOWNLOAD' }), (x) => c.downloaded(x.files, x.backups))
              if (r) onChanged()
            }}
          >
            {c.download}
          </OutlineButton>
        )}
      </div>
    </Card>
  )
}

/** "Reset database" — Super Admin only; typed RESET + own password; restarts into first-run setup. */
export function ResetDatabaseCard() {
  const { user } = useSession()
  const toast = useToast()
  const r = t.resetDb
  const [open, setOpen] = useState(false)
  const [word, setWord] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  if (user?.roleKey !== 'super_admin') return null

  async function submit() {
    setBusy(true)
    try {
      const res = await call('system.resetDatabase', { confirm: 'RESET', password: pw })
      setOpen(false)
      if (res.restarting) setRestarting(true)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
      setPw('')
    }
  }

  return (
    <Card className="relative flex flex-col gap-3 overflow-hidden border-[1.5px] border-[#FFE3E3]">
      <div className="absolute -top-10 -right-10 size-[140px] rounded-full bg-[#FFE3E3]" />
      <div className="relative flex items-center gap-3">
        <IconTile icon="trash" tone="red" size={40} iconSize={20} radius={12} />
        <h2 className="m-0 flex-1 text-lg font-bold">{r.title}</h2>
        <Chip bg="#FFE3E3" fg="#A6232B">{r.superOnly}</Chip>
      </div>
      <span className="relative text-sm text-muted-foreground">{r.desc}</span>
      <DangerButton className="self-start" onClick={() => setOpen(true)}>
        {r.open}
      </DangerButton>
      {open && (
        <Modal
          title={r.dialogTitle}
          onClose={() => !busy && setOpen(false)}
          footer={
            <div className="flex gap-2.5">
              <OutlineButton className="flex-1" disabled={busy} onClick={() => setOpen(false)}>
                {t.common.cancel}
              </OutlineButton>
              <DangerButton className="min-h-12 flex-1" disabled={busy || word !== 'RESET' || !pw} onClick={() => void submit()}>
                {busy ? t.common.loading : r.submit}
              </DangerButton>
            </div>
          }
        >
          <div className="flex items-start gap-3 rounded-2xl bg-[#FFE3E3] px-4 py-3 text-sm leading-relaxed text-[#A6232B]">
            <IconTile icon="trash" tone="red" size={36} iconSize={18} radius={11} />
            <span>{r.warn}</span>
          </div>
          <Field label={r.typeWord}>
            <TextInput value={word} autoComplete="off" onChange={(e) => setWord(e.target.value.trim().toUpperCase())} placeholder="RESET" />
          </Field>
          <Field label={r.password}>
            <TextInput type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
        </Modal>
      )}
      {restarting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,36,48,0.4)]">
          <div className="rounded-[22px] bg-white px-8 py-6 text-lg font-bold shadow-[0_10px_30px_rgba(60,40,90,0.2)]">{r.restarting}</div>
        </div>
      )}
    </Card>
  )
}
