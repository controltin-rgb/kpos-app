import { useCallback, useEffect, useState } from 'react'
import type { KdsTicketDto } from '@shared/api-sales'
import { IconTile, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent, useNow } from '@renderer/lib/events'
import { elapsed } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'

const k = t.kds
/** Minutes after which a ticket is flagged late (Design-Spec: Timer Warning). */
export const LATE_MINUTES = 8

const COLUMNS = [
  { status: 'new', title: k.newCol, bg: '#FFF1E3', fg: '#8A3F05', badge: '#F7791E', badgeFg: '#FFFFFF', border: '#F7791E', btn: 'linear-gradient(135deg, #FFA43A, #F7791E)', btnFg: '#FFFFFF', label: k.start },
  { status: 'preparing', title: k.prepCol, bg: '#FFF7DC', fg: '#6B4A00', badge: '#E5A10C', badgeFg: '#1F2430', border: '#E5A10C', btn: 'linear-gradient(135deg, #F7C23A, #E5A10C)', btnFg: '#1F2430', label: k.done },
  { status: 'ready', title: k.readyCol, bg: '#E4F7EC', fg: '#0E5C3A', badge: '#1BA56B', badgeFg: '#FFFFFF', border: '#1BA56B', btn: 'linear-gradient(135deg, #34C98A, #1BA56B)', btnFg: '#FFFFFF', label: k.bump },
] as const

/** docs/design/KDS.dc.html (confirmed design). Opened as its own window from the System page. */
export function KdsPage() {
  const toast = useToast()
  const now = useNow(1000)
  const [station, setStation] = useState<'bar' | 'kitchen'>('bar')
  const [tickets, setTickets] = useState<KdsTicketDto[]>([])

  const load = useCallback(
    (st: string) =>
      call('kds.tickets', { station: st }).then(setTickets, (err: unknown) => toast(errorMessage(err), 'error')),
    [toast],
  )
  useEffect(() => {
    void load(station)
  }, [load, station])
  useAppEvent((e) => {
    if (e.type === 'kds.changed') void load(station)
  })

  async function advance(billId: string) {
    try {
      await call('kds.advance', { billId, station })
      await load(station)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="box-border flex min-h-full flex-col gap-4 bg-background px-6 pt-5 pb-7 text-foreground">
      <div className="flex flex-wrap items-center gap-3.5">
        <div className="flex flex-[1_1_320px] items-center gap-3.5">
          <IconTile icon="cup" tone="orange" size={52} iconSize={26} radius={15} shadow />
          <div className="flex flex-col gap-0.5">
            <h1 className="m-0 text-[26px] font-bold">{station === 'bar' ? k.title : k.titleKitchen}</h1>
            <div className="text-[13px] text-muted-foreground">{k.subtitle}</div>
          </div>
        </div>
        <div role="group" aria-label={k.stations} className="inline-flex rounded-3xl bg-white p-1 shadow-[0_1px_3px_rgba(40,30,60,0.1)]">
          {(['bar', 'kitchen'] as const).map((st) => (
            <button
              key={st}
              type="button"
              aria-pressed={station === st}
              onClick={() => setStation(st)}
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

      <div className="flex flex-wrap items-start gap-3.5">
        {COLUMNS.map((col) => {
          const list = tickets.filter((tk) => tk.status === col.status)
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
                return (
                  <article
                    key={tk.billId}
                    className="flex flex-col gap-2 rounded-[18px] p-3.5"
                    style={{ background: late ? '#FFF3F3' : '#FFFFFF', border: `2px solid ${late ? '#DC3A44' : col.border}` }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[22px] font-bold">{tk.billNo}</span>
                      <span className="text-sm font-semibold text-[#4A5060]">
                        {t.orderTypes[tk.orderType]}
                        {tk.channel ? ` · ${t.channels[tk.channel]}` : ''}
                      </span>
                    </div>
                    {col.status !== 'ready' && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-muted-foreground">{col.status === 'new' ? k.waiting(elapsed(tk.createdAt, now)) : k.time(elapsed(tk.createdAt, now))}</span>
                        {late && <span className="text-[13px] font-bold text-danger-foreground">{k.late(LATE_MINUTES)}</span>}
                      </div>
                    )}
                    {tk.items.map((it, i) => {
                      const mods = it.mods.filter((m) => m.highlight).map((m) => m.text)
                      const plain = [it.sizeLabel, ...it.mods.filter((m) => !m.highlight).map((m) => m.text)].filter(Boolean).join(' · ')
                      return (
                        <div key={i} className="flex flex-col gap-0.5 border-t border-dashed border-[#D9D2C9] pt-2">
                          <span className="text-lg font-bold">
                            {it.qty} × {it.name}
                          </span>
                          {plain && <span className="text-[15px] text-[#4A5060]">{plain}</span>}
                          {mods.length > 0 && <span className="text-base font-bold text-[#B42318]">{mods.join(' · ')}</span>}
                          {it.note && <span className="text-base font-bold text-[#B42318]">“{it.note}”</span>}
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
