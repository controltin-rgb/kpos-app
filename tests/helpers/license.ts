import { generateKeyPairSync } from 'node:crypto'
import { signLicense } from '@main/license/license-file'
import { DAY_MS, type LicenseFeatures, type LicensePayload } from '@shared/license'
import type { createTestApp } from './app'
import { T0 } from './fixtures'

/** Throwaway Ed25519 key pair trusted by every test app (never the embedded production key). */
const pair = generateKeyPairSync('ed25519')
export const TEST_LICENSE_KEYS = {
  priv: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  pub: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
}
export const TEST_HW = 'HW-7E57-0000-0000-0001'

export function testLicense(over: Partial<Omit<LicensePayload, 'features'>> & { features?: Partial<LicenseFeatures> } = {}): string {
  const { features, ...rest } = over
  return signLicense(
    {
      licenseId: 'test-license',
      licensee: 'KPOSS Cafe',
      plan: 'Test',
      hardwareId: TEST_HW,
      issuedAt: T0,
      expiresAt: null,
      ...rest,
      features: { maxEmployees: 10, maxClients: 0, cloudBackup: false, ...features },
    },
    TEST_LICENSE_KEYS.priv,
  )
}

/** Installs a (default perpetual) test license as the admin on sender 1. */
export async function installLicense(t: ReturnType<typeof createTestApp>, over: Parameters<typeof testLicense>[0] = {}) {
  await t.call(1, 'license.import', { content: testLicense(over) })
}

export { DAY_MS }
