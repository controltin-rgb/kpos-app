import { join } from 'node:path'
import { app, BrowserWindow, dialog, screen, shell } from 'electron'
import { createAppContext, type AppContext } from '@main/app-context'
import { loadOrCreateSecret } from '@main/auth/secret'
import type { Db } from '@main/db/connection'
import { initDatabase, resolveDbPaths } from '@main/db'
import { MigrationError } from '@main/db/migrate'
import { thMain } from '@main/i18n/th'
import { registerIpc } from '@main/ipc'
import { loadOrCreateDevice } from '@main/local-device'
import { printHtml } from '@main/print/electron-printer'
import { EVENT_CHANNEL } from '@shared/api'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

// Dev/testing only: run against a separate data folder (DB, backups, secrets).
if (!app.isPackaged && process.env['KPOSS_USER_DATA']) app.setPath('userData', process.env['KPOSS_USER_DATA'])

let db: Db | null = null

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

/** Opens (or focuses) the KDS / CFD window. KDS shares the caller's session; CFD needs none. */
function openSecondaryWindow(ctx: AppContext, kind: 'kds' | 'cfd', senderId: number): void {
  const existing = extraWindows.get(kind)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  // the customer display goes full screen on a second monitor when there is one
  const displays = screen.getAllDisplays()
  const external = displays.find((d) => d.id !== screen.getPrimaryDisplay().id)
  const win = kind === 'cfd' && external ? createMainWindow('#/cfd', external.bounds, true) : createMainWindow(`#/${kind}`)
  const token = ctx.sessions.get(senderId)
  if (kind === 'kds' && token) ctx.sessions.set(win.webContents.id, token)
  extraWindows.set(kind, win)
  win.on('closed', () => extraWindows.delete(kind))
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

app.whenReady().then(() => {
  const paths = resolveDbPaths({
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })
  try {
    const result = initDatabase(paths)
    db = result.db
    const m = result.migration
    if (m.applied.length) console.info(`[db] migrated v${m.from} → v${m.to}`, m.backupPath ?? '')
  } catch (err) {
    showDbErrorAndQuit(err, paths.dbPath)
    return
  }

  const ctx: AppContext = createAppContext({
    db,
    device: loadOrCreateDevice(join(app.getPath('userData'), 'device.json')),
    printHtml,
    openWindow: (kind, senderId) => openSecondaryWindow(ctx, kind, senderId),
    authSecret: loadOrCreateSecret(join(app.getPath('userData'), 'secrets', 'auth.key')),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
    },
  })
  registerIpc(ctx, isTrustedUrl)
  // push AppEvents (KDS updates, customer display, shift changes) to every window
  ctx.events.on('event', (e) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, e)
  })
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  db?.close()
  db = null
})
