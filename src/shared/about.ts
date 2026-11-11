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
    version: '0.3.1',
    date: '2026-11-11',
    notes: [
      'นำเข้าไฟล์ License ที่ติดตั้งอยู่แล้วซ้ำ จะแจ้งเตือนว่าไม่มีอะไรเปลี่ยน (เลือกไฟล์ใหม่ล่าสุดจากผู้ขาย)',
      'หลังติดตั้ง License แสดงชื่อแพ็กเกจที่ได้ เมนูและหน้าจอเปลี่ยนตามแพ็กเกจทันที',
      'License แบบแพ็กเกจ: แต่ละแพ็กเกจกำหนดได้ว่าใช้ Host กี่เครื่อง จำนวนพนักงาน จำนวนลูกค้า และเปิด/ปิด จอลูกค้า จอบาร์ โปรโมชั่น อัปเดตอัตโนมัติ พิมพ์ฉลาก ตัวเลือก/Topping ลิ้นชักและปิดกะ วัตถุดิบ และคลาวด์',
      'เมนู หน้าจอ และรายงานปรับตามแพ็กเกจของร้าน ฟีเจอร์ที่ไม่อยู่ในแพ็กเกจจะซ่อนและใช้งานไม่ได้ (ข้อมูลเดิมไม่หาย)',
      'ปิดลิ้นชักและปิดกะ = ขายอย่างเดียวโดยไม่ต้องเปิดกะ · ปิดวัตถุดิบ = ขายได้โดยไม่ต้องใส่สูตร',
      'ช่วงทดลองใช้ 30 วันใช้แพ็กเกจ "ทดลองใช้ (30วัน)"',
      'ไม่รับไฟล์ License ที่ออกก่อนใบที่ติดตั้งอยู่ (เปลี่ยน/ลดแพ็กเกจได้ด้วยไฟล์ใหม่จากผู้ขาย)',
      'หน้า "เครื่องและ License" แสดงฟีเจอร์ทั้งหมดในแพ็กเกจ',
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
