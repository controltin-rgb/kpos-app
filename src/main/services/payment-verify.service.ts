import type { SecretStore } from '@main/secrets'
import { PROVIDER_DEFS, type VerifyStatus } from '@shared/payment-verify'
import type { SettingsService } from './settings.service'

/** in test mode the "bank" reports the transfer this long after the QR was shown */
export const MOCK_PAID_AFTER_MS = 8_000

/**
 * Automatic PromptPay check (D41). Read-only: it only tells the POS whether the money arrived; the
 * sale is still recorded through the normal checkout (the manual confirm button never goes away).
 */
export class PaymentVerifyService {
  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(input: { amountSatang: number; since: number; ref?: string | undefined }): Promise<{ status: VerifyStatus; message: string | null }> {
    if (this.settings.get('promptpay.verify_mode') !== 'auto') return { status: 'unavailable', message: 'manual' }
    const provider = this.settings.get('promptpay.provider')
    const def = PROVIDER_DEFS[provider]
    if (!def.connected) return { status: 'unavailable', message: 'not_connected' }
    if (def.needsSecret && !this.secrets.has('promptpay.api_key')) return { status: 'unavailable', message: 'no_api_key' }
    switch (provider) {
      case 'mock':
        return { status: this.now() - input.since >= MOCK_PAID_AFTER_MS ? 'paid' : 'pending', message: 'mock' }
      default:
        return { status: 'unavailable', message: 'not_connected' }
    }
  }
}
