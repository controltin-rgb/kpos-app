import type { Customer, CustomerRow, InspectResult, IssueInput, LicenseRow, ManagerState, Plan, TimelineItem } from '../../../scripts/license-types'

export class ApiError extends Error {}

/** Same-origin calls to the local server (the auth cookie is set when the page was opened from the printed URL). */
async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      // plain text
    }
    throw new ApiError(msg || `HTTP ${res.status}`)
  }
  return JSON.parse(text) as T
}

export interface IssueResult {
  content: string
  payload: { licenseId: string; expiresAt: number | null }
  fileName: string
}
export interface RenewPreview {
  term: IssueInput['term']
  expiresAt: number | null
  previousExpiresAt: number | null
}

export const api = {
  state: () => req<ManagerState>('/api/state'),
  expiring: (days: number) => req<LicenseRow[]>(`/api/expiring?days=${days}`),
  customer: (id: string) => req<{ customer: CustomerRow; licenses: LicenseRow[]; timeline: TimelineItem[] }>(`/api/customers/${encodeURIComponent(id)}`),
  saveCustomer: (c: Partial<Customer> & { name: string }) => req<Customer>('/api/customers', c),
  importCustomers: () => req<{ created: number; assigned: number }>('/api/customers/import', {}),
  issue: (i: IssueInput) => req<IssueResult>('/api/issue', i),
  renewPreview: (licenseId: string, days: number, mode: 'from_now' | 'from_expiry') => req<RenewPreview>('/api/renew-preview', { licenseId, days, mode }),
  setStatus: (licenseId: string, status: 'void' | 'superseded', reason: string) => req<{ ok: true }>('/api/status', { licenseId, status, reason }),
  inspect: (content: string, hardwareId?: string) => req<InspectResult>('/api/inspect', { content, hardwareId }),
  savePlans: (plans: Plan[]) => req<Plan[]>('/api/plans', { plans }),
  setTrialPackage: (name: string) => req<{ name: string }>('/api/trial-package', { name }),
  generateKey: (confirm: string, replace: boolean) => req<{ fingerprint: string; backup: string | null; publicKeyFile: string }>('/api/key/generate', { confirm, replace }),
  backup: () => req<{ dir: string; files: string[] }>('/api/backup', {}),
}

/** Saves text as a file through the browser. */
export function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** Downloads an already-issued license by id (the file name comes from the server's Content-Disposition). */
export async function downloadLicense(licenseId: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeURIComponent(licenseId)}`)
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`)
  const cd = res.headers.get('content-disposition') ?? ''
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
  download(m ? decodeURIComponent(m[1]!) : `${licenseId}.LIC`, await res.text())
}
