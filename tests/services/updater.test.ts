import { describe, expect, it } from 'vitest'
import { createUpdater, type AutoUpdaterLike } from '@main/updater'

function fakeAutoUpdater(version: string | null) {
  const handlers = new Map<string, (...args: never[]) => void>()
  const fake: AutoUpdaterLike & { feed: string | null } = {
    feed: null,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL: (o) => void (fake.feed = o.url),
    on: (event, cb) => handlers.set(event, cb),
    quitAndInstall: () => {},
    checkForUpdates: async () => {
      const emit = (e: string, ...a: unknown[]) => (handlers.get(e) as ((...x: unknown[]) => void) | undefined)?.(...a)
      emit('checking-for-update')
      if (!version) return emit('update-not-available')
      emit('update-available', { version })
      emit('download-progress', { percent: 50 })
      emit('update-downloaded', { version })
    },
  }
  return fake
}

const base = { currentVersion: '0.1.0', feedUrl: () => 'https://example.test/kposs', autoCheck: () => true, onChange: () => {}, canInstall: true }

describe('auto-update (D42)', () => {
  it('a missing autoUpdater shows "unsupported" instead of staying idle (0.1.0 bug)', async () => {
    const u = createUpdater({ ...base, load: async () => undefined as unknown as null })
    expect((await u.check()).state).toBe('unsupported')
  })

  it('finds, downloads and offers the new version from the feed URL', async () => {
    const fake = fakeAutoUpdater('0.2.0')
    const u = createUpdater({ ...base, load: async () => fake })
    const s = await u.check()
    expect(fake.feed).toBe('https://example.test/kposs')
    expect(fake.autoInstallOnAppQuit).toBe(false)
    expect(s).toMatchObject({ state: 'ready', version: '0.2.0', percent: 100, configured: true })
  })

  it('reports "none" when already up to date and does nothing without a URL', async () => {
    expect((await createUpdater({ ...base, load: async () => fakeAutoUpdater(null) }).check()).state).toBe('none')
    expect((await createUpdater({ ...base, feedUrl: () => '', load: async () => fakeAutoUpdater('0.2.0') }).check())).toMatchObject({ state: 'idle', configured: false })
  })
})
