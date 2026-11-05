import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RoleOption, UserDetail, UserList } from '@shared/api'
import { countActions, RESOURCE_KEYS, roleColors } from '@renderer/components/role-style'
import {
  Card,
  Chip,
  DangerButton,
  Field,
  GradientButton,
  OutlineButton,
  PageHeader,
  Pagination,
  SelectInput,
  TextInput,
  Toggle,
  useToast,
} from '@renderer/components/ui'
import { t } from '@renderer/i18n'
import { call, errorMessage, fieldErrors } from '@renderer/lib/api'
import { formatDateTimeShort, initials } from '@renderer/lib/format'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const u = t.users

interface Draft {
  displayName: string
  username: string
  roleId: string
  mustChangePassword: boolean
  active: boolean
  password: string
  pin: string
}

const emptyDraft = (roleId = ''): Draft => ({
  displayName: '',
  username: '',
  roleId,
  mustChangePassword: true,
  active: true,
  password: '',
  pin: '',
})

function Avatar({ name, roleKey, size }: { name: string; roleKey: string | null; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: roleColors(roleKey).g }}
    >
      {initials(name)}
    </span>
  )
}

/** docs/design/Users.dc.html */
export function UsersPage() {
  const { can, user: me } = useSession()
  const toast = useToast()
  const [filters, setFilters] = useState({ search: '', roleId: '', status: 'all' as 'all' | 'active' | 'inactive', page: 1 })
  const [list, setList] = useState<UserList | null>(null)
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [selected, setSelected] = useState<UserDetail | null>(null)
  const [mode, setMode] = useState<'edit' | 'create'>('edit')
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetPw, setResetPw] = useState('')

  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  const load = useCallback(async () => {
    try {
      const res = await call('users.list', {
        page: filters.page,
        status: filters.status,
        ...(filters.search ? { search: filters.search } : {}),
        ...(filters.roleId ? { roleId: filters.roleId } : {}),
      })
      setList(res)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [filters, toast])

  useEffect(() => {
    const h = setTimeout(() => void load(), filters.search ? 250 : 0)
    return () => clearTimeout(h)
  }, [load, filters.search])

  useEffect(() => {
    call('users.roleOptions').then(setRoles, (err: unknown) => toast(errorMessage(err), 'error'))
  }, [toast])

  function fillDraft(d: UserDetail) {
    setSelected(d)
    setMode('edit')
    setFields({})
    setResetOpen(false)
    setDraft({ displayName: d.displayName, username: d.username, roleId: d.roleId, mustChangePassword: d.mustChangePassword, active: d.active, password: '', pin: '' })
  }

  async function select(id: string) {
    try {
      fillDraft(await call('users.get', { id }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  function startCreate() {
    setSelected(null)
    setMode('create')
    setFields({})
    setDraft(emptyDraft(roles.find((r) => r.assignable && r.key === 'cashier')?.id ?? roles.find((r) => r.assignable)?.id ?? ''))
  }

  async function run<T>(fn: () => Promise<T>, okMsg: string): Promise<T | undefined> {
    setBusy(true)
    setFields({})
    try {
      const res = await fn()
      toast(okMsg)
      await load()
      return res
    } catch (err) {
      setFields(fieldErrors(err))
      toast(errorMessage(err), 'error')
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (mode === 'create') {
      const created = await run(
        () =>
          call('users.create', {
            displayName: draft.displayName,
            username: draft.username,
            roleId: draft.roleId,
            password: draft.password,
            mustChangePassword: draft.mustChangePassword,
            ...(draft.pin ? { pin: draft.pin } : {}),
          }),
        u.created,
      )
      if (created) fillDraft(created)
      return
    }
    if (!selected) return
    const patch = {
      id: selected.id,
      ...(draft.displayName !== selected.displayName ? { displayName: draft.displayName } : {}),
      ...(draft.username !== selected.username ? { username: draft.username } : {}),
      ...(draft.roleId !== selected.roleId ? { roleId: draft.roleId } : {}),
      ...(draft.mustChangePassword !== selected.mustChangePassword ? { mustChangePassword: draft.mustChangePassword } : {}),
      ...(draft.active !== selected.active ? { active: draft.active } : {}),
    }
    const updated = await run(() => call('users.update', patch), u.saved)
    if (updated) fillDraft(updated)
  }

  async function toggleRow(id: string, active: boolean) {
    const updated = await run(() => call('users.update', { id, active }), u.saved)
    if (updated && selected?.id === id) fillDraft(updated)
  }

  async function setPin() {
    if (!selected) return
    const updated = await run(() => call('users.setPin', { id: selected.id, pin: draft.pin }), u.pinSaved)
    if (updated) fillDraft(updated)
  }

  async function resetPassword() {
    if (!selected) return
    const updated = await run(() => call('users.resetPassword', { id: selected.id, newPassword: resetPw }), u.resetPasswordDone)
    if (updated) {
      setResetPw('')
      fillDraft(updated)
    }
  }

  async function remove() {
    if (!selected || !window.confirm(u.deleteConfirm(selected.displayName))) return
    const ok = await run(() => call('users.delete', { id: selected.id }), u.deleted)
    if (ok !== undefined) {
      setSelected(null)
      setDraft(emptyDraft())
    }
  }

  const full = !!list && list.activeCount >= list.employeeCap
  const editing = mode === 'create' || !!selected
  const canEdit = mode === 'create' ? can('users:create') : !!selected?.editable && can('users:update')
  const isSelf = selected?.id === me?.userId
  const draftRole = roleById.get(draft.roleId)
  const draftRoleStats = draftRole ? countActions(draftRole.permissions) : null

  return (
    <>
      <PageHeader
        icon="users"
        title={u.title}
        subtitle={u.subtitle}
        actions={
          can('users:create') && (
            <GradientButton onClick={startCreate} disabled={full}>
              {u.add}
            </GradientButton>
          )
        }
      />

      {list && (
        <section aria-label={u.quotaLabel} className="relative flex flex-wrap items-center gap-[18px] overflow-hidden rounded-[20px] bg-white px-[22px] py-[18px] shadow-[0_1px_3px_rgba(40,30,60,0.08)]">
          <div className="absolute -top-10 -right-[30px] size-[140px] rounded-full bg-accent" />
          <div className="relative flex shrink-0 flex-col gap-0.5">
            <span className="text-[13px] text-muted-foreground">{u.quotaLabel}</span>
            <span className="text-[28px] font-bold">
              {list.activeCount} <span className="text-base font-medium text-muted-foreground">{u.quotaUnit(list.employeeCap)}</span>
            </span>
          </div>
          <div className="relative flex flex-[1_1_260px] flex-col gap-1.5">
            <div className="h-3 overflow-hidden rounded-md bg-border">
              <div
                className="h-full rounded-md"
                style={{
                  width: `${Math.min(100, (list.activeCount / Math.max(1, list.employeeCap)) * 100)}%`,
                  background: full ? 'linear-gradient(90deg,#F4616A,#DC3A44)' : 'linear-gradient(90deg,#6A47DB,#9776F6)',
                }}
              />
            </div>
            <span className="text-[13px] text-muted-foreground">{u.quotaNote(list.employeeCap)}</span>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_560px] flex-col gap-3.5">
          <div className="flex flex-wrap gap-2.5">
            <TextInput
              type="search"
              placeholder={u.search}
              aria-label={u.searchLabel}
              className="flex-[2_1_200px]"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            />
            <SelectInput aria-label={u.filterRole} className="flex-[1_1_140px]" value={filters.roleId} onChange={(e) => setFilters((f) => ({ ...f, roleId: e.target.value, page: 1 }))}>
              <option value="">{u.allRoles}</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </SelectInput>
            <SelectInput
              aria-label={u.filterStatus}
              className="flex-[1_1_120px]"
              value={filters.status}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as typeof f.status, page: 1 }))}
            >
              <option value="all">{u.allStatus}</option>
              <option value="active">{u.statusActive}</option>
              <option value="inactive">{u.statusInactive}</option>
            </SelectInput>
          </div>

          <div className="flex items-center gap-3 px-3 text-xs font-bold text-[#7A8090]">
            <span className="flex-[2_1_0]">{u.colUser}</span>
            <span className="flex-[1.2_1_0]">{u.colRole}</span>
            <span className="flex-[1.2_1_0]">{u.colLastLogin}</span>
            <span className="flex-[0_0_52px]">{u.colStatus}</span>
          </div>
          <div role="list" className="flex flex-col gap-1.5">
            {list?.items.map((row) => {
              const role = roleById.get(row.roleId)
              const colors = roleColors(role?.key ?? null)
              const sel = row.id === selected?.id
              return (
                <div
                  key={row.id}
                  role="listitem"
                  onClick={() => void select(row.id)}
                  className={cn(
                    'box-border flex min-h-[60px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-1.5',
                    sel ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]',
                    !row.active && 'opacity-65',
                  )}
                >
                  <div className="flex min-w-0 flex-[2_1_0] items-center gap-3">
                    <Avatar name={row.displayName} roleKey={role?.key ?? null} size={40} />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-[15px] font-semibold">{row.displayName}</span>
                      <span className="text-xs text-muted-foreground">@{row.username}</span>
                    </div>
                  </div>
                  <div className="flex-[1.2_1_0]">
                    <Chip bg={colors.bg} fg={colors.fg}>
                      {row.roleName}
                    </Chip>
                  </div>
                  <span className="flex-[1.2_1_0] text-[13px] text-muted-foreground">
                    {row.locked ? <Chip bg="#FFF4D6" fg="#7A5200">{u.locked}</Chip> : row.lastLoginAt ? formatDateTimeShort(row.lastLoginAt) : u.never}
                  </span>
                  <Toggle
                    checked={row.active}
                    label={u.toggleActive(row.displayName)}
                    disabled={!can('users:update') || busy || row.id === me?.userId || (!row.active && full)}
                    onChange={(next) => void toggleRow(row.id, next)}
                  />
                </div>
              )
            })}
            {list && list.items.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">{u.empty}</div>}
          </div>
          {list && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-muted-foreground">{u.showing(list.items.length, list.total)}</span>
              <Pagination page={list.page} pageSize={list.pageSize} total={list.total} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
            </div>
          )}
        </Card>

        <aside
          aria-label={mode === 'create' ? u.createTitle : u.editTitle}
          className="box-border flex max-w-full flex-[0_0_380px] flex-col gap-3.5 rounded-[22px] bg-white p-[22px] shadow-[0_10px_30px_rgba(60,40,90,0.08)]"
        >
          {!editing ? (
            <p className="m-0 py-10 text-center text-sm text-muted-foreground">{u.selectHint}</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Avatar name={draft.displayName || '?'} roleKey={draftRole?.key ?? null} size={48} />
                <div className="flex flex-col">
                  <span className="text-lg font-bold">{mode === 'create' ? u.createTitle : u.editTitle}</span>
                  {draft.username && <span className="text-[13px] text-muted-foreground">@{draft.username}</span>}
                </div>
              </div>
              {!canEdit && <Chip bg="#FFF4D6" fg="#7A5200">{u.readOnly}</Chip>}

              <Field label={u.fullName} error={fields['displayName']}>
                <TextInput value={draft.displayName} disabled={!canEdit} invalid={!!fields['displayName']} onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))} />
              </Field>
              <Field label={u.username} error={fields['username']}>
                <TextInput value={draft.username} disabled={!canEdit} invalid={!!fields['username']} autoComplete="off" onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))} />
              </Field>
              <Field label={u.role} error={fields['roleId']}>
                <SelectInput value={draft.roleId} disabled={!canEdit || isSelf} onChange={(e) => setDraft((d) => ({ ...d, roleId: e.target.value }))}>
                  {roles
                    .filter((r) => r.assignable || r.id === draft.roleId)
                    .map((r) => (
                      <option key={r.id} value={r.id} disabled={!r.assignable}>
                        {r.name}
                      </option>
                    ))}
                </SelectInput>
              </Field>
              {draftRole && draftRoleStats && (
                <div className="flex flex-col gap-1 rounded-[14px] bg-[#F7F5F2] px-3.5 py-3">
                  <span className="text-[13px] font-bold text-accent-foreground">{u.roleRights}</span>
                  {draftRole.description && <span className="text-[13px] text-muted-foreground">{draftRole.description}</span>}
                  <span className="text-[13px]">{u.rolePages(draftRoleStats.pages, RESOURCE_KEYS.length)}</span>
                </div>
              )}

              {mode === 'create' && (
                <Field label={u.password} error={fields['password']} hint={u.passwordHint}>
                  <TextInput type="password" autoComplete="new-password" value={draft.password} invalid={!!fields['password']} onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))} />
                </Field>
              )}

              <Field label={u.pin} error={fields['pin']}>
                <div className="flex gap-2">
                  <TextInput
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    aria-label="PIN"
                    className="flex-1"
                    disabled={!canEdit}
                    placeholder={selected?.hasPin ? u.pinPlaceholderSet : u.pinPlaceholderEmpty}
                    value={draft.pin}
                    onChange={(e) => setDraft((d) => ({ ...d, pin: e.target.value.replace(/\D/g, '') }))}
                  />
                  {mode === 'edit' && (
                    <OutlineButton className="rounded-[14px] px-4 text-sm" disabled={!canEdit || busy || !/^\d{4,6}$/.test(draft.pin)} onClick={() => void setPin()}>
                      {u.pinReset}
                    </OutlineButton>
                  )}
                </div>
              </Field>

              <div className="flex min-h-12 items-center justify-between">
                <span className="text-[15px]">{u.forceChange}</span>
                <Toggle checked={draft.mustChangePassword} label={u.forceChange} disabled={!canEdit} onChange={(v) => setDraft((d) => ({ ...d, mustChangePassword: v }))} />
              </div>
              {mode === 'edit' && (
                <div className="flex min-h-12 items-center justify-between">
                  <span className="text-[15px]">{u.active}</span>
                  <Toggle checked={draft.active} label={u.active} disabled={!canEdit || isSelf} onChange={(v) => setDraft((d) => ({ ...d, active: v }))} />
                </div>
              )}

              {mode === 'edit' && canEdit && (
                <>
                  <OutlineButton onClick={() => setResetOpen((v) => !v)} aria-expanded={resetOpen} className="rounded-[22px]">
                    {u.resetPassword}
                  </OutlineButton>
                  {resetOpen && (
                    <div className="flex flex-col gap-2 rounded-[14px] bg-[#F7F5F2] p-3">
                      <span className="text-xs text-muted-foreground">{u.resetPasswordPrompt}</span>
                      <div className="flex gap-2">
                        <TextInput type="password" autoComplete="new-password" value={resetPw} invalid={!!fields['newPassword']} onChange={(e) => setResetPw(e.target.value)} className="flex-1" />
                        <OutlineButton className="rounded-[14px] px-4 text-sm" disabled={busy || resetPw.length < 8} onClick={() => void resetPassword()}>
                          {t.common.confirm}
                        </OutlineButton>
                      </div>
                    </div>
                  )}
                </>
              )}

              {canEdit && (
                <div className="flex gap-2.5">
                  <GradientButton size="lg" className="flex-1 rounded-[26px] text-base" disabled={busy} onClick={() => void save()}>
                    {busy ? t.common.saving : mode === 'create' ? u.create : u.save}
                  </GradientButton>
                  {mode === 'edit' && can('users:delete') && !isSelf && (
                    <DangerButton className="rounded-[26px]" disabled={busy} onClick={() => void remove()}>
                      {u.delete}
                    </DangerButton>
                  )}
                </div>
              )}
              <span className="text-xs text-[#7A8090]">{u.auditNote}</span>
            </>
          )}
        </aside>
      </div>
    </>
  )
}
