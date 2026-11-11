import { z } from 'zod'
import { can, type Actor } from '@main/auth/actor'
import type { AuditService } from '@main/services/audit.service'
import { api, type Api, type Channel, type Output, type ParsedInput } from '@shared/api'
import { AppError, type Envelope, type ErrorPayload } from '@shared/errors'
import type { Permission } from '@shared/permissions'

/** Calls allowed while the user still has to change a temporary password. */
const ALLOWED_DURING_PASSWORD_CHANGE = new Set<Channel>(['auth.me', 'auth.logout', 'auth.changePassword', 'system.info'])

export interface CallContext<C extends Channel> {
  /** id of the calling window (Electron webContents id) or LAN device */
  senderId: number
  actor: Api[C]['access'] extends 'public' ? Actor | null : Actor
  /** session token of the caller (null when not logged in) */
  token: string | null
}

export type Handler<C extends Channel> = (ctx: CallContext<C>, input: ParsedInput<C>) => Output<C> | Promise<Output<C>>
export type Handlers = { [C in Channel]: Handler<C> }

export interface Sessions {
  get(senderId: number): string | null
  set(senderId: number, token: string): void
  delete(senderId: number): void
}

export class SessionRegistry implements Sessions {
  private readonly map = new Map<number, string>()
  get(senderId: number) {
    return this.map.get(senderId) ?? null
  }
  set(senderId: number, token: string) {
    this.map.set(senderId, token)
  }
  delete(senderId: number) {
    this.map.delete(senderId)
  }
}

export interface RouterDeps {
  handlers: Handlers
  sessions: Sessions
  resolveActor: (token: string) => Promise<Actor | null>
  audit: AuditService
  log?: (msg: string, err: unknown) => void
  /** extra refusal after authentication/permission (e.g. license read-only mode, D26) */
  gate?: (channel: Channel) => ErrorPayload | null
}

/**
 * Single entry point for every renderer → main call (CLAUDE.md rules 5 and 6):
 * unknown channel → NOT_FOUND, no session → UNAUTHENTICATED, missing permission → FORBIDDEN (audited),
 * invalid input → INVALID_INPUT. Errors never leak stack traces to the renderer.
 */
export function createRouter(deps: RouterDeps) {
  const { handlers, sessions, resolveActor, audit } = deps
  const log = deps.log ?? ((m, e) => console.error(m, e))

  return async function dispatch(senderId: number, channel: string, rawInput: unknown): Promise<Envelope<unknown>> {
    if (!Object.hasOwn(api, channel)) return fail({ code: 'NOT_FOUND', data: { channel } })
    const ch = channel as Channel
    const endpoint = api[ch]

    try {
      const token = sessions.get(senderId)
      let actor: Actor | null = null
      if (token) {
        actor = await resolveActor(token)
        if (!actor) sessions.delete(senderId) // expired / revoked / disabled
      }

      if (endpoint.access !== 'public') {
        if (!actor) return fail({ code: 'UNAUTHENTICATED' })
        if (actor.mustChangePassword && !ALLOWED_DURING_PASSWORD_CHANGE.has(ch)) {
          return fail({ code: 'PASSWORD_CHANGE_REQUIRED' })
        }
        if (endpoint.access !== 'authenticated' && !can(actor, endpoint.access as Permission)) {
          audit.append({
            action: 'auth.permission_denied',
            permission: endpoint.access as Permission,
            userId: actor.userId,
            branchId: actor.branchId,
            after: { channel: ch },
            risk: 'medium',
          })
          return fail({ code: 'FORBIDDEN', data: { permission: endpoint.access } })
        }
      }

      const refused = deps.gate?.(ch)
      if (refused) return fail(refused)

      const parsed = (endpoint.input as z.ZodType).safeParse(rawInput)
      if (!parsed.success) {
        return fail({ code: 'INVALID_INPUT', fields: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> })
      }

      const handler = handlers[ch] as Handler<Channel>
      const data = await handler({ senderId, actor: actor as Actor, token }, parsed.data as never)
      return { ok: true, data: data ?? null }
    } catch (err) {
      if (err instanceof AppError) return fail({ code: err.code, ...(err.data ? { data: err.data } : {}) })
      log(`[ipc] ${ch} failed`, err)
      return fail({ code: 'INTERNAL' })
    }
  }
}

function fail(error: ErrorPayload): Envelope<never> {
  return { ok: false, error }
}
