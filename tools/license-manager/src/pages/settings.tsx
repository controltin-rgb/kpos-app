import { useState } from 'react'
import type { Plan } from '../../../../scripts/license-types'
import { Modal } from '@renderer/components/modal'
import { Card, Chip, DangerButton, Field, GradientButton, OutlineButton, PageHeader, TextInput, useToast } from '@renderer/components/ui'
import { resolveFeatures } from '../../../../src/shared/license'
import { api } from '../api'
import { errText } from '../components'
import { FeatureEditor } from '../features-editor'
import { lm } from '../i18n'
import { useManager } from '../store'

const s = lm.settings

function GenerateDialog({ replace, onClose, onDone }: { replace: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    try {
      const r = await api.generateKey(typed, replace)
      toast(s.generated(r.fingerprint))
      onDone()
    } catch (err) {
      toast(errText(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={s.generateTitle}
      onClose={onClose}
      width={520}
      footer={
        <div className="flex justify-end gap-2.5">
          <OutlineButton onClick={onClose}>{lm.cancel}</OutlineButton>
          <DangerButton disabled={typed !== s.phrase || busy} onClick={() => void go()}>
            {replace ? s.replace : s.generate}
          </DangerButton>
        </div>
      }
    >
      <span className="rounded-xl bg-warning px-3 py-2 text-[13px] text-warning-foreground">{s.generateWarn}</span>
      <Field label={s.generateType(s.phrase)}>
        <TextInput value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
      </Field>
    </Modal>
  )
}

function PlansCard() {
  const toast = useToast()
  const { state, reload } = useManager()
  const [draft, setPlans] = useState<Plan[] | null>(null)
  const plans = draft ?? state?.plans ?? []
  const patch = (i: number, p: Partial<Plan>) => setPlans(plans.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const saved = new Set(state?.plans.map((x) => x.name))
  async function setTrial(name: string) {
    try {
      await api.setTrialPackage(name)
      toast(s.trialSet(name))
      await reload()
    } catch (err) {
      toast(errText(err), 'error')
    }
  }
  async function save() {
    try {
      await api.savePlans(plans)
      toast(s.plansSaved)
      setPlans(null)
      await reload()
    } catch (err) {
      toast(errText(err), 'error')
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-bold">{s.plansTitle}</h2>
      <span className="text-sm text-muted-foreground">{s.plansHint}</span>
      <span className="text-xs text-muted-foreground">{s.trialHint}</span>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-4">
        {plans.map((p, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-2xl bg-[#F7F5F2] p-4">
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Field label={s.planName}>
                  <TextInput aria-label={s.planName} value={p.name} maxLength={60} onChange={(e) => patch(i, { name: e.target.value })} />
                </Field>
              </div>
              {state?.trialPackage === p.name ? (
                <Chip bg="#EDE9FB" fg="#4B2FB8">
                  {s.trialBadge}
                </Chip>
              ) : (
                <OutlineButton disabled={!saved.has(p.name) || draft !== null} title={s.trialNeedSave} onClick={() => void setTrial(p.name)}>
                  {s.useAsTrial}
                </OutlineButton>
              )}
              <OutlineButton disabled={plans.length <= 1} onClick={() => setPlans(plans.filter((_, j) => j !== i))}>
                {s.removePlan}
              </OutlineButton>
            </div>
            <FeatureEditor value={p} onChange={(f) => patch(i, f)} />
          </div>
        ))}
      </div>
      <div className="flex gap-2.5">
        <OutlineButton onClick={() => setPlans([...plans, { name: '', ...resolveFeatures({ maxEmployees: 10, maxClients: 0, cloudBackup: false }) }])}>{s.addPlan}</OutlineButton>
        <GradientButton onClick={() => void save()}>{lm.save}</GradientButton>
      </div>
    </Card>
  )
}

export function SettingsPage() {
  const toast = useToast()
  const { state, reload } = useManager()
  const [gen, setGen] = useState<null | 'new' | 'replace'>(null)
  if (!state) return null
  const k = state.key

  async function backup() {
    try {
      const r = await api.backup()
      toast(s.backedUp(r.files.length, r.dir))
    } catch (err) {
      toast(errText(err), 'error')
    }
  }

  return (
    <>
      <PageHeader icon="lock" tone="pink" title={s.title} subtitle={s.subtitle} />
      <div className="flex flex-wrap items-start gap-[18px]">
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="m-0 flex-1 text-lg font-bold">{s.keyTitle}</h2>
            {!k.found ? (
              <Chip bg="#FFF4D6" fg="#7A5200">
                {s.keyMissing}
              </Chip>
            ) : k.trusted ? (
              <Chip bg="#DDF5E8" fg="#11724A">
                {s.keyOk}
              </Chip>
            ) : (
              <Chip bg="#FFE3E3" fg="#A6232B">
                {s.keyBad}
              </Chip>
            )}
          </div>
          <dl className="m-0 grid grid-cols-[150px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{s.keyPath}</dt>
            <dd className="m-0 font-mono text-xs break-all">{k.path}</dd>
            <dt className="text-muted-foreground">{s.fingerprint}</dt>
            <dd className="m-0 font-mono text-xs">{k.fingerprint ?? '—'}</dd>
          </dl>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">{s.trusted}</span>
            {k.trustedKeys.map((t) => (
              <div key={t.fingerprint} className="flex items-center gap-2 rounded-xl bg-[#F7F5F2] px-3 py-2 font-mono text-xs">
                <span className="flex-1">{t.fingerprint}</span>
                {t.current && (
                  <Chip bg="#EDE9FB" fg="#4B2FB8">
                    {s.currentKey}
                  </Chip>
                )}
              </div>
            ))}
          </div>
          <div>{k.found ? <OutlineButton onClick={() => setGen('replace')}>{s.replace}</OutlineButton> : <GradientButton onClick={() => setGen('new')}>{s.generate}</GradientButton>}</div>
        </Card>

        <Card className="flex min-w-0 flex-[1_1_380px] flex-col gap-3">
          <h2 className="m-0 text-lg font-bold">{s.backupTitle}</h2>
          <span className="text-sm text-muted-foreground">{s.backupHint}</span>
          <div>
            <GradientButton onClick={() => void backup()}>{s.backupNow}</GradientButton>
          </div>
          <h3 className="m-0 mt-2 text-sm font-semibold">{s.files}</h3>
          <dl className="m-0 flex flex-col gap-1 font-mono text-xs break-all text-muted-foreground">
            <dd className="m-0">{state.paths.register}</dd>
            <dd className="m-0">{state.paths.events}</dd>
            <dd className="m-0">{state.paths.plans}</dd>
          </dl>
        </Card>
      </div>
      <PlansCard />
      {gen && (
        <GenerateDialog
          replace={gen === 'replace'}
          onClose={() => setGen(null)}
          onDone={() => {
            setGen(null)
            void reload()
          }}
        />
      )}
    </>
  )
}
