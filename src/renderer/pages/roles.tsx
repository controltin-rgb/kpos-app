import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RoleSummary } from '@shared/api'
import { CRUD, normalizePermissions, RESOURCES, SPECIAL_PERMISSIONS, WILDCARD, type CrudAction, type Permission, type Resource } from '@shared/permissions'
import { countActions, RESOURCE_KEYS, visibleResources } from '@renderer/components/role-style'
import { Card, Chip, DangerButton, Field, GradientButton, OutlineButton, PageHeader, TextInput, Toggle, useToast } from '@renderer/components/ui'
import { useConfirm } from '@renderer/components/confirm'
import { t } from '@renderer/i18n'
import { call, errorMessage } from '@renderer/lib/api'
import { useSession } from '@renderer/lib/session'
import { cn } from '@renderer/lib/utils'

const r = t.roles

interface Draft {
  name: string
  description: string
  perms: string[]
}

const toDraft = (role: RoleSummary): Draft => ({ name: role.name, description: role.description ?? '', perms: [...role.permissions].sort() })
const sameDraft = (a: Draft, b: Draft) => a.name === b.name && a.description === b.description && a.perms.join() === b.perms.join()

/** docs/design/Roles.dc.html */
export function RolesPage() {
  const { can } = useSession()
  const toast = useToast()
  const confirm = useConfirm()
  const [roles, setRoles] = useState<RoleSummary[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const apply = useCallback((list: RoleSummary[], keep?: string) => {
    setRoles(list)
    const pick = list.find((x) => x.id === keep) ?? list[0]
    if (pick) {
      setSelId(pick.id)
      setDraft(toDraft(pick))
    }
  }, [])

  const load = useCallback(
    async (keep?: string) => {
      try {
        apply(await call('roles.list'), keep)
      } catch (err) {
        toast(errorMessage(err), 'error')
      }
    },
    [apply, toast],
  )

  useEffect(() => {
    let alive = true
    call('roles.list').then(
      (list) => alive && apply(list),
      (err: unknown) => toast(errorMessage(err), 'error'),
    )
    return () => {
      alive = false
    }
  }, [apply, toast])

  const cur = roles.find((x) => x.id === selId) ?? null
  const dirty = !!cur && !!draft && !sameDraft(draft, toDraft(cur))
  const editable = !!cur?.editable && can('roles:update')
  const isAll = !!draft?.perms.includes(WILDCARD)
  const stats = useMemo(() => countActions(draft?.perms ?? []), [draft])

  async function select(role: RoleSummary) {
    if (dirty && !(await confirm({ kind: 'warning', title: r.dirty, message: t.confirmDialog.discardBody, confirmLabel: t.confirmDialog.discard }))) return
    setSelId(role.id)
    setDraft(toDraft(role))
    setJustSaved(false)
  }

  function setPerms(fn: (s: Set<string>) => void) {
    setDraft((d) => {
      if (!d) return d
      const s = new Set(d.perms)
      fn(s)
      return { ...d, perms: normalizePermissions([...s] as Permission[]) }
    })
    setJustSaved(false)
  }

  /** Same rules as the prototype: turning off "view" clears the row; any action turns "view" on. */
  function toggleCrud(res: Resource, act: CrudAction) {
    setPerms((s) => {
      const key = `${res}:${act}`
      if (act === 'view') {
        if (s.has(key)) RESOURCES[res].forEach((a) => s.delete(`${res}:${a}`))
        else s.add(key)
      } else if (s.has(key)) s.delete(key)
      else s.add(key)
    })
  }

  function toggleSpecial(p: string) {
    setPerms((s) => {
      if (s.has(p)) s.delete(p)
      else s.add(p)
    })
  }

  async function save() {
    if (!cur || !draft) return
    setBusy(true)
    try {
      const updated = await call('roles.update', {
        id: cur.id,
        permissions: draft.perms,
        ...(draft.name !== cur.name ? { name: draft.name } : {}),
        ...(draft.description !== (cur.description ?? '') ? { description: draft.description || null } : {}),
      })
      await load(updated.id)
      setJustSaved(true)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    setBusy(true)
    try {
      const role = await call('roles.create', { name: r.newRoleName, permissions: ['dashboard:view'] })
      await load(role.id)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!cur || !(await confirm({ kind: 'danger', title: t.confirmDialog.deleteTitle, message: r.deleteConfirm(cur.name), confirmLabel: t.confirmDialog.delete }))) return
    setBusy(true)
    try {
      await call('roles.delete', { id: cur.id })
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const has = (p: string) => isAll || !!draft?.perms.includes(p)

  return (
    <>
      <PageHeader
        icon="shield"
        title={r.title}
        subtitle={r.subtitle}
        actions={can('roles:create') && <GradientButton onClick={() => void create()} disabled={busy}>{r.add}</GradientButton>}
      />

      <div className="flex flex-wrap items-start gap-[18px] pb-[90px]">
        <Card className="box-border flex max-w-full flex-[0_0_290px] flex-col gap-2 p-4">
          <span className="px-1.5 py-0.5 text-[13px] font-bold tracking-[0.04em] text-[#6A47DB]">{r.listTitle(roles.length)}</span>
          {roles.map((role) => {
            const sel = role.id === selId
            return (
              <button
                key={role.id}
                type="button"
                aria-pressed={sel}
                onClick={() => void select(role)}
                className={cn(
                  'box-border flex min-h-[60px] w-full cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-2 text-foreground',
                  sel ? 'border-[#9776F6] bg-[#F5F2FE]' : 'border-transparent bg-[#F7F5F2]',
                )}
              >
                <span className={cn('size-3 shrink-0 rounded-full', role.locked ? 'bg-[#6A47DB]' : 'bg-[#B9B3A9]')} />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-px text-left">
                  <span className="text-[15px] font-bold">{role.name}</span>
                  <span className="text-xs text-muted-foreground">{r.listMeta(role.userCount, visibleResources(role.permissions).length)}</span>
                </span>
                {role.isSystem && <span className="rounded-[10px] bg-accent px-2 py-[3px] text-[11px] font-bold text-accent-foreground">{r.system}</span>}
              </button>
            )
          })}
        </Card>

        {cur && draft && (
          <div className="flex min-w-0 flex-[1_1_640px] flex-col gap-[18px]">
            <Card className="relative flex flex-col gap-3 overflow-hidden px-[22px]">
              <div className="absolute -top-[50px] -right-10 size-[170px] rounded-full bg-accent" />
              {editable && !cur.isSystem ? (
                <div className="relative flex flex-wrap gap-3">
                  <div className="flex-[1_1_220px]">
                    <Field label={r.name}>
                      <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                    </Field>
                  </div>
                  <div className="flex-[2_1_300px]">
                    <Field label={r.description}>
                      <TextInput value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                    </Field>
                  </div>
                </div>
              ) : (
                <div className="relative flex flex-wrap items-center gap-3">
                  <h2 className="m-0 text-[22px] font-bold">{cur.name}</h2>
                  {cur.locked && <span className="rounded-xl bg-accent px-2.5 py-1 text-xs font-bold text-accent-foreground">{r.locked}</span>}
                  <span className="text-sm text-muted-foreground">{cur.description}</span>
                </div>
              )}
              <div className="relative flex flex-wrap gap-2.5">
                <Chip className="h-8 rounded-2xl px-3.5 text-sm">{r.pagesChip(stats.pages, RESOURCE_KEYS.length)}</Chip>
                <Chip className="h-8 rounded-2xl px-3.5 text-sm" bg="#DDF5E8" fg="#11724A">
                  {r.actionsChip(stats.actions)}
                </Chip>
                <Chip className="h-8 rounded-2xl px-3.5 text-sm" bg="#FFF1E3" fg="#8A3F05">
                  {r.specialsChip(stats.specials)}
                </Chip>
              </div>
              <div className="relative flex flex-col gap-1.5">
                <span className="text-[13px] font-semibold text-muted-foreground">{r.visibleMenus}</span>
                <div className="flex flex-wrap gap-1.5">
                  {visibleResources(draft.perms).map((res) => (
                    <span key={res} className="inline-flex h-7 items-center rounded-[14px] border border-border bg-[#F7F5F2] px-3 text-[13px]">
                      {r.resources[res][0]}
                    </span>
                  ))}
                </div>
              </div>
              {isAll && <span className="relative text-sm font-semibold text-accent-foreground">{r.allPermissions}</span>}
              {!editable && !cur.locked && <span className="relative text-[13px] text-[#7A5200]">{r.readOnly}</span>}
            </Card>

            <Card className="flex flex-col gap-1.5 px-[22px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="m-0 text-lg font-bold">{r.matrixTitle}</h3>
                <span className="text-[13px] text-muted-foreground">{r.matrixHint}</span>
              </div>
              <div className="grid grid-cols-[minmax(180px,1fr)_repeat(4,76px)] items-center gap-1 border-b-[1.5px] border-border px-2 py-2.5 text-[13px] font-bold text-muted-foreground">
                <span>{r.colResource}</span>
                {CRUD.map((a) => (
                  <span key={a} className="text-center">
                    {r.actions[a]}
                  </span>
                ))}
              </div>
              {RESOURCE_KEYS.map((res) => {
                const canView = has(`${res}:view`)
                return (
                  <div key={res} className="grid min-h-14 grid-cols-[minmax(180px,1fr)_repeat(4,76px)] items-center gap-1 border-b border-[#F3F0EB] px-2 py-1.5">
                    <div className="flex min-w-0 flex-col gap-px">
                      <span className="text-[15px] font-semibold">{r.resources[res][0]}</span>
                      <span className="text-xs text-[#7A8090]">{r.resources[res][1]}</span>
                    </div>
                    {CRUD.map((a) => {
                      const allowed = (RESOURCES[res] as readonly string[]).includes(a)
                      const on = has(`${res}:${a}`)
                      return (
                        <div key={a} className="flex justify-center">
                          {allowed ? (
                            <span className={cn(a !== 'view' && !canView && !on && 'opacity-45')}>
                              <Toggle
                                checked={on}
                                label={`${r.resources[res][0]} · ${r.actions[a]}`}
                                disabled={!editable || isAll}
                                onChange={() => toggleCrud(res, a)}
                              />
                            </span>
                          ) : (
                            <span className="text-base text-[#CFC9C0]">—</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </Card>

            <Card className="flex flex-col gap-1.5 px-[22px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="m-0 text-lg font-bold">{r.specialsTitle}</h3>
                <span className="text-[13px] text-muted-foreground">{r.specialsHint}</span>
              </div>
              {SPECIAL_PERMISSIONS.map((p) => (
                <div key={p} className="flex min-h-[60px] items-center gap-3.5 border-b border-[#F3F0EB] px-2 py-1.5">
                  <div className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="text-[15px] font-semibold">{r.specials[p][0]}</span>
                    <span className="text-xs text-[#7A8090]">{r.specials[p][1]}</span>
                  </div>
                  <code className="shrink-0 rounded-lg bg-[#F7F5F2] px-2 py-[3px] text-xs text-[#4A5060]">{p}</code>
                  <Toggle checked={has(p)} label={r.specials[p][0]} disabled={!editable || isAll} onChange={() => toggleSpecial(p)} />
                </div>
              ))}
              <span className="pt-1.5 text-xs text-[#7A8090]">{r.footnote}</span>
            </Card>
          </div>
        )}
      </div>

      {cur && editable && (
        <div
          role="region"
          aria-label={r.save}
          className="sticky bottom-0 z-[5] -mx-7 -mt-[86px] box-border flex flex-wrap items-center gap-3 border-t border-border bg-white/95 px-7 py-3.5 shadow-[0_-8px_24px_rgba(40,30,60,0.08)]"
        >
          <span
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-[18px] px-4 text-sm font-semibold',
              dirty ? 'bg-[#FFF1E3] text-[#8A3F05]' : 'bg-success text-success-foreground',
            )}
          >
            {dirty ? r.dirty : justSaved ? r.justSaved : r.clean}
          </span>
          <div className="flex-1" />
          {!cur.isSystem && can('roles:delete') && (
            <DangerButton className="min-h-12" disabled={busy} onClick={() => void remove()}>
              {r.delete}
            </DangerButton>
          )}
          <OutlineButton className="min-h-12 px-[22px]" disabled={!dirty || busy} onClick={() => setDraft(toDraft(cur))}>
            {r.discard}
          </OutlineButton>
          <GradientButton className="px-[26px]" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? t.common.saving : r.save}
          </GradientButton>
        </div>
      )}
    </>
  )
}
