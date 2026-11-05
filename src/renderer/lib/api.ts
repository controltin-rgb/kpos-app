import type { Channel, Input, Output } from '@shared/api'
import type { Envelope, ErrorPayload } from '@shared/errors'
import { t } from '@renderer/i18n'

/** Error thrown by `call` when the main process returns { ok: false }. */
export class ApiError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.code)
    this.name = 'ApiError'
  }
  get code() {
    return this.payload.code
  }
}

type Listener = () => void
const unauthenticatedListeners = new Set<Listener>()

/** Subscribe to "session ended" (expired, revoked, disabled) so the app can return to login. */
export function onUnauthenticated(fn: Listener): () => void {
  unauthenticatedListeners.add(fn)
  return () => unauthenticatedListeners.delete(fn)
}

/** Typed IPC call: renderer → preload → main router (CLAUDE.md rule 6). */
export async function call<C extends Channel>(channel: C, ...input: Input<C> extends undefined ? [] : [Input<C>]): Promise<Output<C>> {
  const res = (await window.kposs.invoke(channel, input[0])) as Envelope<Output<C>>
  if (res.ok) return res.data
  if (res.error.code === 'UNAUTHENTICATED' || res.error.code === 'PASSWORD_CHANGE_REQUIRED') {
    unauthenticatedListeners.forEach((fn) => fn())
  }
  throw new ApiError(res.error)
}

/** Thai message for any error thrown by `call`. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return t.errors[err.code] ?? t.errors.INTERNAL
  return t.errors.INTERNAL
}

/** Field errors of an INVALID_INPUT error, keyed by field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.payload.fields) return {}
  return Object.fromEntries(Object.entries(err.payload.fields).map(([k, v]) => [k, v[0] ?? t.errors.fields.invalid]))
}
