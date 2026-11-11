import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { Db } from '@main/db/connection'
import type { AuditService } from '@main/services/audit.service'
import { JOURNAL_KEEP_DAYS } from '@shared/api-system'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'

/**
 * Change journal (D38) — the app's own "WAL streaming": TEMP triggers on every table write each row
 * change into `change_journal`; `ship()` (every 10 s) appends them to segment files in the local
 * journal folder and the off-site folder, then deletes them from the DB. A point-in-time restore
 * replays a timeline's segments on top of a snapshot of the same timeline.
 *
 * TEMP triggers live only in this connection: backups (db.backup) and restored copies never carry
 * them, and nothing has to be removed from the schema to turn journaling off.
 */

export type JournalReason = 'first' | 'restore' | 'migrate' | 'diverged' | 'missing'

export interface TimelineFile {
  id: string
  createdAt: number
  schemaVersion: number
  reason: JournalReason
  /** first seq written in this timeline */
  firstSeq: number
  /** timeline that was live before this one */
  parent: string | null
}

/** One journal line: [seq, at, table, op, key JSON, row JSON]. JSON stays text so 64-bit integers survive. */
export type JournalEntry = [number, number, string, 'i' | 'u' | 'd', string | null, string | null]

export interface JournalStatus {
  timeline: string
  pendingRows: number
  lastShippedAt: number | null
  offsite: 'off' | 'ok' | 'error'
  error: string | null
  bytes: number
}

/** Tables the journal never records (its own bookkeeping). */
const SKIP = new Set(['change_journal', 'journal_state'])
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024
const HOUR = 3_600_000
const ICT = 7 * HOUR

const q = (name: string) => `"${name.replace(/"/g, '""')}"`
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const path$ = (col: string) => lit(`$."${col.replace(/"/g, '\\"')}"`)
const segName = (timeline: string, firstSeq: number) => `seg-${timeline}-${String(firstSeq).padStart(12, '0')}.jsonl`
const SEG_RE = /^seg-(.+)-(\d{12})\.jsonl$/
const TL_RE = /^timeline-(.+)\.json$/

interface TableShape {
  name: string
  cols: string[]
  /** primary key columns; empty = rowid table without a declared key (keyed by rowid) */
  pk: string[]
}

/** Columns and primary key of every user table (journal bookkeeping excluded). */
export function tableShapes(db: Database.Database): TableShape[] {
  const names = db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[]
  return names
    .filter((n) => !SKIP.has(n))
    .map((name) => {
      const info = db.pragma(`table_info(${q(name)})`) as { name: string; pk: number }[]
      return {
        name,
        cols: info.map((c) => c.name),
        pk: info
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name),
      }
    })
}

function keyExpr(t: TableShape, row: 'OLD' | 'NEW'): string {
  if (t.pk.length === 0) return `json_object('rowid', ${row}.rowid)`
  return `json_object(${t.pk.map((c) => `${lit(c)}, ${row}.${q(c)}`).join(', ')})`
}

function rowExpr(t: TableShape): string {
  const cols = t.cols.map((c) => `${lit(c)}, NEW.${q(c)}`)
  if (t.pk.length === 0) cols.unshift(`'rowid', NEW.rowid`)
  return `json_object(${cols.join(', ')})`
}

function triggerSql(t: TableShape): string[] {
  const base = (n: string) => q(`kposs_j_${t.name}_${n}`)
  const ins = (op: string, k: string, d: string) => `INSERT INTO change_journal (at, tbl, op, k, d) VALUES (kposs_journal_at(), ${lit(t.name)}, '${op}', ${k}, ${d});`
  return [
    `CREATE TEMP TRIGGER ${base('i')} AFTER INSERT ON main.${q(t.name)} BEGIN ${ins('i', 'NULL', rowExpr(t))} END`,
    `CREATE TEMP TRIGGER ${base('u')} AFTER UPDATE ON main.${q(t.name)} BEGIN ${ins('u', keyExpr(t, 'OLD'), rowExpr(t))} END`,
    `CREATE TEMP TRIGGER ${base('d')} AFTER DELETE ON main.${q(t.name)} BEGIN ${ins('d', keyExpr(t, 'OLD'), 'NULL')} END`,
  ]
}

/** Last seq handed out in change_journal of this file (0 = none yet). */
export function journalSeq(db: Database.Database): number {
  try {
    return (db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'change_journal'`).pluck().get() as number | undefined) ?? 0
  } catch {
    return 0 // no AUTOINCREMENT row written yet → sqlite_sequence may not exist
  }
}

/** journal_state.timeline + seq inside a database file (null for files older than migration 0008). */
export function journalPosition(db: Database.Database): { timeline: string; seq: number } | null {
  try {
    const t = db.prepare('SELECT timeline FROM journal_state WHERE singleton = 1').pluck().get() as string | undefined
    return t ? { timeline: t, seq: journalSeq(db) } : null
  } catch {
    return null
  }
}

function fsyncAppend(file: string, text: string): void {
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const sizeOf = (p: string) => {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}

const rmQuiet = (p: string) => {
  try {
    rmSync(p, { force: true })
  } catch {
    // locked by a scan — retried at the next prune
  }
}

/**
 * Reads the entries of one segment. A torn last line (crash mid-append: no newline after it) is
 * ignored — its rows were still in the DB and were shipped again into a new segment. Damage
 * anywhere else throws.
 */
export function readSegment(file: string): JournalEntry[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out: JournalEntry[] = []
  lines.forEach((line, i) => {
    if (!line) return
    try {
      out.push(JSON.parse(line) as JournalEntry)
    } catch {
      if (i !== lines.length - 1) throw new AppError('JOURNAL_CORRUPT', { file: file.split(/[\\/]/).pop() })
    }
  })
  return out
}

export interface JournalOptions {
  /** local journal folder (userData/backup/journal) */
  dir: string
  now: () => number
  /** off-site folder root when the off-site copy is on (Backup settings), else null */
  offsiteRoot?: () => string | null
}

export class JournalService {
  private timelineId = ''
  private current: { name: string; hour: number; size: number } | null = null
  /** newest seq already in a segment file of this timeline */
  private shippedSeq = 0
  private lastShippedAt: number | null = null
  private offsiteState: 'off' | 'ok' | 'error' = 'off'
  private offsiteSynced: string | null = null // off-site folder that is known to match the local one
  private lastError: string | null = null
  private started = false
  private atCache: number | null = null

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly opts: JournalOptions,
  ) {}

  get dir(): string {
    return this.opts.dir
  }

  get timeline(): string {
    return this.timelineId
  }

  get isStarted(): boolean {
    return this.started
  }

  // ---------------------------------------------------------------------------
  // start: pick / open the timeline, install the triggers
  // ---------------------------------------------------------------------------

  /**
   * Called once, right after the DB is opened and migrated and before anything else writes.
   * `restored`: a staged restore was just swapped in (a new timeline must start).
   */
  start(opts: { restored?: boolean } = {}): { timeline: string; reason: JournalReason | null } {
    mkdirSync(this.opts.dir, { recursive: true })
    const schema = this.db.pragma('user_version', { simple: true }) as number
    const state = this.db.prepare('SELECT timeline, schema_version AS schemaVersion FROM journal_state WHERE singleton = 1').get() as { timeline: string; schemaVersion: number } | undefined
    let reason: JournalReason | null = null
    if (!state) reason = 'first'
    else if (opts.restored) reason = 'restore'
    else if (state.schemaVersion !== schema) reason = 'migrate'
    else if (!existsSync(join(this.opts.dir, `timeline-${state.timeline}.json`))) reason = 'missing'
    else if (this.lastSegmentSeq(state.timeline) > journalSeq(this.db)) reason = 'diverged' // the file went back in time

    if (reason) {
      const id = uuidv7(this.opts.now())
      const tl: TimelineFile = { id, createdAt: this.opts.now(), schemaVersion: schema, reason, firstSeq: journalSeq(this.db) + 1, parent: state?.timeline ?? null }
      writeFileSync(join(this.opts.dir, `timeline-${id}.json`), JSON.stringify(tl, null, 2))
      this.db
        .transaction(() => {
          this.db.prepare('DELETE FROM change_journal').run() // leftovers of the previous timeline
          this.db
            .prepare(
              `INSERT INTO journal_state (singleton, timeline, schema_version, started_at, reason) VALUES (1, @id, @schema, @at, @reason)
               ON CONFLICT (singleton) DO UPDATE SET timeline = excluded.timeline, schema_version = excluded.schema_version, started_at = excluded.started_at, reason = excluded.reason`,
            )
            .run({ id, schema, at: tl.createdAt, reason })
          this.audit.append({ action: 'backup.journal_start', permission: 'backup:create', entity: 'journal', entityId: id, before: state ? { timeline: state.timeline } : null, after: { timeline: id, reason, schemaVersion: schema }, risk: 'low' })
        })
        .immediate()
      this.timelineId = id
    } else this.timelineId = state!.timeline

    this.shippedSeq = reason ? 0 : this.lastSegmentSeq(this.timelineId)
    this.install()
    this.started = true
    return { timeline: this.timelineId, reason }
  }

  private install(): void {
    // every row written in one synchronous run (= one transaction, CLAUDE.md rule 2) gets the same time,
    // so a restore point never cuts a transaction in half
    this.db.function('kposs_journal_at', { deterministic: false }, () => {
      if (this.atCache === null) {
        this.atCache = this.opts.now()
        queueMicrotask(() => {
          this.atCache = null
        })
      }
      return this.atCache
    })
    for (const name of this.db.prepare(`SELECT name FROM sqlite_temp_schema WHERE type = 'trigger' AND name LIKE 'kposs_j_%'`).pluck().all() as string[]) this.db.exec(`DROP TRIGGER temp.${q(name)}`)
    for (const t of tableShapes(this.db)) for (const sql of triggerSql(t)) this.db.exec(sql)
  }

  // ---------------------------------------------------------------------------
  // files
  // ---------------------------------------------------------------------------

  timelines(dir: string = this.opts.dir): TimelineFile[] {
    if (!existsSync(dir)) return []
    const out: TimelineFile[] = []
    for (const n of readdirSync(dir)) {
      if (!TL_RE.test(n)) continue
      try {
        out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as TimelineFile)
      } catch {
        // unreadable timeline file: its segments cannot be used
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Segment files of a timeline, oldest first. */
  segments(timeline: string, dir: string = this.opts.dir): { name: string; firstSeq: number }[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .map((name) => {
        const m = SEG_RE.exec(name)
        return m && m[1] === timeline ? { name, firstSeq: Number(m[2]) } : null
      })
      .filter((x): x is { name: string; firstSeq: number } => x !== null)
      .sort((a, b) => a.firstSeq - b.firstSeq)
  }

  private lastSegmentSeq(timeline: string): number {
    const segs = this.segments(timeline)
    for (let i = segs.length - 1; i >= 0; i--) {
      const e = readSegment(join(this.opts.dir, segs[i]!.name))
      if (e.length) return e[e.length - 1]![0]
    }
    return 0
  }

  private offsiteDir(): string | null {
    const d = this.opts.offsiteRoot?.() ?? null
    return d ? join(d, 'journal') : null
  }

  // ---------------------------------------------------------------------------
  // ship: DB → segment files (every 10 s, and before a restore / at quit)
  // ---------------------------------------------------------------------------

  /** Moves captured rows to the current segment file and mirrors them off-site. Never throws. */
  ship(): { shipped: number } {
    if (!this.started) return { shipped: 0 }
    let shipped = 0
    let appended: { name: string; text: string; before: number } | null = null
    try {
      const all = this.db.prepare('SELECT seq, at, tbl, op, k, d FROM change_journal ORDER BY seq').raw().all() as JournalEntry[]
      // rows already written before a crash (append done, delete not) are only deleted
      const rows = all.filter((r) => r[0] > this.shippedSeq)
      if (rows.length) {
        const seg = this.segmentFor(rows[0]![0], rows[0]![1])
        const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
        const file = join(this.opts.dir, seg.name)
        const before = Math.max(0, sizeOf(file))
        fsyncAppend(file, text)
        seg.size = before + Buffer.byteLength(text)
        appended = { name: seg.name, text, before }
        this.shippedSeq = rows[rows.length - 1]![0]
        shipped = rows.length
        this.lastShippedAt = this.opts.now()
      }
      if (all.length) this.db.prepare('DELETE FROM change_journal WHERE seq <= ?').run(all[all.length - 1]![0])
      this.lastError = null
    } catch (err) {
      this.lastError = String(err instanceof Error ? err.message : err).slice(0, 200)
    }
    this.mirror(appended)
    return { shipped }
  }

  /**
   * The segment to append to: a new file each Bangkok hour, past 8 MB, after every start, and when the
   * file is not the size we left it (so a torn line is never followed by more lines in the same file).
   */
  private segmentFor(firstSeq: number, at: number): { name: string; hour: number; size: number } {
    const hour = Math.floor((at + ICT) / HOUR)
    // a failed / partial append (disk full, cut power) leaves the file at another size: never write after it
    const moved = this.current !== null && sizeOf(join(this.opts.dir, this.current.name)) !== this.current.size
    if (!this.current || moved || this.current.hour !== hour || this.current.size >= SEGMENT_MAX_BYTES) this.current = { name: segName(this.timelineId, firstSeq), hour, size: 0 }
    return this.current
  }

  /** Keeps the off-site journal folder equal to the local one (append when in step, copy to catch up). */
  private mirror(appended: { name: string; text: string; before: number } | null): void {
    const dir = this.offsiteDir()
    if (!dir) {
      this.offsiteState = 'off'
      this.offsiteSynced = null
      return
    }
    try {
      mkdirSync(dir, { recursive: true })
      if (this.offsiteSynced !== dir) {
        for (const n of readdirSync(this.opts.dir)) {
          const src = join(this.opts.dir, n)
          if (sizeOf(join(dir, n)) !== sizeOf(src)) copyFileSync(src, join(dir, n))
        }
        this.offsiteSynced = dir
      } else if (appended) {
        const dest = join(dir, appended.name)
        if (sizeOf(dest) === appended.before || (appended.before === 0 && sizeOf(dest) === -1)) fsyncAppend(dest, appended.text)
        else copyFileSync(join(this.opts.dir, appended.name), dest)
      }
      this.offsiteState = 'ok'
    } catch (err) {
      this.offsiteState = 'error'
      this.offsiteSynced = null
      this.lastError = String(err instanceof Error ? err.message : err).slice(0, 200)
    }
  }

  status(): JournalStatus {
    let bytes = 0
    if (existsSync(this.opts.dir)) for (const n of readdirSync(this.opts.dir)) bytes += Math.max(0, sizeOf(join(this.opts.dir, n)))
    return {
      timeline: this.timelineId,
      pendingRows: this.started ? (this.db.prepare('SELECT count(*) FROM change_journal').pluck().get() as number) : 0,
      lastShippedAt: this.lastShippedAt,
      offsite: this.offsiteDir() ? this.offsiteState : 'off',
      error: this.lastError,
      bytes,
    }
  }

  // ---------------------------------------------------------------------------
  // replay
  // ---------------------------------------------------------------------------

  /**
   * Applies `timeline`'s entries with seq > fromSeq and time ≤ until to `target` (a restored copy of
   * a snapshot of the same timeline). Stops at the first later entry, so the result is always a
   * consistent prefix of the history. Every statement must touch exactly the row it touched live.
   */
  replay(target: Database.Database, timeline: string, fromSeq: number, until: number): { applied: number; lastSeq: number; lastAt: number | null } {
    const shapes = new Map(tableShapes(target).map((t) => [t.name, t]))
    const stmts = new Map<string, { i: Database.Statement; u: Database.Statement; d: Database.Statement }>()
    const forTable = (name: string) => {
      let s = stmts.get(name)
      if (s) return s
      const t = shapes.get(name)
      if (!t) throw new AppError('JOURNAL_CORRUPT', { table: name })
      const cols = t.pk.length ? t.cols : ['rowid', ...t.cols]
      const keyCols = t.pk.length ? t.pk : ['rowid']
      const vals = cols.map((c) => `json_extract(@d, ${path$(c)})`).join(', ')
      const where = keyCols.map((c) => `${q(c)} IS json_extract(@k, ${path$(c)})`).join(' AND ')
      s = {
        i: target.prepare(`INSERT INTO ${q(name)} (${cols.map(q).join(', ')}) VALUES (${vals})`),
        u: target.prepare(`UPDATE ${q(name)} SET (${cols.map(q).join(', ')}) = (${vals}) WHERE ${where}`),
        d: target.prepare(`DELETE FROM ${q(name)} WHERE ${where}`),
      }
      stmts.set(name, s)
      return s
    }

    let last = fromSeq
    let lastAt: number | null = null
    let applied = 0
    target.pragma('foreign_keys = OFF') // cascades were journaled as their own rows
    target
      .transaction(() => {
        outer: for (const seg of this.segments(timeline)) {
          const entries = readSegment(join(this.opts.dir, seg.name))
          if (!entries.length || entries[entries.length - 1]![0] <= last) continue
          for (const [seq, at, tbl, op, k, d] of entries) {
            if (seq <= last) continue // already in the snapshot, or a line re-shipped after a crash
            if (at > until) break outer
            if (seq !== last + 1) throw new AppError('JOURNAL_GAP', { after: last, next: seq })
            const s = forTable(tbl)
            const r = op === 'i' ? s.i.run({ d }) : op === 'u' ? s.u.run({ d, k }) : s.d.run({ k })
            if (r.changes !== 1) throw new AppError('JOURNAL_CORRUPT', { seq, table: tbl, op })
            last = seq
            lastAt = at
            applied++
          }
        }
      })
      .immediate()
    target.pragma('foreign_keys = ON')
    return { applied, lastSeq: last, lastAt }
  }

  // ---------------------------------------------------------------------------
  // retention (D38: 14 days)
  // ---------------------------------------------------------------------------

  /**
   * Removes journal files no restore inside the window can need: timelines that ended before the
   * window, and segments already contained in the newest base snapshot taken before the window.
   * `bases`: usable snapshots per timeline (finishedAt, journal seq).
   */
  prune(bases: readonly { timeline: string; finishedAt: number; seq: number }[]): string[] {
    const windowStart = this.opts.now() - JOURNAL_KEEP_DAYS * 86_400_000
    const tls = this.timelines()
    const removed: string[] = []
    tls.forEach((tl, i) => {
      const end = tls[i + 1]?.createdAt ?? Infinity
      const segs = this.segments(tl.id)
      if (end < windowStart && tl.id !== this.timelineId) {
        removed.push(...segs.map((s) => s.name), `timeline-${tl.id}.json`)
        return
      }
      const base = bases.filter((b) => b.timeline === tl.id && b.finishedAt <= windowStart).sort((a, b) => b.finishedAt - a.finishedAt)[0]
      if (!base) return
      // a segment is droppable when the next one starts at or before base.seq + 1 (all its entries ≤ base.seq)
      segs.forEach((s, j) => {
        const next = segs[j + 1]
        if (next && next.firstSeq <= base.seq + 1) removed.push(s.name)
      })
    })
    if (!removed.length) return []
    const off = this.offsiteDir()
    for (const n of removed) {
      rmQuiet(join(this.opts.dir, n))
      if (off) rmQuiet(join(off, n))
    }
    if (this.current && removed.includes(this.current.name)) this.current = null
    return removed
  }
}

