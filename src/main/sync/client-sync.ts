import type { HostConnection } from '@main/lan/host-connection'
import { AppError } from '@shared/errors'
import type { SyncResult, SyncSnapshot } from '@shared/sync'
import type { ClientStore, OutboxCounts } from './client-store'

const PULL_EVERY_MS = 60_000
const PUSH_EVERY_MS = 10_000
const BATCH = 50

export interface SyncState extends OutboxCounts {
  lastPullAt: number | null
  lastPushAt: number | null
}

/**
 * Keeps a Client ready to sell offline (D36): refreshes the snapshot and number blocks while the Host
 * is reachable, and sends queued offline bills back as soon as it is. Never throws from the timers.
 */
export class ClientSync {
  private lastPullAt: number | null = null
  private lastPushAt: number | null = null
  private pushing: Promise<void> | null = null
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(
    private readonly store: ClientStore,
    private readonly conn: HostConnection,
    private readonly onChange: (s: SyncState) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string, err: unknown) => void = () => {},
  ) {}

  state(): SyncState {
    return { ...this.store.counts(), lastPullAt: this.lastPullAt, lastPushAt: this.lastPushAt }
  }

  start(): void {
    void this.tick()
    this.timers.push(setInterval(() => void this.pull().catch(() => undefined), PULL_EVERY_MS))
    this.timers.push(
      setInterval(() => {
        if (this.store.counts().pending > 0) void this.push().catch(() => undefined)
      }, PUSH_EVERY_MS),
    )
    for (const t of this.timers) t.unref?.()
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** On (re)connect: send what was sold offline first, then refresh prices and numbers. */
  async tick(): Promise<void> {
    try {
      await this.push()
      await this.pull()
    } catch {
      // Host unreachable: try again on the next timer / reconnect
    }
  }

  async pull(): Promise<SyncSnapshot> {
    const snap = await this.conn.request<SyncSnapshot>('GET', '/sync/snapshot')
    this.store.saveSnapshot(snap)
    this.lastPullAt = this.now()
    this.onChange(this.state())
    return snap
  }

  /** Sends pending offline bills in batches. Concurrent calls share one run. */
  push(): Promise<void> {
    this.pushing ??= this.pushAll().finally(() => {
      this.pushing = null
    })
    return this.pushing
  }

  private async pushAll(): Promise<void> {
    for (;;) {
      const batch = this.store.pending(BATCH)
      if (batch.length === 0) break
      const ids = batch.map((b) => b.id)
      let results: SyncResult[]
      try {
        results = await this.conn.request<SyncResult[]>('POST', '/sync/bills', batch)
      } catch (err) {
        this.store.failAttempt(ids, err instanceof AppError ? err.code : String(err))
        this.onChange(this.state())
        throw err
      }
      this.store.record(results, ids)
      this.lastPushAt = this.now()
      this.onChange(this.state())
      const rejected = results.filter((r) => r.status === 'rejected')
      if (rejected.length) this.log('[sync] bills rejected by the Host', rejected)
      if (batch.length < BATCH) break
    }
  }
}
