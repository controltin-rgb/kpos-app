import { useCallback, useEffect, useMemo, useState } from 'react'
import { ROADMAP_STATUSES, type AboutInfo, type RoadmapStatus } from '@shared/about'
import type { AboutDto, ManualPageDto, UpdateStatusDto } from '@shared/api-system'
import { useConfirm } from '@renderer/components/confirm'
import { Markdown } from '@renderer/components/markdown'
import { Modal } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, IconTile, inputClass, OutlineButton, PageHeader, SelectInput, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useAppEvent } from '@renderer/lib/events'
import { formatDateTimeShort } from '@renderer/lib/format'
import { useFeatures, useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const a = t.about
const STATUS_CHIP: Record<RoadmapStatus, { bg: string; fg: string }> = {
  planned: { bg: '#EDE9FB', fg: '#4B2FB8' },
  in_progress: { bg: '#FFF4D6', fg: '#7A5200' },
  done: { bg: '#DDF5E8', fg: '#11724A' },
}

// ---------------------------------------------------------------------------
// เกี่ยวกับระบบ
// ---------------------------------------------------------------------------

export function AboutPage() {
  const { system, can } = useSession()
  const features = useFeatures()
  const toast = useToast()
  const [about, setAbout] = useState<AboutDto | null>(null)
  const [editing, setEditing] = useState(false)
  const s = t.system

  useEffect(() => {
    call('system.about').then(setAbout, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [toast])

  const open = (kind: 'kds' | 'cfd') => call('pos.openWindow', { kind }).catch((err: unknown) => toast(errorMessage(err), 'error'))
  const rows: [string, string][] = system
    ? [
        [s.appVersion, system.appVersion],
        [s.schema, `v${system.schemaVersion}`],
        [s.electron, system.electron],
        [s.node, system.node],
        [s.sqlite, system.sqlite],
        [s.platform, system.platform],
      ]
    : []
  const info = about?.info
  const contacts = info ? ([[a.phone, info.contactPhone], [a.email, info.contactEmail], [a.website, info.website]] as const).filter(([, v]) => v) : []

  return (
    <>
      <PageHeader
        icon="info"
        tone="amber"
        title={a.title}
        subtitle={a.subtitle}
        actions={can('system:update') && about && <OutlineButton onClick={() => setEditing(true)}>{a.edit}</OutlineButton>}
      />
      {info && (
        <div className="grid max-w-5xl grid-cols-1 gap-[18px] lg:grid-cols-2">
          <Card className="relative flex flex-col gap-3 overflow-hidden lg:col-span-2">
            <div className="absolute -top-12 -right-12 size-[160px] rounded-full bg-[#FFF4D6]" />
            <div className="relative flex items-center gap-3.5">
              <IconTile icon="cup" tone="orange" size={52} iconSize={26} radius={15} shadow />
              <div className="flex flex-col gap-0.5">
                <h2 className="m-0 text-xl font-bold">{info.productName}</h2>
                <span className="text-sm text-muted-foreground">{a.currentVersion(system?.appVersion ?? info.current.version, '')}</span>
              </div>
            </div>
            {info.description && <p className="relative m-0 text-[15px] leading-relaxed">{info.description}</p>}
            <div className="relative flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {info.vendor && (
                <span>
                  <span className="text-muted-foreground">{a.vendor}: </span>
                  <strong>{info.vendor}</strong>
                </span>
              )}
              {contacts.map(([k, v]) => (
                <span key={k}>
                  <span className="text-muted-foreground">{k}: </span>
                  <strong className="select-text">{v}</strong>
                </span>
              ))}
              {!contacts.length && <span className="text-muted-foreground">{a.noContact}</span>}
            </div>
            <span className="relative text-xs text-muted-foreground">{about.edited && about.updatedAt ? a.editedAt(formatDateTimeShort(about.updatedAt)) : a.defaultText}</span>
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-bold">{a.current}</h2>
            <Chip className="self-start">{a.currentVersion(info.current.version, info.current.date)}</Chip>
            <ul className="m-0 flex flex-col gap-1.5 pl-5 text-[15px] leading-relaxed">
              {info.current.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Card>

          <Card className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-bold">{a.upcoming}</h2>
            {info.upcoming.length === 0 && <span className="text-sm text-muted-foreground">{a.noUpcoming}</span>}
            <div className="flex flex-col gap-2.5">
              {info.upcoming.map((u, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-2xl border border-border px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-[15px]">{u.title}</strong>
                    <Chip bg={STATUS_CHIP[u.status].bg} fg={STATUS_CHIP[u.status].fg}>
                      {a.statuses[u.status]}
                    </Chip>
                  </div>
                  {u.detail && <span className="text-sm text-muted-foreground">{u.detail}</span>}
                  {u.eta && <span className="text-xs text-muted-foreground">{a.eta(u.eta)}</span>}
                </div>
              ))}
            </div>
          </Card>

          {features.autoUpdate && <UpdateCard />}

          <Card className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-bold">{a.machine}</h2>
            <dl className="m-0 grid grid-cols-2 gap-y-2 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="m-0 font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {can('pos:view') && (features.cfd || features.kds) && (
            <Card className="flex flex-col gap-3 lg:col-span-2">
              <strong>{t.windows.title}</strong>
              <div className="flex flex-wrap gap-2.5">
                {features.cfd && <OutlineButton onClick={() => void open('cfd')}>{t.windows.openCfd}</OutlineButton>}
                {features.kds && <OutlineButton onClick={() => void open('kds')}>{t.windows.openKds}</OutlineButton>}
              </div>
              <span className="text-xs text-muted-foreground">{t.windows.hint}</span>
            </Card>
          )}
        </div>
      )}
      {editing && about && (
        <AboutEditor
          about={about}
          onClose={() => setEditing(false)}
          onSaved={(d) => {
            setAbout(d)
            setEditing(false)
            toast(a.saved)
          }}
        />
      )}
    </>
  )
}

function UpdateCard() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const u = t.update
  const [st, setSt] = useState<UpdateStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    call('update.status').then(setSt, () => {})
  }, [])
  useAppEvent((e) => {
    if (e.type === 'update.state') setSt((prev) => ({ ...e.status, feedUrl: prev?.feedUrl ?? e.status.feedUrl, configured: prev?.configured ?? e.status.configured }))
  })
  if (!st) return null
  const text =
    st.state === 'available' ? u.states.available(st.version ?? '') : st.state === 'downloading' ? u.states.downloading(st.version ?? '', st.percent ?? 0) : st.state === 'ready' ? u.states.ready(st.version ?? '') : u.states[st.state]
  const tone = st.state === 'error' ? 'bg-danger text-danger-foreground' : st.state === 'ready' || st.state === 'available' ? 'bg-success text-success-foreground' : 'bg-accent text-accent-foreground'
  async function check() {
    setBusy(true)
    try {
      setSt(await call('update.check'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  async function install() {
    if (!(await confirm({ kind: 'warning', title: u.install, message: u.installConfirm, confirmLabel: u.install }))) return
    await call('update.install').catch((err: unknown) => toast(errorMessage(err), 'error'))
  }
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-bold">{u.title}</h2>
      <span className="text-sm text-muted-foreground">{u.current(st.currentVersion)}</span>
      {st.configured || st.state === 'unsupported' ? (
        <span className={cn('rounded-xl px-3 py-2 text-[13px]', tone)}>
          {text}
          {st.state === 'error' && st.error ? ` — ${st.error}` : ''}
        </span>
      ) : (
        <span className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{u.notConfigured}</span>
      )}
      {st.checkedAt && <span className="text-xs text-muted-foreground">{u.checkedAt(formatDateTimeShort(st.checkedAt))}</span>}
      {can('settings:update') && st.state !== 'unsupported' && (
        <div className="flex flex-wrap gap-2.5">
          <OutlineButton disabled={busy || !st.configured || st.state === 'checking' || st.state === 'downloading'} onClick={() => void check()}>
            {busy || st.state === 'checking' ? u.checking : u.check}
          </OutlineButton>
          {st.state === 'ready' && <GradientButton onClick={() => void install()}>{u.install}</GradientButton>}
        </div>
      )}
    </Card>
  )
}

function AboutEditor({ about, onClose, onSaved }: { about: AboutDto; onClose: () => void; onSaved: (d: AboutDto) => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [d, setD] = useState<AboutInfo>(about.info)
  const [notes, setNotes] = useState(about.info.current.notes.join('\n'))
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<AboutInfo>) => setD({ ...d, ...patch })
  const setItem = (i: number, patch: Partial<AboutInfo['upcoming'][number]>) => set({ upcoming: d.upcoming.map((u, j) => (j === i ? { ...u, ...patch } : u)) })
  const dateOk = /^(\d{4}-\d{2}-\d{2})?$/.test(d.current.date)

  async function save(info: AboutInfo | null) {
    setBusy(true)
    try {
      onSaved(await call('system.saveAbout', { info }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  const payload = (): AboutInfo => ({
    ...d,
    current: { ...d.current, notes: notes.split('\n').map((x) => x.trim()).filter(Boolean) },
    upcoming: d.upcoming.filter((u) => u.title.trim()),
  })

  return (
    <Modal
      title={a.editTitle}
      onClose={onClose}
      width={720}
      footer={
        <div className="flex flex-wrap gap-2.5">
          {about.edited && (
            <OutlineButton
              disabled={busy}
              onClick={async () => {
                if (await confirm({ kind: 'warning', title: a.resetDefault, message: a.resetConfirm, confirmLabel: a.resetDefault })) void save(null)
              }}
            >
              {a.resetDefault}
            </OutlineButton>
          )}
          <span className="flex-1" />
          <OutlineButton onClick={onClose}>{t.common.cancel}</OutlineButton>
          <GradientButton disabled={busy || !d.productName.trim() || !dateOk} onClick={() => void save(payload())}>
            {busy ? t.common.saving : t.common.save}
          </GradientButton>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label={a.productName}>
            <TextInput value={d.productName} maxLength={80} onChange={(e) => set({ productName: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label={a.description}>
            <textarea className={cn(inputClass, 'min-h-20 py-2')} value={d.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
        <Field label={a.vendor}>
          <TextInput value={d.vendor} maxLength={120} onChange={(e) => set({ vendor: e.target.value })} />
        </Field>
        <Field label={a.phone}>
          <TextInput value={d.contactPhone} maxLength={40} onChange={(e) => set({ contactPhone: e.target.value })} />
        </Field>
        <Field label={a.email}>
          <TextInput value={d.contactEmail} maxLength={120} onChange={(e) => set({ contactEmail: e.target.value })} />
        </Field>
        <Field label={a.website}>
          <TextInput value={d.website} maxLength={200} onChange={(e) => set({ website: e.target.value })} />
        </Field>
      </div>

      <h3 className="m-0 mt-2 text-base font-bold">{a.current}</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label={a.version}>
          <TextInput value={d.current.version} maxLength={30} onChange={(e) => set({ current: { ...d.current, version: e.target.value } })} />
        </Field>
        <Field label={a.date} error={dateOk ? undefined : t.errors.INVALID_INPUT}>
          <TextInput value={d.current.date} maxLength={10} placeholder="2026-11-08" onChange={(e) => set({ current: { ...d.current, date: e.target.value.trim() } })} />
        </Field>
        <div className="col-span-2">
          <Field label={a.notes}>
            <textarea className={cn(inputClass, 'min-h-32 py-2')} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </div>

      <h3 className="m-0 mt-2 text-base font-bold">{a.upcoming}</h3>
      <div className="flex flex-col gap-3">
        {d.upcoming.map((u, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr] gap-2.5 rounded-2xl border border-border p-3">
            <Field label={a.itemTitle}>
              <TextInput value={u.title} maxLength={120} onChange={(e) => setItem(i, { title: e.target.value })} />
            </Field>
            <Field label={a.itemEta}>
              <TextInput value={u.eta} maxLength={40} onChange={(e) => setItem(i, { eta: e.target.value })} />
            </Field>
            <Field label={a.itemStatus}>
              <SelectInput value={u.status} onChange={(e) => setItem(i, { status: e.target.value as RoadmapStatus })}>
                {ROADMAP_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {a.statuses[s]}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <div className="col-span-3 flex items-end gap-2.5">
              <div className="flex-1">
                <Field label={a.itemDetail}>
                  <TextInput value={u.detail} maxLength={300} onChange={(e) => setItem(i, { detail: e.target.value })} />
                </Field>
              </div>
              <DangerButton className="min-h-11" onClick={() => set({ upcoming: d.upcoming.filter((_, j) => j !== i) })}>
                {a.removeItem}
              </DangerButton>
            </div>
          </div>
        ))}
        {d.upcoming.length < 50 && (
          <OutlineButton className="self-start" onClick={() => set({ upcoming: [...d.upcoming, { title: '', detail: '', eta: '', status: 'planned' }] })}>
            {a.addItem}
          </OutlineButton>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// คู่มือการใช้งานระบบ
// ---------------------------------------------------------------------------

export function ManualPage() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const m = t.manual
  const editable = can('manual:update')
  const [pages, setPages] = useState<ManualPageDto[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<ManualPageDto | 'new' | null>(null)

  const load = useCallback(
    () =>
      call('manual.list', { includeHidden: editable && showHidden }).then(
        (p) => {
          setPages(p)
          setSel((cur) => (cur && p.some((x) => x.slug === cur) ? cur : (p[0]?.slug ?? null)))
        },
        (err: unknown) => toast(errorMessage(err), 'error'),
      ),
    [editable, showHidden, toast],
  )
  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? pages.filter((p) => p.title.toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle)) : pages
  }, [pages, q])
  const cur = pages.find((p) => p.slug === sel) ?? null

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn()
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <PageHeader
        icon="info"
        tone="amber"
        title={m.title}
        subtitle={m.subtitle}
        actions={editable && <OutlineButton onClick={() => setEditing('new')}>{m.add}</OutlineButton>}
      />
      <div className="grid max-w-6xl grid-cols-1 gap-[18px] lg:grid-cols-[300px_1fr]">
        <Card className="flex flex-col gap-3 self-start">
          <TextInput type="search" placeholder={m.search} aria-label={m.search} value={q} onChange={(e) => setQ(e.target.value)} />
          {editable && (
            <div className="flex min-h-11 items-center justify-between gap-2 text-sm">
              {m.showHidden}
              <Toggle checked={showHidden} label={m.showHidden} onChange={setShowHidden} />
            </div>
          )}
          <nav aria-label={m.pages} className="flex flex-col gap-1">
            {filtered.map((p) => (
              <button
                key={p.slug}
                type="button"
                onClick={() => setSel(p.slug)}
                aria-current={p.slug === sel ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border-0 px-3 text-left font-[inherit] text-[15px]',
                  p.slug === sel ? 'bg-accent font-bold text-accent-foreground' : 'bg-transparent text-foreground hover:bg-[#F7F5F2]',
                  p.hidden && 'opacity-60',
                )}
              >
                <span className="flex-1">{p.title}</span>
                {p.hidden && <span className="text-xs">{m.hiddenChip}</span>}
              </button>
            ))}
            {!filtered.length && <span className="px-3 text-sm text-muted-foreground">{m.empty}</span>}
          </nav>
        </Card>

        {cur && (
          <Card className="flex min-w-0 flex-col gap-3">
            {editable && (
              <div className="flex flex-wrap items-center gap-2">
                {cur.edited && cur.builtin && <Chip bg="#FFF4D6" fg="#7A5200">{m.editedChip}</Chip>}
                {!cur.builtin && <Chip>{m.customChip}</Chip>}
                {cur.hidden && <Chip bg="#FFE3E3" fg="#A6232B">{m.hiddenChip}</Chip>}
                <span className="flex-1" />
                <OutlineButton onClick={() => setEditing(cur)}>{m.edit}</OutlineButton>
                <OutlineButton onClick={() => void act(() => call('manual.save', { slug: cur.slug, title: cur.title, body: cur.body, sort: cur.sort, hidden: !cur.hidden }))}>
                  {cur.hidden ? m.show : m.hide}
                </OutlineButton>
                {cur.builtin && cur.edited && (
                  <OutlineButton
                    onClick={async () => {
                      if (await confirm({ kind: 'warning', title: m.reset, message: m.resetConfirm, confirmLabel: m.reset })) void act(() => call('manual.reset', { slug: cur.slug }))
                    }}
                  >
                    {m.reset}
                  </OutlineButton>
                )}
                {!cur.builtin && (
                  <DangerButton
                    className="min-h-11"
                    onClick={async () => {
                      if (await confirm({ kind: 'danger', title: t.confirmDialog.deleteTitle, message: m.removeConfirm(cur.title), confirmLabel: m.remove })) void act(() => call('manual.reset', { slug: cur.slug }))
                    }}
                  >
                    {m.remove}
                  </DangerButton>
                )}
              </div>
            )}
            <article className="min-w-0 break-words">
              <Markdown text={cur.body} />
            </article>
            {cur.edited && cur.updatedAt && <span className="text-xs text-muted-foreground">{m.updatedBy(cur.updatedByName ?? '—', formatDateTimeShort(cur.updatedAt))}</span>}
          </Card>
        )}
      </div>
      {editing && (
        <ManualEditor
          page={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null)
            setSel(p.slug)
            toast(m.saved)
            void load()
          }}
        />
      )}
    </>
  )
}

function ManualEditor({ page, onClose, onSaved }: { page: ManualPageDto | null; onClose: () => void; onSaved: (p: ManualPageDto) => void }) {
  const toast = useToast()
  const m = t.manual
  const [title, setTitle] = useState(page?.title ?? '')
  const [body, setBody] = useState(page?.body ?? '# ')
  const [sort, setSort] = useState(page ? String(page.sort) : '')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const sortNum = sort.trim() === '' ? undefined : Number(sort)
  const sortOk = sortNum === undefined || (Number.isInteger(sortNum) && sortNum >= 0)

  async function save() {
    setBusy(true)
    try {
      onSaved(await call('manual.save', { slug: page?.slug ?? null, title: title.trim(), body, ...(sortNum !== undefined ? { sort: sortNum } : {}), hidden: page?.hidden ?? false }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={page ? m.editTitle : m.newTitle}
      onClose={onClose}
      width={860}
      footer={
        <div className="flex gap-2.5">
          <span className="flex-1" />
          <OutlineButton onClick={onClose}>{t.common.cancel}</OutlineButton>
          <GradientButton disabled={busy || !title.trim() || !sortOk} onClick={() => void save()}>
            {busy ? t.common.saving : t.common.save}
          </GradientButton>
        </div>
      }
    >
      <div className="grid grid-cols-[3fr_1fr] gap-3">
        <Field label={m.pageTitle}>
          <TextInput value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={m.order} error={sortOk ? undefined : t.errors.INVALID_INPUT}>
          <TextInput inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{m.formatHint}</span>
        <div className="flex min-h-11 items-center gap-2 text-sm">
          {m.preview}
          <Toggle checked={preview} label={m.preview} onChange={setPreview} />
        </div>
      </div>
      {preview ? (
        <div className="max-h-[50vh] overflow-auto rounded-2xl border border-border p-4">
          <Markdown text={body} />
        </div>
      ) : (
        <textarea aria-label={m.body} className={cn(inputClass, 'min-h-[50vh] py-3 font-mono text-sm leading-relaxed')} value={body} maxLength={100_000} onChange={(e) => setBody(e.target.value)} />
      )}
    </Modal>
  )
}
