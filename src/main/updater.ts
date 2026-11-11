import type { UpdateStatusDto } from '@shared/api-system'

/**
 * Auto-update (D42) over a plain HTTPS folder the vendor controls: electron-builder's output
 * (installer + latest.yml / latest-mac.yml / latest-linux.yml) is uploaded there, the shop's
 * "update.feed_url" setting points at it. Electron-free interface so the IPC layer can be tested.
 *
 * Platform notes: Windows NSIS and Linux AppImage update in place. macOS needs a signed app for
 * Squirrel.Mac — unsigned builds report "available" and the shop installs the .dmg by hand.
 */
export interface UpdaterPort {
  status(): UpdateStatusDto
  check(): Promise<UpdateStatusDto>
  install(): void
}

export interface UpdaterDeps {
  currentVersion: string
  feedUrl: () => string
  autoCheck: () => boolean
  onChange: (s: UpdateStatusDto) => void
  /** electron-updater's autoUpdater, or null where it cannot work (dev run, tar.gz build) */
  load: () => Promise<AutoUpdaterLike | null>
  /** auto-install not possible (unsigned macOS) → only report the new version */
  canInstall: boolean
  log?: (msg: string, err?: unknown) => void
}

/** The part of electron-updater's AppUpdater used here. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(opts: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, cb: (...args: never[]) => void): unknown
}

export function createUpdater(deps: UpdaterDeps): UpdaterPort {
  let s: UpdateStatusDto = {
    state: 'idle',
    configured: false,
    feedUrl: '',
    autoCheck: deps.autoCheck(),
    currentVersion: deps.currentVersion,
    version: null,
    releaseNotes: null,
    percent: null,
    checkedAt: null,
    error: null,
  }
  let au: AutoUpdaterLike | null | undefined
  let feed = ''
  const set = (patch: Partial<UpdateStatusDto>) => {
    s = { ...s, ...patch }
    deps.onChange(s)
  }
  const fresh = (): UpdateStatusDto => {
    const url = deps.feedUrl()
    return { ...s, feedUrl: url, configured: url !== '', autoCheck: deps.autoCheck(), ...(au === null ? { state: 'unsupported' as const } : {}) }
  }

  async function ensure(): Promise<AutoUpdaterLike | null> {
    if (au !== undefined) return au
    try {
      au = (await deps.load()) ?? null // undefined would leave the updater "idle" forever instead of "unsupported"
    } catch (err) {
      deps.log?.('[update] updater unavailable', err)
      au = null
    }
    if (!au) return null
    au.autoDownload = deps.canInstall
    au.autoInstallOnAppQuit = false // installing needs the shop's go-ahead (the POS may be mid-sale)
    au.on('checking-for-update', () => set({ state: 'checking', error: null }))
    au.on('update-not-available', () => set({ state: 'none', checkedAt: Date.now(), version: null, percent: null }))
    au.on('update-available', (info: { version: string; releaseNotes?: unknown }) =>
      set({ state: deps.canInstall ? 'downloading' : 'available', version: info.version, releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 4000) : null, checkedAt: Date.now(), percent: 0 }),
    )
    au.on('download-progress', (p: { percent: number }) => set({ state: 'downloading', percent: Math.round(p.percent) }))
    au.on('update-downloaded', (info: { version: string }) => set({ state: 'ready', version: info.version, percent: 100 }))
    au.on('error', (err: Error) => set({ state: 'error', error: String(err?.message ?? err).slice(0, 300), checkedAt: Date.now() }))
    return au
  }

  return {
    status: fresh,
    async check() {
      const url = deps.feedUrl()
      if (!url) return fresh()
      const u = await ensure()
      if (!u) return fresh()
      if (url !== feed) {
        u.setFeedURL({ provider: 'generic', url })
        feed = url
      }
      try {
        set({ state: 'checking', error: null })
        await u.checkForUpdates()
      } catch (err) {
        set({ state: 'error', error: String(err instanceof Error ? err.message : err).slice(0, 300), checkedAt: Date.now() })
      }
      return fresh()
    },
    install() {
      if (s.state === 'ready' && au) au.quitAndInstall(false, true)
    },
  }
}

/** Tests / Client builds: never updates. */
export const noUpdater = (currentVersion: string): UpdaterPort => ({
  status: () => ({ state: 'unsupported', configured: false, feedUrl: '', autoCheck: false, currentVersion, version: null, releaseNotes: null, percent: null, checkedAt: null, error: null }),
  check: async () => noUpdater(currentVersion).status(),
  install: () => {},
})
