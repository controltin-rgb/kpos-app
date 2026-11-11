import type { ReactNode } from 'react'

/**
 * Small, safe reader for the manual's text format (src/shared/manual.ts): headings, bullet and
 * numbered lists, note boxes, **bold** and `code`. Builds React elements — never raw HTML — so text
 * typed by a shop cannot inject markup.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1]!.length
      const cls = level === 1 ? 'mt-1 mb-1 text-2xl font-bold' : level === 2 ? 'mt-4 mb-1 text-lg font-bold' : 'mt-3 mb-0.5 text-base font-bold'
      const Tag = (['h2', 'h3', 'h4'] as const)[level - 1]!
      blocks.push(
        <Tag key={key++} className={`m-0 ${cls}`}>
          {inline(h[2]!)}
        </Tag>,
      )
      i++
      continue
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: { text: string; sub: string[] }[] = []
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]!) || /^\s*\d+\.\s+/.test(lines[i]!))) {
        const l = lines[i]!
        const indent = /^\s*/.exec(l)![0].length
        const body = l.replace(/^\s*([-*]|\d+\.)\s+/, '')
        if (indent >= 2 && items.length) items[items.length - 1]!.sub.push(body)
        else items.push({ text: body, sub: [] })
        i++
      }
      const ListTag = ordered ? 'ol' : 'ul'
      blocks.push(
        <ListTag key={key++} className={`my-1 flex flex-col gap-1 pl-6 text-[15px] leading-relaxed ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => (
            <li key={j}>
              {inline(it.text)}
              {it.sub.length > 0 && (
                <ul className="mt-1 flex list-[circle] flex-col gap-0.5 pl-5">
                  {it.sub.map((s, k) => (
                    <li key={k}>{inline(s)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ListTag>,
      )
      continue
    }
    if (/^>\s?/.test(line)) {
      const parts: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) parts.push(lines[i++]!.replace(/^>\s?/, ''))
      blocks.push(
        <div key={key++} className="my-2 rounded-2xl bg-[#FFF4D6] px-4 py-3 text-sm leading-relaxed text-[#7A5200]">
          {inline(parts.join(' '))}
        </div>,
      )
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!)) para.push(lines[i++]!)
    blocks.push(
      <p key={key++} className="my-1 text-[15px] leading-relaxed">
        {inline(para.join(' '))}
      </p>,
    )
  }
  return <div className="flex flex-col">{blocks}</div>
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g
  let last = 0
  let k = 0
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index))
    if (m[2] !== undefined) out.push(<strong key={k++}>{m[2]}</strong>)
    else out.push(
        <code key={k++} className="rounded-md bg-[#F3F0EC] px-1.5 py-0.5 text-[13px]">
          {m[3]}
        </code>,
      )
    last = m.index! + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
