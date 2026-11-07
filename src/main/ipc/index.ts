import { ipcMain, type WebContents } from 'electron'
import type { AppContext } from '@main/app-context'
import type { Sessions } from './router'
import { RPC_CHANNEL } from '@shared/api'

/**
 * Binds the router to Electron IPC. Only frames whose URL belongs to the app may call in,
 * and a window's session is dropped when the window goes away.
 */
export function registerIpc(ctx: { dispatch: AppContext['dispatch']; sessions: Sessions }, isTrustedUrl: (url: string) => boolean): void {
  const tracked = new WeakSet<WebContents>()

  ipcMain.handle(RPC_CHANNEL, async (event, payload: unknown) => {
    const frameUrl = event.senderFrame?.url ?? ''
    if (!isTrustedUrl(frameUrl)) return { ok: false, error: { code: 'FORBIDDEN' } }

    const sender = event.sender
    if (!tracked.has(sender)) {
      tracked.add(sender)
      const id = sender.id
      sender.once('destroyed', () => ctx.sessions.delete(id))
    }

    const { channel, input } = (payload ?? {}) as { channel?: unknown; input?: unknown }
    if (typeof channel !== 'string') return { ok: false, error: { code: 'INVALID_INPUT' } }
    return ctx.dispatch(sender.id, channel, input)
  })
}
