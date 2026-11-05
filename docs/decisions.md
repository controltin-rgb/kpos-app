# บันทึกการตัดสินใจ (Decision Log)

เอกสารนี้บันทึกข้อสรุปที่ผู้ใช้ยืนยันแล้ว ใช้แทนจุดที่ `Implement.md` กับ `Design-Spec.md` เขียนไม่ตรงกัน

| # | วันที่ | หัวข้อ | ข้อสรุป |
|---|---|---|---|
| D1 | 2026-11-05 | Primary key | UUIDv7 (`TEXT`) ทุกตาราง สร้างที่ `src/shared/id.ts` |
| D2 | 2026-11-05 | เวลา | epoch milliseconds (`INTEGER`) ทุกคอลัมน์ชื่อลงท้าย `_at` |
| D3 | 2026-11-05 | ปริมาณวัตถุดิบ | `INTEGER` หน่วย milli ของหน่วยฐาน (1 ml = 1000, 1 g = 1000, 1 ชิ้น = 1000) คอลัมน์ลงท้าย `_milli`; ตัวคูณขนาดก็เก็บเป็น milli (1.25× = 1250) |
| D4 | 2026-11-05 | ต้นทุนล็อต | เก็บ `total_cost_satang` ต่อล็อต คิดต้นทุนที่ตัด = `round(total_cost × qty_used / qty_received)` ไม่เก็บต้นทุนต่อหน่วยเป็นทศนิยม |
| D5 | 2026-11-05 | สาขา/Sync | ทุกตารางที่ผูกสาขามี `branch_id`; master data มี `created_at`, `updated_at`, `deleted_at`, `rev` |
| D6 | 2026-11-05 | บทบาทเริ่มต้น | **Super Admin** (สูงสุด) · Owner · Branch Manager · Head Barista · Cashier — ชื่อตาม Design-Spec. Super Admin = สิทธิ์ทั้งหมด (`*` รวมสิทธิ์ที่เพิ่มในอนาคต); Owner = ทุกสิทธิ์ **ยกเว้น `license:manage`** |
| D7 | 2026-11-05 | ชนิดตาราง | ทุกตารางเป็น SQLite `STRICT` (กันค่า REAL หลุดเข้าคอลัมน์เงิน/ปริมาณ) |
| D8 | 2026-11-05 | ชื่อตาราง | พหูพจน์ snake_case ตาม Implement.md (`bills`, `stock_lots` …) |
| D9 | 2026-11-05 | ปัดเศษ VAT | ตามคำสั่งกรมสรรพากร ที่ ป. 86/2542 ข้อ 4(6) (https://www.rd.go.th/3568.html): ดูทศนิยมตำแหน่งที่ 3 — ต่ำกว่า 5 ปัดทิ้ง, ตั้งแต่ 5 ปัดขึ้น (= ปัดครึ่งขึ้นเป็นสตางค์). คำนวณ **ระดับบิล/ใบกำกับ** จากมูลค่าสินค้าที่มี VAT ในเอกสารนั้น. อัตราตั้งค่าได้ (ค่าเริ่มต้น 7% = 700 bp). implement ใน `src/shared/money.ts` — **ต้องให้นักบัญชีตรวจก่อนใช้จริง** |
| D10 | 2026-11-05 | รูปแบบ permission key | ใช้โครงจากต้นแบบ `Roles.dc.html` (หน้า × view/create/update/delete + สิทธิ์เฉพาะ เช่น `pos:void`) แทนรายการตัวอย่างใน Implement.md §7 และเพิ่ม `license:manage`, `backup:restore`, `shift:view_all` — รายการจริงอยู่ที่ `src/shared/permissions.ts` |
| D11 | 2026-11-05 | ตารางของ BetterAuth | BetterAuth 1.7 เก็บวันที่เป็น ISO TEXT และบังคับ email จึงแยกเป็นตาราง `auth_user/auth_session/auth_account/auth_verification` (migration 0002) ใช้รูปแบบของ BetterAuth ตรง ๆ — **ข้อยกเว้นเดียวของ D2** · ผูกกับ `users.auth_user_id` · email เป็นค่าสังเคราะห์ `<users.id>@kposs.local` · รหัสผ่านเก็บใน `auth_account` (scrypt ของ BetterAuth) · ปิด sign-up สาธารณะ และปิด transaction ของ BetterAuth เพื่อไม่ให้ซ้อนกับ transaction เงิน/สต็อก (**รอผู้ใช้ตรวจ**) |
| D12 | 2026-11-05 | การตรวจสิทธิ์ | BetterAuth ใช้ทำ session (bearer token เก็บใน main process ไม่ส่งถึง renderer) · RBAC ตรวจเองที่ IPC router จาก `role_permissions` (แก้จากหน้า Roles ได้ มีผลทันที) แทน organization/access plugin ของ BetterAuth · ทุก endpoint ประกาศสิทธิ์ขั้นต่ำใน `src/shared/api.ts` · การปฏิเสธสิทธิ์ลง audit (risk=medium) (**รอผู้ใช้ตรวจ**) |
| D13 | 2026-11-05 | ค่าเริ่มต้นด้านความปลอดภัย | ใส่รหัส/PIN ผิด 5 ครั้ง → ล็อก 5 นาที (ลง audit) · session หมดอายุ 16 ชม. · PIN 4–6 หลัก hash ด้วย scrypt · รหัสผ่านอย่างน้อย 8 ตัว · เพดานพนักงานเริ่มต้น 10 คน/สาขา (`settings.license.employee_cap` จนกว่าจะมี License) · ผู้ใช้จัดการได้เฉพาะบัญชี/บทบาทที่ rank ต่ำกว่าตน · ให้สิทธิ์ได้เฉพาะที่ตนมี · ต้องเหลือ Super Admin ที่ใช้งานอย่างน้อย 1 คน · บทบาทที่ไม่ใช่ระบบได้ rank 40 (**รอผู้ใช้ตรวจ**) |

## ประเด็นที่ยังเปิดอยู่
ดู `Implement.md` §13 — รูปแบบเลขบิล/ใบกำกับ, ขนาดบล็อกเลขบิล, retention backup, พฤติกรรม License หมดอายุ, เครื่องพิมพ์, คนนับ ≠ คนอนุมัติ, PromptPay API
