# Implement.md — แผนสร้าง KPOSS (Korn POS Management System)

เอกสารนี้ใช้คู่กับ `CLAUDE.md` สำหรับสร้างโปรเจกต์ใน Claude Code
ที่มา: `POS Management System.docx` + หน้าจอต้นแบบ 20 หน้า (UI Design) ที่ผู้ใช้ยืนยันแนวทางแล้ว

---

## 0. ไฟล์ที่ต้อง Copy ไปวางใน Project ใหม่

สร้างโปรเจกต์ใหม่ที่ path ใดก็ได้ แล้วคัดลอกตามตารางนี้

| # | ไฟล์ต้นทาง | วางที่ (ใน Project ใหม่) | หมายเหตุ |
|---|---|---|---|
| 1 | `CLAUDE.md` | `./CLAUDE.md` | วางที่รากโปรเจกต์ Claude Code จะอ่านอัตโนมัติ |
| 2 | `Implement.md` (ไฟล์นี้) | `./docs/Implement.md` | แผนหลัก |
| 3 | `POS Management System.docx` (จาก `D:\Developers\NodeProjects\Pos_Beverage`) | `./docs/POS Management System.docx` | เอกสารความต้องการต้นฉบับ (หัวข้อ 5 = ข้อกำหนดการออกแบบ) |
| 4 | ไฟล์ต้นแบบหน้าจอทั้ง 20 ไฟล์ `*.dc.html` | `./docs/design/` | ดูรายการใน §0.1 |
| 5 | `canvas.json` | `./docs/design/canvas.json` | ตำแหน่งบอร์ดบนแคนวาส (เก็บไว้อ้างอิงเท่านั้น) |
| 6 | เอกสารออกแบบระบบ (Thai design spec) — export จากเอกสารใน Claude เป็น `.md` หรือ `.docx` | `./docs/Design-Spec.md` (หรือ `.docx`) | ถ้า export ไม่ได้ ข้ามได้ เพราะสาระสำคัญรวมอยู่ใน Implement.md แล้ว |

> ไฟล์ต้นแบบ `.dc.html` คือไฟล์ HTML ต้นแบบของเครื่องมือออกแบบ ใช้ **อ้างอิงหน้าตา/ข้อความ/ระยะ/สี** เท่านั้น ไม่ได้เอาไป run ในแอปโดยตรง ให้ Claude Code อ่านแล้วเขียนเป็นคอมโพเนนต์ React + Tailwind ให้เหมือน
> เมื่อเปิดไฟล์ในโปรเจกต์ใหม่ ไฟล์ `support.js` ที่ต้นแบบอ้างถึงไม่จำเป็น (ไม่ต้อง copy)

### 0.1 รายการไฟล์ต้นแบบหน้าจอ (วางใน `docs/design/`)

| ไฟล์ | หน้าจอ | สถานะ |
|---|---|---|
| `Main.dc.html` | Login | ยืนยันแล้ว |
| `Dashboard.dc.html` | Dashboard (กดโต้ตอบได้, sidebar พับกลุ่มได้) | ยืนยันแล้ว |
| `POS.dc.html` | POS หน้าขาย | ยืนยันแล้ว |
| `Shift.dc.html` | ปิดกะ / นับเงิน | ยืนยันแล้ว |
| `KDS.dc.html` | จอบาร์ (KDS) | ยืนยันแล้ว |
| `CFD.dc.html` | จอลูกค้า (CFD) | ยืนยันแล้ว |
| `Label.dc.html` | พิมพ์ฉลาก A4 (QR code) | ยืนยันแล้ว |
| `Users.dc.html` | ผู้ใช้งานระบบ | ร่างแล้ว |
| `Roles.dc.html` | จัดการสิทธิ์ | ร่างแล้ว |
| `Products.dc.html` | สินค้าและสูตร (BOM) | ร่างแล้ว |
| `Inventory.dc.html` | วัตถุดิบและสต็อก | ร่างแล้ว |
| `Receiving.dc.html` | รับเข้า / ใบสั่งซื้อ / นับสต็อก | ร่างแล้ว |
| `Waste.dc.html` | Waste / ของเสีย | ร่างแล้ว |
| `Expenses.dc.html` | บันทึกค่าใช้จ่าย | ร่างแล้ว |
| `Orders.dc.html` | บิลและประวัติ | ร่างแล้ว |
| `Reports.dc.html` | รายงานและใบกำกับภาษี | ร่างแล้ว |
| `Promo.dc.html` | โปรโมชันและสมาชิก | ร่างแล้ว |
| `Settings.dc.html` | การตั้งค่า | ร่างแล้ว |
| `Backup.dc.html` | Backup / Restore | ร่างแล้ว |
| `Audit.dc.html` | Audit Log | ร่างแล้ว |

หน้าที่ยังไม่มีต้นแบบ (ใน sidebar แต่ยังไม่ได้ออกแบบ): หมวดหมู่สินค้า, ตัวเลือกและ Topping, Z-Report, ค่าคอมมิชชันเดลิเวอรี, คูปอง → ให้สร้างตามสไตล์เดียวกับหน้าข้างเคียง (Products / Reports / Promo) และถามผู้ใช้เมื่อกฎไม่ชัด

---

## 1. เป้าหมายระบบ

POS ร้านเครื่องดื่ม ใช้งานต่อเนื่องได้แม้ไม่มีอินเทอร์เน็ตหรือ Host ล่ม ตัดสต็อกตามสูตร (BOM) ปิดกะนับเงิน ออกรายงานและใบกำกับภาษี สำรอง/กู้คืนข้อมูลย้อนเวลาได้

โหมดติดตั้ง
- **Standalone** — เครื่องเดียว
- **Host** — เครื่องหลักถือฐานข้อมูล
- **Client** — เครื่องลูก (POS/KDS/CFD) เชื่อม Host ผ่าน LAN

## 2. สถาปัตยกรรม

- Electron: main process = backend (services + better-sqlite3 + LAN API), renderer = React
- สื่อสาร renderer ↔ main ด้วย IPC ที่ type-safe (zod validate input ทุก channel)
- **Host** เปิด LAN API (HTTPS/WebSocket ภายในร้าน) ให้ Client เรียก; Client ไม่เปิดไฟล์ DB ของ Host
- **Offline ของ Client:** ถ้า Host ล่ม Client ยังขายต่อได้ เก็บบิลในคิวท้องถิ่น (SQLite ของ Client) ใช้ **บล็อกเลขที่บิลที่จองล่วงหน้า** จาก Host (เช่น ครั้งละ 200 เลข ต่อเครื่อง) แล้วส่งบิลกลับเมื่อ Host กลับมา; ตรวจเลขซ้ำ/ลำดับตอน sync
- จอ KDS / CFD เป็น window แยกที่รับ event เรียลไทม์จาก Host
- การพิมพ์: ใบเสร็จความร้อน (ESC/POS), ฉลากแก้วบนกระดาษ A4 (QR code), ใบกำกับภาษี (PDF)

## 3. โครงโฟลเดอร์

```
.
├─ CLAUDE.md
├─ package.json
├─ electron.vite.config.ts / vite config
├─ migrations/                 0001_init.sql, 0002_...sql
├─ docs/
│  ├─ Implement.md
│  ├─ POS Management System.docx
│  └─ design/                  *.dc.html + canvas.json
├─ src/
│  ├─ shared/
│  │  ├─ money.ts              satang utils, VAT calc
│  │  ├─ permissions.ts        รายการ resource:action (ดู §7)
│  │  ├─ schemas/              zod
│  │  └─ types.ts
│  ├─ main/
│  │  ├─ index.ts              สร้าง window, โหมด Standalone/Host/Client
│  │  ├─ db/
│  │  │  ├─ connection.ts      เปิด DB + PRAGMA
│  │  │  ├─ migrate.ts         รัน migrations + backup ก่อนรัน
│  │  │  └─ repos/             bills.repo.ts, stock.repo.ts, shifts.repo.ts, audit.repo.ts ...
│  │  ├─ services/             bill, stock(BOM/FEFO), shift, expense, receiving, waste, promo, report, tax
│  │  ├─ auth/                 BetterAuth, PIN login, RBAC guard
│  │  ├─ license/              ตรวจ .LIC (Ed25519 + hardware id)
│  │  ├─ sync/                 LAN API, queue ของ Client, บล็อกเลขบิล
│  │  ├─ print/                receipt, label A4, tax invoice
│  │  ├─ backup/               snapshot, restore, PITR
│  │  └─ ipc/                  ลงทะเบียน channel + ตรวจสิทธิ์
│  └─ renderer/
│     ├─ app.tsx, router
│     ├─ pages/                dashboard, pos, shift, kds, cfd, label, users, roles, products, inventory,
│     │                        receiving, waste, expenses, orders, reports, promo, settings, backup, audit
│     ├─ components/           Sidebar, Header, Card, Toggle, Pagination, DataTable ฯลฯ
│     ├─ hooks/, i18n/th.ts
└─ tests/                      unit + integration (vitest)
```

## 4. เริ่มโปรเจกต์ (ลำดับคำสั่ง)

```bash
mkdir kposs && cd kposs && git init
# copy ไฟล์ตาม §0 ก่อน
pnpm init
pnpm add better-sqlite3 zod better-auth react react-dom react-router-dom
pnpm add -D typescript electron electron-vite electron-builder vite tailwindcss vitest @types/better-sqlite3 eslint
pnpm dlx shadcn@latest init
```
- better-sqlite3 เป็น native module: ใช้ prebuilt ที่มากับแพ็กเกจ (ไม่ต้องคอมไพล์; อย่าอนุมัติ build script ของ better-sqlite3 ใน pnpm) และตั้งให้ unpack จาก asar
- เปิด TypeScript `strict`, ตั้ง path alias `@shared`, `@main`, `@renderer`

---

## 5. ฐานข้อมูล (SQLite / better-sqlite3)

### 5.1 หลักการ
- PRAGMA ตาม CLAUDE.md ทุกการเชื่อมต่อ
- เงินทุกคอลัมน์เป็น `INTEGER` สตางค์ (ชื่อลงท้าย `_satang`)
- เวลาเก็บเป็น ISO-8601 UTC (`TEXT`) หรือ epoch ms (`INTEGER`) เลือกอย่างเดียวทั้งระบบ (แนะนำ epoch ms)
- primary key: `INTEGER PRIMARY KEY` สำหรับตารางภายใน; เอกสารที่ sync ข้ามเครื่อง (bills) เพิ่ม `uuid TEXT UNIQUE`
- Soft delete ด้วย `deleted_at` สำหรับ master data (สินค้า, วัตถุดิบ, ผู้ใช้); ledger ห้ามลบ

### 5.2 ตารางหลัก (ร่าง — ปรับรายละเอียดตอนเขียน migration)

**ระบบ/ผู้ใช้**
- `branches`, `devices(id, name, role[host|client], hardware_id, last_seen)`
- `users(id, username, display_name, pin_hash, role_id, active, created_at)`
- `roles(id, name, is_system)`, `role_permissions(role_id, permission)` — permission เป็น `resource:action`
- `settings(key, value_json)` (VAT, ร้าน, รูปแบบเลขบิล, เครื่องพิมพ์ ฯลฯ)
- `license(id, raw, hardware_id, expires_at, features_json)`

**สินค้า/สูตร**
- `categories`, `products(id, sku, name, category_id, active)`
- `product_sizes(id, product_id, label, price_satang, size_multiplier)`
- `modifiers`, `modifier_options(id, group, name, price_satang, bom_json)` (Topping/ตัวเลือก)
- `recipes(id, product_id)`, `recipe_items(recipe_id, ingredient_id, qty, unit, size_mode[scale|fixed|custom], custom_json)`

**สต็อก**
- `ingredients(id, name, unit, min_qty, has_expiry, cost_method[fefo|fifo])`
- `stock_lots(id, ingredient_id, lot_no, qty_remaining, unit_cost_satang, received_at, expires_at, po_id)`
- `stock_ledger(id, ts, ingredient_id, lot_id, delta_qty, reason[sale|receive|waste|count_adjust|void_reversal|...], ref_type, ref_id, user_id)` **append-only**
- `purchase_orders(id, supplier, status, ...)`, `purchase_order_lines(...)`
- `stock_counts(id, status[draft|pending|approved|rejected], created_by, approved_by, ...)`, `stock_count_lines(count_id, ingredient_id, counted_qty, system_qty, reason)`
- `waste_records(id, kind[ingredient|drink], ref_id, qty, reason, value_satang, ...)`

**ขาย**
- `bills(id, uuid, bill_no, device_id, shift_id, channel[dine_in|takeaway|grab|lineman|shopeefood|foodpanda], status[open|paid|void|refund], subtotal_satang, discount_satang, vat_satang, total_satang, delivery_order_id, commission_pct, member_id, created_at)`
- `bill_items(bill_id, product_id, size_id, qty, unit_price_satang, modifiers_json, bom_snapshot_json)`
- `payments(bill_id, method[cash|promptpay|card|...], amount_satang, confirmed_by)`
- `bill_events` **append-only** (create/paid/void/refund/reprint)
- `bill_number_blocks(device_id, from_no, to_no, used_to)`
- `tax_invoices(id, bill_id, type[full|abbreviated], customer_json, invoice_no, ...)`

**กะ/เงินสด/ค่าใช้จ่าย**
- `shifts(id, opened_by, opened_at, opening_float_satang, closed_at, counted_satang, expected_satang, over_short_satang)`
- `cash_ledger` **append-only** (เงินเข้า/ออกลิ้นชัก, จ่ายค่าใช้จ่ายจากลิ้นชัก)
- `expenses(id, category, amount_satang, source[drawer|petty_cash|bank], vat_invoice, receipt_path, shift_id, ...)`

**โปรโมชัน/สมาชิก**
- `promotions(id, type, value, rules_json, active, starts_at, ends_at)`, `coupons`, `members(id, phone, points, ...)`

**ระบบ**
- `audit_log(id, ts, user_id, device_id, permission, action, entity, entity_id, before_json, after_json, risk, prev_hash, hash)` **append-only + hash chain**
- `backup_runs(id, ts, kind, path, size, ok)`

### 5.3 Trigger ที่ต้องมี
- `BEFORE UPDATE/DELETE` บน `stock_ledger`, `cash_ledger`, `bill_events`, `audit_log` → `RAISE(ABORT, 'append-only')`
- Hash chain ของ `audit_log`: `hash = SHA256(prev_hash || canonical_json(row))` คำนวณใน service (ไม่ใช่ trigger) และมีฟังก์ชัน `verifyAuditChain()` ตรงกับปุ่ม "ตรวจสอบความสมบูรณ์" ในหน้า Audit
- กัน `stock_lots.qty_remaining < 0`

### 5.4 Migration
- `migrations/NNNN_name.sql`, `migrate.ts` อ่านตามลำดับ เปรียบเทียบกับ `PRAGMA user_version`
- ก่อนรัน: สำรองไฟล์ DB เป็น `backup/pre-migrate-<version>.sqlite`
- รันทั้งชุดใน transaction; ล้มเหลว → rollback และไม่เปิดแอปต่อ แสดงข้อความภาษาไทยพร้อมที่เก็บ backup

---

## 6. กฎธุรกิจที่ต้อง implement

### 6.1 ตัดสต็อกตาม BOM
- ตอนจ่ายเงินสำเร็จ → สร้างรายการ `stock_ledger` ต่อวัตถุดิบต่อล็อตในธุรกรรมเดียวกับการปิดบิล
- วัตถุดิบมีวันหมดอายุ → **FEFO** (ล็อตหมดอายุก่อนตัดก่อน); ไม่มีวันหมดอายุ → **FIFO** (รับเข้าก่อนตัดก่อน)
- **Size multiplier:** ทุกวัตถุดิบคูณตามขนาด โดยแต่ละรายการตั้งโหมดได้: `scale` (คูณตามขนาด), `fixed` (คงที่ เช่น ฝา/หลอด), `custom` (กำหนดต่อขนาด)
- เก็บ `bom_snapshot_json` ในแต่ละรายการบิล เพื่อให้ void/refund คืนสต็อกตามสูตร ณ เวลาที่ขาย แม้สูตรเปลี่ยนภายหลัง
- Void/Refund → รายการชดเชยใน ledger (reason `void_reversal`) คืนกลับล็อตเดิม
- ตัวอย่างทดสอบ: ชานมไข่มุก 22oz ตัด นมสด/ไข่มุก/แก้ว/ฝา ตามสูตร, ขนาด 16oz ใช้ multiplier ต่างกัน, ตัดล็อต EXP เก่าก่อน

### 6.2 บิลและเลขที่
- เลขบิลต่อเนื่องไม่ซ้ำ รูปแบบตั้งค่าได้ (เช่น `A-10231`)
- Client ใช้บล็อกที่จองไว้; Host เติมบล็อกใหม่เมื่อเหลือต่ำกว่าเกณฑ์
- การเปลี่ยนสถานะบิลทุกครั้งลง `bill_events`; Void ต้องมีสิทธิ์ `bill:void` + เหตุผล + audit (risk=สูง)

### 6.3 ภาษี/ราคา
- VAT 7% รองรับทั้ง "ราคารวม VAT" และ "ราคาไม่รวม VAT" ตามตั้งค่า
- กำหนดจุดปัดเศษเดียว (แนะนำปัดระดับบิล) เขียนใน `money.ts` + test; **ถามผู้ใช้ก่อนฟิกซ์**
- ใบกำกับภาษีเต็มรูป/อย่างย่อ: ฟิลด์ตามประมวลรัษฎากร ต้องให้นักบัญชีตรวจก่อนใช้จริง

### 6.4 การชำระเงิน
- เงินสด, PromptPay (QR, **พนักงานกดยืนยันเองเฟสแรก**), บัตร/อื่นๆ ตามตั้งค่า
- เดลิเวอรี: กรอก Order ID เอง + % ค่าคอมมิชชัน (คำนวณยอดสุทธิร้านได้รับ)

### 6.5 กะและลิ้นชักเงินสด
- เปิดกะระบุเงินทอนตั้งต้น; ปิดกะนับเงินตามชนิดธนบัตร/เหรียญ
- ยอดคาดการณ์ = float + เงินสดรับ − เงินสดจ่าย(ค่าใช้จ่ายจากลิ้นชัก, คืนเงิน) ; แสดง Over/Short
- ค่าใช้จ่ายที่จ่ายจากลิ้นชักลดยอดคาดการณ์ในหน้าปิดกะ (ตรงกับหน้า Expenses)

### 6.6 ค่าใช้จ่าย
- หมวด, แหล่งเงิน (ลิ้นชัก / เงินสดย่อย / ธนาคาร), สวิตช์ใบกำกับภาษีซื้อ, แนบรูปใบเสร็จ, รายการแบ่งหน้า, สรุปตามหมวด

### 6.7 รับเข้า / ใบสั่งซื้อ / นับสต็อก
- PO: สร้าง → รับเข้า (ระบุจำนวนรับ + วันหมดอายุต่อบรรทัด) → สร้าง `stock_lots` + ledger
- นับสต็อก: ร่าง → รออนุมัติ → อนุมัติ/ปฏิเสธ; ต้องกรอกเหตุผลเมื่อมีส่วนต่าง; ต้องมีสิทธิ์ `inventory:approve_count` จึงอนุมัติได้ (คนนับกับคนอนุมัติควรต่างคนกัน — ตั้งค่าบังคับได้); เมื่ออนุมัติจึงสร้างรายการปรับใน ledger

### 6.8 Waste / ของเสีย
- ประเภท: วัตถุดิบ / เครื่องดื่มที่ทำแล้ว (ตัดตาม BOM); เหตุผล: หมดอายุ, ผลิตผิด, ตกหล่น/เสียหาย, ลูกค้าคืน
- แสดงล็อตที่จะตัด (FEFO/FIFO) และมูลค่า; แผงล็อตใกล้หมดอายุ (≤3 วัน) กดบันทึกเป็นของเสียได้
- ตัวชี้วัด: ของเสียต่อยอดขาย (เป้า ≤ 2%)

### 6.9 โปรโมชัน/สมาชิก/คูปอง
- ประเภทส่วนลด % / บาท / ซื้อ X แถม Y, เงื่อนไขช่วงเวลา/สินค้า, แต้มสมาชิก, คูปอง
- ส่วนลดเกินเพดานต้องขอสิทธิ์ผู้จัดการ (`bill:discount` + ขีดจำกัดต่อบทบาท)

### 6.10 Backup / Restore / PITR
- **Tier A (เปิดใช้เฟสแรก):** snapshot รายวัน (ใช้ `VACUUM INTO` หรือ backup API ของ better-sqlite3) เก็บตามนโยบาย retention
- **Tier B (เฟส 4d, D38):** บันทึกการเปลี่ยนแปลงในแอป (TEMP trigger → `change_journal` → ไฟล์ segment ทุก 10 วินาที ในเครื่อง + นอกเครื่อง) แทน WAL streaming/Litestream — `src/main/backup/journal.ts`
- **Tier C:** snapshot + เล่นการเปลี่ยนแปลงซ้ำถึงเวลาที่เลือก (ทุกตาราง ไม่ใช่แค่ ledger) เก็บย้อนหลัง 14 วัน; timeline ใหม่หลัง restore/migrate
- Restore ต้องมีสิทธิ์สูงสุด, ยืนยัน 2 ขั้น, สำรองสถานะปัจจุบันก่อนเสมอ, ลง audit

### 6.11 License
- ตรวจ `.LIC` (Ed25519 public key ฝังในแอป) + hardware id; ใกล้หมดอายุแจ้งบน Dashboard; หมดอายุ → โหมดอ่านอย่างเดียว (ไม่ให้ขายใหม่) ตามนโยบายที่ผู้ใช้กำหนด

---

## 7. สิทธิ์ (RBAC) — `resource:action`

ตัวอย่างชุดเริ่มต้น (หน้า "จัดการสิทธิ์" ในต้นแบบเป็นตัวอ้างอิงเมทริกซ์เต็ม)
```
pos:sell  bill:void  bill:refund  bill:discount  bill:reprint  bill:view
shift:open  shift:close  shift:view_all
product:view  product:create  product:update  product:delete  recipe:update
inventory:view  inventory:receive  inventory:waste  inventory:count  inventory:approve_count
expense:create  expense:view
promo:manage  member:manage
report:view  report:export  tax:issue
user:create  user:update  user:disable  role:update
settings:update  backup:run  backup:restore
audit:view  license:manage
```
- บทบาทเริ่มต้น: Owner, Branch Manager, Cashier, Barista (ปรับได้; Owner ลบไม่ได้)
- เมนู/ปุ่มที่ไม่มีสิทธิ์ซ่อนใน UI **และ** ถูกปฏิเสธใน IPC handler
- การเปลี่ยนสิทธิ์ทุกครั้งลง audit (risk=สูง)

---

## 8. แผนที่หน้าจอ → Route → ต้นแบบ

| Route | หน้า | ต้นแบบ | สิทธิ์ขั้นต่ำ |
|---|---|---|---|
| `/login` | Login | Main.dc.html | – |
| `/` | Dashboard | Dashboard.dc.html | report:view |
| `/pos` | หน้าขาย | POS.dc.html | pos:sell |
| `/shift` | ปิดกะ/นับเงิน | Shift.dc.html | shift:close |
| `/kds` | จอบาร์ | KDS.dc.html | pos:sell |
| `/cfd` | จอลูกค้า | CFD.dc.html | – (จอแสดงผล) |
| `/label` | พิมพ์ฉลาก A4 | Label.dc.html | inventory:view |
| `/orders` | บิลและประวัติ | Orders.dc.html | bill:view |
| `/products` | สินค้าและสูตร | Products.dc.html | product:view |
| `/inventory` | วัตถุดิบและสต็อก | Inventory.dc.html | inventory:view |
| `/receiving` | รับเข้า/PO/นับสต็อก | Receiving.dc.html | inventory:receive |
| `/waste` | Waste | Waste.dc.html | inventory:waste |
| `/expenses` | ค่าใช้จ่าย | Expenses.dc.html | expense:view |
| `/reports` | รายงาน/ใบกำกับภาษี | Reports.dc.html | report:view |
| `/promo` | โปรโมชัน/สมาชิก | Promo.dc.html | promo:manage |
| `/users` | ผู้ใช้งานระบบ | Users.dc.html | user:update |
| `/roles` | จัดการสิทธิ์ | Roles.dc.html | role:update |
| `/audit` | Audit Log | Audit.dc.html | audit:view |
| `/backup` | Backup/Restore | Backup.dc.html | backup:run |
| `/settings` | การตั้งค่า | Settings.dc.html | settings:update |

โครง Sidebar (ให้ตรงต้นแบบ): แดชบอร์ด · หน้าขาย POS · บิลและประวัติ · กะและลิ้นชักเงินสด · สินค้าและเมนู▸ · สต็อกและวัตถุดิบ▸ · Waste · โปรโมชันและสมาชิก▸ · ค่าใช้จ่าย · รายงาน▸ · พิมพ์ฉลาก A4 · ระบบความปลอดภัย▸(ผู้ใช้งานระบบ, จัดการสิทธิ์) · Audit Log · Backup/Restore · การตั้งค่า
Dashboard: กลุ่มพับอยู่เป็นค่าเริ่มต้น คลิกหัวกลุ่มเพื่อกาง/พับ; ปุ่มช่วงเวลา (วันนี้/เมื่อวาน/สัปดาห์/เดือน), แท่งกราฟและช่องทางขายคลิกได้, กระดิ่งแจ้งเตือนและเมนูผู้ใช้เป็นการ์ด dropdown

---

## 9. Design tokens (สรุป — ค่าจริงดูใน `docs/design/*.dc.html`)

```
bg #F7F5F2 · text #1F2430 · muted #5C6270 · border #EFEBE6
primary gradient #6A47DB → #9776F6 · lavender #EDE9FB / text #4B2FB8
success #DDF5E8/#11724A · warn #FFF4D6/#7A5200 · danger #FFE3E3/#A6232B
tile gradients: blue #4C8DF6→#2F6FE0 · green #34C98A→#1BA56B · orange #FFA43A→#F7791E
                pink #F05A8E→#E23B76 · teal #2CC4B8→#14A094 · amber #F7C23A→#E5A10C · red #F4616A→#DC3A44
font Noto Sans Thai · card radius 20–22 · input height 44 · toggle 52×32 · pagination 6–7/หน้า
```
เขียนเป็น Tailwind theme (`tailwind.config`) + CSS variables และสร้างคอมโพเนนต์กลาง: `GradientButton`, `IconTile`, `StatCard`(วงกลมมุม), `Toggle`, `Segmented`, `Pagination`, `Chip`, `Toast`, `Dropdown card`

---

## 10. แผนงานเป็นเฟส (ทำตามลำดับ จบเฟสต้องผ่านเกณฑ์)

**เฟส 0 — โครงโปรเจกต์**
- Electron + Vite + React + Tailwind + shadcn, TypeScript strict, ESLint, vitest, i18n ไทย
- เกณฑ์: `pnpm dev` เปิดหน้าต่างว่างได้, `pnpm build` ผ่าน, better-sqlite3 โหลดใน Electron ได้

**เฟส 1 — ฐานข้อมูลและแกนระบบ**
- connection + PRAGMA, migration runner (+backup ก่อนรัน), migration 0001 (ตารางทั้งหมดใน §5.2 + trigger §5.3)
- `money.ts` (+test), repository พื้นฐาน, audit service + hash chain + `verifyAuditChain`
- Auth: ผู้ใช้/PIN, BetterAuth session, RBAC guard ที่ IPC, หน้า Login/Users/Roles
- เกณฑ์: test migration ผ่าน, UPDATE/DELETE ledger ถูก trigger ปฏิเสธ, ตรวจ audit chain ได้, ปฏิเสธ IPC เมื่อไม่มีสิทธิ์

**เฟส 2 — ขายและสต็อกหลัก (Standalone)**
- สินค้า/ขนาด/Topping/สูตร BOM, วัตถุดิบ/ล็อต, หน้า POS, ชำระเงินสด+PromptPay(ยืนยันมือ), ตัด BOM แบบ FEFO/FIFO, void/refund คืนสต็อก, เลขบิล, พิมพ์ใบเสร็จ
- เปิด/ปิดกะ, ลิ้นชักเงินสด, KDS/CFD (window แยก), บิลและประวัติ
- เกณฑ์: test ตัวเลขตัดสต็อกตามขนาด/โหมด multiplier, void คืนสต็อกครบ, ปิดกะ Over/Short ถูกต้อง

**เฟส 3 — สต็อกครบวงจรและการเงิน**
- รับเข้า/PO, นับสต็อก+อนุมัติ, Waste, ค่าใช้จ่าย (เชื่อมยอดคาดการณ์กะ), พิมพ์ฉลาก A4 (QR), แจ้งเตือนใกล้หมด/หมดอายุ
- โปรโมชัน/สมาชิก/คูปอง, เดลิเวอรี (Order ID + คอมมิชชัน)
- รายงาน (ยอดขาย, กำไรตาม BOM, ของเสีย, Z-Report), ใบกำกับภาษีเต็ม/อย่างย่อ (PDF) — **ให้นักบัญชีตรวจ**
- Dashboard ตามต้นแบบ

**เฟส 4 — หลายเครื่อง ความทนทาน และความปลอดภัย**
- โหมด Host/Client ผ่าน LAN, บล็อกเลขบิล, คิวออฟไลน์ + sync, KDS/CFD ข้ามเครื่อง
- Backup/Restore Tier A → B (WAL streaming) → C (PITR), หน้า Backup/Restore
- License `.LIC` (Ed25519 + hardware id), ตั้งค่า, Audit Log หน้าเต็ม
- ติดตั้งตัว build (electron-builder), auto-update (ถ้าต้องการ)
- เกณฑ์: Host ล่ม Client ขายต่อได้และ sync กลับไม่ซ้ำ, restore แล้วข้อมูลตรง, license ปลอม/ผิดเครื่องถูกปฏิเสธ

## 11. กลยุทธ์ทดสอบ
- **Unit:** `money.ts`, การคำนวณ BOM/size multiplier, FEFO/FIFO, ส่วนลด/โปรโมชัน, เลขบิล, over/short
- **Integration (SQLite in-memory/ไฟล์ชั่วคราว):** ปิดบิล→ตัดสต็อกใน transaction เดียว, void คืนสต็อก, trigger append-only, migration ขึ้น/ลง backup, audit chain
- **Sync:** จำลอง Host ล่ม, บล็อกเลขบิลหมด, ส่งบิลซ้ำ (idempotent โดย `uuid`)
- **UI:** smoke test หน้าหลัก + ตรวจ touch target/ภาษาไทยไม่ตกบรรทัดผิดปกติ
- กฎบังคับ: โมดูลที่แตะเงิน/สต็อก/ภาษี ต้องมี test ก่อน merge

## 12. ความปลอดภัย
- PIN เก็บเป็น hash (argon2/scrypt), ล็อกชั่วคราวหลังใส่ผิดหลายครั้ง (ลง audit)
- IPC: validate ด้วย zod, ปิด `nodeIntegration`, เปิด `contextIsolation`, preload เปิดเผย API เท่าที่จำเป็น
- LAN API: TLS ภายในร้าน + โทเคนต่อเครื่อง (ลงทะเบียนอุปกรณ์โดย Owner)
- ไฟล์ backup/รูปใบเสร็จ: เก็บใน userData, ตรวจ path (กัน path traversal)
- ไม่เก็บข้อมูลบัตรเครดิตเต็ม

## 13. ประเด็นเปิด (ต้องถามผู้ใช้ก่อนฟิกซ์)
1. กฎปัดเศษ VAT (ระดับรายการหรือระดับบิล)
2. รูปแบบเลขที่บิลและเลขที่ใบกำกับภาษี
3. ขนาดบล็อกเลขบิลต่อเครื่อง Client
4. นโยบาย retention ของ backup และตำแหน่งสำรองนอกเครื่อง
5. พฤติกรรมเมื่อ License หมดอายุ (อ่านอย่างเดียว/เตือนอย่างเดียว)
6. รุ่นเครื่องพิมพ์ใบเสร็จ/ขนาดกระดาษ
7. ต้องการให้คนนับกับคนอนุมัตินับสต็อกเป็นคนละคนเสมอหรือไม่
8. PromptPay API ตรวจยอดอัตโนมัติ (แผนอนาคต) — ผู้ให้บริการที่จะใช้
9. หน้าที่ยังไม่ออกแบบ: หมวดหมู่สินค้า, ตัวเลือกและ Topping, Z-Report, ค่าคอมมิชชันเดลิเวอรี, คูปอง

---

## 14. คำสั่งแรกที่แนะนำให้พิมพ์ใน Claude Code

> อ่าน CLAUDE.md และ docs/Implement.md แล้วเริ่มเฟส 0: สร้างโครงโปรเจกต์ Electron + Vite + React + Tailwind + shadcn + better-sqlite3 ตาม §3–§4 จากนั้นเสนอแผน migration 0001 ตาม §5 ให้ฉันตรวจก่อนเขียนโค้ดเฟส 1
