import type { MigrationErrorCode } from '@main/db/migrate'
import type { SystemRoleKey } from '@shared/permissions'

/** Thai strings shown by the main process (native dialogs). */
export const thMain = {
  dbError: {
    title: 'เปิดฐานข้อมูลไม่สำเร็จ',
    backupAt: (path: string) => `ไฟล์สำรองก่อนอัปเดตอยู่ที่:\n${path}`,
    dbAt: (path: string) => `ไฟล์ฐานข้อมูล:\n${path}`,
    contact: 'แอปจะปิดตัวลงโดยไม่แก้ไขข้อมูล กรุณาติดต่อผู้ดูแลระบบ',
    codes: {
      INVALID_MIGRATION_FILES: 'ไฟล์อัปเดตฐานข้อมูลของแอปไม่สมบูรณ์ กรุณาติดตั้งแอปใหม่',
      CHECKSUM_MISMATCH: 'ไฟล์อัปเดตฐานข้อมูลที่เคยใช้แล้วถูกแก้ไข ระบบจึงหยุดเพื่อป้องกันข้อมูลเสียหาย',
      DB_NEWER_THAN_APP: 'ฐานข้อมูลนี้มาจากแอปเวอร์ชันที่ใหม่กว่า กรุณาอัปเดตแอปก่อนใช้งาน',
      BACKUP_FAILED: 'สำรองข้อมูลก่อนอัปเดตไม่สำเร็จ จึงยังไม่อัปเดตฐานข้อมูล (ตรวจพื้นที่ดิสก์)',
      MIGRATION_FAILED: 'อัปเดตฐานข้อมูลไม่สำเร็จ ระบบย้อนกลับข้อมูลเป็นสถานะเดิมแล้ว',
    } satisfies Record<MigrationErrorCode, string>,
    unknown: 'เกิดข้อผิดพลาดที่ไม่คาดคิดขณะเปิดฐานข้อมูล',
  },
  /** Default names of system roles (seed data; users may rename non-locked roles). */
  roles: {
    super_admin: { name: 'ผู้ดูแลระบบสูงสุด (Super Admin)', description: 'เข้าถึงทุกหน้าและทุก action รวมถึง License แก้ไขไม่ได้' },
    owner: { name: 'เจ้าของ', description: 'เข้าถึงทุกหน้าและทุก action ยกเว้นจัดการ License แก้ไขไม่ได้' },
    branch_manager: { name: 'ผู้จัดการ', description: 'จัดการงานประจำวัน ยกเว้นแก้สิทธิ์และตั้งค่าระบบ' },
    head_barista: { name: 'หัวหน้าบาริสต้า', description: 'ดูแลเมนู สูตร สต็อก และจอ KDS (อนุมัติผลนับสต็อกไม่ได้)' },
    cashier: { name: 'แคชเชียร์', description: 'ขายหน้าร้าน รับชำระ และปิดกะของตัวเอง' },
  } satisfies Record<SystemRoleKey, { name: string; description: string }>,
} as const
