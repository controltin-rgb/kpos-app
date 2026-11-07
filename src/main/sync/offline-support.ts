import { renderReceipt } from '@main/print/receipt'
import { api, type Channel, type ParsedInput, type SessionUser, type SetupStatus } from '@shared/api'
import type { PosCatalog, SaleResult, ShiftSummaryDto } from '@shared/api-sales'
import { periodKey } from '@shared/bill-number'
import { AppError, type Envelope, type ErrorCode } from '@shared/errors'
import { hasPermission, type Permission } from '@shared/permissions'
import { buildPromptPayPayload } from '@shared/promptpay'
import type { ClientStore } from './client-store'
import { buildOfflineSale, offlineQuote } from './offline-sale'

/** Errors that mean "the Host is not reachable right now" (not: revoked, certificate changed). */
export const isOfflineError = (code: ErrorCode) => code === 'LAN_UNREACHABLE' || code === 'LAN_HOST_OFFLINE'

/** Channels a Client can answer by itself while the Host is down (D35, D36). */
const OFFLINE_CHANNELS = new Set<string>(['auth.me', 'setup.status', 'pos.catalog', 'pos.quote', 'pos.checkout', 'pos.promptPayPayload', 'shift.current', 'orders.print'])

const ok = <T,>(data: T): Envelope<T> => ({ ok: true, data })
const fail = (code: ErrorCode, data?: Record<string, unknown>): Envelope<never> => ({ ok: false, error: { code, ...(data ? { data } : {}) } })

/**
 * Offline selling on a Client (D35, D36). Remembers, from normal online calls, who is logged in on
 * each window and the device's open shift; when the Host stops answering, sells from the synced
 * snapshot with reserved bill numbers and queues the bills for the Host.
 */
export class OfflineSupport {
  private readonly users = new Map<number, SessionUser>()
  private shift: ShiftSummaryDto | null = null
  private setup: SetupStatus | null = null
  private readonly printed = new Set<string>()

  constructor(
    private readonly store: ClientStore,
    private readonly device: { id: string; name: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** Learns from a successful call to the Host. */
  observe(win: number, channel: string, env: Envelope<unknown>): void {
    if (!env.ok) {
      if (env.error.code === 'UNAUTHENTICATED') this.users.delete(win)
      return
    }
    const d = env.data
    switch (channel) {
      case 'auth.login':
      case 'auth.me':
      case 'auth.changePassword':
        if (d) this.users.set(win, d as SessionUser)
        else this.users.delete(win)
        break
      case 'auth.logout':
        this.users.delete(win)
        break
      case 'setup.status':
        this.setup = d as SetupStatus
        break
      case 'shift.current':
      case 'shift.open':
      case 'shift.cashMove':
        this.shift = (d as ShiftSummaryDto | null) ?? null
        break
      case 'shift.close':
        this.shift = null
        break
    }
  }

  /** Permission of the user remembered on this window (null = nobody remembered). */
  cachedCan(win: number, perm: string): boolean | null {
    const u = this.users.get(win)
    return u ? hasPermission(new Set(u.permissions), perm as Permission) : null
  }

  forgetWindow(win: number): void {
    this.users.delete(win)
  }

  handles(channel: string): boolean {
    return OFFLINE_CHANNELS.has(channel)
  }

  /** Is this bill one of ours that the Host does not have yet? */
  isLocalBill(id: unknown): boolean {
    return typeof id === 'string' && this.store.detail(id) !== null
  }

  private user(win: number, perm: Permission): SessionUser {
    const u = this.users.get(win)
    if (!u) throw new AppError('UNAUTHENTICATED') // D35: only people already logged in on this Client
    if (!hasPermission(new Set(u.permissions), perm)) throw new AppError('FORBIDDEN', { permission: perm })
    return u
  }

  private parse<C extends Channel>(channel: C, input: unknown): ParsedInput<C> {
    const r = api[channel].input.safeParse(input)
    if (!r.success) throw new AppError('INVALID_INPUT')
    return r.data as ParsedInput<C>
  }

  /** Answers a call without the Host. */
  handle(win: number, channel: string, input: unknown, print: (html: string, paperMm: 58 | 80) => Promise<void>): Envelope<unknown> | Promise<Envelope<unknown>> {
    try {
      const snap = this.store.snapshot()
      switch (channel) {
        case 'auth.me':
          return ok(this.users.get(win) ?? null)
        case 'setup.status':
          return ok(this.setup ?? { setupRequired: false, shopName: snap?.branch.shopName ?? null, branchName: snap?.branch.name ?? null })
        case 'shift.current':
          this.user(win, 'shift:view')
          return ok(this.shift)
        case 'pos.catalog': {
          const u = this.user(win, 'pos:view')
          if (!snap) return fail('OFFLINE_NOT_READY')
          const cat: PosCatalog = { ...snap.posCatalog, vatRateBp: snap.settings.vatRateBp, promptPayId: snap.settings.promptPayId, device: this.device, branchName: u.branchName }
          return ok(cat)
        }
        case 'pos.quote': {
          this.user(win, 'pos:view')
          if (!snap) return fail('OFFLINE_NOT_READY')
          return ok(offlineQuote(snap, this.parse('pos.quote', input), this.now()))
        }
        case 'pos.promptPayPayload': {
          this.user(win, 'pos:view')
          if (!snap?.settings.promptPayId) return fail('PROMPTPAY_NOT_CONFIGURED')
          const { amountSatang } = this.parse('pos.promptPayPayload', input)
          return ok(buildPromptPayPayload({ id: snap.settings.promptPayId, amountSatang }))
        }
        case 'pos.checkout': {
          const user = this.user(win, 'pos:create')
          const parsed = this.parse('pos.checkout', input)
          const again = this.store.detail(parsed.requestId)
          if (again) return ok({ bill: again, shortages: [] } satisfies SaleResult) // retried checkout
          if (!snap) return fail('OFFLINE_NOT_READY')
          if (!this.shift || this.shift.status !== 'open') return fail('SHIFT_NOT_OPEN')
          const now = this.now()
          const period = periodKey(snap.settings.billPolicy, now)
          const shift = this.shift
          const detail = this.store.sell(period, (number) => buildOfflineSale(snap, parsed, { user, shift, number, now }))
          return ok({ bill: detail, shortages: [] } satisfies SaleResult)
        }
        case 'orders.print': {
          this.user(win, 'orders:view')
          const { id } = this.parse('orders.print', input)
          const bill = this.store.detail(id)
          if (!bill || !snap) return fail('LAN_UNREACHABLE')
          const html = renderReceipt(bill, {
            shopName: snap.branch.shopName,
            branchName: snap.branch.name,
            header: snap.settings.receiptHeader,
            footer: snap.settings.receiptFooter,
            paperMm: snap.settings.paperMm,
            vatRateBp: snap.settings.vatRateBp,
            reprint: this.printed.has(id),
          })
          this.printed.add(id)
          return print(html, snap.settings.paperMm).then(
            () => ok(null),
            () => fail('PRINT_FAILED'),
          )
        }
      }
      return fail('LAN_UNREACHABLE')
    } catch (err) {
      if (err instanceof AppError) return fail(err.code, err.data)
      throw err
    }
  }
}
