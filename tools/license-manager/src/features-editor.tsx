import { FEATURE_KEYS, type FeatureKey, type LicenseFeatures } from '../../../src/shared/license'
import { Field, TextInput, Toggle } from '@renderer/components/ui'
import { lm } from './i18n'

const num = (v: string, max: number) => Math.min(max, Number(v.replace(/\D/g, '') || 0))

/** Limits + on/off switches of a license package (shared by the issue dialog and the package editor). */
export function FeatureEditor({ value, onChange, disabled }: { value: LicenseFeatures; onChange: (f: LicenseFeatures) => void; disabled?: boolean }) {
  const f = lm.features
  const set = (patch: Partial<LicenseFeatures>) => onChange({ ...value, ...patch })
  const hostOn = value.maxClients > 0
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <Field label={f.employees}>
          <TextInput aria-label={f.employees} inputMode="numeric" disabled={disabled} value={String(value.maxEmployees)} onChange={(e) => set({ maxEmployees: Math.max(1, num(e.target.value, 1000)) })} />
        </Field>
        <Field label={f.members} hint={f.membersHint}>
          <TextInput aria-label={f.members} inputMode="numeric" disabled={disabled} value={String(value.maxMembers)} onChange={(e) => set({ maxMembers: num(e.target.value, 1_000_000) })} />
        </Field>
        <div className="flex flex-col gap-2 text-sm font-semibold">
          {f.host}
          <div className="flex min-h-11 items-center gap-3">
            <Toggle checked={hostOn} disabled={disabled} label={f.host} onChange={(v) => set({ maxClients: v ? Math.max(1, value.maxClients) : 0 })} />
            {hostOn ? (
              <TextInput aria-label={f.hostClients} className="w-20" inputMode="numeric" disabled={disabled} value={String(value.maxClients)} onChange={(e) => set({ maxClients: Math.max(1, num(e.target.value, 100)) })} />
            ) : (
              <span className="text-xs font-normal text-muted-foreground">{f.hostOff}</span>
            )}
          </div>
          {hostOn && <span className="text-xs font-normal text-muted-foreground">{f.hostClients}</span>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-6">
        {FEATURE_KEYS.map((k: FeatureKey) => (
          <div key={k} className="flex min-h-12 items-center justify-between gap-3">
            <span className="text-sm">{f.keys[k]}</span>
            <Toggle checked={value[k]} disabled={disabled} label={f.keys[k]} onChange={(v) => set({ [k]: v })} />
          </div>
        ))}
      </div>
    </div>
  )
}
