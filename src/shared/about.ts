import { z } from 'zod'

/** "About the system" page (System menu). Stored as the `system.about` setting; editable with system:update. */

export const ROADMAP_STATUSES = ['planned', 'in_progress', 'done'] as const
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

const line = z.string().trim().max(300)
const date = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/)

export const aboutSchema = z.object({
  productName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000),
  vendor: z.string().trim().max(120),
  contactPhone: z.string().trim().max(40),
  contactEmail: z.string().trim().max(120),
  website: z.string().trim().max(200),
  /** การอัปเดตปัจจุบัน */
  current: z.object({
    version: z.string().trim().max(30),
    date,
    notes: z.array(line).max(50),
  }),
  /** การอัปเดตในอนาคต */
  upcoming: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(120),
        detail: line,
        eta: z.string().trim().max(40),
        status: z.enum(ROADMAP_STATUSES),
      }),
    )
    .max(50),
})

export type AboutInfo = z.infer<typeof aboutSchema>

/** Shipped default; a shop's edit replaces it as a whole. */
export const DEFAULT_ABOUT: AboutInfo = {
  productName: 'KPOSS — Korn POS Management System',
  description: 'ระบบขายหน้าร้านสำหรับร้านเครื่องดื่มและคาเฟ่ ใช้งานออฟไลน์ได้ รองรับหลายเครื่องในร้านผ่าน LAN',
  vendor: 'Korn',
  contactPhone: '',
  contactEmail: '',
  website: '',
  current: {
    version: '0.2.1',
    date: '2026-11-09',
    notes: [
      'แก้ปุ่มตรวจหาอัปเดตที่กดแล้วไม่มีอะไรเกิดขึ้น (ตั้งแต่เวอร์ชันนี้อัปเดตอัตโนมัติผ่านลิงก์ได้)',
      'จอบาร์ (KDS) ตามขั้นตอนมาตรฐาน: ชำระเงินแล้วออเดอร์ขึ้นจอทันที NEW → PREPARING → READY → ส่งมอบ',
      'จอบาร์: เสียงเตือนออเดอร์ใหม่ ติ๊กเสร็จทีละแก้ว เรียกคืนบิลที่ส่งแล้ว และแถบสรุปเมนูที่ต้องทำ',
      'บิลและประวัติ: เลือกดูย้อนหลังเป็นรายเดือน',
      'รายงานใหม่: สรุปยอดขายรายวัน รายงานค่าใช้จ่าย และวัตถุดิบใกล้หมดอายุ (ส่งออก CSV ได้)',
      'โหมดมืด โปรไฟล์สมาชิก สวิตช์เปิด/ปิดเดลิเวอรี รหัสสินค้าอัตโนมัติ และหน้าบัญชีของฉัน',
    ],
  },
  upcoming: [
    { title: 'ตรวจยอด PromptPay อัตโนมัติกับธนาคาร', detail: 'เชื่อมต่อผู้ให้บริการจริงเมื่อได้บัญชีร้านค้าและ API key', eta: '', status: 'planned' },
    { title: 'ลงลายเซ็นดิจิทัลให้ตัวติดตั้ง', detail: 'ไม่ขึ้นหน้าต่างเตือนตอนติดตั้งบน Windows และ macOS', eta: '', status: 'planned' },
    { title: 'ซิงก์หลายสาขาและดูรายงานออนไลน์', detail: 'ต้องมีเซิร์ฟเวอร์กลาง', eta: '', status: 'planned' },
  ],
}

export function parseAbout(raw: unknown): AboutInfo {
  const r = aboutSchema.safeParse(raw)
  return r.success ? r.data : DEFAULT_ABOUT
}
