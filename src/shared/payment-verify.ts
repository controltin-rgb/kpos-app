/**
 * Automatic PromptPay payment check (future-ready). The manual "confirm received" button always stays
 * available; 'auto' only adds a background check that can confirm for the cashier.
 *
 * Providers are listed so a shop can pick and store its credentials now. Only `mock` (test mode) has
 * a working connector in this version; the others report "not connected yet" until their API is
 * integrated with a real merchant account (see docs/decisions.md D41).
 */

export const PAYMENT_VERIFY_MODES = ['manual', 'auto'] as const
export type PaymentVerifyMode = (typeof PAYMENT_VERIFY_MODES)[number]

export const PAYMENT_PROVIDERS = ['mock', 'slipok', 'easyslip', 'kbank', 'scb', 'ktb', 'custom'] as const
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number]

export interface ProviderDef {
  /** which non-secret fields the provider needs (secret = API key, stored outside the DB) */
  fields: readonly ('merchantId' | 'branchId' | 'endpoint')[]
  needsSecret: boolean
  /** a connector exists in this build */
  connected: boolean
}

export const PROVIDER_DEFS: Record<PaymentProvider, ProviderDef> = {
  mock: { fields: [], needsSecret: false, connected: true },
  slipok: { fields: ['branchId'], needsSecret: true, connected: false },
  easyslip: { fields: [], needsSecret: true, connected: false },
  kbank: { fields: ['merchantId'], needsSecret: true, connected: false },
  scb: { fields: ['merchantId'], needsSecret: true, connected: false },
  ktb: { fields: ['merchantId'], needsSecret: true, connected: false },
  custom: { fields: ['endpoint'], needsSecret: true, connected: false },
}

export type VerifyStatus = 'paid' | 'pending' | 'unavailable'

export interface PaymentVerifyConfig {
  merchantId: string
  branchId: string
  endpoint: string
}

export const EMPTY_VERIFY_CONFIG: PaymentVerifyConfig = { merchantId: '', branchId: '', endpoint: '' }
