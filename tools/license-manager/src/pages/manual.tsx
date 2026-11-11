import { useState } from 'react'
import { Card, PageHeader, TextInput } from '@renderer/components/ui'
import { cn } from '@renderer/lib/utils'
import { lm } from '../i18n'

const m = lm.manual

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-4"><Card className="flex flex-col gap-2.5">
      <h2 className="m-0 text-lg font-bold">{title}</h2>
      {children}
    </Card></div>
  )
}

const P = ({ children }: { children: React.ReactNode }) => <p className="m-0 text-sm leading-relaxed">{children}</p>
const Mono = ({ children }: { children: React.ReactNode }) => <code className="rounded-md bg-[#F7F5F2] px-1.5 py-0.5 font-mono text-xs break-all">{children}</code>
const Steps = ({ items }: { items: string[] }) => (
  <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed">
    {items.map((s) => (
      <li key={s}>{s}</li>
    ))}
  </ol>
)
const Bullets = ({ items }: { items: string[] }) => (
  <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed">
    {items.map((s) => (
      <li key={s}>{s}</li>
    ))}
  </ul>
)
const Note = ({ children, warn }: { children: React.ReactNode; warn?: boolean }) => (
  <span className={cn('rounded-xl px-3 py-2 text-[13px]', warn ? 'bg-warning text-warning-foreground' : 'bg-accent text-accent-foreground')}>{children}</span>
)

export function ManualPage() {
  const [q, setQ] = useState('')
  const sections = m.sections.filter((s) => !q.trim() || (s.title + s.search).toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <>
      <PageHeader icon="info" tone="blue" title={m.title} subtitle={m.subtitle} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="sticky top-4 flex w-[240px] shrink-0 flex-col gap-2">
          <TextInput type="search" aria-label={m.search} placeholder={m.search} value={q} onChange={(e) => setQ(e.target.value)} />
          {sections.map((s) => (
            <a key={s.id} href={`#/manual`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }} className="rounded-xl px-2 py-1.5 text-sm text-foreground no-underline hover:bg-accent">
              {s.title}
            </a>
          ))}
          {sections.length === 0 && <span className="text-sm text-muted-foreground">{lm.noData}</span>}
        </Card>
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-[18px]">
          {sections.map((s) => (
            <Section key={s.id} id={s.id} title={s.title}>
              {s.body.map((b, i) => {
                if ('items' in b) return b.kind === 'steps' ? <Steps key={i} items={b.items} /> : <Bullets key={i} items={b.items} />
                if (b.kind === 'p') return <P key={i}>{b.text}</P>
                if (b.kind === 'code') return <Mono key={i}>{b.text}</Mono>
                return <Note key={i} warn={b.kind === 'warn'}>{b.text}</Note>
              })}
            </Section>
          ))}
        </div>
      </div>
    </>
  )
}
