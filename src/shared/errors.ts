/** Machine-readable error codes returned over IPC. The renderer maps them to Thai text (i18n). */
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PASSWORD_CHANGE_REQUIRED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'SETUP_ALREADY_DONE',
  'USERNAME_TAKEN',
  'RANK_FORBIDDEN',
  'PRIVILEGE_ESCALATION',
  'CANNOT_MODIFY_SELF',
  'LAST_SUPER_ADMIN',
  'ROLE_LOCKED',
  'ROLE_IN_USE',
  'EMPLOYEE_CAP_REACHED',
  'SHIFT_NOT_OPEN',
  'SHIFT_ALREADY_OPEN',
  'NOT_SHIFT_OWNER',
  'PRODUCT_UNAVAILABLE',
  'INVALID_MODIFIERS',
  'PAYMENT_INSUFFICIENT',
  'PAYMENT_INVALID',
  'DELIVERY_DISABLED',
  'PROMPTPAY_NOT_CONFIGURED',
  'BILL_NOT_VOIDABLE',
  'BILL_NOT_REFUNDABLE',
  'APPROVAL_REQUIRED',
  'SKU_TAKEN',
  'IN_USE',
  'PRINT_FAILED',
  'STOCK_INSUFFICIENT',
  'NOT_EDITABLE',
  'SAME_APPROVER',
  'REASON_REQUIRED',
  'COUPON_INVALID',
  'POINTS_INSUFFICIENT',
  'DISCOUNT_LIMIT',
  'TAX_NOT_CONFIGURED',
  'TAX_INVOICE_EXISTS',
  'BACKUP_UNAVAILABLE',
  'BACKUP_FAILED',
  'BACKUP_INVALID',
  'BACKUP_BUSY',
  'OFFSITE_UNREACHABLE',
  'PITR_UNAVAILABLE',
  'PITR_OUT_OF_RANGE',
  'JOURNAL_GAP',
  'JOURNAL_CORRUPT',
  'LICENSE_READ_ONLY',
  'LICENSE_INVALID',
  'LICENSE_OUTDATED',
  'LICENSE_ALREADY_INSTALLED',
  'FEATURE_NOT_LICENSED',
  'MEMBER_CAP_REACHED',
  'LAN_PAIRING_INVALID',
  'LAN_CLIENT_LIMIT',
  'LAN_UNREACHABLE',
  'LAN_DEVICE_REVOKED',
  'LAN_CERT_MISMATCH',
  'LAN_NOT_AVAILABLE',
  'LAN_HOST_OFFLINE',
  'OFFLINE_NOT_SUPPORTED',
  'OFFLINE_NO_NUMBERS',
  'OFFLINE_NOT_READY',
  'SYNC_PENDING',
  'SUPER_ADMIN_ONLY',
  'UPDATE_NOT_CONFIGURED',
  'UPDATE_FAILED',
  'CLOUD_NOT_CONFIGURED',
  'CLOUD_FAILED',
  'PAYMENT_VERIFY_UNAVAILABLE',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorPayload {
  code: ErrorCode
  /** zod field errors for INVALID_INPUT */
  fields?: Record<string, string[]>
  /** extra data, e.g. lockedUntil for ACCOUNT_LOCKED */
  data?: Record<string, unknown>
}

/** Thrown by main-process services; converted to an ErrorPayload by the IPC router. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly data?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'AppError'
  }
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload }
