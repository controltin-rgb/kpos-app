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
import { StockOpsService } from '@main/services/stock-ops.service'
import { ExpenseService } from '@main/services/expense.service'
import { PromoService } from '@main/services/promo.service'
import { ReportService } from '@main/services/report.service'
import { DashboardService } from '@main/services/dashboard.service'
import { UsersService } from '@main/services/users.service'
import { formatBillNo, periodKey } from '@shared/bill-number'
import { AppError } from '@shared/errors'
import { buildPromptPayPayload } from '@shared/promptpay'
import type { AppEvent } from '@shared/api'
import type { CfdState } from '@shared/api-sales'
import { renderZReport } from '@main/print/z-report'
import { remoteScope } from '@main/request-scope'
import { LanManager, type LanManagerOptions } from '@main/lan/lan-manager'
import { SyncHostService } from '@main/sync/sync-host.service'
import { BackupService, type BackupPaths } from '@main/backup/backup.service'
import { JournalService } from '@main/backup/journal'
import { AuditQueryService } from '@main/services/audit-query.service'
import { LicenseService } from '@main/license/license.service'
import { LICENSE_PUBLIC_KEYS } from '@main/license/public-key'
import { READ_ONLY_BLOCKED_CHANNELS } from '@shared/license'

export interface AppContextOptions {
  db: Db
  authSecret: string
  now?: () => number
  versions?: { app: string; electron: string; node: string; chrome: string; platform: string }
  log?: (msg: string, err: unknown) => void
  /** this machine (persisted in userData/device.json by the Electron entry) */
  device?: LocalDevice
  /** prints a document (Electron: hidden window → OS printer); tests may capture the HTML. 210 = A4 */
  printHtml?: (html: string, opts: { paperMm: 58 | 80 | 210 }) => Promise<void>
  /** OS save dialog for exports; returns the saved path or null when cancelled */
  saveFile?: (defaultName: string, content: string) => Promise<string | null>
  /** opens the KDS / CFD window sharing the caller's session */
  openWindow?: (kind: 'kds' | 'cfd', senderId: number) => void
  /** folder for expense receipt images (userData/receipts) */
  receiptsDir?: string
  /** native file picker for receipt images; returns an absolute path or null */
  pickFile?: () => Promise<string | null>
  /** DB file + backup folder; null/absent when this process does not own a DB file (tests in memory, Client mode) */
  backupPaths?: BackupPaths | null
  /**
   * Change journal for point-in-time restore (D38), needs backupPaths. `restored`: a staged restore
   * was just swapped in. Absent → Tier A snapshots only.
   */
  journal?: { dir: string; restored?: boolean }
  /** native folder picker for the off-site backup folder */
  pickFolder?: () => Promise<string | null>
  /** restarts the app (used to swap in a restored database before it is opened) */
  relaunch?: () => void
  /** this machine's Hardware ID for licensing (Electron: machineFingerprint()) */
  hardwareId?: string
  /** trusted license public keys (default: the embedded ones) */
  licensePublicKeys?: readonly string[]
  /** native dialog to pick a .LIC; returns its text */
  pickLicenseFile?: () => Promise<string | null>
  /** Host/Client networking (D33); absent → this machine stays Standalone */
  lan?: Omit<LanManagerOptions, 'appVersion'>
}

export type { AppEvent } from '@shared/api'

/** Wires repositories, services and the IPC router. Electron-free so tests can drive it directly. */
export function createAppContext(opts: AppContextOptions) {
  const { db } = opts
  const now = opts.now ?? Date.now
  const audit = new AuditService(db, now)
  // the journal starts before anything writes, so every change after the timeline start is in it
  let settingsRef: SettingsService | null = null
  const journal =
    opts.journal && opts.backupPaths
      ? new JournalService(db, audit, {
          dir: opts.journal.dir,
          now,
          offsiteRoot: () => (settingsRef?.get('backup.offsite_enabled') ? settingsRef.get('backup.offsite_dir') || null : null),
        })
      : null
  try {
    journal?.start({ restored: opts.journal?.restored ?? false })
  } catch (err) {
    opts.log?.('[journal] start failed — point-in-time restore is off', err) // Tier A snapshots still work
  }
  seedSystemRoles(db, now())

  const license = new LicenseService(db, audit, {
    hardwareId: opts.hardwareId ?? 'HW-0000-0000-0000-0000',
    publicKeys: opts.licensePublicKeys ?? LICENSE_PUBLIC_KEYS,
    now,
    ...(opts.pickLicenseFile ? { pickFile: opts.pickLicenseFile } : {}),
  })
  const auth = createAuth(db, opts.authSecret)
  const authService = new AuthService(db, auth, audit, now)
  const setup = new SetupService(db, authService, audit, now)
  const users = new UsersService(db, authService, audit, now, () => license.employeeCap())
  const roles = new RolesService(db, audit, now)
  const sessions = new SessionRegistry()
  const events = new EventEmitter()
  const emit = (e: AppEvent) => events.emit('event', e)
  let lastCfd: CfdState | null = null

  const device = new DeviceService(db, opts.device ?? { id: '00000000-0000-7000-8000-000000000001', name: 'POS-01', hardwareId: 'test', role: 'standalone' }, now)
  audit.setDeviceProvider(() => device.auditDeviceId())
  const docs = new DocNumberService(db)
  const settings = new SettingsService(db, audit, now)
  settingsRef = settings
  const stock = new StockService(db)
  const catalog = new CatalogService(db, audit, now)
  const inventory = new InventoryService(db, stock, audit, now)
  const shifts = new ShiftService(db, device, docs, audit, now)
  const promo = new PromoService(db, settings, authService, audit, now)
  const sales = new SaleService(db, catalog, stock, shifts, docs, settings, authService, audit, promo, now)
  const kds = new KdsService(db, now)
  const expenses = new ExpenseService(db, shifts, docs, audit, opts.receiptsDir ?? null, now)
  const stockOps = new StockOpsService(db, stock, catalog, shifts, docs, settings, audit, (b) => device.ensure(b), now)
  const org = new OrgRepo(db)
  const reports = new ReportService(db, sales, shifts, stockOps, expenses, docs, settings, audit, now)
  const dashboard = new DashboardService(db, reports, shifts, stock, now, () => license.status().daysLeft)
  const backup = new BackupService(db, audit, settings, { paths: opts.backupPaths ?? null, now, cloudLicensed: () => license.status().features.cloudBackup, journal, ...(opts.pickFolder ? { pickFolder: opts.pickFolder } : {}) })
  const auditQuery = new AuditQueryService(db, now)
  const syncHost = new SyncHostService(db, catalog, promo, settings, docs, sales, audit, now)
  const lan = new LanManager(
    {
      db,
      audit,
      settings,
      license,
      device,
      events,
      sessions,
      now,
      sync: {
        snapshot: (deviceId) => syncHost.snapshot(deviceId),
        ingest: (deviceId, bills) => syncHost.ingest(deviceId, bills),
        changed: () => (emit({ type: 'shift.changed' }), emit({ type: 'kds.changed' })),
      },
      setupRequired: () => setup.status().setupRequired, dispatch: (sender, ch, input) => dispatch(sender, ch, input) },
    { certDir: null, appVersion: opts.versions?.app ?? '0.0.0', ...opts.lan },
  )
  const printHtml = opts.printHtml ?? (async () => {})
  const print = async (html: string, a4 = false) => {
    const paperMm = a4 ? 210 : settings.get('receipt.paper_mm')
    // a LAN Client prints on its own printer: hand the document back with the reply (D33)
    const scope = remoteScope()
    if (scope) {
      scope.effects.push({ kind: 'print', html, paperMm })
      return
    }
    try {
      await printHtml(html, { paperMm })
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
    return { ...all, 'license.employee_cap': license.employeeCap(), branchCode: code, billNoExample: formatBillNo(code, policy, periodKey(policy, now()), 1) }
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
      deviceRole: device.local.role,
      deviceName: device.local.name,
      hostName: null,
      hostConnected: null,
      offlinePending: null,
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

    'audit.verify': () => ({ ...audit.verifyChain(), anchor: backup.checkAuditAnchor() }),
    'audit.list': (_ctx, input) => auditQuery.list(input),

    // ---- Host / Client over the LAN (D33–D34) ------------------------------
    'lan.status': () => lan.status(),
    'lan.syncNow': () => lan.status(),
    'lan.setMode': (ctx, input) => lan.setMode(ctx.actor, input.mode, input.port),
    'lan.startPairing': (ctx) => lan.startPairing(ctx.actor),
    'lan.cancelPairing': () => (lan.host.cancelPairing(), null),
    'lan.revokeDevice': (ctx, input) => (lan.revoke(ctx.actor, input.id), null),
    'lan.ping': (_ctx, input) => lan.ping(input.address),
    'lan.pair': (_ctx, input) => lan.pair(input),
    'lan.unpair': () => {
      throw new AppError('LAN_NOT_AVAILABLE') // only a Client can unpair
    },

    // ---- license (Implement.md §6.11) -------------------------------------
    'license.status': () => license.status(),
    'license.import': async (ctx, input) => {
      const raw = input.content ?? (await license.pickFile())
      if (raw === null) return null // dialog cancelled
      return license.install(ctx.actor, raw)
    },
    'audit.overview': () => auditQuery.overview(),

    // ---- backup / restore (Implement.md §6.10) ----------------------------
    'backup.overview': () => backup.overview(),
    'backup.list': () => backup.list(),
    'backup.run': (ctx) => backup.run('manual', ctx.actor),
    'backup.saveSchedule': (ctx, input) => backup.saveSchedule(ctx.actor, input),
    'backup.pickFolder': () => (remoteScope() ? null : backup.pickFolder()), // the folder dialog belongs to the Host machine
    'backup.restoreCopy': (ctx, input) => backup.restoreCopy(ctx.actor, input.id),
    'backup.restoreReplace': async (ctx, input) => {
      await backup.stageReplace(ctx.actor, input.id)
      // let the reply reach the window before the app restarts
      if (opts.relaunch) setTimeout(opts.relaunch, 300)
      return { restarting: !!opts.relaunch }
    },
    'backup.pitrCopy': (ctx, input) => backup.pitrCopy(ctx.actor, input.at),
    'backup.pitrReplace': async (ctx, input) => {
      await backup.pitrReplace(ctx.actor, input.at)
      if (opts.relaunch) setTimeout(opts.relaunch, 300)
      return { restarting: !!opts.relaunch }
    },

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
      device: { id: device.currentId(), name: device.currentName() },
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

    // ---- purchasing / counts / waste ---------------------------------------
    'purchasing.suppliers': (ctx) => stockOps.suppliers(ctx.actor),
    'purchasing.saveSupplier': (ctx, input) => stockOps.saveSupplier(ctx.actor, input),
    'purchasing.orders': (ctx, input) => stockOps.orders(ctx.actor, input.status === 'open'),
    'purchasing.saveOrder': (ctx, input) => stockOps.saveOrder(ctx.actor, input),
    'purchasing.setStatus': (ctx, input) => stockOps.setStatus(ctx.actor, input.id, input.status),
    'purchasing.receive': (ctx, input) => stockOps.receive(ctx.actor, input),
    'counts.list': (ctx, input) => stockOps.counts(ctx.actor, input.status === 'open'),
    'counts.get': (ctx, input) => stockOps.getCount(ctx.actor, input.id),
    'counts.create': (ctx, input) => stockOps.createCount(ctx.actor, input),
    'counts.saveLines': (ctx, input) => stockOps.saveCountLines(ctx.actor, input),
    'counts.submit': (ctx, input) => stockOps.submitCount(ctx.actor, input.id),
    'counts.approve': (ctx, input) => stockOps.approveCount(ctx.actor, input.id),
    'counts.reject': (ctx, input) => stockOps.rejectCount(ctx.actor, input.id, input.reason),
    'waste.record': (ctx, input) => stockOps.recordWaste(ctx.actor, input),
    'waste.void': (ctx, input) => stockOps.voidWaste(ctx.actor, input.id, input.reason),
    'waste.list': (ctx, input) => stockOps.wasteList(ctx.actor, input),
    'waste.expiring': (ctx, input) => stockOps.expiring(ctx.actor, input.withinDays),
    'waste.summary': (ctx, input) => stockOps.wasteSummary(ctx.actor, input.from, input.to),
    'inventory.adjust': (ctx, input) => stockOps.adjust(ctx.actor, input),

    // ---- expenses ---------------------------------------------------------
    'expenses.categories': (ctx) => expenses.categories(ctx.actor),
    'expenses.saveCategory': (ctx, input) => expenses.saveCategory(ctx.actor, input),
    'expenses.list': (ctx, input) => expenses.list(ctx.actor, input),
    'expenses.create': (ctx, input) => withShiftEvent(expenses.create(ctx.actor, input)),
    'expenses.void': (ctx, input) => withShiftEvent(expenses.void(ctx.actor, input.id, input.reason)),
    'expenses.summary': (ctx, input) => expenses.summary(ctx.actor, input.from, input.to),
    'expenses.pickReceipt': async () => {
      const file = await opts.pickFile?.()
      return file ? expenses.storeReceipt(file) : null
    },
    'expenses.uploadReceipt': (_ctx, input) => {
      const data = Buffer.from(input.dataBase64, 'base64')
      if (data.length === 0 || data.length > 5 * 1024 * 1024) throw new AppError('INVALID_INPUT', { fields: { receiptFile: ['size'] } })
      return expenses.storeReceiptBytes(input.ext, data)
    },
    'expenses.receipt': (ctx, input) => expenses.receiptDataUrl(ctx.actor, input.id),

    // ---- dashboard / notifications -----------------------------------------
    'dashboard.summary': (ctx, input) => dashboard.summary(ctx.actor, input.period),
    'notifications.list': (ctx) => dashboard.notifications(ctx.actor),
    'notifications.read': (ctx, input) => (dashboard.markRead(ctx.actor, input.id), null),

    // ---- reports / tax invoices --------------------------------------------
    'reports.sales': (ctx, input) => reports.salesReport(ctx.actor, input.from, input.to, input.bucket),
    'reports.profit': (ctx, input) => reports.profitReport(ctx.actor, input.from, input.to),
    'reports.zList': (ctx, input) => reports.zList(ctx.actor, input.from, input.to),
    'reports.export': async (ctx, input) => {
      const f = reports.exportCsv(ctx.actor, input.report, input.from, input.to)
      const scope = remoteScope()
      if (scope) {
        scope.effects.push({ kind: 'save', name: f.name, content: f.content }) // the Client shows its own save dialog
        return null
      }
      return (await opts.saveFile?.(f.name, f.content)) ?? null
    },
    'tax.list': (ctx, input) => reports.taxList(ctx.actor, input.from, input.to, input.billId),
    'tax.issue': (ctx, input) => {
      const r = reports.issueTax(ctx.actor, input)
      emit({ type: 'bill.changed', billId: r.billId })
      return r
    },
    'tax.cancel': (ctx, input) => reports.cancelTax(ctx.actor, input.id, input.reason),
    'tax.print': async (ctx, input) => {
      const doc = reports.taxHtml(ctx.actor, input.id)
      await print(doc.html, doc.paper === 'a4')
      return null
    },

    'labels.print': async (_ctx, input) => {
      await print(input.html, true)
      return null
    },

    // ---- promotions / members ---------------------------------------------
    'promo.list': (ctx) => promo.promotions(ctx.actor),
    'promo.save': (ctx, input) => promo.savePromotion(ctx.actor, input),
    'promo.delete': (ctx, input) => (promo.deletePromotion(ctx.actor, input.id), null),
    'coupons.list': (ctx) => promo.coupons(ctx.actor),
    'coupons.save': (ctx, input) => promo.saveCoupon(ctx.actor, input),
    'coupons.delete': (ctx, input) => (promo.deleteCoupon(ctx.actor, input.id), null),
    'members.tiers': (ctx) => promo.tiers(ctx.actor),
    'members.search': (ctx, input) => promo.search(ctx.actor, input.phone),
    'members.list': (ctx, input) => promo.list(ctx.actor, input),
    'members.register': (ctx, input) => promo.register(ctx.actor, input),
    'members.adjustPoints': (ctx, input) => promo.adjustPoints(ctx.actor, input.id, input.delta, input.reason),
    'members.erase': (ctx, input) => (promo.erase(ctx.actor, input.id, input.reason), null),
    'members.pointsRules': () => promo.pointsRules(),
    'members.savePointsRules': (ctx, input) => promo.savePointsRules(ctx.actor, input),
    'pos.quote': (ctx, input) => sales.quote(ctx.actor, input),

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
    gate: (ch) => (READ_ONLY_BLOCKED_CHANNELS.has(ch) && license.isReadOnly() ? { code: 'LICENSE_READ_ONLY' } : null),
    audit,
    ...(opts.log ? { log: opts.log } : {}),
  })

  return { db, auth, audit, authService, setup, users, roles, sessions, dispatch, events, device, docs, settings, stock, catalog, inventory, shifts, sales, kds, stockOps, expenses, promo, reports, dashboard, backup, journal, license, lan, syncHost }
}

export type AppContext = ReturnType<typeof createAppContext>
