import { Card, PageHeader } from '@renderer/components/ui'
import type { NavLeaf } from '@renderer/components/nav'
import { t } from '@renderer/i18n'

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
