import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BackupDto, BackupOverviewDto, RestoreInspectDto } from '@shared/api-system'
import { BACKUP_KEEP_DAILY } from '@shared/api-system'
import { Card, Chip, GradientButton, OutlineButton, PageHeader, Pagination, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { formatDateTimeShort, formatTime } from '@renderer/lib/format'
import { bangkokToday, panelClass } from '@renderer/lib/forms'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const b = t.backup
const DAY = 86_400_000
const PER_PAGE = 7

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** "วันนี้ 03:00" / "เมื่อวาน 03:00" / "03/11/69 03:00" as in the prototype. */
function whenLabel(ms: number, now: number): string {
  const today = bangkokToday(now)
  if (ms >= today) return b.today(formatTime(ms))
  if (ms >= today - DAY) return b.yesterday(formatTime(ms))
  return formatDateTimeShort(ms)
}

function StatCard({ label, value, sub, circle }: { label: string; value: string; sub: string; circle: string }) {
  return (
    <div className="relative flex min-w-0 flex-[1_1_260px] flex-col gap-1 overflow-hidden rounded-[20px] bg-white px-5 py-[18px] shadow-[0_1px_3px_rgba(40,30,60,0.08)]">
      <div className="absolute -top-[30px] -right-6 size-[100px] rounded-full" style={{ background: circle }} />
      <span className="relative text-[13px] text-muted-foreground">{label}</span>
      <span className="relative text-2xl font-bold">{value}</span>
      <span className="relative text-xs text-[#7A8090]">{sub}</span>
    </div>
  )
}

function verifyChip(x: BackupDto) {
  if (x.ok && x.verified && x.available) return <Chip bg="#DDF5E8" fg="#11724A">{b.verified}</Chip>
  if (x.ok && !x.available) return <Chip bg="#FFF4D6" fg="#7A5200">{b.missing}</Chip>
  return <Chip bg="#FFE3E3" fg="#A6232B">{b.failed}</Chip>
}

/** docs/design/Backup.dc.html (draft) — Tier A snapshots, schedule & destinations, restore. */
export function BackupPage() {
  const { can } = useSession()
  const toast = useToast()
  const [ov, setOv] = useState<BackupOverviewDto | null>(null)
  const [list, setList] = useState<BackupDto[]>([])
  const [page, setPage] = useState(1)
  const [selId, setSelId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [now] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const [o, l] = await Promise.all([call('backup.overview'), call('backup.list')])
      setOv(o)
      setList(l)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [toast])
  useEffect(() => {
    const h = setTimeout(() => void load(), 0)
    return () => clearTimeout(h)
  }, [load])

  const selected = list.find((x) => x.id === selId) ?? list.find((x) => x.ok && x.available) ?? null

  async function runNow() {
    setRunning(true)
    try {
      const r = await call('backup.run')
      toast(b.done)
      setSelId(r.id)
      setPage(1)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
      await load()
    } finally {
      setRunning(false)
    }
  }

  const last = ov?.last ?? null
  const rows = list.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  return (
    <>
      <PageHeader
        icon="cloud"
        tone="green"
        title={b.title}
        subtitle={b.subtitle}
        actions={
          can('backup:create') && (
            <GradientButton size="lg" disabled={running} onClick={() => void runNow()}>
              {running ? b.running : b.runNow}
            </GradientButton>
          )
        }
      />

      <div className="flex flex-wrap gap-3.5">
        <StatCard
          label={b.cards.last}
          value={last ? whenLabel(last.startedAt, now) : b.cards.none}
          sub={last ? (last.ok ? b.cards.lastOk : b.cards.lastFailed) : b.cards.noneSub}
          circle={last && !last.ok ? '#FFE3E3' : '#DDF5E8'}
        />
        <StatCard label={b.cards.space} value={ov ? b.cards.spaceValue(ov.count, sizeLabel(ov.totalBytes)) : '—'} sub={ov ? b.cards.spaceSub(ov.keepDaily, ov.keepMonthly) : ''} circle="#EDE9FB" />
        <StatCard label={b.cards.cloud} value={b.cards.cloudValue(ov?.outboxPending ?? 0)} sub={b.cards.cloudSub} circle="#E3EEFE" />
      </div>

      <Card className="flex flex-col gap-3 px-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-lg font-bold">{b.tiersTitle}</h2>
          <span className="text-[13px] text-muted-foreground">{b.tiersHint}</span>
        </div>
        <div className="flex flex-wrap gap-3">
          {b.tiers.map((tier) => (
            <button
              key={tier.id}
              type="button"
              aria-pressed={tier.enabled}
              aria-disabled={!tier.enabled}
              className={cn(
                'flex min-h-32 flex-[1_1_240px] flex-col items-start gap-2 rounded-[18px] border-2 p-4 text-left font-[inherit] text-foreground',
                tier.enabled ? 'cursor-pointer border-[#9776F6] bg-[#F5F2FE]' : 'cursor-not-allowed border-[#E6E1D9] bg-white opacity-70',
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
                  style={tier.enabled ? { background: 'linear-gradient(135deg,#8B6CF0,#6A47DB)', color: '#FFFFFF' } : { background: '#EFEBE6', color: '#7A8090' }}
                >
                  {tier.id}
                </span>
                <span className="flex-1 text-base font-bold">{tier.title}</span>
                <span
                  className="inline-flex h-6 shrink-0 items-center rounded-xl px-2.5 text-[11px] font-bold"
                  style={tier.enabled ? { background: '#DDF5E8', color: '#11724A' } : { background: '#F0EDE8', color: '#5C6270' }}
                >
                  {tier.phase}
                </span>
              </span>
              <span className="text-[13px] text-muted-foreground">{tier.desc}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="flex flex-wrap items-start gap-[18px]">
        <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-[18px]">
          <Card className="flex flex-col gap-2.5">
            <h2 className="m-0 text-lg font-bold">{b.listTitle}</h2>
            <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
              <span className="flex-[1.6_1_0]">{b.cols.when}</span>
              <span className="flex-[0.8_1_0]">{b.cols.size}</span>
              <span className="flex-[1_1_0]">{b.cols.kind}</span>
              <span className="flex-[1_1_0]">{b.cols.verify}</span>
            </div>
            <div role="list" className="flex flex-col gap-1.5">
              {rows.map((x) => (
                <div
                  key={x.id}
                  role="listitem"
                  onClick={() => setSelId(x.id)}
                  className={cn('box-border flex min-h-14 cursor-pointer items-center gap-3 rounded-[14px] border-2 px-3 py-1.5', selected?.id === x.id ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]')}
                >
                  <span className="flex flex-[1.6_1_0] flex-col">
                    <span className="text-[15px] font-semibold">{whenLabel(x.startedAt, now)}</span>
                    {x.offsite !== 'none' && <span className={cn('text-xs', x.offsite === 'copied' ? 'text-success-foreground' : 'text-warning-foreground')}>{x.offsite === 'copied' ? b.offsiteCopied : b.offsiteFailed}</span>}
                  </span>
                  <span className="flex-[0.8_1_0] text-sm">{x.sizeBytes ? sizeLabel(x.sizeBytes) : '—'}</span>
                  <span className="flex-[1_1_0] text-[13px] text-muted-foreground">
                    {b.kinds[x.kind]}
                    {x.createdByName ? ` · ${x.createdByName}` : ''}
                  </span>
                  <span className="flex-[1_1_0]">{verifyChip(x)}</span>
                </div>
              ))}
              {list.length === 0 && <span className="px-3 text-sm text-muted-foreground">{b.empty}</span>}
            </div>
            <Pagination page={page} pageSize={PER_PAGE} total={list.length} onPage={setPage} />
          </Card>

          {ov && <ScheduleCard ov={ov} onSaved={setOv} />}
        </div>

        <RestorePanel list={list} selected={selected} onSelect={setSelId} now={now} onChanged={() => void load()} />
      </div>
    </>
  )
}

function ScheduleCard({ ov, onSaved }: { ov: BackupOverviewDto; onSaved: (o: BackupOverviewDto) => void }) {
  const { can } = useSession()
  const toast = useToast()
  const editable = can('settings:update')
  const [time, setTime] = useState(ov.dailyTime)

  async function save(patch: Partial<{ dailyTime: string; keepDaily: 14 | 30 | 90; offsiteEnabled: boolean; offsiteDir: string }>) {
    try {
      const next = await call('backup.saveSchedule', { dailyTime: ov.dailyTime, keepDaily: ov.keepDaily, offsiteEnabled: ov.offsiteEnabled, offsiteDir: ov.offsiteDir, ...patch })
      onSaved(next)
      toast(b.saved)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function pickAnd(enable: boolean) {
    const dir = await call('backup.pickFolder').catch(() => null)
    if (dir) await save({ offsiteDir: dir, offsiteEnabled: enable })
  }

  const offsiteDesc = !ov.offsiteDir ? b.destOffsiteNone : ov.offsiteReachable ? ov.offsiteDir : b.destOffsiteUnreachable(ov.offsiteDir)

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-bold">{b.scheduleTitle}</h2>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-[1_1_160px] flex-col gap-1.5 text-sm font-semibold">
          {b.dailyTime}
          <TextInput
            type="time"
            value={time}
            disabled={!editable}
            onChange={(e) => setTime(e.target.value)}
            onBlur={() => {
              if (/^\d{2}:\d{2}$/.test(time) && time !== ov.dailyTime) void save({ dailyTime: time })
            }}
          />
          <span className="text-xs font-normal text-muted-foreground">{b.dailyHint}</span>
        </label>
        <label className="flex flex-[1_1_160px] flex-col gap-1.5 text-sm font-semibold">
          {b.keep}
          <SelectInput value={ov.keepDaily} disabled={!editable} onChange={(e) => void save({ keepDaily: Number(e.target.value) as 14 | 30 | 90 })}>
            {BACKUP_KEEP_DAILY.map((d) => (
              <option key={d} value={d}>
                {b.keepOption(d)}
              </option>
            ))}
          </SelectInput>
          <span className="text-xs font-normal text-muted-foreground">{b.keepHint(ov.keepMonthly)}</span>
        </label>
      </div>
      <span className="text-[13px] font-bold text-primary">{b.destinations}</span>
      <div className="flex min-h-14 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px]">{b.destLocal}</span>
          <span className="truncate text-xs text-[#7A8090]">{ov.localDir}</span>
        </div>
        <Toggle checked label={b.destLocal} disabled onChange={() => {}} />
      </div>
      <div className="flex min-h-14 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px]">{b.destOffsite}</span>
          <span className={cn('truncate text-xs', ov.offsiteDir && !ov.offsiteReachable ? 'text-warning-foreground' : 'text-[#7A8090]')}>{offsiteDesc}</span>
          {editable && ov.canPickFolder && ov.offsiteDir && (
            <button type="button" onClick={() => void pickAnd(ov.offsiteEnabled)} className="mt-1 min-h-11 cursor-pointer self-start rounded-full border-0 bg-accent px-4 text-[13px] font-semibold text-accent-foreground">
              {b.changeFolder}
            </button>
          )}
        </div>
        <Toggle
          checked={ov.offsiteEnabled}
          label={b.destOffsite}
          disabled={!editable || (!ov.offsiteDir && !ov.canPickFolder)}
          onChange={(on) => void (on && !ov.offsiteDir ? pickAnd(true) : save({ offsiteEnabled: on }))}
        />
      </div>
      <div className="flex min-h-14 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[15px]">{b.destCloud}</span>
          <span className="text-xs text-[#7A8090]">{ov.cloudLicensed ? b.destCloudLicensed : b.destCloudDesc}</span>
        </div>
        <Toggle checked={false} label={b.destCloud} disabled onChange={() => {}} />
      </div>
      {!editable && <span className="text-xs text-muted-foreground">{b.noSettingsPermission}</span>}
    </Card>
  )
}

function RestorePanel({ list, selected, onSelect, now, onChanged }: { list: BackupDto[]; selected: BackupDto | null; onSelect: (id: string) => void; now: number; onChanged: () => void }) {
  const { can } = useSession()
  const toast = useToast()
  const allowed = can('backup:restore')
  const [copyMode, setCopyMode] = useState(true)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [inspect, setInspect] = useState<RestoreInspectDto | null>(null)
  const [restarting, setRestarting] = useState(false)

  // one bar per day for the last 14 days; tall = a usable backup exists that day
  const timeline = useMemo(() => {
    const today = bangkokToday(now)
    return Array.from({ length: 14 }, (_, i) => {
      const daysAgo = 13 - i
      const start = today - daysAgo * DAY
      const latest = list.find((x) => x.ok && x.available && x.startedAt >= start && x.startedAt < start + DAY) ?? null
      return { daysAgo, latest }
    })
  }, [list, now])

  const usable = !!selected && selected.ok && selected.available
  const typed = confirm.trim() === b.confirmWord
  const canGo = allowed && usable && typed && !busy

  async function go() {
    if (!selected || !canGo) return
    setBusy(true)
    try {
      if (copyMode) {
        setInspect(await call('backup.restoreCopy', { id: selected.id, confirm: 'RESTORE' }))
      } else {
        const r = await call('backup.restoreReplace', { id: selected.id, confirm: 'RESTORE' })
        if (r.restarting) setRestarting(true)
        else toast(b.restartManually)
      }
      setConfirm('')
      onChanged()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside aria-label={b.restoreTitle} className={cn(panelClass, 'flex-[0_0_440px]')}>
      <h2 className="m-0 text-xl font-bold">{b.restoreTitle}</h2>
      <div className="flex flex-col gap-0.5 rounded-2xl bg-[#F5F2FE] px-4 py-3.5">
        <span className="text-[13px] text-muted-foreground">{b.selected}</span>
        <span className="text-lg font-bold">{selected ? whenLabel(selected.startedAt, now) : '—'}</span>
        <span className="text-[13px] text-muted-foreground">
          {selected
            ? `${selected.sizeBytes ? sizeLabel(selected.sizeBytes) : '—'} · ${b.kinds[selected.kind]}${usable ? '' : ` · ${b.corrupt}`}`
            : b.selectHint}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-primary">{b.timeline}</span>
        <div className="flex h-14 items-end gap-1.5">
          {timeline.map((d) => {
            const on = !!d.latest && d.latest.id === selected?.id
            return (
              <button
                key={d.daysAgo}
                type="button"
                aria-label={b.timelineDay(d.daysAgo)}
                title={d.latest ? formatDateTimeShort(d.latest.startedAt) : b.timelineDay(d.daysAgo)}
                disabled={!d.latest}
                onClick={() => d.latest && (onSelect(d.latest.id), setInspect(null))}
                className={cn('flex-1 rounded-md border-0 p-0', d.latest ? 'h-10 cursor-pointer' : 'h-3.5 cursor-default')}
                style={{ background: on ? 'linear-gradient(180deg,#8B6CF0,#6A47DB)' : d.latest ? '#CFC2F8' : '#EFEBE6' }}
              />
            )
          })}
        </div>
        <span className="text-xs text-[#7A8090]">{b.tierNote}</span>
      </div>

      <div className="flex min-h-14 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[15px]">{b.optCopy}</span>
          <span className="text-xs text-[#7A8090]">{b.optCopyDesc}</span>
        </div>
        <Toggle checked={copyMode} label={b.optCopy} disabled={!allowed} onChange={(v) => setCopyMode(v)} />
      </div>
      <div className="flex min-h-14 items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[15px]">{b.optPreBackup}</span>
          <span className="text-xs text-[#7A8090]">{b.optPreBackupDesc}</span>
        </div>
        <Toggle checked label={b.optPreBackup} disabled onChange={() => {}} />
      </div>
      <div className={cn('rounded-[14px] px-3.5 py-3 text-[13px]', copyMode ? 'bg-[#E3EEFE] text-[#1D4FA8]' : 'bg-warning text-warning-foreground')}>{copyMode ? b.warnCopy : b.warnReplace}</div>

      {inspect && inspect.backupId === selected?.id && (
        <div className="flex flex-col gap-1 rounded-2xl bg-success px-4 py-3 text-[13px] text-success-foreground">
          <span className="font-bold">{b.inspectTitle}</span>
          <span>{b.inspectLines(inspect.bills, inspect.users, inspect.auditCount)}</span>
          {inspect.lastBillAt && <span>{b.inspectLastBill(formatDateTimeShort(inspect.lastBillAt))}</span>}
          <span>{b.schemaNote(inspect.schemaVersion)}</span>
          <span className="break-all">{b.inspectPath(inspect.path)}</span>
          <OutlineButton className="mt-1.5 self-start" onClick={() => (setCopyMode(false), setInspect(null))}>
            {b.useThis}
          </OutlineButton>
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm font-semibold">
        {b.confirmLabel}
        <TextInput value={confirm} disabled={!allowed} onChange={(e) => setConfirm(e.target.value)} placeholder={b.confirmWord} autoComplete="off" />
      </label>
      <button
        type="button"
        disabled={!canGo}
        onClick={() => void go()}
        className="min-h-[52px] rounded-[26px] border-0 font-[inherit] text-base font-bold"
        style={
          canGo
            ? { background: copyMode ? 'linear-gradient(90deg,#6A47DB,#9776F6)' : 'linear-gradient(90deg,#F4616A,#DC3A44)', color: '#FFFFFF', cursor: 'pointer' }
            : { background: '#E6E1D9', color: '#8C8880', cursor: 'not-allowed' }
        }
      >
        {busy ? b.working : copyMode ? b.doCopy : b.doReplace}
      </button>
      <span className="text-xs text-[#7A8090]">{allowed ? b.footnote : b.noRestorePermission}</span>

      {restarting && (
        <div role="alertdialog" aria-live="assertive" className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,36,48,0.45)]">
          <div className="rounded-[22px] bg-white px-8 py-6 text-lg font-bold shadow-[0_10px_30px_rgba(60,40,90,0.2)]">{b.restarting}</div>
        </div>
      )}
    </aside>
  )
}
