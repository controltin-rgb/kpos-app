import { z } from 'zod'
import type { Actor } from '@main/auth/actor'
import type { Db } from '@main/db/connection'
import { OrgRepo } from '@main/db/repos/org.repo'
import { BILL_RESET_POLICIES, DEFAULT_BILL_RESET, type BillResetPolicy } from '@shared/bill-number'
import { AppError } from '@shared/errors'
import { uuidv7 } from '@shared/id'
import { DEFAULT_VAT_RATE_BP } from '@shared/money'
import { isValidPromptPayId } from '@shared/promptpay'
import { isValidThaiTaxId } from '@shared/tax-id'
import type { AuditService } from './audit.service'

/** Typed settings with defaults. Stored in `settings` as JSON (global scope for now). */
export const SETTINGS = {
  'vat.rate_bp': { schema: z.number().int().min(0).max(10_000), default: DEFAULT_VAT_RATE_BP },
  'bill.reset_policy': { schema: z.enum(BILL_RESET_POLICIES), default: DEFAULT_BILL_RESET as BillResetPolicy },
  'promptpay.id': {
    schema: z.string().trim().refine((v) => v === '' || isValidPromptPayId(v), 'invalid'),
    default: '',
  },
  'receipt.header': { schema: z.string().trim().max(200), default: '' },
  'receipt.footer': { schema: z.string().trim().max(200), default: 'ขอบคุณที่ใช้บริการ' },
  'receipt.paper_mm': { schema: z.union([z.literal(58), z.literal(80)]), default: 80 as 58 | 80 },
  'license.employee_cap': { schema: z.number().int().min(1).max(1000), default: 10 },
  /** D22: the approver of a stock count must differ from its creator */
  'stock.count_separate_approver': { schema: z.boolean(), default: true },
  /** points: spend this much (satang) for 1 point; redeem N points for M satang (Promo prototype) */
  'points.earn_every_satang': { schema: z.number().int().min(100).max(100_000_00), default: 2_500 },
  'points.redeem_points': { schema: z.number().int().min(1).max(100_000), default: 20 },
  'points.redeem_value_satang': { schema: z.number().int().min(1).max(100_000_00), default: 1_000 },
  /** seller details printed on tax invoices (ป.86/2542 / ประมวลรัษฎากร ม.86/4, 86/6) */
  'tax.seller_name': { schema: z.string().trim().max(160), default: '' },
  'tax.seller_tax_id': { schema: z.string().trim().refine((v) => v === '' || isValidThaiTaxId(v), 'invalid'), default: '' },
  'tax.seller_branch': { schema: z.string().trim().regex(/^\d{5}$/), default: '00000' },
  'tax.seller_address': { schema: z.string().trim().max(300), default: '' },
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>
export type SettingsMap = { [K in SettingKey]: SettingValue<K> }

/** Settings an operator may edit from the Settings page (license cap comes from the license file later). */
export const EDITABLE_SETTINGS = ['vat.rate_bp', 'bill.reset_policy', 'promptpay.id', 'receipt.header', 'receipt.footer', 'receipt.paper_mm', 'stock.count_separate_approver', 'points.earn_every_satang', 'points.redeem_points', 'points.redeem_value_satang', 'tax.seller_name', 'tax.seller_tax_id', 'tax.seller_branch', 'tax.seller_address'] as const

export class SettingsService {
  private readonly org: OrgRepo

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {
    this.org = new OrgRepo(db)
  }

  get<K extends SettingKey>(key: K): SettingValue<K> {
    const raw = this.org.getSetting<unknown>(key, null)
    const parsed = SETTINGS[key].schema.safeParse(raw)
    return (parsed.success ? parsed.data : SETTINGS[key].default) as SettingValue<K>
  }

  all(): SettingsMap {
    return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map((k) => [k, this.get(k)])) as SettingsMap
  }

  /** Updates editable settings in one transaction; every changed key is audited with before/after (rule 4). */
  update(actor: Actor, patch: Partial<SettingsMap>, permission: 'settings:update' | 'promo:update' = 'settings:update'): SettingsMap {
    const keys = Object.keys(patch) as SettingKey[]
    for (const k of keys) {
      if (!(EDITABLE_SETTINGS as readonly string[]).includes(k)) throw new AppError('INVALID_INPUT', { invalid: [k] })
      const ok = SETTINGS[k].schema.safeParse(patch[k])
      if (!ok.success) throw new AppError('INVALID_INPUT', { invalid: [k] })
    }
    const at = this.now()
    this.db.transaction(() => {
      for (const k of keys) {
        const before = this.get(k)
        const after = SETTINGS[k].schema.parse(patch[k])
        if (JSON.stringify(before) === JSON.stringify(after)) continue
        this.org.setSetting({ id: uuidv7(at), key: k, branchId: null, value: after, userId: actor.userId, now: at })
        this.audit.append({
          action: 'settings.update',
          permission,
          userId: actor.userId,
          branchId: actor.branchId,
          entity: 'settings',
          entityId: k,
          before: { [k]: before },
          after: { [k]: after },
          risk: k === 'vat.rate_bp' || k.startsWith('tax.') ? 'high' : 'medium',
        })
      }
    }).immediate()
    return this.all()
  }
}
