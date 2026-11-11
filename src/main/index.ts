import { appendFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, screen, shell } from 'electron'
import { createAppContext, type AppContext } from '@main/app-context'
import { loadOrCreateSecret } from '@main/auth/secret'
import type { Db } from '@main/db/connection'
import { initDatabase, resolveDbPaths } from '@main/db'
import { migrate, MigrationError } from '@main/db/migrate'
import { openDatabase } from '@main/db/connection'
import { ClientStore } from '@main/sync/client-store'
import { thMain } from '@main/i18n/th'
import { registerIpc } from '@main/ipc'
import { loadOrCreateDevice, saveDeviceRole } from '@main/local-device'
import { createClientContext, type ClientContext } from '@main/lan/client-context'
import { HostConnection, type HostConfig } from '@main/lan/host-connection'
import { clearHostConfig, loadHostConfig, saveHostConfig, type SecretBox } from '@main/lan/host-store'
import type { LocalDevice } from '@main/services/device.service'
import { printHtml } from '@main/print/electron-printer'
import { applyPendingRestore, type PendingRestoreResult } from '@main/backup/backup.service'
import { machineFingerprint } from '@main/license/hardware-id'
import { EVENT_CHANNEL } from '@shared/api'
import { JOURNAL_SHIP_INTERVAL_MS } from '@shared/api-system'
import type { JournalService } from '@main/backup/journal'
import { preUpdateBackup, recordAppVersion } from '@main/backup/pre-update'
import { applyPendingReset, finishReset } from '@main/backup/reset'
import { FileSecretStore } from '@main/secrets'
import { createUpdater, type AutoUpdaterLike, type UpdaterPort } from '@main/updater'
import { CLOUD_SYNC_INTERVAL_MIN } from '@shared/api-system'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

/**
 * electron-updater is CommonJS and exposes `autoUpdater` through a lazy getter that an ESM `import()` does not
 * surface (the namespace had no autoUpdater, so update checks silently did nothing in 0.1.0). Load it with require.
 * In-place update works for the NSIS installer and AppImage; not in dev, not for tar.gz.
 */
function loadAutoUpdater(): AutoUpdaterLike | null {
  if (!app.isPackaged || (process.platform === 'linux' && !process.env['APPIMAGE'])) return null
  const mod = createRequire(import.meta.url)('electron-updater') as { autoUpdater?: AutoUpdaterLike }
  return mod.autoUpdater ?? null
}

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

// Dev/testing only: run against a separate data folder (DB, backups, secrets).
// Never share the installed app's data folder: `pnpm dev` defaults to %APPDATA%\KPOSS-dev, so test data
// never shows up in an installed KPOSS (which uses %APPDATA%\KPOSS).
if (!app.isPackaged) app.setPath('userData', process.env['KPOSS_USER_DATA'] || join(app.getPath('appData'), 'KPOSS-dev'))

/**
 * One running copy per data folder (D39): two copies on the same database would both write it and
 * both ship the change journal. A copy started by relaunch() waits for the old one to exit.
 */
const RELAUNCHED = process.argv.includes('--kposs-relaunched')
const gotInstanceLock = app.requestSingleInstanceLock()

/**
 * --smoke-test=<file>: start normally, append one JSON line about the start to <file>, then quit
 * (CI / installer checks). With --smoke-relaunch the first run relaunches itself instead of quitting.
 */
const SMOKE_FILE = process.argv.find((a) => a.startsWith('--smoke-test='))?.slice('--smoke-test='.length) ?? null

let db: Db | null = null
let journal: JournalService | null = null

/** Only our own pages may call the main process. */
function isTrustedUrl(url: string): boolean {
  if (isDev) return url.startsWith(process.env['ELECTRON_RENDERER_URL']!)
  return url.startsWith('file://') && url.includes('/renderer/index.html')
}

/** Main window, or a KDS / CFD window when `route` is given ('#/kds', '#/cfd'). */
function createMainWindow(route = '', bounds?: Electron.Rectangle, fullscreen = false): BrowserWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? 1366,
    height: bounds?.height ?? 860,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    fullscreen,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#F7F5F2',
    title: route === '#/cfd' ? 'KPOSS · จอลูกค้า' : route === '#/kds' ? 'KPOSS · จอบาร์' : 'KPOSS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Open external links in the OS browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']! + route)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), route ? { hash: route.slice(1) } : undefined)
  }
  return win
}

const extraWindows = new Map<'kds' | 'cfd', BrowserWindow>()

/** Opens (or focuses) the KDS / CFD window. KDS shares the caller's session (shareSession); CFD needs none. */
function openSecondaryWindow(kind: 'kds' | 'cfd', senderId: number, shareSession: (child: number, parent: number) => void): void {
  const existing = extraWindows.get(kind)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  // the customer display goes full screen on a second monitor when there is one
  const displays = screen.getAllDisplays()
  const external = displays.find((d) => d.id !== screen.getPrimaryDisplay().id)
  const win = kind === 'cfd' && external ? createMainWindow('#/cfd', external.bounds, true) : createMainWindow(`#/${kind}`)
  if (kind === 'kds') shareSession(win.webContents.id, senderId)
  extraWindows.set(kind, win)
  win.on('closed', () => extraWindows.delete(kind))
}

const relaunch = () => {
  const args = process.argv.slice(1).filter((a) => a !== '--kposs-relaunched' && a !== '--smoke-relaunch')
  app.relaunch({ args: [...args, '--kposs-relaunched'] })
  app.quit()
}

async function acquireInstanceLock(): Promise<boolean> {
  if (gotInstanceLock) return true
  if (!RELAUNCHED) return false
  // the copy that relaunched us is still shutting down (closing the DB, shipping the journal)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (app.requestSingleInstanceLock()) return true
  }
  return false
}

/** --smoke-test: report once the window has rendered, then quit (or relaunch once). */
function smokeReport(win: BrowserWindow, info: Record<string, unknown>): void {
  if (!SMOKE_FILE) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript('document.getElementById("root")?.childElementCount ?? 0')
        .catch(() => 0)
        .then((rendered: number) => {
          appendFileSync(SMOKE_FILE, JSON.stringify({ pid: process.pid, version: app.getVersion(), relaunched: RELAUNCHED, rendered: rendered > 0, ...info }) + '\n')
          if (process.argv.includes('--smoke-relaunch')) relaunch()
          else app.quit()
        })
    }, 1500)
  })
}

/** OS-backed encryption for the Client's device token (DPAPI on Windows, Keychain on macOS). */
const secretBox = async (): Promise<SecretBox | null> =>
  (await safeStorage.isAsyncEncryptionAvailable())
    ? { encrypt: (s) => safeStorage.encryptStringAsync(s), decrypt: async (b) => (await safeStorage.decryptStringAsync(b)).result }
    : null

/** Native helpers shared by the Host/Standalone and Client contexts — they act on THIS machine. */
const native = {
  printHtml,
  saveFile: async (defaultName: string, content: string) => {
    const r = await dialog.showSaveDialog({ defaultPath: join(app.getPath('documents'), defaultName) })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, content, 'utf8')
    return r.filePath
  },
  pickFile: async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Receipt', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  pickLicenseFile: async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'KPOSS License', extensions: ['LIC', 'lic'] }] })
    const file = r.canceled ? null : r.filePaths[0]
    if (!file) return null
    // a .LIC is a few hundred bytes; refuse anything large before reading it
    if ((await stat(file)).size > 16_000) return ''
    return readFile(file, 'utf8')
  },
}

const versions = () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, platform: process.platform })

/** Push AppEvents (KDS updates, customer display, shift changes, LAN state) to every window. */
function forwardEvents(events: NodeJS.EventEmitter) {
  events.on('event', (e) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, e)
  })
}

/** Client mode (D33): no database on this machine — everything goes to the paired Host. */
function startClient(device: LocalDevice, cfg: HostConfig, deviceFile: string) {
  const userData = app.getPath('userData')
  // the Client's own small DB: offline snapshot, reserved bill numbers, bills waiting for the Host (D36)
  const storePath = join(userData, 'data', 'client.sqlite')
  let store: ClientStore | undefined
  try {
    const local = openDatabase(storePath)
    migrate(local, {
      dbPath: storePath,
      migrationsDir: app.isPackaged ? join(process.resourcesPath, 'migrations-client') : join(app.getAppPath(), 'migrations-client'),
      backupDir: join(userData, 'backup'),
    })
    db = local
    store = new ClientStore(local)
  } catch (err) {
    console.error('[sync] offline store unavailable — online only:', err)
  }
  let feed = { url: '', autoCheck: false }
  const updater = createUpdater({
    currentVersion: app.getVersion(),
    feedUrl: () => feed.url,
    autoCheck: () => feed.autoCheck,
    onChange: (status) => ctx.events.emit('event', { type: 'update.state', status }),
    load: async () => loadAutoUpdater(),
    canInstall: process.platform !== 'darwin',
    log: (m, e) => console.error(m, e),
  })
  const ctx: ClientContext = createClientContext({
    conn: new HostConnection(cfg),
    device,
    updater,
    setUpdateFeed: (url, autoCheck) => {
      const first = !feed.url && !!url
      feed = { url, autoCheck }
      if (first && autoCheck) void updater.check()
    },
    ...(store ? { store } : {}),
    versions: versions(),
    ...native,
    openWindow: (kind, senderId) => openSecondaryWindow(kind, senderId, ctx.aliasWindow),
    unpair: () => {
      clearHostConfig(userData)
      saveDeviceRole(deviceFile, 'standalone')
      relaunch()
    },
    log: (m, e) => console.error(m, e),
  })
  registerIpc(ctx, isTrustedUrl)
  forwardEvents(ctx.events)
  smokeReport(createMainWindow(), { role: 'client' })
}

function showDbErrorAndQuit(err: unknown, dbPath: string): void {
  const t = thMain.dbError
  const lines: string[] = []
  if (err instanceof MigrationError) {
    lines.push(t.codes[err.code])
    if (err.backupPath) lines.push('', t.backupAt(err.backupPath))
  } else {
    lines.push(t.unknown)
  }
  lines.push('', t.dbAt(dbPath), '', t.contact)
  console.error('[db] startup failed:', err)
  dialog.showErrorBox(t.title, lines.join('\n'))
  app.exit(1)
}

app.on('second-instance', () => {
  // someone opened the app again: bring the running copy to the front instead
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  if (!(await acquireInstanceLock())) {
    app.quit()
    return
  }
  const userData = app.getPath('userData')
  const deviceFile = join(userData, 'device.json')
  const device = loadOrCreateDevice(deviceFile)

  if (device.role === 'client') {
    const cfg = await loadHostConfig(userData, await secretBox())
    if (cfg) {
      startClient(device, cfg, deviceFile)
      return
    }
    // pairing data missing or unreadable: start over as a fresh install
    console.error('[lan] host config missing — back to standalone')
    device.role = 'standalone'
    saveDeviceRole(deviceFile, 'standalone')
  }

  const paths = resolveDbPaths({ userData, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  // a restore staged from the Backup page is swapped in before the DB is opened
  let restore: PendingRestoreResult | null = null
  try {
    restore = applyPendingRestore(paths.dbPath)
    if (restore) console.info('[backup] staged restore:', restore.status)
  } catch (err) {
    console.error('[backup] applying staged restore failed:', err)
  }
  // "Reset database" (Super Admin): the old file is removed before anything opens it
  try {
    if (applyPendingReset(paths.dbPath)) console.info('[system] database reset applied')
  } catch (err) {
    console.error('[system] database reset failed:', err)
  }
  // D39: the first start of a new version copies the database before migrations or new code touch it
  let preUpdate: string | null = null
  try {
    preUpdate = preUpdateBackup(paths.dbPath, paths.backupDir, app.getVersion())
    if (preUpdate) console.info('[backup] pre-update copy:', preUpdate)
  } catch (err) {
    console.error('[backup] pre-update copy failed:', err)
  }
  let preMigrateBackup: string | null
  try {
    const result = initDatabase(paths)
    db = result.db
    const m = result.migration
    if (m.applied.length) console.info(`[db] migrated v${m.from} → v${m.to}`, m.backupPath ?? '')
    preMigrateBackup = m.backupPath
  } catch (err) {
    showDbErrorAndQuit(err, paths.dbPath)
    return
  }

  // D42: auto-update — its events reach the windows through the same event bus as the context
  const updateEvents = new EventEmitter()
  let settingsForUpdate: AppContext['settings'] | null = null
  const updater: UpdaterPort = createUpdater({
    currentVersion: app.getVersion(),
    feedUrl: () => settingsForUpdate?.get('update.feed_url') ?? '',
    autoCheck: () => settingsForUpdate?.get('update.auto_check') ?? false,
    onChange: (status) => updateEvents.emit('event', { type: 'update.state', status }),
    load: async () => loadAutoUpdater(),
    canInstall: process.platform !== 'darwin', // Squirrel.Mac needs a signed app (code signing not done yet)
    log: (m, e) => console.error(m, e),
  })

  const ctx: AppContext = createAppContext({
    db,
    device,
    secrets: new FileSecretStore(join(userData, 'secrets'), secretBox),
    updater,
    ...native,
    receiptsDir: join(userData, 'receipts'),
    openWindow: (kind, senderId) =>
      openSecondaryWindow(kind, senderId, (child, parent) => {
        const token = ctx.sessions.get(parent)
        if (token) ctx.sessions.set(child, token)
      }),
    backupPaths: { dbPath: paths.dbPath, backupDir: paths.backupDir },
    journal: { dir: join(paths.backupDir, 'journal'), restored: restore?.status === 'applied' },
    pickFolder: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    hardwareId: machineFingerprint(),
    relaunch,
    lan: {
      certDir: join(userData, 'secrets'),
      saveRole: (role) => saveDeviceRole(deviceFile, role),
      becomeClient: (cfg, deviceName) =>
        void (async () => {
          await saveHostConfig(userData, cfg, await secretBox())
          saveDeviceRole(deviceFile, 'client', deviceName)
          relaunch()
        })(),
      log: (m, e) => console.error(m, e),
    },
    authSecret: loadOrCreateSecret(join(userData, 'secrets', 'auth.key')),
    versions: versions(),
  })
  registerIpc(ctx, isTrustedUrl)
  try {
    if (preUpdate) ctx.backup.registerExisting(preUpdate, 'pre_update')
    if (preMigrateBackup) ctx.backup.registerExisting(preMigrateBackup, 'pre_migrate')
    recordAppVersion(paths.dbPath, app.getVersion())
    ctx.backup.completeRestore(restore)
    if (finishReset(db, paths.dbPath, ctx.audit, Date.now())) ctx.license.invalidate()
  } catch (err) {
    console.error('[backup] startup bookkeeping failed:', err)
  }
  settingsForUpdate = ctx.settings
  forwardEvents(updateEvents)
  const autoUpdateOn = () => ctx.settings.get('update.auto_check') && ctx.license.status().features.autoUpdate
  if (autoUpdateOn()) setTimeout(() => void updater.check(), 20_000)
  setInterval(() => autoUpdateOn() && void updater.check(), 6 * 3_600_000).unref()
  // D43: encrypted cloud copy every few minutes (only when switched on, licensed and configured)
  const cloudTick = () => void ctx.cloudSync(false).catch((err: unknown) => console.error('[cloud] sync failed:', err instanceof Error ? err.message : err))
  setInterval(cloudTick, CLOUD_SYNC_INTERVAL_MIN * 60_000).unref()
  // D25: daily snapshot — checked every minute; a snapshot missed while the app was closed runs soon after start
  const backupTick = () =>
    void ctx.backup
      .runDueSnapshot()
      .then(async (snap) => {
        await ctx.backup.ensureJournalBase()
        if (snap) cloudTick() // a new snapshot goes to the cloud right away
      })
  setTimeout(backupTick, 30_000)
  setInterval(backupTick, 60_000).unref()
  // D38: captured changes go to the journal files (and off-site) every 10 s
  if (ctx.journal) {
    journal = ctx.journal
    setInterval(() => ctx.journal?.ship(), JOURNAL_SHIP_INTERVAL_MS).unref()
  }
  // Host: open the LAN API for paired Clients (D33)
  void ctx.lan.startIfHost()
  forwardEvents(ctx.events)
  smokeReport(createMainWindow(), { role: device.role, schema: db.pragma('user_version', { simple: true }), journal: !!ctx.journal?.isStarted, preUpdate: !!preUpdate })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // (the Host LAN server dies with the process) — the last captured changes go to the journal files
  journal?.ship()
  journal = null
  db?.close()
  db = null
})
