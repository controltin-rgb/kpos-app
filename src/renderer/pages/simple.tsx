import { Card, OutlineButton, PageHeader, useToast } from '@renderer/components/ui'
import { call, errorMessage } from '@renderer/lib/api'
import type { NavLeaf } from '@renderer/components/nav'
import { t } from '@renderer/i18n'
import { useSession } from '@renderer/lib/session'

export function DashboardPage() {
  const { user } = useSession()
  return (
    <>
      <PageHeader icon="home" title={t.dashboard.title} subtitle={t.dashboard.subtitle(user?.branchName ?? '')} />
      <Card className="relative overflow-hidden">
        <div className="absolute -top-[34px] -right-[34px] size-[110px] rounded-full bg-[#E4EEFF]" />
        <p className="relative m-0 text-sm text-muted-foreground">{t.dashboard.placeholder}</p>
      </Card>
    </>
  )
}

export function PlaceholderPage({ route }: { route: NavLeaf }) {
  return (
    <>
      <PageHeader icon="info" tone="amber" title={route.label} subtitle={t.placeholder.title} />
      <Card>
        <p className="m-0 text-sm text-muted-foreground">{t.placeholder.body(route.phase)}</p>
      </Card>
    </>
  )
}

export function ForbiddenPage() {
  return (
    <>
      <PageHeader icon="lock" tone="red" title={t.forbidden.title} />
      <Card>
        <p className="m-0 text-sm text-muted-foreground">{t.forbidden.body}</p>
      </Card>
    </>
  )
}

export function SystemPage() {
  const { system, can } = useSession()
  const toast = useToast()
  const open = (kind: 'kds' | 'cfd') => call('pos.openWindow', { kind }).catch((err: unknown) => toast(errorMessage(err), 'error'))
  const s = t.system
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
  return (
    <>
      <PageHeader icon="info" tone="amber" title={s.title} subtitle={s.subtitle} />
      <Card className="max-w-xl">
        <dl className="m-0 grid grid-cols-2 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="m-0 font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {can('pos:view') && (
        <Card className="flex max-w-xl flex-col gap-3">
          <strong>{t.windows.title}</strong>
          <div className="flex flex-wrap gap-2.5">
            <OutlineButton onClick={() => void open('cfd')}>{t.windows.openCfd}</OutlineButton>
            <OutlineButton onClick={() => void open('kds')}>{t.windows.openKds}</OutlineButton>
          </div>
          <span className="text-xs text-muted-foreground">{t.windows.hint}</span>
        </Card>
      )}
    </>
  )
}
