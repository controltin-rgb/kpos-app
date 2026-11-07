import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { LanPingDto, LanStatusDto } from '@shared/api-lan'
import { Segmented } from '@renderer/components/modal'
import { Chip, GradientButton, OutlineButton, TextInput, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent, useNow } from '@renderer/lib/events'
import { formatDateTimeShort } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'
import { AuthInput, AuthLayout, AuthSubmit, AuthTitle, FormError } from './auth-layout'

const l = t.lan
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
/** Thai text for an error code received as data (not thrown). */
const errorText = (code: string | null) => {
  const m = (t.errors as Record<string, unknown>)[code ?? '']
  return typeof m === 'string' ? m : t.errors.LAN_UNREACHABLE
}
const prettyCode =(c: string) => `${c.slice(0, 4)}-${c.slice(4)}`

function RestartingOverlay() {
  return (
    <div role="alertdialog" aria-live="assertive" className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,36,48,0.45)]">
      <div className="rounded-[22px] bg-white px-8 py-6 text-lg font-bold shadow-[0_10px_30px_rgba(60,40,90,0.2)]">{l.restarting}</div>
    </div>
  )
}

/** Settings → "เครื่องและ License": machine mode and LAN (docs/design/Settings.dc.html "show_mode"). */
export function LanSection() {
  const { can } = useSession()
  const toast = useToast()
  const editable = can('settings:update')
  const [s, setS] = useState<LanStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [port, setPort] = useState('')
  const now = useNow(1000)

  const load = useCallback(async () => {
    try {
      const x = await call('lan.status')
      setS(x)
      setPort((p) => p || String(x.port))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [toast])
  useEffect(() => {
    const h = setTimeout(() => void load(), 0)
    const timer = setInterval(() => void load(), 15_000)
    return () => (clearTimeout(h), clearInterval(timer))
  }, [load])
  useAppEvent((e) => {
    if (e.type === 'lan.state') void load()
  })

  // pairing codes expire: refresh when the countdown hits zero
  const pairingLeft = s?.pairing ? s.pairing.expiresAt - now : null
  useEffect(() => {
    if (pairingLeft === null || pairingLeft > 0) return
    const h = setTimeout(() => void load(), 0)
    return () => clearTimeout(h)
  }, [pairingLeft, load])

  if (!s) return null

  async function act<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const portNum = Number(port)
  const portOk = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535

  if (s.role === 'client') return <ClientPanel s={s} onReload={() => void load()} />

  return (
    <div className="flex flex-col gap-3.5">
      <h2 className="m-0 text-xl font-bold">{l.title}</h2>
      <div className="flex flex-wrap gap-3">
        {(['standalone', 'host', 'client'] as const).map((m) => {
          const on = s.role === m
          return (
            <div
              key={m}
              aria-current={on || undefined}
              className={cn('flex min-h-24 flex-[1_1_200px] flex-col gap-1.5 rounded-[18px] border-2 p-4', on ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-[#E6E1D9] bg-white', m === 'client' && 'opacity-70')}
            >
              <span className="text-base font-bold">{l.modes[m].title}</span>
              <span className="text-[13px] text-muted-foreground">{l.modes[m].desc}</span>
            </div>
          )
        })}
      </div>
      <span className="text-xs text-[#7A8090]">{l.clientOnlyAtSetup}</span>

      {s.role === 'standalone' ? (
        <>
          <div className="rounded-[14px] bg-[#F5F2FE] px-3.5 py-3 text-[13px] text-[#4B2FB8]">{l.standaloneNote}</div>
          {editable && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex w-40 flex-col gap-1.5 text-sm font-semibold">
                {l.port}
                <TextInput inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} invalid={!portOk} />
              </label>
              <GradientButton disabled={busy || !portOk} onClick={() => void act(() => call('lan.setMode', { mode: 'host', port: portNum }), l.switchedHost)}>
                {l.switchToHost}
              </GradientButton>
            </div>
          )}
          {s.error && <span className="text-[13px] text-danger-foreground">{l.startError(s.error)}</span>}
        </>
      ) : (
        <HostPanel s={s} busy={busy} editable={editable} pairingLeft={pairingLeft} act={act} />
      )}
    </div>
  )
}

function HostPanel({ s, busy, editable, pairingLeft, act }: { s: LanStatusDto; busy: boolean; editable: boolean; pairingLeft: number | null; act: <T>(fn: () => Promise<T>, ok?: string) => Promise<void> }) {
  const activeClients = s.clients.filter((c) => !c.revoked).length
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-[1_1_220px] flex-col gap-1.5 text-sm font-semibold">
          {l.address}
          <TextInput readOnly value={s.addresses.length ? s.addresses.map((a) => `${a}:${s.port}`).join('  ·  ') : l.noAddress} />
        </label>
        <label className="flex flex-[0_1_120px] flex-col gap-1.5 text-sm font-semibold">
          {l.port}
          <TextInput readOnly value={String(s.port)} />
        </label>
        <label className="flex flex-[1_1_160px] flex-col gap-1.5 text-sm font-semibold">
          {l.blockSize}
          <TextInput readOnly value="200" />
        </label>
      </div>
      <span className="text-[13px] text-muted-foreground">{l.blockNote}</span>
      {s.fingerprint && <span className="font-mono text-xs text-[#7A8090]">{l.fingerprint(s.fingerprint)}</span>}
      {s.error && <span className="text-[13px] text-danger-foreground">{l.startError(s.error)}</span>}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-bold text-primary">{l.clients}</span>
          <span className="text-xs text-muted-foreground">{l.clientsCount(activeClients, s.maxClients)}</span>
        </div>
        {s.clients.length === 0 && <span className="text-sm text-muted-foreground">{l.noClients}</span>}
        {s.clients.map((c) => (
          <div key={c.id} className="flex min-h-[52px] items-center gap-3 rounded-[14px] bg-[#F7F5F2] px-3.5 py-1.5">
            <span className={cn('inline-block size-2.5 shrink-0 rounded-full', c.revoked ? 'bg-[#A9A59E]' : c.online ? 'bg-[#1BA56B]' : 'bg-[#DC3A44]')} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[15px] font-semibold">
                {c.name} · {l.kinds[c.kind]}
              </span>
              <span className="truncate text-xs text-muted-foreground">{c.lastSeenAt ? l.lastSeen(formatDateTimeShort(c.lastSeenAt)) : c.hardwareId}</span>
            </div>
            {c.revoked ? (
              <Chip bg="#F0EDE8" fg="#5C6270">
                {l.revoked}
              </Chip>
            ) : (
              <Chip bg={c.online ? '#DDF5E8' : '#FFE3E3'} fg={c.online ? '#11724A' : '#A6232B'}>
                {c.online ? l.online : l.offline}
              </Chip>
            )}
            {editable && !c.revoked && (
              <button
                type="button"
                disabled={busy}
                onClick={() => window.confirm(l.confirmRevoke(c.name)) && void act(() => call('lan.revokeDevice', { id: c.id }))}
                className="min-h-11 cursor-pointer rounded-full border-0 bg-white px-3.5 text-[13px] font-semibold text-danger-foreground"
              >
                {l.revoke}
              </button>
            )}
          </div>
        ))}
      </div>

      {s.pairing && pairingLeft !== null && pairingLeft > 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-[18px] bg-[#F5F2FE] p-4">
          <span className="text-[13px] font-bold text-primary">{l.pairingTitle}</span>
          <span className="font-mono text-[34px] font-bold tracking-[0.12em] text-[#3A2A8C]">{prettyCode(s.pairing.code)}</span>
          <span className="text-[13px] text-muted-foreground">{l.pairingExpires(mmss(pairingLeft))}</span>
          <span className="text-[13px]">{l.pairingHelp}</span>
          <OutlineButton disabled={busy} onClick={() => void act(() => call('lan.cancelPairing'))}>
            {l.pairingCancel}
          </OutlineButton>
        </div>
      ) : (
        editable && (
          <div className="flex flex-wrap items-center gap-2.5">
            <GradientButton disabled={busy || !s.running || activeClients >= s.maxClients} onClick={() => void act(() => call('lan.startPairing'))}>
              {l.addClient}
            </GradientButton>
            {s.maxClients === 0 && <span className="text-[13px] text-warning-foreground">{l.licenseNoClients}</span>}
          </div>
        )
      )}

      {editable && (
        <OutlineButton
          className="self-start"
          disabled={busy}
          onClick={() => window.confirm(l.confirmStandalone) && void act(() => call('lan.setMode', { mode: 'standalone' }), l.switchedStandalone)}
        >
          {l.switchToStandalone}
        </OutlineButton>
      )}
    </>
  )
}

function ClientPanel({ s, onReload }: { s: LanStatusDto; onReload: () => void }) {
  const { can } = useSession()
  const toast = useToast()
  const host = s.host!
  const [confirm, setConfirm] = useState('')
  const [restarting, setRestarting] = useState(false)

  async function test() {
    try {
      await call('auth.me')
      toast(l.testOk)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
    onReload()
  }

  return (
    <div className="flex flex-col gap-3.5">
      <h2 className="m-0 text-xl font-bold">{l.title}</h2>
      <div className="flex flex-col gap-1 rounded-[18px] border-2 border-[#9776F6] bg-[#F5F2FE] p-4">
        <span className="text-base font-bold">{l.modes.client.title}</span>
        <span className="text-[13px] text-muted-foreground">{l.modes.client.desc}</span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-[1_1_240px] flex-col gap-1.5 text-sm font-semibold">
          {l.hostTitle}
          <TextInput readOnly value={`${host.url} · ${l.hostLine(host.name, host.shopName)}`} />
        </label>
        <OutlineButton onClick={() => void test()}>{l.test}</OutlineButton>
      </div>
      <Chip className="self-start" bg={host.connected ? '#DDF5E8' : '#FFE3E3'} fg={host.connected ? '#11724A' : '#A6232B'}>
        {host.connected ? l.connected : `${l.disconnected}${host.lastError ? ` · ${errorText(host.lastError)}` : ''}`}
      </Chip>
      {s.fingerprint && <span className="font-mono text-xs text-[#7A8090]">{l.fingerprint(s.fingerprint)}</span>}
      <SyncPanel s={s} onReload={onReload} />
      {can('settings:update') && (
        <div className="flex flex-col gap-2 border-t border-border pt-3.5">
          <span className="text-[13px] text-muted-foreground">{l.unpairNote}</span>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-56 flex-col gap-1.5 text-sm font-semibold">
              {l.unpairConfirmLabel}
              <TextInput value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="UNPAIR" autoComplete="off" />
            </label>
            <OutlineButton
              disabled={confirm.trim() !== 'UNPAIR'}
              onClick={() =>
                void call('lan.unpair', { confirm: 'UNPAIR' }).then(
                  (r) => r.restarting && setRestarting(true),
                  (err: unknown) => toast(errorMessage(err), 'error'),
                )
              }
            >
              {l.unpair}
            </OutlineButton>
          </div>
        </div>
      )}
      {restarting && <RestartingOverlay />}
    </div>
  )
}

/** Client offline selling status (D36): queue, reserved numbers, last refresh. */
function SyncPanel({ s, onReload }: { s: LanStatusDto; onReload: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<{ pending: number; rejected: number } | null>(null)
  useAppEvent((e) => {
    if (e.type === 'sync.state') setLive({ pending: e.pending, rejected: e.rejected })
  })
  const sync = s.sync
  if (!sync) return <div className="rounded-[14px] bg-warning px-3.5 py-3 text-[13px] text-warning-foreground">{l.pendingNote}</div>
  const pending = live?.pending ?? sync.pending
  const rejected = live?.rejected ?? sync.rejected
  return (
    <div className="flex flex-col gap-2 rounded-[18px] bg-[#F7F5F2] p-4">
      <span className="text-[13px] font-bold text-primary">{l.syncTitle}</span>
      <span className="text-[13px] text-muted-foreground">{l.pendingNote}</span>
      <div className="flex flex-wrap gap-2">
        <Chip bg={pending ? '#FFF4D6' : '#DDF5E8'} fg={pending ? '#7A5200' : '#11724A'}>
          {l.syncPending(pending)}
        </Chip>
        <Chip bg="#EDE9FB" fg="#4B2FB8">
          {l.numbersLeft(sync.numbersLeft)}
        </Chip>
        {sync.sent > 0 && (
          <Chip bg="#F0EDE8" fg="#5C6270">
            {l.syncSent(sync.sent)}
          </Chip>
        )}
      </div>
      {rejected > 0 && <span className="text-[13px] font-semibold text-danger-foreground">{l.syncRejected(rejected)}</span>}
      <span className="text-xs text-muted-foreground">{sync.lastPullAt ? l.lastPull(formatDateTimeShort(sync.lastPullAt)) : l.neverPulled}</span>
      <OutlineButton
        className="self-start"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void call('lan.syncNow')
            .then(
              (x) => (toast(x.host?.connected ? l.synced : t.errors.LAN_UNREACHABLE, x.host?.connected ? 'success' : 'error'), onReload()),
              (err: unknown) => toast(errorMessage(err), 'error'),
            )
            .finally(() => setBusy(false))
        }}
      >
        {l.syncNow}
      </OutlineButton>
    </div>
  )
}

/** First-run setup, "เชื่อมต่อกับเครื่องหลัก": pair this fresh install with a Host (D34). */
export function JoinHostForm() {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState<string>(l.deviceNameDefault)
  const [kind, setKind] = useState<'pos' | 'kds'>('pos')
  const [ping, setPing] = useState<LanPingDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function check() {
    setError(null)
    setPing(null)
    try {
      const p = await call('lan.ping', { address: address.trim() })
      setPing(p)
      if (!p.ok) setError(errorText(p.error))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const r = await call('lan.pair', { address: address.trim(), code: code.trim(), deviceName: name.trim(), kind })
      setDone(l.paired(r.hostName))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <AuthInput id="host" label={l.hostAddress} icon="monitor" hint={l.hostAddressHint} value={address} onChange={(e) => (setAddress(e.target.value), setPing(null))} required autoFocus />
        </div>
        <OutlineButton type="button" className="mb-6" disabled={address.trim().length < 3} onClick={() => void check()}>
          {l.check}
        </OutlineButton>
      </div>
      {ping?.ok && (
        <div className={cn('rounded-[14px] px-3.5 py-2.5 text-[13px] font-semibold', ping.pairing ? 'bg-success text-success-foreground' : 'bg-warning text-warning-foreground')}>
          {ping.pairing ? l.found(ping.hostName ?? '', ping.shopName) : l.foundNoPairing}
        </div>
      )}
      <AuthInput id="code" label={l.code} icon="lockLogin" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="off" required />
      <AuthInput id="dname" label={l.deviceName} icon="monitor" value={name} onChange={(e) => setName(e.target.value)} required />
      <Segmented label={l.kind} value={kind} onChange={setKind} options={[{ value: 'pos', label: l.kinds.pos }, { value: 'kds', label: l.kinds.kds }]} />
      <FormError message={error} />
      <AuthSubmit busy={busy}>{busy ? t.common.saving : l.pair}</AuthSubmit>
      {done && (
        <div role="alertdialog" className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(31,36,48,0.45)]">
          <div className="rounded-[22px] bg-white px-8 py-6 text-lg font-bold">{done}</div>
        </div>
      )}
    </form>
  )
}

/** A Client that cannot reach its Host (4c-1 has no offline selling yet — D33). */
export function HostOfflinePage() {
  const { offlineCode, system, refresh } = useSession()
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const revoked = offlineCode === 'LAN_DEVICE_REVOKED'
  const cert = offlineCode === 'LAN_CERT_MISMATCH'

  return (
    <AuthLayout>
      <AuthTitle title={l.offlineTitle} subtitle={system?.hostName ? l.chipHost(system.hostName) : ''} />
      <div className={cn('rounded-[14px] px-4 py-3 text-sm', cert || revoked ? 'bg-danger text-danger-foreground' : 'bg-warning text-warning-foreground')}>
        {revoked ? l.revokedBody : cert ? l.certBody : l.offlineBody}
      </div>
      <GradientButton
        size="lg"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void refresh().finally(() => setBusy(false))
        }}
      >
        {l.retry}
      </GradientButton>
      {revoked && (
        <OutlineButton onClick={() => void call('lan.unpair', { confirm: 'UNPAIR' }).then((r) => r.restarting && setRestarting(true), () => {})}>{l.unpair}</OutlineButton>
      )}
      {restarting && <RestartingOverlay />}
    </AuthLayout>
  )
}
