import { useState, type FormEvent } from 'react'
import { t } from '@renderer/i18n'
import { ApiError, call, errorMessage } from '@renderer/lib/api'
import { formatTime } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { AuthInput, AuthLayout, AuthSubmit, AuthTitle, FormError } from './auth-layout'

export function LoginPage() {
  const { setup, setUser } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!username || !password) return
    setBusy(true)
    setError(null)
    try {
      setUser(await call('auth.login', { username, password }))
    } catch (err) {
      let msg = errorMessage(err)
      const until = err instanceof ApiError ? err.payload.data?.['lockedUntil'] : undefined
      if (typeof until === 'number') msg += ` (${t.errors.lockedUntil(formatTime(until))})`
      setError(msg)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <AuthTitle title={t.app.fullName} subtitle={t.login.subtitle(setup?.shopName ?? '')} />
      <form onSubmit={submit} className="mt-1.5 flex flex-col gap-4">
        <AuthInput
          id="u"
          label={t.login.username}
          icon="user"
          placeholder={t.login.usernamePlaceholder}
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <AuthInput
          id="p"
          type="password"
          label={t.login.password}
          icon="lockLogin"
          placeholder={t.login.passwordPlaceholder}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <FormError message={error} />
        <AuthSubmit busy={busy}>{busy ? t.login.submitting : t.login.submit}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
