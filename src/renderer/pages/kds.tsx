import { useCallback, useEffect, useRef, useState } from 'react'
import type { KdsTicketDto } from '@shared/api-sales'
import { Icon } from '@renderer/components/icons'
import { IconTile, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent, useNow } from '@renderer/lib/events'
import { elapsed } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

const k = t.kds
/** Minutes after which a ticket is flagged late (Design-Spec: Timer Warning). */
export const LATE_MINUTES = 8
/** How long a newly arrived bill stays highlighted. */
const FRESH_MS = 8_000
const SOUND_KEY = 'kposs.kds_sound'

const COLUMNS = [
  { status: 'new', title: k.newCol, bg: '#FFF1E3', fg: '#8A3F05', badge: '#F7791E', badgeFg: '#FFFFFF', border: '#F7791E', btn: 'linear-gradient(135deg, #FFA43A, #F7791E)', btnFg: '#FFFFFF', label: k.start },
  { status: 'preparing', title: k.prepCol, bg: '#FFF7DC', fg: '#6B4A00', badge: '#E5A10C', badgeFg: '#1F2430', border: '#E5A10C', btn: 'linear-gradient(135deg, #F7C23A, #E5A10C)', btnFg: '#1F2430', label: k.done },
  { status: 'ready', title: k.readyCol, bg: '#E4F7EC', fg: '#0E5C3A', badge: '#1BA56B', badgeFg: '#FFFFFF', border: '#1BA56B', btn: 'linear-gradient(135deg, #34C98A, #1BA56B)', btnFg: '#FFFFFF', label: k.bump },
] as const

/** Short two-tone chime for a new order (Web Audio, no sound file needed). */
function chime() {
  try {
    const ctx = new AudioContext()
    ;[880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = ctx.currentTime + i * 0.18
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.34)
    })
    setTimeout(() => void ctx.close(), 1000)
  } catch {
    // no audio device: the highlight still shows
  }
}

/** Drinks still to make (not ticked) across NEW + PREPARING, e.g. "ชาไทย 22oz ×3". */
function summarize(tickets: KdsTicketDto[]) {
  const map = new Map<string, number>()
  for (const tk of tickets) {
    if (tk.status === 'ready') continue
    for (const it of tk.items) {
      if (it.done) continue
      const key = it.sizeLabel ? `${it.name} ${it.sizeLabel}` : it.name
      map.set(key, (map.get(key) ?? 0) + it.qty)
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'th'))
}

/** docs/design/KDS.dc.html (confirmed design) + standard bar workflow (D49). Opened as its own window from the System page. */
export function KdsPage() {
  const toast = useToast()
  const now = useNow(1000)
  const [station, setStation] = useState<'bar' | 'kitchen'>('bar')
  const [tickets, setTickets] = useState<KdsTicketDto[]>([])
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== 'off')
  const [fresh, setFresh] = useState<Record<string, number>>({})
  // bills already seen at this station; null until the first load (no chime for what is already waiting)
  const seen = useRef<Set<string> | null>(null)
  const soundRef = useRef(sound)
  useEffect(() => {
    soundRef.current = sound
  }, [sound])

  const load = useCallback(
    (st: string) =>
      call('kds.tickets', { station: st }).then(
        (list) => {
          if (seen.current) {
            const arrived = list.filter((tk) => tk.status === 'new' && !seen.current!.has(tk.billId))
            if (arrived.length) {
              if (soundRef.current) chime()
              const at = Date.now()
              setFresh((f) => ({ ...f, ...Object.fromEntries(arrived.map((tk) => [tk.billId, at])) }))
            }
          }
          seen.current = new Set([...(seen.current ?? []), ...list.map((tk) => tk.billId)])
          setTickets(list)
        },
        (err: unknown) => toast(errorMessage(err), 'error'),
      ),
    [toast],
  )
  useEffect(() => {
    seen.current = null
    void load(station)
  }, [load, station])
  useAppEvent((e) => {
    if (e.type === 'kds.changed') void load(station)
  })

  function toggleSound() {
    const next = !sound
    setSound(next)
    localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
    if (next) chime()
  }

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn()
      await load(station)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  const advance = (billId: string) => run(() => call('kds.advance', { billId, station }))
  const toggleItem = (ticketId: string) => run(() => call('kds.toggleItem', { ticketId, station }))
  const recall = () =>
    run(async () => {
      const billId = await call('kds.recall', { station })
      toast(billId ? k.recalled : k.nothingToRecall, billId ? 'success' : 'info')
    })

  const summary = summarize(tickets)
  const headerBtn = 'inline-flex h-11 cursor-pointer items-center gap-2 rounded-[22px] border-0 bg-white px-4 text-sm font-semibold text-[#2B3040] shadow-[0_1px_3px_rgba(40,30,60,0.1)]'

  return (
    <div className="keep-light box-border flex min-h-full flex-col gap-4 bg-background px-6 pt-5 pb-7 text-foreground">
      <div className="flex flex-wrap items-center gap-3.5">
        <div className="flex flex-[1_1_320px] items-center gap-3.5">
          <IconTile icon="cup" tone="orange" size={52} iconSize={26} radius={15} shadow />
          <div className="flex flex-col gap-0.5">
            <h1 className="m-0 text-[26px] font-bold">{station === 'bar' ? k.title : k.titleKitchen}</h1>
            <div className="text-[13px] text-muted-foreground">{k.subtitle}</div>
          </div>
        </div>
        <button type="button" aria-pressed={sound} onClick={toggleSound} className={cn(headerBtn, !sound && 'text-muted-foreground')}>
          <Icon name="bell" size={18} color={sound ? '#4B2FB8' : '#9AA0AC'} />
          {sound ? k.soundOn : k.soundOff}
        </button>
        <button type="button" onClick={() => void recall()} className={headerBtn}>
          <Icon name="refresh" size={18} color="#4B2FB8" />
          {k.recall}
        </button>
        <div role="group" aria-label={k.stations} className="inline-flex rounded-3xl bg-white p-1 shadow-[0_1px_3px_rgba(40,30,60,0.1)]">
          {(['bar', 'kitchen'] as const).map((st) => (
            <button
              key={st}
              type="button"
              aria-pressed={station === st}
              onClick={() => {
                setStation(st)
                setFresh({})
              }}
              className={cn(
                'min-h-11 cursor-pointer rounded-[20px] border-0 px-5 text-[15px]',
                station === st ? 'bg-[linear-gradient(90deg,#6A47DB,#9776F6)] font-semibold text-white' : 'bg-transparent text-[#2B3040]',
              )}
            >
              {st === 'bar' ? k.bar : k.kitchen}
            </button>
          ))}
        </div>
        <div className="inline-flex h-10 items-center gap-2 rounded-[20px] bg-success px-4 text-sm font-semibold text-success-foreground">
          <span className="inline-block size-2 rounded-full bg-[#1BA56B]" />
          {k.connected}
        </div>
      </div>

      {/* all-day summary: what the bar still has to make */}
      <section aria-label={k.summary} className="flex flex-wrap items-center gap-2 rounded-[18px] bg-white px-4 py-3 shadow-[0_1px_3px_rgba(40,30,60,0.08)]">
        <span className="mr-1 text-sm font-bold">{k.summary}</span>
        {summary.length === 0 && <span className="text-sm text-muted-foreground">{k.summaryEmpty}</span>}
        {summary.map(([name, qty]) => (
          <span key={name} className="inline-flex h-9 items-center gap-2 rounded-[18px] bg-accent px-3.5 text-sm font-semibold text-accent-foreground">
            {name}
            <span className="rounded-xl bg-white px-2 text-[15px] font-bold">×{qty}</span>
          </span>
        ))}
      </section>

      <div className="flex flex-wrap items-start gap-3.5">
        {COLUMNS.map((col) => {
          const list = tickets.filter((tk) => tk.status === col.status)
          const checkable = col.status !== 'ready'
          return (
            <section key={col.status} aria-label={col.status.toUpperCase()} className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 rounded-[22px] p-3.5" style={{ background: col.bg }}>
              <div className="flex items-center justify-between px-1.5 py-1">
                <span className="text-lg font-bold" style={{ color: col.fg }}>
                  {col.title}
                </span>
                <span className="box-border flex h-8 min-w-8 items-center justify-center rounded-2xl px-2 font-bold" style={{ background: col.badge, color: col.badgeFg }}>
                  {list.length}
                </span>
              </div>
              {list.length === 0 && <div className="px-2 py-4 text-center text-sm text-muted-foreground">{k.empty}</div>}
              {list.map((tk) => {
                const mins = Math.floor((now - tk.createdAt) / 60_000)
                const late = col.status !== 'ready' && mins >= LATE_MINUTES
                const isFresh = col.status === 'new' && now - (fresh[tk.billId] ?? 0) < FRESH_MS
                const cups = tk.items.reduce((n, it) => n + it.qty, 0)
                const doneCups = tk.items.reduce((n, it) => n + (it.done ? it.qty : 0), 0)
                return (
                  <article
                    key={tk.billId}
                    className={cn('flex flex-col gap-2 rounded-[18px] p-3.5', isFresh && 'animate-pulse')}
                    style={{
                      background: late ? '#FFF3F3' : '#FFFFFF',
                      border: `2px solid ${late ? '#DC3A44' : col.border}`,
                      boxShadow: isFresh ? `0 0 0 4px ${col.border}55` : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-[22px] font-bold">
                        {tk.billNo}
                        {isFresh && <span className="rounded-xl bg-[#F7791E] px-2 py-0.5 text-xs font-bold text-white">{k.newOrder}</span>}
                      </span>
                      <span className="text-sm font-semibold text-[#4A5060]">
                        {t.orderTypes[tk.orderType]}
                        {tk.channel ? ` · ${t.channels[tk.channel]}` : ''}
                      </span>
                    </div>
                    {col.status !== 'ready' && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-muted-foreground">
                          {col.status === 'new' ? k.waiting(elapsed(tk.createdAt, now)) : k.time(elapsed(tk.createdAt, now))}
                          {doneCups > 0 && ` · ${k.itemsDone(doneCups, cups)}`}
                        </span>
                        {late && <span className="text-[13px] font-bold text-danger-foreground">{k.late(LATE_MINUTES)}</span>}
                      </div>
                    )}
                    {tk.items.map((it) => {
                      const mods = it.mods.filter((m) => m.highlight).map((m) => m.text)
                      const plain = [it.sizeLabel, ...it.mods.filter((m) => !m.highlight).map((m) => m.text)].filter(Boolean).join(' · ')
                      const body = (
                        <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', it.done && 'opacity-45')}>
                          <span className={cn('text-lg font-bold', it.done && 'line-through')}>
                            {it.qty} × {it.name}
                          </span>
                          {plain && <span className="text-[15px] text-[#4A5060]">{plain}</span>}
                          {mods.length > 0 && <span className="text-base font-bold text-[#B42318]">{mods.join(' · ')}</span>}
                          {it.note && <span className="text-base font-bold text-[#B42318]">“{it.note}”</span>}
                        </span>
                      )
                      return checkable ? (
                        <button
                          key={it.ticketId}
                          type="button"
                          role="checkbox"
                          aria-checked={it.done}
                          aria-label={it.done ? k.itemDone(it.name) : `${it.qty} × ${it.name}`}
                          onClick={() => void toggleItem(it.ticketId)}
                          className="flex min-h-11 w-full cursor-pointer items-start gap-2.5 border-0 border-t border-dashed border-[#D9D2C9] bg-transparent px-0 pt-2 text-left text-foreground"
                        >
                          <span
                            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
                            style={{ background: it.done ? '#1BA56B' : '#FFFFFF', border: `2px solid ${it.done ? '#1BA56B' : '#C9C2B8'}` }}
                          >
                            {it.done && (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M5 12l5 5L20 7" />
                              </svg>
                            )}
                          </span>
                          {body}
                        </button>
                      ) : (
                        <div key={it.ticketId} className="flex border-t border-dashed border-[#D9D2C9] pt-2">
                          {body}
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => void advance(tk.billId)}
                      className="mt-1 min-h-[52px] cursor-pointer rounded-[14px] border-0 text-base font-bold"
                      style={{ background: col.btn, color: col.btnFg }}
                    >
                      {col.label}
                    </button>
                  </article>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
