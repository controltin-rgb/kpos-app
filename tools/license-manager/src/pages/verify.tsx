import { useState } from 'react'
import type { InspectResult } from '../../../../scripts/license-types'
import { FEATURE_KEYS, resolveFeatures } from '../../../../src/shared/license'
import { Card, Chip, Field, GradientButton, OutlineButton, PageHeader, TextInput, useToast } from '@renderer/components/ui'
import { api } from '../api'
import { errText, StatusChip } from '../components'
import { date, expiryText } from '../format'
import { lm } from '../i18n'

const v = lm.verify

export function VerifyPage() {
  const toast = useToast()
  const [content, setContent] = useState('')
  const [hw, setHw] = useState('')
  const [result, setResult] = useState<InspectResult | null>(null)

  async function check() {
    try {
      setResult(await api.inspect(content, hw.trim() || undefined))
    } catch (err) {
      toast(errText(err), 'error')
    }
  }
  async function pick(file: File | undefined) {
    if (!file) return
    setContent(await file.text())
    setResult(null)
  }
  const p = result?.payload

  return (
    <>
      <PageHeader icon="shield" tone="green" title={v.title} subtitle={v.subtitle} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col gap-3">
          <Field label={v.paste}>
            <textarea
              className="min-h-48 w-full rounded-[14px] border-[1.5px] border-[#E6E1D9] bg-white p-3 font-mono text-xs"
              value={content}
              spellCheck={false}
              onChange={(e) => {
                setContent(e.target.value)
                setResult(null)
              }}
            />
          </Field>
          <label className="inline-flex min-h-11 w-fit cursor-pointer items-center rounded-full border-[1.5px] border-[#E6E1D9] bg-white px-5 text-[15px] font-semibold">
            {v.pickFile}
            <input type="file" accept=".LIC,.lic,.json,text/plain" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          <Field label={v.hw} hint={v.hwHint}>
            <TextInput value={hw} className="font-mono" placeholder="HW-XXXX-XXXX-XXXX-XXXX" onChange={(e) => setHw(e.target.value.toUpperCase())} />
          </Field>
          <div className="flex gap-2.5">
            <GradientButton disabled={!content.trim()} onClick={() => void check()}>
              {v.check}
            </GradientButton>
            <OutlineButton
              onClick={() => {
                setContent('')
                setHw('')
                setResult(null)
              }}
            >
              {lm.cancel}
            </OutlineButton>
          </div>
        </Card>
        {result && (
          <Card className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
            {result.ok ? (
              <div className="flex flex-wrap items-center gap-2">
                <Chip bg="#DDF5E8" fg="#11724A">
                  {v.ok}
                </Chip>
                {result.status && <StatusChip status={result.status} daysLeft={result.daysLeft} />}
              </div>
            ) : (
              <Chip bg="#FFE3E3" fg="#A6232B">
                {v.bad[result.problem ?? 'format'] ?? result.problem}
              </Chip>
            )}
            {p && (
              <dl className="m-0 grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{v.licensee}</dt>
                <dd className="m-0 font-semibold">{p.licensee}</dd>
                <dt className="text-muted-foreground">{v.plan}</dt>
                <dd className="m-0">{p.plan}</dd>
                <dt className="text-muted-foreground">{v.hardware}</dt>
                <dd className="m-0 font-mono">{p.hardwareId}</dd>
                <dt className="text-muted-foreground">{v.issuedAt}</dt>
                <dd className="m-0">{date(p.issuedAt)}</dd>
                <dt className="text-muted-foreground">{v.expiresAt}</dt>
                <dd className="m-0">{expiryText(p.expiresAt)}</dd>
                <dt className="text-muted-foreground">{v.features}</dt>
                <dd className="m-0 flex flex-col gap-1.5">
                  <span>{lm.features.text(resolveFeatures(p.features))}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {FEATURE_KEYS.map((k) => (
                      <Chip key={k} bg={resolveFeatures(p.features)[k] ? '#DDF5E8' : '#EFEBE6'} fg={resolveFeatures(p.features)[k] ? '#11724A' : '#5C6270'}>
                        {resolveFeatures(p.features)[k] ? '✓' : '✕'} {lm.features.keys[k].replace(/ \(.*\)$/, '')}
                      </Chip>
                    ))}
                  </span>
                </dd>
              </dl>
            )}
          </Card>
        )}
      </div>
    </>
  )
}
