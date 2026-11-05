import { useState, type FormEvent } from 'react'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { useSession } from '@renderer/lib/session'
import { AuthInput, AuthLayout, AuthSubmit, AuthTitle, FormError } from './auth-layout'

/** First-run setup (no prototype yet — follows the Login card style). */
export function SetupPage() {
  const { refresh, setUser } = useSession()
  const [form, setForm] = useState({
    shopName: '',
    branchName: t.setup.branchDefault,
    displayName: '',
    username: '',
    password: '',
    confirm: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setFields({})
    if (form.password !== form.confirm) {
      setFields({ confirm: t.setup.passwordMismatch })
      return
    }
    setBusy(true)
    try {
      const { confirm: _confirm, ...input } = form
      const user = await call('setup.complete', input)
      await refresh()
      setUser(user)
    } catch (err) {
      setError(errorMessage(err))
      setFields(fieldErrors(err))
    } finally {
      setBusy(false)
    }
  }

  const s = t.setup
  return (
    <AuthLayout>
      <AuthTitle title={s.title} subtitle={s.subtitle} />
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <AuthInput id="shop" label={s.shopName} icon="home" value={form.shopName} onChange={set('shopName')} error={fields['shopName']} autoFocus required />
        <AuthInput id="branch" label={s.branchName} icon="home" value={form.branchName} onChange={set('branchName')} error={fields['branchName']} required />
        <AuthInput id="dn" label={s.displayName} icon="user" value={form.displayName} onChange={set('displayName')} error={fields['displayName']} required />
        <AuthInput
          id="un"
          label={s.username}
          icon="user"
          hint={s.usernameHint}
          autoComplete="username"
          value={form.username}
          onChange={set('username')}
          error={fields['username']}
          required
        />
        <AuthInput
          id="pw"
          type="password"
          label={s.password}
          icon="lockLogin"
          hint={s.passwordHint}
          autoComplete="new-password"
          value={form.password}
          onChange={set('password')}
          error={fields['password']}
          required
        />
        <AuthInput
          id="pw2"
          type="password"
          label={s.confirmPassword}
          icon="lockLogin"
          autoComplete="new-password"
          value={form.confirm}
          onChange={set('confirm')}
          error={fields['confirm']}
          required
        />
        <FormError message={error} />
        <AuthSubmit busy={busy}>{busy ? t.common.saving : s.submit}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
