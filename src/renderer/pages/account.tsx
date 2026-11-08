import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ProfileDto } from '@shared/api'
import { Segmented } from '@renderer/components/modal'
import { Card, Field, GradientButton, PageHeader, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { formatDateTimeShort } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { useTextScale, useTheme, type TextScale, type ThemePref } from '@renderer/lib/theme'

const a = t.account
type Tab = 'profile' | 'pin' | 'prefs'
const TABS: Tab[] = ['profile', 'pin', 'prefs']

/** Header user menu: my profile, change my PIN, personal settings (D48). Every signed-in user, own account only. */
export function AccountPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('tab')
  const tab: Tab = TABS.includes(q as Tab) ? (q as Tab) : 'profile'
  const [profile, setProfile] = useState<ProfileDto | null>(null)
  const toast = useToast()

  useEffect(() => {
    let alive = true
    call('profile.get').then((p) => alive && setProfile(p), (err: unknown) => toast(errorMessage(err), 'error'))
    return () => {
      alive = false
    }
  }, [toast])

  return (
    <>
      <PageHeader icon="users" tone="violet" title={a.title} subtitle={a.subtitle} />
      <div className="mb-[18px]">
        <Segmented label={a.title} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} options={TABS.map((k) => ({ value: k, label: a.tabs[k] }))} />
      </div>
      {profile && tab === 'profile' && <ProfileTab profile={profile} onSaved={setProfile} />}
      {profile && tab === 'pin' && <PinTab profile={profile} onSaved={setProfile} />}
      {tab === 'prefs' && <PrefsTab />}
    </>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold">{children}</span>
    </div>
  )
}

function ProfileTab({ profile, onSaved }: { profile: ProfileDto; onSaved: (p: ProfileDto) => void }) {
  const { refresh } = useSession()
  const toast = useToast()
  const [d, setD] = useState({ displayName: profile.displayName, email: profile.email ?? '', phone: profile.phone ?? '' })
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const dirty = d.displayName !== profile.displayName || d.email !== (profile.email ?? '') || d.phone !== (profile.phone ?? '')

  async function save() {
    setBusy(true)
    setFields({})
    try {
      onSaved(await call('profile.update', d))
      await refresh() // header shows the new name
      toast(t.crud.saved)
    } catch (err) {
      setFields(fieldErrors(err))
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  const err = (k: string) => (fields[k] ? (fields[k] === 'duplicate' ? a.emailTaken : t.errors.INVALID_INPUT) : undefined)

  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <Card className="flex max-w-xl min-w-0 flex-[1_1_420px] flex-col gap-3">
        <h2 className="m-0 text-lg font-bold">{a.profileTitle}</h2>
        <Field label={a.displayName} error={err('displayName')}>
          <TextInput value={d.displayName} maxLength={80} onChange={(e) => setD({ ...d, displayName: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={a.email} error={err('email')}>
            <TextInput type="email" value={d.email} maxLength={120} onChange={(e) => setD({ ...d, email: e.target.value.trim() })} />
          </Field>
          <Field label={a.phone} error={err('phone')}>
            <TextInput inputMode="numeric" value={d.phone} maxLength={10} onChange={(e) => setD({ ...d, phone: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        <span className="text-xs text-muted-foreground">{a.profileNote}</span>
        <GradientButton disabled={!dirty || busy || !d.displayName.trim()} onClick={() => void save()}>
          {a.save}
        </GradientButton>
      </Card>
      <div className="flex max-w-md min-w-0 flex-[1_1_320px] flex-col gap-[18px]">
        <Card className="flex flex-col gap-2.5">
          <h2 className="m-0 text-lg font-bold">{a.accountTitle}</h2>
          <Row label={a.username}>{profile.username}</Row>
          <Row label={a.role}>{profile.roleName}</Row>
          <Row label={a.branch}>{profile.branchName}</Row>
          <Row label={a.pin}>{profile.hasPin ? a.pinSet : a.pinNotSet}</Row>
          <Row label={a.lastLogin}>{profile.lastLoginAt ? formatDateTimeShort(profile.lastLoginAt) : '—'}</Row>
          <Row label={a.since}>{formatDateTimeShort(profile.createdAt).slice(0, 8)}</Row>
        </Card>
        <PasswordCard />
      </div>
    </div>
  )
}

function PasswordCard() {
  const toast = useToast()
  const { setUser } = useSession()
  const c = t.changePassword
  const [d, setD] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  async function save() {
    setFields({})
    if (d.newPassword !== d.confirm) {
      setFields({ confirm: t.setup.passwordMismatch })
      return
    }
    setBusy(true)
    try {
      setUser(await call('auth.changePassword', { currentPassword: d.currentPassword, newPassword: d.newPassword }))
      setD({ currentPassword: '', newPassword: '', confirm: '' })
      toast(a.passwordChanged)
    } catch (err) {
      setFields(fieldErrors(err))
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-bold">{c.title}</h2>
      <Field label={c.current}>
        <TextInput type="password" autoComplete="current-password" value={d.currentPassword} onChange={(e) => setD({ ...d, currentPassword: e.target.value })} />
      </Field>
      <Field label={c.next} hint={t.setup.passwordHint} error={fields['newPassword'] ? t.errors.INVALID_INPUT : undefined}>
        <TextInput type="password" autoComplete="new-password" value={d.newPassword} onChange={(e) => setD({ ...d, newPassword: e.target.value })} />
      </Field>
      <Field label={c.confirm} error={fields['confirm']}>
        <TextInput type="password" autoComplete="new-password" value={d.confirm} onChange={(e) => setD({ ...d, confirm: e.target.value })} />
      </Field>
      <GradientButton disabled={busy || !d.currentPassword || d.newPassword.length < 8 || !d.confirm} onClick={() => void save()}>
        {c.submit}
      </GradientButton>
    </Card>
  )
}

function PinTab({ profile, onSaved }: { profile: ProfileDto; onSaved: (p: ProfileDto) => void }) {
  const toast = useToast()
  const [d, setD] = useState({ currentPassword: '', pin: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const pinOk = /^\d{4,6}$/.test(d.pin)
  const match = d.pin === d.confirm

  async function save() {
    setBusy(true)
    try {
      onSaved(await call('profile.changePin', { currentPassword: d.currentPassword, newPin: d.pin }))
      setD({ currentPassword: '', pin: '', confirm: '' })
      toast(a.pinChanged)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6)

  return (
    <Card className="flex max-w-xl flex-col gap-3">
      <h2 className="m-0 text-lg font-bold">{profile.hasPin ? a.pinChangeTitle : a.pinSetTitle}</h2>
      <span className="text-sm text-muted-foreground">{a.pinIntro}</span>
      <Field label={a.newPin} hint={a.pinHint} error={d.pin && !pinOk ? a.pinHint : undefined}>
        <TextInput type="password" inputMode="numeric" autoComplete="off" value={d.pin} onChange={(e) => setD({ ...d, pin: digits(e.target.value) })} />
      </Field>
      <Field label={a.confirmPin} error={d.confirm && !match ? a.pinMismatch : undefined}>
        <TextInput type="password" inputMode="numeric" autoComplete="off" value={d.confirm} onChange={(e) => setD({ ...d, confirm: digits(e.target.value) })} />
      </Field>
      <Field label={a.passwordToConfirm} hint={a.passwordToConfirmHint}>
        <TextInput type="password" autoComplete="current-password" value={d.currentPassword} onChange={(e) => setD({ ...d, currentPassword: e.target.value })} />
      </Field>
      <GradientButton disabled={busy || !pinOk || !match || !d.currentPassword} onClick={() => void save()}>
        {a.savePin}
      </GradientButton>
    </Card>
  )
}

function PrefsTab() {
  const [theme, setTheme] = useTheme()
  const [scale, setScale] = useTextScale()
  const h = t.header
  return (
    <Card className="flex max-w-xl flex-col gap-4">
      <h2 className="m-0 text-lg font-bold">{a.prefsTitle}</h2>
      <Field label={h.theme} hint={a.themeHint}>
        <Segmented<ThemePref>
          label={h.theme}
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', label: h.themeLight },
            { value: 'dark', label: h.themeDark },
            { value: 'auto', label: h.themeAuto },
          ]}
        />
      </Field>
      <Field label={a.textSize} hint={a.textSizeHint}>
        <Segmented<`${TextScale}`>
          label={a.textSize}
          value={`${scale}`}
          onChange={(v) => setScale(Number(v) as TextScale)}
          options={[
            { value: '100', label: a.textSizes[100] },
            { value: '110', label: a.textSizes[110] },
            { value: '125', label: a.textSizes[125] },
          ]}
        />
      </Field>
      <span className="text-xs text-muted-foreground">{a.prefsNote}</span>
    </Card>
  )
}
