/**
 * Chooses the package a shop gets during the 30-day trial (no license file). Vendor/dev machine only.
 *   pnpm license:trial -- --plan "ทดลองใช้ (30วัน)"     (a package saved in the License Manager)
 *   pnpm license:trial                                   (shows the current one)
 * Writes src/shared/trial-package.json — commit it; shops get it with the next app release.
 */
import { readTrialPackage, setTrialPackage } from './license-lib'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const i = argv.indexOf('--plan')
const result = i >= 0 ? setTrialPackage(argv[i + 1] ?? '') : readTrialPackage()
console.log(i >= 0 ? 'trial package set:' : 'current trial package:', JSON.stringify(result, null, 2))
