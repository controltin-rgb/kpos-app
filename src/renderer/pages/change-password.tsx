import { useState, type FormEvent } from 'react'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { useSession } from '@renderer/lib/session'
import { AuthInput, AuthLayout, AuthSubmit, AuthTitle, FormError } from './auth-layout'

/** Forced password change after an admin created/reset the account. */
export function ChangePasswordPage() {
  const { user, setUser, logout } = useSession()
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const c = t.changePassword

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setFields({})
    if (form.newPassword !== form.confirm) {
      setFields({ confirm: t.setup.passwordMismatch })
      return
    }
    setBusy(true)
    try {
      setUser(await call('auth.changePassword', { currentPassword: form.currentPassword, newPassword: form.newPassword }))
    } catch (err) {
      setError(errorMessage(err))
      setFields(fieldErrors(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <AuthTitle title={c.title} subtitle={`${user?.displayName ?? ''} · ${c.forcedNote}`} />
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <AuthInput id="cur" type="password" label={c.current} icon="lockLogin" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} autoFocus required />
        <AuthInput
          id="new"
          type="password"
          label={c.next}
          icon="lockLogin"
          hint={t.setup.passwordHint}
          autoComplete="new-password"
          value={form.newPassword}
          onChange={set('newPassword')}
          error={fields['newPassword']}
          required
        />
        <AuthInput id="new2" type="password" label={c.confirm} icon="lockLogin" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} error={fields['confirm']} required />
        <FormError message={error} />
        <AuthSubmit busy={busy}>{c.submit}</AuthSubmit>
        <button type="button" onClick={() => void logout()} className="min-h-11 cursor-pointer border-0 bg-transparent text-sm font-semibold text-muted-foreground">
          {c.logout}
        </button>
      </form>
    </AuthLayout>
  )
}
