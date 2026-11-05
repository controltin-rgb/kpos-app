import { EventEmitter } from 'node:events'
import { toSessionUser } from '@main/auth/actor'
import { AuthService } from '@main/auth/auth.service'
import { createAuth } from '@main/auth/better-auth'
import { sqliteVersion, type Db } from '@main/db/connection'
import { createRouter, SessionRegistry, type Handlers } from '@main/ipc/router'
import { OrgRepo } from '@main/db/repos/org.repo'
import { renderReceipt } from '@main/print/receipt'
import { AuditService } from '@main/services/audit.service'
import { CatalogService } from '@main/services/catalog.service'
import { DeviceService, type LocalDevice } from '@main/services/device.service'
import { DocNumberService } from '@main/services/doc-number.service'
import { InventoryService } from '@main/services/inventory.service'
import { KdsService } from '@main/services/kds.service'
import { RolesService } from '@main/services/roles.service'
import { SaleService } from '@main/services/sale.service'
import { seedSystemRoles } from '@main/services/seed'
import { SettingsService } from '@main/services/settings.service'
import { SetupService } from '@main/services/setup.service'
import { ShiftService } from '@main/services/shift.service'
import { StockService } from '@main/services/stock/stock.service'
import { UsersService } from '@main/services/users.service'
import { formatBillNo, periodKey } from '@shared/bill-number'
import { AppError } from '@shared/errors'
import { buildPromptPayPayload } from '@shared/promptpay'
import type { AppEvent } from '@shared/api'
import type { CfdState } from '@shared/api-sales'
import { renderZReport } from '@main/print/z-report'

export interface AppContextOptions {
  db: Db
  authSecret: string
  now?: () => number
  versions?: { app: string; electron: string; node: string; chrome: string; platform: string }
  log?: (msg: string, err: unknown) => void
  /** this machine (persisted in userData/device.json by the Electron entry) */
  device?: LocalDevice
  /** prints a receipt (Electron: hidden window → OS printer); tests may capture the HTML */
  printHtml?: (html: string, opts: { paperMm: 58 | 80 }) => Promise<void>
  /** opens the KDS / CFD window sharing the caller's session */
  openWindow?: (kind: 'kds' | 'cfd', senderId: number) => void
}

export type { AppEvent } from '@shared/api'

/** Wires repositories, services and the IPC router. Electron-free so tests can drive it directly. */
export function createAppContext(opts: AppContextOptions) {
  const { db } = opts
  const now = opts.now ?? Date.now
  seedSystemRoles(db, now())

  const audit = new AuditService(db, now)
  const auth = createAuth(db, opts.authSecret)
  const authService = new AuthService(db, auth, audit, now)
  const setup = new SetupService(db, authService, audit, now)
  const users = new UsersService(db, authService, audit, now)
  const roles = new RolesService(db, audit, now)
  const sessions = new SessionRegistry()
  const events = new EventEmitter()
  const emit = (e: AppEvent) => events.emit('event', e)
  let lastCfd: CfdState | null = null

  const device = new DeviceService(db, opts.device ?? { id: '00000000-0000-7000-8000-000000000001', name: 'POS-01', hardwareId: 'test', role: 'standalone' }, now)
  const docs = new DocNumberService(db)
  const settings = new SettingsService(db, audit, now)
  const stock = new StockService(db)
  const catalog = new CatalogService(db, audit, now)
  const inventory = new InventoryService(db, stock, audit, now)
  const shifts = new ShiftService(db, device, docs, audit, now)
  const sales = new SaleService(db, catalog, stock, shifts, docs, settings, authService, audit, now)
  const kds = new KdsService(db, now)
  const org = new OrgRepo(db)
  const printHtml = opts.printHtml ?? (async () => {})
  const print = async (html: string) => {
    try {
      await printHtml(html, { paperMm: settings.get('receipt.paper_mm') })
    } catch (err) {
      throw new AppError('PRINT_FAILED', { message: String(err) })
    }
  }
  const withShiftEvent = <T,>(v: T): T => (emit({ type: 'shift.changed' }), v)

  const settingsDto = () => {
    const all = settings.all()
    const branch = org.firstBranch()
    const code = branch ? docs.branchCode(branch.id) : 'A'
    const policy = all['bill.reset_policy']
    return { ...all, branchCode: code, billNoExample: formatBillNo(code, policy, periodKey(policy, now()), 1) }
  }

  async function printBill(actor: Parameters<typeof sales.get>[0], billId: string, reprint: boolean) {
    const bill = sales.get(actor, billId)
    const branch = org.branch(actor.branchId)
    const html = renderReceipt(bill, {
      shopName: branch?.company_name ?? '',
      branchName: branch?.name ?? '',
      header: settings.get('receipt.header'),
      footer: settings.get('receipt.footer'),
      paperMm: settings.get('receipt.paper_mm'),
      vatRateBp: settings.get('vat.rate_bp'),
      reprint,
    })
    await print(html)
  }
  const v = opts.versions ?? { app: '0.0.0', electron: '', node: process.versions.node, chrome: '', platform: process.platform }

  const handlers: Handlers = {
    'system.info': () => ({
      appVersion: v.app,
      electron: v.electron,
      node: v.node,
      chrome: v.chrome,
      platform: v.platform,
      sqlite: sqliteVersion(db),
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
    }),

    'setup.status': () => setup.status(),
    'setup.complete': async (ctx, input) => {
      const { token, actor } = await setup.complete(input)
      sessions.set(ctx.senderId, token)
      return toSessionUser(actor)
    },

    'auth.me': (ctx) => (ctx.actor ? toSessionUser(ctx.actor) : null),
    'auth.login': async (ctx, input) => {
      const { token, actor } = await authService.login(input.username, input.password)
      sessions.set(ctx.senderId, token)
      return toSessionUser(actor)
    },
    'auth.logout': async (ctx) => {
      if (ctx.token) await authService.logout(ctx.token, ctx.actor)
      sessions.delete(ctx.senderId)
      return null
    },
    'auth.changePassword': async (ctx, input) =>
      toSessionUser(await authService.changeOwnPassword(ctx.actor, input.currentPassword, input.newPassword)),

    'users.list': (ctx, input) => users.list(ctx.actor, input),
    'users.get': (ctx, input) => users.get(ctx.actor, input.id),
    'users.roleOptions': (ctx) => users.roleOptions(ctx.actor),
    'users.create': (ctx, input) => users.create(ctx.actor, input),
    'users.update': (ctx, input) => users.update(ctx.actor, input),
    'users.resetPassword': (ctx, input) => users.resetPassword(ctx.actor, input.id, input.newPassword),
    'users.setPin': (ctx, input) => users.setPin(ctx.actor, input.id, input.pin),
    'users.delete': async (ctx, input) => {
      await users.delete(ctx.actor, input.id)
      return null
    },

    'roles.list': (ctx) => roles.list(ctx.actor),
    'roles.create': (ctx, input) => roles.create(ctx.actor, input),
    'roles.update': (ctx, input) => roles.update(ctx.actor, input),
    'roles.delete': (ctx, input) => {
      roles.delete(ctx.actor, input.id)
      return null
    },

    'audit.verify': () => audit.verifyChain(),

    // ---- catalog ----------------------------------------------------------
    'catalog.categories': (ctx) => catalog.categories(ctx.actor),
    'catalog.saveCategory': (ctx, input) => catalog.saveCategory(ctx.actor, input),
    'catalog.deleteCategory': (ctx, input) => (catalog.deleteCategory(ctx.actor, input.id), null),
    'catalog.products': (ctx) => catalog.products(ctx.actor, settings.get('vat.rate_bp')),
    'catalog.saveProduct': (ctx, input) => {
      const p = catalog.saveProduct(ctx.actor, input)
      return catalog.products(ctx.actor, settings.get('vat.rate_bp')).find((x) => x.id === p.id)!
    },
    'catalog.deleteProduct': (ctx, input) => (catalog.deleteProduct(ctx.actor, input.id), null),
    'catalog.groups': (ctx) => catalog.groups(ctx.actor),
    'catalog.saveGroup': (ctx, input) => catalog.saveGroup(ctx.actor, input),
    'catalog.deleteGroup': (ctx, input) => (catalog.deleteGroup(ctx.actor, input.id), null),

    // ---- inventory --------------------------------------------------------
    'inventory.ingredients': (ctx) => inventory.ingredients(ctx.actor),
    'inventory.saveIngredient': (ctx, input) => inventory.saveIngredient(ctx.actor, input),
    'inventory.deleteIngredient': (ctx, input) => (inventory.deleteIngredient(ctx.actor, input.id), null),
    'inventory.lots': (ctx, input) => inventory.lots(ctx.actor, input.ingredientId),
    'inventory.addLot': (ctx, input) => inventory.addLot(ctx.actor, device.ensure(ctx.actor.branchId), input),

    // ---- POS --------------------------------------------------------------
    'pos.catalog': (ctx) => ({
      ...catalog.posCatalog(ctx.actor),
      vatRateBp: settings.get('vat.rate_bp'),
      promptPayId: settings.get('promptpay.id'),
      device: { id: device.local.id, name: device.local.name },
      branchName: ctx.actor.branchName,
    }),
    'pos.checkout': (ctx, input) => {
      const res = sales.checkout(ctx.actor, input)
      emit({ type: 'bill.changed', billId: res.bill.id })
      emit({ type: 'kds.changed' })
      return res
    },
    'pos.showOnCfd': (_ctx, input) => {
      lastCfd = input
      emit({ type: 'cfd.state', payload: input })
      return null
    },
    'cfd.state': () => lastCfd,
    'pos.openWindow': (ctx, input) => (opts.openWindow?.(input.kind, ctx.senderId), null),
    'pos.promptPayPayload': (_ctx, input) => {
      const id = settings.get('promptpay.id')
      if (!id) throw new AppError('PROMPTPAY_NOT_CONFIGURED')
      return buildPromptPayPayload({ id, amountSatang: input.amountSatang })
    },

    // ---- bills ------------------------------------------------------------
    'orders.list': (ctx, input) => sales.list(ctx.actor, input),
    'orders.get': (ctx, input) => sales.get(ctx.actor, input.id),
    'orders.void': (ctx, input) => {
      const bill = sales.void(ctx.actor, input)
      emit({ type: 'bill.changed', billId: bill.id })
      emit({ type: 'kds.changed' })
      return bill
    },
    'orders.refund': (ctx, input) => {
      const bill = sales.refund(ctx.actor, input)
      emit({ type: 'bill.changed', billId: bill.id })
      emit({ type: 'kds.changed' })
      return bill
    },
    'orders.print': async (ctx, input) => {
      const before = sales.get(ctx.actor, input.id)
      const printedBefore = before.events.some((e) => e.event === 'reprint')
      sales.recordPrint(ctx.actor, input.id, device.ensure(ctx.actor.branchId))
      await printBill(ctx.actor, input.id, printedBefore)
      return null
    },

    // ---- shifts -----------------------------------------------------------
    'shift.current': () => shifts.current(),
    'shift.open': (ctx, input) => withShiftEvent(shifts.open(ctx.actor, input.openingFloatSatang)),
    'shift.cashMove': (ctx, input) => withShiftEvent(shifts.cashMove(ctx.actor, input.kind, input.amountSatang, input.reason)),
    'shift.close': (ctx, input) => withShiftEvent(shifts.close(ctx.actor, input.shiftId, input.counts, input.note ?? null)),
    'shift.printZ': async (ctx, input) => {
      const row = shifts.repo.shift(input.shiftId)
      if (!row || row.branch_id !== ctx.actor.branchId) throw new AppError('NOT_FOUND')
      const branch = org.branch(ctx.actor.branchId)
      await print(renderZReport(shifts.summary(row), { shopName: branch?.company_name ?? '', branchName: branch?.name ?? '', paperMm: settings.get('receipt.paper_mm'), printedBy: ctx.actor.displayName, printedAt: now() }))
      return null
    },

    // ---- KDS --------------------------------------------------------------
    'kds.tickets': (ctx, input) => kds.tickets(ctx.actor, input.station),
    'kds.advance': (ctx, input) => {
      kds.advance(ctx.actor, input.billId, input.station)
      emit({ type: 'kds.changed' })
      return null
    },

    // ---- settings ---------------------------------------------------------
    'settings.get': () => settingsDto(),
    'settings.update': (ctx, input) => {
      settings.update(ctx.actor, input)
      return settingsDto()
    },
  }

  const dispatch = createRouter({
    handlers,
    sessions,
    resolveActor: (token) => authService.resolve(token),
    audit,
    ...(opts.log ? { log: opts.log } : {}),
  })

  return { db, auth, audit, authService, setup, users, roles, sessions, dispatch, events, device, docs, settings, stock, catalog, inventory, shifts, sales, kds }
}

export type AppContext = ReturnType<typeof createAppContext>
