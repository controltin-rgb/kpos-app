# CLAUDE.md — KPOSS (Korn POS Management System)

ระบบ POS สำหรับร้านเครื่องดื่ม/คาเฟ่ ติดตั้งเป็นแอป Desktop (Electron) ใช้งานออฟไลน์ได้ รองรับหลายเครื่องในร้านผ่าน LAN
อ่าน `docs/Implement.md` ก่อนเริ่มงานทุกครั้ง (แผนการสร้าง, schema, กฎธุรกิจ, ลำดับงาน) และดูหน้าจอต้นแบบที่ `docs/design/`

## ภาษาและการสื่อสาร
- UI และข้อความที่ผู้ใช้เห็นเป็น **ภาษาไทย** ทั้งหมด (เก็บ string ไว้ในไฟล์ i18n ไม่ฝังในคอมโพเนนต์)
- โค้ด ชื่อตัวแปร ชื่อตาราง คอมเมนต์ เขียนเป็นภาษาอังกฤษ
- ตอบผู้ใช้เป็นภาษาไทย

## Tech stack (ห้ามเปลี่ยนโดยไม่ถามก่อน)
- Electron + Node.js (monolith: main process เป็น backend ในตัว, ไม่แยก server ภายนอก)
- **better-sqlite3** เป็นตัวหลักในการเข้าถึงฐานข้อมูล — **ห้ามใช้ Prisma** (ตัดสินใจแล้ว)
  - อนุญาต Kysely หรือ Drizzle เป็น query builder เสริมได้ภายหลัง ถ้าไม่ซ่อน PRAGMA/transaction
- React 19 + Tailwind + shadcn/ui (renderer)
- BetterAuth สำหรับ session + RBAC แบบ `resource:action`
- License: ไฟล์ `.LIC` ลงลายเซ็น Ed25519 ผูกกับฮาร์ดแวร์
- TypeScript strict ทั้งโปรเจกต์

## กฎที่ห้ามละเมิด
1. **เงินเก็บเป็นจำนวนเต็มหน่วยสตางค์เสมอ** (`INTEGER`) ห้ามใช้ float กับเงิน แปลงเป็นบาทตอนแสดงผลเท่านั้น VAT 7% ปัดตามกฎเดียวทั้งระบบ (ดู Implement.md §6.3)
2. **งานเขียนฐานข้อมูลที่เกี่ยวกับเงิน/สต็อกทำใน transaction เดียว** แบบ synchronous (`BEGIN IMMEDIATE`) ไม่มีการ await กลาง transaction
3. **ตาราง append-only** (`stock_ledger`, `audit_log`, `cash_ledger`, `bill_events`): มี trigger กัน UPDATE/DELETE ห้ามเขียน code ที่แก้หรือลบแถวเหล่านี้ การแก้ไขทำด้วยแถวใหม่ที่ชดเชย (reversal)
4. **ทุกการกระทำสำคัญต้องลง `audit_log`** (void, refund, ส่วนลด, แก้สิทธิ์, ตัดของเสีย, ปรับสต็อก, เปลี่ยนตั้งค่า, ปิดกะ, restore) พร้อมค่า before/after
5. **ทุก action ผ่านการตรวจสิทธิ์ `resource:action` ฝั่ง main process** ห้ามเชื่อการซ่อนปุ่มฝั่ง UI อย่างเดียว
6. **UI ไม่เรียก DB ตรง** ต้องผ่าน IPC → service → repository เท่านั้น
7. **Migration เป็นไฟล์ `.sql` เรียงเลข** (`migrations/0001_init.sql` …) ห้ามแก้ไฟล์ migration ที่ปล่อยแล้ว ให้เพิ่มไฟล์ใหม่ ก่อนรัน migration ต้อง backup อัตโนมัติ เก็บเวอร์ชันใน `PRAGMA user_version`
8. ห้ามฝังความลับ/คีย์ private ของ License ในรีโป (เก็บเฉพาะ public key)
9. ห้ามแก้หน้าจอต้นแบบที่ผู้ใช้ยืนยันแล้ว (Login, Dashboard, POS, ปิดกะ, KDS, CFD, พิมพ์ฉลาก A4) ให้ตรงกับ `docs/design/` โดยไม่ถาม

## การตั้งค่า SQLite ที่ต้องมีทุกการเชื่อมต่อ
```
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```
เปิดฐานข้อมูลเพียงที่เดียวใน main process (Host) โหมด Client คุยผ่าน LAN API กับ Host ไม่เปิดไฟล์ DB ข้ามเครื่อง

## โครงโฟลเดอร์ (ย่อ — รายละเอียดใน Implement.md §3)
```
src/main/        backend: db/, services/, ipc/, auth/, license/, sync/, print/, backup/
src/renderer/    React UI: pages/, components/, hooks/, i18n/
src/shared/      types, zod schemas, permission keys, money utils
migrations/      *.sql
docs/            Implement.md, design/ (ต้นแบบหน้าจอ), POS Management System.docx
```

## Design system (ต้องตรงกับหัวข้อ 5 ใน docx)
- พื้นหลัง `#F7F5F2`, ตัวอักษร `#1F2430`, muted `#5C6270`, เส้นขอบ `#EFEBE6`
- ฟอนต์ Noto Sans Thai
- ปุ่มหลักไล่สี `#6A47DB → #9776F6` (มุมมนเต็ม), chip/active ม่วงอ่อน `#EDE9FB` ตัวอักษร `#4B2FB8`
- การ์ดขอบมน 20–22px พร้อมวงกลมสีพาสเทลที่มุม, ไอคอนอยู่ในกรอบสี่เหลี่ยมมนไล่สี
- Touch target ≥ 44px, toggle switch 52×32 (ห้ามใช้ checkbox ธรรมดา), pagination 6–7 รายการ/หน้า
- สถานะสี: สำเร็จ `#DDF5E8/#11724A`, เตือน `#FFF4D6/#7A5200`, อันตราย `#FFE3E3/#A6232B`
- ใช้ค่าจากไฟล์ต้นแบบใน `docs/design/*.dc.html` เป็นอ้างอิงตรงของสไตล์ ระยะ และข้อความ

## คำสั่งที่ใช้บ่อย (ปรับให้ตรงเมื่อสร้างโปรเจกต์แล้ว)
```
npm run dev          # รันแอปโหมดพัฒนา (electron-vite dev)
npm run build        # typecheck + electron-vite build + electron-builder --dir → release/
npm run build:dist   # เหมือน build แต่สร้างตัวติดตั้ง (dmg/nsis/AppImage)
npm run test         # vitest — รันภายใต้ Node ของ Electron (ELECTRON_RUN_AS_NODE=1) ให้ native module ตรงกับตอนใช้งานจริง
npm run migrate      # รัน migration กับ DB ตัวอย่าง .data/dev.sqlite (แอปรันเองอัตโนมัติตอนเปิด)
npm run lint && npm run typecheck   # typecheck ตรวจ tsconfig.node.json และ tsconfig.web.json แยกกัน
KPOSS_USER_DATA=/tmp/x npm run dev  # (dev เท่านั้น) ใช้โฟลเดอร์ข้อมูลแยก เช่น ทดสอบหน้าตั้งค่าครั้งแรก
```
- การตัดสินใจอยู่ใน `docs/decisions.md` (D1–D10, D14–D17 ผู้ใช้ยืนยันแล้ว; D11–D13, D18 รอตรวจ) อ่านก่อนเริ่มงาน
- IPC: ทุก endpoint ประกาศใน `src/shared/api.ts` (access + zod input) → handler ใน `src/main/app-context.ts` → service → repo; ทดสอบผ่าน `createTestApp()` ใน `tests/helpers/app.ts`
- TypeScript ปักไว้ที่ 6.0.x เพราะ typescript-eslint ยังไม่รองรับ TS 7
- ถ้า `npm run dev` ขึ้น error `does not provide an export named 'BrowserWindow'` แปลว่า shell มี `ELECTRON_RUN_AS_NODE=1` ค้างอยู่ ให้ `unset ELECTRON_RUN_AS_NODE`
- renderer อยู่ที่ `src/renderer/` (มี `index.html`, `main.tsx`, `app.tsx`), preload อยู่ที่ `src/preload/` (build เป็น CJS เพราะเปิด sandbox)
- ESLint บล็อกไม่ให้ renderer import `@main/*`, `better-sqlite3`, `electron`, `node:*` (บังคับกฎข้อ 6)

## วิธีทำงาน
- ทำทีละเฟสตาม `docs/Implement.md` §10 จบเฟสต้องผ่านเกณฑ์ที่เขียนไว้และมี test ของกฎธุรกิจนั้น
- ก่อนเขียนโมดูลที่แตะสต็อก/เงิน/ภาษี ให้เขียน test ก่อน (ตัวอย่างตัวเลขใน Implement.md §6)
- ก่อนตัดสินใจเรื่องที่ไม่ชัด (เช่น ปัดเศษ VAT, รูปแบบเลขที่บิล) ให้ถามผู้ใช้ อย่าเดา
- ใบกำกับภาษีเต็มรูป/อย่างย่อ ต้องให้นักบัญชีตรวจก่อนใช้จริง ใส่ข้อความเตือนนี้ในเอกสารที่ออกให้ทีมงานเสมอ
- PromptPay: เฟสแรกพนักงานกดยืนยันรับเงินเอง (API ตรวจยอดอัตโนมัติเป็นแผนอนาคต)
