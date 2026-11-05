# KPOSS — เอกสารออกแบบระบบ POS (Korn POS Management System)

Nov 5, 2026 · @Korn

KPOSS คือ POS แบบ Offline-First สำหรับร้านเครื่องดื่ม/อาหาร/ค้าปลีก รันเป็นแอปเดียวบน Electron + Node.js + SQLite รองรับหลายสาขา ติดตั้งแบบ LAN (เครื่องหลักเก็บข้อมูล เครื่องรองขายตามสิทธิ์) และคุมด้วย License ผูกฮาร์ดแวร์ เอกสารนี้สรุปการออกแบบจาก "POS Management System.docx"

## 1. ภาพรวมและสถาปัตยกรรม

ระบบเป็นแอปเดียว (Monolith) บน Electron: เครื่องหลักรัน Fastify + SQLite และเก็บข้อมูลทั้งหมด เครื่องรองเปิดหน้า POS, KDS, CFD หรือ Back Office ผ่าน LAN จึงไม่ต้องใช้พื้นที่เก็บข้อมูลบนเครื่องรอง ตามข้อ 6 ของเอกสารต้นทาง

&#91;embedded content: สถาปัตยกรรม LAN Host/Client · 4 ประเภทเครื่องรอง + Cloud ทางเลือก\]

หลักการออกแบบ 4 ข้อที่ทุกโมดูลต้องทำตาม:

- **Offline-first** — ทุกบิลเขียนลง SQLite ก่อนเสมอ แล้วค่อยซิงก์ขึ้น Cloud เมื่อมีอินเทอร์เน็ต
- **Single writer** — เครื่องหลักเป็นผู้เขียนฐานข้อมูลรายเดียว ตัดปัญหาข้อมูลชนกันภายใน LAN เครื่องรองส่งคำสั่งผ่าน API เท่านั้น
- **Permission-driven UI** — เมนู ปุ่ม และข้อมูลบนหน้าจอถูกกรองตาม Role และสิทธิ์ View/Add/Edit/Delete
- **Audit everything** — เหตุการณ์สำคัญ (Void, ปรับสต็อก, ลดราคาเอง, เปลี่ยนราคา, Login) ถูกบันทึกพร้อมค่าเก่า→ค่าใหม่

| ส่วนประกอบ | เทคโนโลยี | หน้าที่ |
| --- | --- | --- |
| Runtime | Node.js 24+ | Native TypeScript, ใช้ร่วมกับ Electron main |
| Desktop shell | Electron | หลายหน้าต่าง (POS + CFD), เข้าถึงเครื่องพิมพ์และลิ้นชัก |
| UI | React 19 + Tailwind + shadcn/ui | รองรับจอสัมผัส และ Responsive ทุกขนาด |
| ฐานข้อมูลหลัก | SQLite (better-sqlite3) | Relational DB แบบ Embedded ไม่ต้องมี DB Server |
| Cache / Queue | ไม่ใช้ (SQLite + Event Bus ในหน่วยความจำ) | คิว Sync เก็บใน SQLite (Outbox) ส่วน KDS ใช้ Event Bus + SSE (ดู 10.3) |
| Auth | BetterAuth | Session, Role, Permission |
| License | Node crypto (Ed25519) | ตรวจลายเซ็นไฟล์ .LIC แบบ offline |
| Printing | electron-pos-printer / node-escpos | ใบเสร็จความร้อน และเครื่องพิมพ์ฉลากผ่าน USB/LAN |

## 2. โครงสร้างองค์กรและสิทธิ์ (BetterAuth)

สิทธิ์ถูกกำหนดที่ระดับ Branch ภายใต้ Company (Core System → Company → Branches) และแก้ไขได้จากหน้าตั้งค่า ไม่ฝังอยู่ในโค้ด ตารางด้านล่างคือค่าเริ่มต้นของ 4 Role ในเอกสารต้นทาง โดย V = ดู, A = เพิ่ม, E = แก้ไข, D = ลบ

| ทรัพยากร / หน้าจอ | Owner / Super Admin | Branch Manager | Head Barista / Kitchen Lead | Cashier / Staff |
| --- | --- | --- | --- | --- |
| หน้าขาย POS และบิล | VAED | VAED | V | VA |
| เปิด-ปิดกะ, Cash In/Out | VAED | VAED | - | VA (กะตัวเอง) |
| พนักงานและสิทธิ์ | VAED ทุกสาขา | VAED เฉพาะสาขาตน | - | - |
| สินค้า, เมนู, หมวดหมู่, Modifier | VAED | VAED | VAED (เมนู) | V |
| วัตถุดิบ, BOM, Lot/EXP | VAED | VAED | VAED | V |
| รับเข้า, นับสต็อก | VAED | VAE + อนุมัติ | VAE (ไม่อนุมัติเอง) | - |
| Waste Log | VAED | VAED | VAE | - |
| โปรโมชัน, สมาชิก (CRM) | VAED | VAED | V | VA (สมาชิก) |
| ค่าใช้จ่าย / Petty Cash | VAED | VAED | - | A (ระหว่างกะ) |
| รายงานยอดขายและการเงิน | V ทุกสาขา + รวม | V สาขาตน | V (รายงานวัตถุดิบ/Waste) | V (กะตัวเอง) |
| ตั้งค่าระบบ, VAT, Notification, License | VAED | V | - | - |
| Backup/Restore, Audit Log | VAED | V (Audit สาขาตน) | - | - |

การทำงานที่อ่อนไหวแยกเป็น **Action Permission** ที่ต้องผ่านการอนุมัติ:

- `bill.void` — Cashier ขอ Void ได้ แต่ต้องให้ Branch Manager ยืนยันด้วย PIN พร้อมใส่เหตุผล และบันทึก Audit Log
- `discount.manual`, `price.change` — เฉพาะ Manager ขึ้นไป หรือ Cashier ที่ได้รับสิทธิ์รายบุคคล
- `stock.adjust.approve` — Manager อนุมัติผลต่างจากการนับสต็อกก่อนตัดยอดจริง
- `system.backup`, `system.restore` — Owner เท่านั้น

แนวทางใช้ BetterAuth: ใช้ Organization + Access Control plugin โดยกำหนด key รูปแบบ `resource:action` (เช่น `inventory:edit`) เก็บ Role และ Permission ในตาราง SQLite เพื่อให้ Owner ปรับเองได้ พนักงานผูกกับสาขาหลักหนึ่งสาขา และเพิ่มสิทธิ์เข้าทำงานข้ามสาขาได้ผ่านตารางเชื่อมต่างหาก ฝั่ง API ตรวจสิทธิ์ทุก request และฝั่ง UI ซ่อนเมนูที่ไม่มีสิทธิ์ View

## 3. แผนผังโมดูล

ระบบแบ่งเป็น 15 โมดูล แต่ละโมดูลเป็นเจ้าของตารางของตัวเอง และคุยกันผ่าน Domain Service เท่านั้น ไม่เขียนข้ามตารางกันตรงๆ

| # | โมดูล | ขอบเขต | ผู้ใช้หลัก |
| --- | --- | --- | --- |
| 1 | Organization & Auth | Company, Branch, พนักงาน (≤ 10 คน/สาขา), Role/Permission, Session, PIN อนุมัติ | Owner, Manager |
| 2 | POS Sales | Cart, Dine-in/Takeaway/Delivery (บันทึก Order ID ค่าย), ชำระเงินสด/PromptPay, ใบกำกับภาษีย่อ/เต็ม, Reprint, Void | Cashier |
| 3 | Shift & Cash Drawer | เปิด-ปิดกะ, Float, Cash Drop/Payout, นับเงินแยกพิกัด, Over/Short, Z-Report | Cashier, Manager |
| 4 | Catalog | สินค้า 3 ประเภท (ชงสด/อาหาร/สำเร็จรูป), หมวดหมู่ + ไอคอน, Option Group, Size Variant, Barcode | Head Barista, Manager |
| 5 | Inventory | วัตถุดิบ, BOM, Lot + EXP, FIFO, % คงเหลือ, Daily/Full Count, Variance, อนุมัติปรับสต็อก | Head Barista, Manager |
| 6 | Waste & Loss | Ingredient/Finished Waste, เหตุผล, COGW | Head Barista |
| 7 | Promotion & CRM | สมาชิก (ค้นหาด้วยเบอร์), Tier, แต้ม, คูปอง, X Get Y, Buy X Get Y Free, Happy Hour | Manager, Cashier |
| 8 | KDS / Bar Display | Routing ตามหมวด, NEW → PREPARING → READY → COMPLETED, Timer Warning | Barista, ครัว |
| 9 | Customer Facing Display | ตะกร้า Live, PromptPay Dynamic QR, Idle Slider/Video | ลูกค้า |
| 10 | A4 Label Editor | Grid 2×5 / 3×7 / 4×10, ประเภทฉลาก, Field Toggle, Live Preview, Overflow Detection | Head Barista, Manager |
| 11 | Accounting & Reports | Petty Cash, VAT 7%/0%/Non-VAT (Include/Exclude), รายงาน 4 ชุด, Daily Summary | Owner, Manager |
| 12 | Notification | กระดิ่งหน้า Dashboard (5 รายการล่าสุด), อีเมล (SMTP), กฎการแจ้งเตือนในเมนูตั้งค่า | ทุก Role ตามสิทธิ์ |
| 13 | System Admin | Audit Log, Backup/Restore (+ PITR), System Info, Health Check, Release Notes, Roadmap | Owner |
| 14 | License Manager | Hardware Fingerprint, .LIC, Feature Flags, จำกัดพนักงาน/สาขา | Owner |
| 15 | Sync Engine | คิว Offline, Exponential Backoff, Conflict Resolution | ระบบ |

## 4. ออกแบบฐานข้อมูล (SQLite)

ฐานข้อมูลแบ่งเป็น 8 กลุ่มตาราง ทุกตารางที่ผูกกับสาขามี `branch_id` เพื่อให้กรองสิทธิ์และ Sync ได้ง่าย

| กลุ่ม | ตารางหลัก |
| --- | --- |
| องค์กร/สิทธิ์ | `company`, `branch`, `user`, `employee`, `role`, `role_permission`, `employee_branch_access` |
| คะตาลอก | `category`, `product`, `product_variant`, `option_group`, `option_item`, `product_option_group`, `recipe_line` (BOM) |
| คลัง | `ingredient`, `stock_lot`, `stock_ledger`, `stock_count` + `stock_count_line`, `stock_adjustment`, `waste_log` |
| ขาย | `sale_order`, `sale_order_item`, `sale_item_option`, `payment`, `tax_invoice`, `bill_event` (void/reprint) |
| กะ/ลิ้นชัก | `shift`, `cash_movement`, `cash_count` |
| ลูกค้า/โปรโมชัน | `member`, `member_tier`, `point_ledger`, `promotion`, `promotion_rule`, `coupon` |
| บัญชี | `expense`, `expense_category`, `tax_config` |
| ระบบ | `audit_log`, `notification`, `notification_rule`, `sync_queue`, `license`, `app_setting`, `backup_job`, `label_template`, `kds_ticket` |

กฎการออกแบบที่ใช้กับทุกตาราง:

- **Primary key = UUIDv7 (TEXT)** — สร้างได้ออฟไลน์ไม่ชนกัน เรียงตามเวลาได้ เหมาะกับ Sync
- **เงินเก็บเป็น INTEGER (สตางค์)** ห้ามใช้ float กับเงิน ปริมาณวัตถุดิบเก็บเป็นหน่วยฐาน (ml, g, ชิ้น) เป็น INTEGER หรือ REAL ที่ round ทุกครั้ง
- **Append-only ในงานสำคัญ** — `stock_ledger`, `point_ledger`, `audit_log`, `bill_event` ห้าม UPDATE/DELETE แก้ไขด้วยการเพิ่มรายการกลับรายการเท่านั้น
- **ทุกแถวมี** `branch_id`, `created_at`, `updated_at`, `deleted_at` (soft delete), `rev` (เลขเวอร์ชันสำหรับ Sync)
- **ไม่ลบบิล** — บิลที่ Void คงสถานะ `voided` พร้อมเหตุผลและผู้อนุมัติ เลขบิลต้องต่อเนื่องตามข้อกำหนดใบกำกับภาษี (แยก running no. ต่อสาขาและชนิดเอกสาร)

ตารางแกนกลางส่วนสำคัญสุด (สต็อก BOM/FIFO, การขาย, กะ) เขียนเป็น DDL ได้ดังนี้:

```sql
CREATE TABLE ingredient (
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL,
  name TEXT NOT NULL, base_unit TEXT NOT NULL,        -- ml | g | pcs
  pack_size REAL NOT NULL,                            -- ปริมาตรเต็มขวด/แพ็ค เช่น 1000 ml
  min_level REAL DEFAULT 0, is_daily_count INTEGER DEFAULT 0
);
CREATE TABLE stock_lot (
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, ingredient_id TEXT NOT NULL REFERENCES ingredient(id),
  lot_no TEXT, received_at TEXT NOT NULL, expires_at TEXT,
  qty_received REAL NOT NULL, qty_remaining REAL NOT NULL,
  unit_cost_satang REAL NOT NULL                      -- ต้นทุนต่อหน่วยฐาน
);
CREATE INDEX idx_lot_fifo ON stock_lot(ingredient_id, expires_at, received_at) WHERE qty_remaining > 0;
CREATE TABLE stock_ledger (                           -- append-only
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, lot_id TEXT NOT NULL REFERENCES stock_lot(id),
  qty_delta REAL NOT NULL, reason TEXT NOT NULL,      -- sale|receive|waste|adjust|count
  ref_type TEXT, ref_id TEXT, cost_satang INTEGER, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sale_order (
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, shift_id TEXT NOT NULL REFERENCES shift(id),
  bill_no TEXT NOT NULL, order_type TEXT NOT NULL,    -- dine_in|takeaway|delivery
  channel TEXT, ext_order_id TEXT,                    -- Grab|Lineman|ShopeeFood|Foodpanda
  member_id TEXT, subtotal INTEGER, discount INTEGER, vat INTEGER, total INTEGER,
  vat_mode TEXT, status TEXT NOT NULL,                -- open|paid|voided
  created_by TEXT, created_at TEXT NOT NULL, UNIQUE(branch_id, bill_no)
);
CREATE TABLE shift (
  id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL, closed_at TEXT,
  float_satang INTEGER NOT NULL, actual_cash INTEGER, over_short INTEGER, status TEXT NOT NULL
);
```

สูตรที่ระบบคำนวณ (จากเอกสารต้นทาง):

```latex
\text{Over/Short} = \text{Actual Cash} - (\text{Starting Cash} + \text{Cash Sales} - \text{Cash Expenses})
```

```latex
\text{Asset Value} = \text{Total Cost} \times \frac{\text{Current Volume}}{\text{Full Volume}}, \qquad \text{Percent} = \frac{\text{Current Volume}}{\text{Full Volume}} \times 100
```

## 5. Flow ธุรกิจหลัก

### 5.1 การชำระเงิน (Checkout) — 1 Database Transaction

1. พนักงานเลือกสินค้า สแกนบาร์โค้ด เลือก Size, ความหวาน, Topping และประเภทออเดอร์ (หน้าจอ CFD อัปเดตทันที)
2. Promotion Engine คำนวณส่วนลดอัตโนมัติ (Happy Hour, Bundle, Tier) และคำนวณ VAT ตามค่าของสาขา (Include/Exclude)
3. รับชำระ: เงินสด (คำนวณเงินทอน) หรือ PromptPay QR (ฝังยอดใน QR แล้วยืนยันการรับเงิน)
4. **Transaction เดียว**: สร้าง `sale_order` + `sale_order_item` + `payment` → เขียน `stock_ledger` ตาม BOM/FIFO → สะสมแต้ม → สร้าง `kds_ticket` → เขียน `audit_log` → ใส่ `sync_queue` ถ้าล้มทั้งชุดให้ rollback
5. หลัง commit: พิมพ์ใบกำกับภาษีอย่าง่ย (หรือเต็มรูปแบบเมื่อลูกค้าขอ) เปิดลิ้นชัก ส่งตั๋วไป KDS ผ่าน SSE

การพิมพ์และลิ้นชักทำหลัง commit เสมอ ถ้าเครื่องพิมพ์เสีย บิลยังสำเร็จ และสั่ง Reprint ได้ภายหลัง

### 5.2 ตัดสต็อก BOM + FIFO

ตัวอย่าง "กาแฟเย็น 1 แก้ว (16 oz)" ตามเอกสารต้นทาง:

| วัตถุดิบ | ปริมาณต่อ 1 แก้ว | หมายเหตุ |
| --- | --- | --- |
| เมล็ดกาแฟ | 18 g |  |
| นมสด | 120 ml |  |
| ไซรัป | 15 ml |  |
| แก้ว 16 oz + ฝา | 1 ใบ + 1 ชิ้น | คูณตาม Size เช่น 22 oz × 1.2 เป็นค่าเริ่มต้นของทุกวัตถุดิบ และตั้งค่าต่อวัตถุดิบได้ |
| ไข่มุก (Topping) | 30 g | เพิ่มเมื่อเลือก Topping |

ขั้นตอนต่อ 1 วัตถุดิบ: หาปริมาณที่ต้องใช้ (สูตร × ตัวคูณขนาด × จำนวน) → เลือก Lot ที่ `qty_remaining > 0` ตามกฎ: วัตถุดิบที่มีวันหมดอายุเรียงแบบ FEFO (หมดอายุก่อนตัดก่อน) ส่วนวัตถุดิบอื่นเรียงแบบ FIFO ตามวันที่รับเข้า → ตัดทีละ Lot จนครบ → เขียน `stock_ledger` หนึ่งแถวต่อ Lot ที่ตัด (บันทึกต้นทุนจริงต่อบิล) หากสต็อกไม่พอ ระบบยังขายได้และติดลบใน Lot สมมติ พร้อมแจ้งเตือนให้นับสต็อก (ไม่หยุดขายหน้าร้าน)

### 5.3 กะและลิ้นชัก

1. **เปิดกะ** — กรอก Float เงินทอนเริ่มต้น การขายทุกบิลผูกกับ `shift_id` ห้ามขายถ้าไม่มีกะที่เปิดอยู่
2. **ระหว่างกะ** — บันทึก Cash Drop, Petty Cash, Payout เป็น `cash_movement` (ต้องใส่เหตุผล)
3. **ปิดกะ** — นับแบงก์ 1000/500/100/เหรียญ → ระบบคำนวณ Over/Short → พิมพ์ Z-Report แยก Cash, PromptPay, Delivery Platforms → ล็อกกะ ห้ามแก้บิลย้อนหลังโดยไม่มีสิทธิ์ Manager

### 5.4 KDS และ Waste

| สถานะตั๋ว KDS | สี | พฤติกรรม |
| --- | --- | --- |
| NEW | ส้ม | เสียงเตือน ส่งเข้า Bar หรือ Kitchen ตามหมวด |
| PREPARING | เหลือง | เริ่มจับเวลา เกินเกณฑ์ (เช่น กาแฟ 5 นาที) การ์ดกระพริบแดง |
| READY | เขียว | แจ้งพนักงานหน้าร้าน |
| COMPLETED | - | Bump ออกจากจอ เก็บเวลาเตรียมไว้ในรายงาน |

จุด Modifier ที่ต้องแสดงตัวหนา/สีแดงบน KDS (เช่น หวาน 0%, ไม่ใส่นมสด, Topping) มาจาก `sale_item_option` โดยตรง

**Waste** — เลือก Ingredient Waste หรือ Finished Product Waste + เหตุผล (Expired, Damaged/Dropped, Made Wrong Order, Quality Test) → ตัดจาก Lot แบบ FIFO เขียน `stock_ledger` (reason = waste) → ส่งต้นทุนไปบัญชี COGW แยกจาก Shrinkage ที่ไม่ทราบสาเหตุจากการนับสต็อก

## 6. Offline-First, LAN และ Sync

การขายทำงานได้ต่อเนื่องแม้ไม่มีอินเทอร์เน็ต เพราะออกแบบให้สองชั้นแยกจากกัน: **LAN** (เครื่องรอง ↔ เครื่องหลัก ทำงานกับข้อมูลจริงแบบ real-time) และ **Cloud Sync** (เครื่องหลัก ↔ Cloud เมื่อออนไลน์)

| ชั้น | กลไก | เมื่อลิงก์หลุด |
| --- | --- | --- |
| เครื่องรอง ↔ เครื่องหลัก (LAN) | HTTP REST + SSE/WebSocket, ค้นหาเครื่องหลักอัตโนมัติด้วย mDNS หรือกรอก IP เอง | เครื่องรองแจ้ง "หลุดการเชื่อมต่อ" และลองต่อใหม่ทุก ๆ ไม่กี่วินาที เครื่องรองเก็บบิลชั่วคราวแล้วส่งคืนเมื่อเชื่อมต่อได้ (ดูด้านล่าง) |
| เครื่องหลัก ↔ Cloud | คิว `sync_queue` ส่งเป็นชุดตามลำดับ, Exponential Backoff, ทำซ้ำได้ไม่เกิดข้อมูลซ้ำ (Idempotency Key) | ขายต่อได้ปกติ คิวสะสมใน SQLite และส่งเมื่อออนไลน์ |

**โหมดการติดตั้ง** — เลือกตอนติดตั้ง: *Standalone* (เครื่องเดียว ไม่มีเครื่องหลัก คือ Host ที่ไม่เปิด LAN), *Host* (เปิด LAN เก็บข้อมูลจริง) หรือ *Client* (เครื่องรอง) เปลี่ยนจาก Standalone เป็น Host ได้ภายหลังโดยไม่สูญข้อมูล

**เมื่อเครื่องหลักดับ** — เครื่องรองขายต่อได้ในโหมด Pending: เขียนบิลลงคิวบนเครื่องรอง (SQLite เล็กในเครื่องนั้น) พิมพ์ใบเสร็จได้ แล้วส่งคืนเครื่องหลักเมื่อต่อติด ในช่วงนั้น:

- **เลขบิล** — เครื่องหลักจองช่วงเลขบิลให้เครื่องรองล่วงหน้าเป็นชุด (เช่น 100 เลขต่อชุด) ใช้เลขจากชุดนั้นได้แม้ออฟไลน์ เลขจึงไม่ซ้ำและใช้กับใบกำกับภาษีได้
- **สต็อก** — เครื่องรองไม่ตัดสต็อกเอง เครื่องหลักจะตัดตาม BOM/Lot ตอนรับบิลคืน ถ้าสต็อกไม่พอใส่ Variance ให้ Manager ตรวจ
- **KDS/CFD** — ไม่ทำงานจนกว่าเครื่องหลักกลับมา พนักงานต้องแจ้งเบาร์ด้วยปากหรือใบพิมพ์สำรอง (อยากให้พิมพ์ใบออเดอร์ออกเครื่องพิมพ์บาร์ช่วงนั้น)

รายละเอียดการ Sync:

- **คิวส่งขึ้น** — ทุก transaction ที่เปลี่ยนข้อมูล (บิล, กะ, สต็อก, Audit Log) ถูกเขียนลง `sync_queue` ใน transaction เดียวกับข้อมูลจริง (อย่าง Outbox Pattern) จึงไม่มีการสูญหาย
- **ทิศทาง** — ข้อมูลประมวลผลในสาขาส่งขึ้น Cloud; Master Data (สินค้า, ราคา, สูตร, สมาชิก) ดึงลงมาเป็น Snapshot และ Delta
- **Conflict Resolution** — ใช้ Timestamp + Vector Clock สำหรับข้อมูลที่แก้ได้หลายที่ เช่น Master Data; ข้อมูล Ledger (แต้ม, สต็อก) ใช้การรวมรายการ (ผลรวมจาก delta) แทนการเขียนทับ ปัญหา "แต้มถูกใช้จาก 2 เครื่อง" จึงใช้ไม่ได้เกินยอดคงเหลือ
- **ไม่สูญเสียบิลเมื่อเครื่องหลักดับ** — สำรอง SQLite เป็นไฟล์ไปที่อุปกรณ์จัดเก็บอื่น (USB/NAS) ตามตารางเวลา และใช้ WAL + `PRAGMA synchronous=FULL` กับตารางการเงิน

การสำรองและกู้คืน: อัตโนมัติรายวันขึ้น Cloud, กดสำรองเองได้เป็น .sql หรือ .tar.gz และกู้คืนย้อนหลัง (PITR) ได้ผ่านการเก็บ Snapshot + WAL หรือ Change Log (ดูข้อสังเกตในหัวข้อ 10)

## 7. License Manager และความปลอดภัย

ใบอนุญาตผูกกับฮาร์ดแวร์ของเครื่องหลักและตรวจที่เครื่องเองแบบ offline ด้วยลายเซ็น Ed25519 เจ้าของซอฟต์แวร์เก็บ Private Key ไว้ฝั่งออก License แอปฝังเฉพาะ Public Key

1. ติดตั้งครั้งแรก → แอปอ่าน Hardware Fingerprint (CPU ID + Motherboard Serial + MAC Address) และสร้าง **Hardware ID Code**
2. ผู้ใช้ส่งรหัสให้ผู้พัฒนา → ผู้พัฒนาออกไฟล์ `.LIC` ด้วย Private Key
3. ผู้ใช้กรอก License Key หรืออัปโหลด `.LIC` → แอปตรวจลายเซ็น, Hardware ID, วันหมดอายุ แล้วเปิดใช้งานตาม Feature ในไฟล์
4. ทุกครั้งที่เปิดแอปและทุกวันที่รันค้างไว้ → ตรวจซ้ำ และแจ้งเตือนก่อนหมดอายุ (ผ่านระบบ Notification)

โครงสร้าง Payload ของไฟล์ .LIC:

```json
{
  "v": 1,
  "licenseId": "uuid",
  "company": "ชื่อบริษัท",
  "branchId": "BR-001",
  "hardwareId": "sha256-of-fingerprint",
  "allowedEmployees": 10,
  "allowedTerminals": 3,
  "features": ["pos", "kds", "cfd", "label", "crm", "multi-branch"],
  "issuedAt": "2026-11-05",
  "expiresAt": "2027-11-05"
}
// ไฟล์จริง = base64(payload) + "." + base64(ed25519_signature)
```

ข้อกำหนดด้านความปลอดภัยบนแพลตฟอร์มทั้งระบบ:

- **Hardware ID** — MAC Address เปลี่ยนได้ง่าย (เช่น เปลี่ยนการ์ด LAN) ควรใช้แบบผสม และยอมให้ตรงกันได้ 2 จาก 3 ค่า พร้อมขั้นตอนย้ายเครื่อง (ออกไฟล์ใหม่)
- **นาฬิกาแอบแฝง** — บันทึกเวลาใช้งานล่าสุดในฐานข้อมูล หากเวลาเครื่องถูกปรับย้อนหลังเพื่อยืดอายุ License ให้ปฏิเสธและบันทึก Audit Log
- **Grace Period** — License หมดอายุแล้วยังใช้หน้าขายได้ช่วงสั้น ๆ แล้วจำกัดเป็นโหมดดูข้อมูล/ส่งออกเท่านั้น ไม่ล็อกข้อมูลผู้ประกอบการ
- **หน้าต่าง Renderer** — `contextIsolation: true`, `nodeIntegration: false`, ปิด remote module และใช้ `preload` เปิดเฉพาะ API ที่จำเป็น
- **LAN API** — ผูกที่ `0.0.0.0` เฉพาะเมื่อเปิดโหมด Host, เครื่องรองต้อง Pair ด้วย Pairing Code และส่ง Token ทุก request ทั้งหมด, พิจารณา TLS แบบ self-signed ใน LAN
- **รหัสผ่าน/PIN** — แฮชด้วย Argon2id (ผ่าน BetterAuth) และจำกัดจำนวนครั้ง Login ผิด
- **ไฟล์สำรอง** — เข้ารหัสด้วยรหัสผ่านที่ Owner ตั้ง เพราะมีข้อมูลสมาชิกและการเงิน

## 8. API และ Event ภายใน

ทุกหน้าจอคุยกับ Fastify ผ่าน REST (`/api/v1`) และรับการอัปเดต real-time ผ่าน SSE ทุก endpoint ตรวจ Session (BetterAuth) → สิทธิ์ `resource:action` → ขอบเขตสาขา (`branch_id`) ก่อนเข้า service

| กลุ่ม | Endpoint หลัก | สิทธิ์ที่ใช้ |
| --- | --- | --- |
| Auth | `POST /auth/sign-in`, `POST /auth/pin-override`, `GET /me` | สาธารณะ / ทุก Role |
| กะ | `POST /shifts/open`, `POST /shifts/:id/cash-movements`, `POST /shifts/:id/close`, `GET /shifts/:id/z-report` | `shift:add`, `shift:edit` |
| ขาย | `POST /orders`, `POST /orders/:id/pay`, `POST /orders/:id/void`, `POST /orders/:id/reprint`, `GET /orders` | `sale:add`, `bill.void` |
| คะตาลอก | `GET/POST/PATCH /products`, `/categories`, `/option-groups`, `/recipes` | `catalog:*` |
| สต็อก | `POST /inventory/receive`, `POST /inventory/counts`, `POST /inventory/adjustments/:id/approve`, `POST /inventory/waste`, `GET /inventory/lots?near_expiry=7` | `inventory:*`, `stock.adjust.approve` |
| ลูกค้า/โปรโมชัน | `GET /members?phone=`, `POST /promotions/evaluate`, `POST /coupons/redeem` | `crm:*`, `promotion:*` |
| บัญชี/รายงาน | `GET /reports/sales`, `/reports/drawer`, `/reports/usage-waste`, `/reports/daily-summary`, `POST /expenses` | `report:view`, `expense:add` |
| ระบบ | `GET /audit-logs`, `POST /backups`, `POST /restore`, `GET /system/health`, `GET /system/info`, `POST /license/activate` | `system:*` (Owner) |
| แจ้งเตือน | `GET /notifications?limit=5`, `PATCH /notifications/:id/read`, `PUT /settings/notifications` | ทุก Role ตามสิทธิ์ |

ช่อง SSE (สมัครรับตามสาขา/สถานี):

- `/events/kds?station=bar|kitchen` — ตั๋วใหม่ เปลี่ยนสถานะ เตือนเกินเวลา
- `/events/cfd?terminal=<id>` — ตะกร้าสด ยอดรวม PromptPay QR สถานะ Idle
- `/events/notifications` — รายการแจ้งเตือนใหม่ให้กระดิ่ง (จำนวนที่ยังไม่อ่าน)
- `/events/system` — สถานะ Online/Offline, คิว Sync ค้าง, การเชื่อมต่อเครื่องหลัก

กฎของ API: ทุกการเขียนที่สร้างออเดอร์/ชำระเงินรับ `Idempotency-Key` กันกดซ้ำเมื่อเครื่อข่ายชะงัก คืนค่าเงินเป็นสตางค์ (integer) เสมอ และ error ใช้รูปแบบเดียว `{ code, message, details }` เพื่อให้ UI แสดงข้อความภาษาไทยได้จาก `code`

## 9. UX/UI

ภาพอ้างอิงในเอกสารต้นทางใช้เป็นแนว Layout เท่านั้น (เนื้อหาในภาพเป็นของระบบอื่น) จึงเก็บเฉพาะโครง ไม่คัดลอกสีและข้อความ

### 9.1 Dashboard Shell

| ส่วน | ข้อกำหนด |
| --- | --- |
| Header | ปุ่ม Toggle Sidebar · Label สถานะระบบ (Online / Offline / Sync ค้าง N) · ปุ่ม Dark/Light/System · กระดิ่ง (แสดง 5 รายการล่าสุด + badge จำนวนที่ไม่อ่าน) · เมนูผู้ใช้ (ชื่อ + Role → ข้อมูลผู้ใช้, ตั้งค่า, ออกจากระบบ) |
| Sidebar | พับ/ขยายได้ (ไอคอนอย่างเดียวเมื่อพับ) · เมนูให้เห็นเฉพาะหน้าที่มีสิทธิ์ View · บนมือถือเป็น Drawer ทับเนื้อหา |
| ปรับขนาดอัตโนมัติ | ≥ 1280 px: Sidebar ขยาย · 768–1279 px: Sidebar แบบไอคอน · < 768 px: Drawer + Bottom Action Bar บนหน้า POS |

### 9.2 Dashboard Content (ตามสิทธิ์ Role)

ตัวเลือกช่วงเวลา: วันนี้ · เมื่อวาน · สัปดาห์นี้ · เดือนนี้

| Widget | ข้อมูล | Owner | Manager | Head Barista | Cashier |
| --- | --- | --- | --- | --- | --- |
| Summary Card 4 ใบ | ยอดขาย · จำนวนบิล · ยอดเฉลี่ย/บิล · กำไรขั้นต้น (ยอดขาย − ต้นทุน BOM − ค่าใช้จ่าย) | ทุกสาขา | สาขาตน | จำนวนแก้ว/บิล + Waste | กะตัวเอง |
| ยอดขายรายชั่วโมง | กราฟแท่ง/เส้น | ✓ | ✓ | - | ✓ (กะตัวเอง) |
| สัดส่วนช่องทางการขาย | Donut: Dine-in / Takeaway / Grab / Lineman / ShopeeFood / Foodpanda | ✓ | ✓ | - | - |
| ขายดี 5 อันดับแรก | จำนวนและยอด | ✓ | ✓ | ✓ | ✓ |
| วัตถุดิบใกล้หมด / ใกล้ EXP | รายการ + % คงเหลือ + วันหมดอายุ (3/7 วัน) | ✓ | ✓ | ✓ | - |
| เดลิเวอรี่ | ยอดแยกค่าย, จำนวนออเดอร์, Order ID ล่าสุด | ✓ | ✓ | - | - |
| กะและลิ้นชัก | สถานะกะ เงินสดในลิ้นชัก Over/Short ล่าสุด | ✓ | ✓ | - | ✓ |
| รายการรอดำเนินการ | อนุมัติปรับสต็อก, Void ที่รอยืนยัน, License ใกล้หมด, Backup ล่าสุด | ✓ | ✓ (บางรายการ) | - | - |

### 9.3 หน้า POS (หน้าขาย)

- **ซ้าย (ประมาณ 60%)** — แถบหมวดหมู่ (ไอคอน Lucide) + ช่องค้นหา/สแกนบาร์โค้ด + Grid การ์ดสินค้าปุ่มใหญ่ แตะได้แม้ใส่ถุงมือ (≥ 44 px)
- **ขวา (ประมาณ 40%)** — ตะกร้า: ออเดอร์ประเภท (Dine-in/Takeaway/Delivery), สมาชิก, รายการพร้อม Modifier, ส่วนลด, VAT, ยอดรวม, ปุ่มชำระเงินใหญ่
- **Modifier Sheet** — เปิดเมื่อแตะเมนู เลือกขนาด, ความหวาน (0/25/50/100/125%), Topping และสถานะสต็อกคงเหลือของ Topping นั้น
- **ทางลัด** — ปุ่มเงินสดด่วน (จำนวนเต็ม/แบงก์ยอดนิยม), Hold/Recall ออเดอร์, ค้นสมาชิกด้วยเบอร์โทร, Cash In/Out

### 9.4 สไตล์และความสามารถในการเข้าถึง

- Design Token ผ่าน CSS Variables + Tailwind รองรับ Light/Dark/System เป็นค่าเริ่มต้น ใช้สีหลัก (Primary) 1 สีสำหรับปุ่ม Action และสีสถานะ 4 สี (สำเร็จ/เตือน/ผิดพลาด/ข้อมูล)
- สถานะใน KDS ไม่สื่อด้วยสีอย่างเดียว มีข้อความกำกับเสมอ (NEW / PREPARING / READY) ตัวอักษร ≥ 16 px บนจอ KDS ความทึบสีผ่าน WCAG AA
- หน้าใดที่ไม่มีสิทธิ์ ไม่แสดงในเมนู และเข้าตรง URL ได้ผลเป็นหน้า 403 ที่อธิบายชัดเจน
- ทุกหน้าไม่พึ่งเม้าส์เท่านั้น รองรับจอสัมผัส และคีย์ลัดหน้าขาย (เช่น F2 = ชำระเงิน, F4 = ค้นหา)

## 10. Roadmap และจุดที่ต้องตัดสินใจ

### 10.1 เฟสการพัฒนา

แบ่งให้ได้ของที่ขายจริงได้ตั้งแต่เฟส 1 และทดสอบกับร้านจริงก่อนเพิ่มฟีเจอร์ถัดไป (ยังไม่กำหนดวันที่ เพราะขึ้นกับจำนวนนักพัฒนา)

| เฟส | เนื้อหา | เกณฑ์ผ่าน |
| --- | --- | --- |
| 0. Foundation | โครง Electron + Fastify + SQLite Migration, BetterAuth + RBAC, License Verify, Audit Log, Settings, Design System | ล็อกอินได้ เห็นเมนูตามสิทธิ์ ใช้งานได้เฉพาะเมื่อมี License |
| 1. MVP ขายได้ | Catalog + Modifier, POS, เงินสด + PromptPay, ใบเสร็จ + ใบกำกับภาษี, กะ + Z-Report, VAT | ปิดกะได้ยอดตรงกับบิล ทุกบิลพิมพ์ซ้ำได้ |
| 2. สต็อกและบัญชี | วัตถุดิบ, BOM, Lot/FIFO, % คงเหลือ, นับสต็อก + อนุมัติ, Waste, Expense, รายงาน | ขาย 1 แก้วแล้วสต็อกลดตามสูตร ค่าผลต่างจากการนับอยู่ใน Variance Log |
| 3. หลายเครื่อง | โหมด Host/Client ผ่าน LAN, KDS, CFD, Dashboard, Notification (กระดิ่ง + อีเมล) | 3 เครื่อง (POS, KDS, CFD) ทำงานพร้อมกันได้ตั้งแต่เปิดสาขา |
| 4. เติบโต | CRM + Promotion Engine, A4 Label Editor, Delivery, Backup/PITR, Cloud Sync, Multi-branch | สาขา 2 ซิงก์ขึ้น Cloud ได้และกู้คืนจาก Backup ได้ |
| 5. พร้อมจำหน่าย | Installer, Auto-update, ทดสอบไฟดับ/เน็ตหลุด, Pilot ในร้านจริง, เอกสารผู้ใช้, ระบบออก License | ติดตั้งใหม่บนเครื่องเปล่าได้ภายในไม่เกินชั่วโมงเดียว |

### 10.2 การตัดสินใจที่ยืนยันแล้ว

| หัวข้อ | การตัดสินใจ | ผลต่อการออกแบบ |
| --- | --- | --- |
| จำนวนพนักงาน | ให้ License กำหนดเพดานตามแพ็กเกจ | `allowedEmployees` คือเพดานของแพ็กเกจ (ค่าเริ่มต้น 10 คน/สาขา) แอปบล็อกการเพิ่มพนักงานเมื่อเต็มและแจ้งผ่าน Notification |
| SQLite driver | better-sqlite3 ที่ rebuild ให้ตรงกับ Electron | Build native module ด้วย Electron เวอร์ชันที่พาคแอปจริง และ rebuild ทุกครั้งที่อัปเกรด Electron (อยู่ใน CI) |
| Local NoSQL | ไม่ใช้ | ดูเหตุผลใน 10.3 |
| รูปแบบการติดตั้ง | เครื่องเดียว (Standalone) และ LAN หลายเครื่อง | โหมด Standalone / Host / Client เลือกตอนติดตั้ง (หัวข้อ 6) |
| เครื่องหลักดับ | เครื่องรองเก็บบิลชั่วคราวแล้วส่งคืน | จองช่วงเลขบิลล่วงหน้าให้แต่ละเครื่องรอง ไม่ตัดสต็อกจนกว่าจะส่งคืน |
| ลำดับตัดสต็อก | FEFO กับวัตถุดิบที่มีวันหมดอายุ อื่น ๆ FIFO | เพิ่ม `ingredient.has_expiry`; Lot ที่มีวันหมดอายุเรียง `expires_at`, ไม่มีเรียง `received_at` |
| ตัวคูณ Size | คูณทุกวัตถุดิบ และตั้งค่าได้ต่อวัตถุดิบ | เพิ่ม `ingredient.size_scale_mode` (ค่าเริ่มต้น = ใช้ตัวคูณของ Size) และ `size_scale_override` สำหรับกำหนดตัวเลขเองของวัตถุดิบนั้น |
| PromptPay | ตั้งค่า QR ได้ ให้พนักงานกดยืนยันเอง ส่วน API ยืนยันอัตโนมัติเป็นแผนอนาคต | หน้าตั้งค่าต่อสาขา: PromptPay ID (เบอร์โทร/เลขผู้เสียภาษี/e-Wallet) และชนิด Static หรือ Dynamic (ฝังยอด); `payment` เก็บ `confirmed_by`, `confirmed_at` และสถานะ `confirmation_source` = manual (เผื่อใส่ `api` ในอนาคต) |
| ใบกำกับภาษี | ออกได้ทั้งอย่างย่อและเต็มรูปแบบ | `tax_invoice.type` = abbreviated / full; แบบเต็มรูปเก็บชื่อ ที่อยู่ เลขผู้เสียภาษี และสาขาของผู้ซื้อ เลขรันแยกตามชนิดเอกสาร ควรให้นักบัญชีตรวจรูปแบบก่อนใช้จริง |
| Delivery | ไม่เชื่อม API | พนักงานกรอก Order ID ค่ายเองใน `sale_order.ext_order_id` |
| PITR | ให้แนะนำแบบที่เหมาะสม | ดู 10.4 |

### 10.3 แนะนำ: ไม่ต้องใช้ Local NoSQL

ขอบเขตที่เอกสารต้นทางให้ LokiJS/RxDB ทำ 3 งาน ซึ่ง SQLite ทำได้หมด และดีกว่าในแง่ความถูกต้องของข้อมูล:

| งาน | ทำด้วย | เหตุผล |
| --- | --- | --- |
| คิว Sync / Offline Queue | ตาราง `sync_queue` ใน SQLite (Outbox) | เขียนใน transaction เดียวกับบิล จึงไม่มีกรณีบิลบันทึกแล้วคิวหาย ถ้าใช้ NoSQL แยก ต้องคอยทำให้ 2 ฐานตรงกันเอง |
| KDS Live Queue | ตาราง `kds_ticket` + Event Bus (EventEmitter) ในหน่วยความจำ + SSE | ตั๋วคงอยู่หลังรีสตาร์ทแอป และ Event Bus แค่ผลักการอัปเดตไปหน้าจอ |
| Master Data Cache | SQLite อ่านตรง + TanStack Query ฝั่ง React | ร้านเล็กมีสินค้าไม่กี่พันรายการ SQLite ในไฟล์เร็วพออยู่แล้ว |

ผลดีคือลด dependency และจุดที่ข้อมูลอาจไม่ตรงกัน และบิลอญ่าไม่อยู่คนละที่กับคิว หากอนาคตต้องทำ Mobile ที่ต้องการ Replication แบบ reactive ค่อยพิจารณา RxDB อีกครั้ง

### 10.4 แนะนำ: ออกแบบ PITR บน SQLite

SQLite ไม่มี PITR ในตัว แนะนำให้แบ่งเป็น 3 ชั้น เริ่มจากชั้น A แล้วเพิ่ม B ในเฟส 4:

| ชั้น | วิธี | กู้คืนได้ถึง | ข้อควรระวัง |
| --- | --- | --- | --- |
| A. Snapshot (ทุกร้าน) | ใช้ Online Backup API ของ better-sqlite3 (`db.backup()`) ทุกวัน + ก่อนอัปเดตแอป + ก่อน Restore เก็บ 30 วัน บีบเป็น .tar.gz | จุดของ Snapshot แต่ละครั้ง (สูญสูงสุดราว 1 วัน) | ในโหมด Standalone ต้องเก็บสำเนาไปดิสก์อื่น (USB/โฟลเดอร์ Cloud) ไม่ใช่ดิสก์เดียวกับ DB |
| B. WAL Streaming (แนะนำสำหรับ PITR จริง) | ใช้เครื่องมือส่ง WAL ต่อเนื่อง เช่น Litestream รันเป็น child process จาก Electron Main ส่งไปดิสก์สำรอง/NAS/Cloud Storage | เวลาใดก็ได้ในช่วงที่เก็บ (สูญสูงสุดราวไม่กี่วินาที) | DB ต้องเป็นโหมด WAL และอยู่บนดิสก์ในเครื่อง (ไม่ใช่ Network Share) แอปไม่สั่ง checkpoint เอง และต้องทดสอบกับ Windows + Electron ก่อน (ผมยังไม่ได้ตรวจเอกสารเวอร์ชันล่าสุดของเครื่องมือนี้) |
| C. Replay (ทางสำรอง) | Snapshot รายชั่วโมง + เล่นซ้ำรายการจากตาราง append-only และ `sync_queue`/Cloud จาก Snapshot จนถึงเวลาเป้าหมาย | ครอบคลุมเฉพาะข้อมูลที่เป็น Ledger | ใช้เมื่อไม่ใช้ชั้น B กู้ได้ไม่ละเอียดเท่า และต้องทำ Replay ให้เป็น idempotent |

ขั้นตอน One-click Restore (ใช้เหมือนกันทุกชั้น): Owner เลือกเวลา → ระบบกู้ไฟล์ใหม่ไว้ข้าง ๆ (ไม่ทับของเดิม) → รัน `PRAGMA integrity_check` และแสดงสรุปจำนวนบิล/ยอดขายที่จะสูญหาย → Owner ยืนยัน → สลับไฟล์ เก็บไฟล์เดิมไว้ 7 วัน และบันทึก Audit Log

แนะนำ: ทำชั้น A ในเฟส 1–2 และเพิ่มชั้น B ในเฟส 4 ตาม Roadmap เมื่อทดสอบกับเครื่องจริงแล้ว

Sources: เอกสารผู้ใช้ "POS Management System.docx" (โฟลเดอร์ Pos\_Beverage) — ออกแบบการเก็บข้อมูล สำรอง และซิงก์ในหัวข้อ 4–6 เป็นข้อเสนอของผมที่เสริมจากเอกสาร
