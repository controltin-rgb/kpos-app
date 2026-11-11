import { th } from './th'
import { thCatalog } from './th-catalog'
import { thOps } from './th-ops'
import { thSales } from './th-sales'
import { thSystem } from './th-system'
import { thExtra } from './th-extra'

/** Active locale. The app is Thai-only for now; kept behind a module for future locales. */
export const t = { ...th, ...thSales, ...thCatalog, ...thOps, ...thSystem, ...thExtra }
