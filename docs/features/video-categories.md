# Feature: จัดหมวดหมู่วิดีโอตั้งแต่ตอนอัปโหลด และส่งออกข้อมูลหมวดหมู่ได้

สถานะ: in-progress

## Outcome

ผู้ใช้เลือกหมวดหมู่ได้ตั้งแต่หน้าจอ New video ก่อนเริ่มอัปโหลด (ทั้ง batch) วิดีโอทุกไฟล์ในรอบนั้นถูกบันทึกพร้อมหมวดหมู่ทันที ไม่ต้องกลับมาไล่แก้ทีละร้อยรายการ, กรองรายการวิดีโอตามหมวดหมู่ได้, และส่งออกรายการวิดีโอพร้อมหมวดหมู่เป็น CSV ได้

## In scope

- ตาราง `categories` ระดับ organization + คอลัมน์ `assets.category_id` (หนึ่งวิดีโอ = หนึ่งหมวดหมู่ หรือไม่มีเลย)
- CRUD หมวดหมู่เป็น section หนึ่งใน `SettingsPage.tsx` (ไม่สร้างหน้าใหม่/เมนู sidebar ใหม่)
- ตัวเลือกหมวดหมู่ระดับ batch ในหน้า New video ทั้งโหมด `Upload files` และ `Import URL` (เลือกก่อนกด Start processing)
- แก้หมวดหมู่ภายหลังผ่าน `PATCH /v1/assets/:id` ที่มีอยู่ และช่องเลือกใน `VideoDetailPage`
- ตัวกรองหมวดหมู่ใน `VideosPage` (ใช้ร่วมกับช่องค้นหาเดิม)
- ส่งออก CSV ของ assets พร้อมชื่อหมวดหมู่ กรองตามหมวดหมู่ได้
- แปลข้อความใหม่ครบทั้ง 4 ภาษา (`lib/i18n/{en,de,es,fr}.ts` + `types.ts`)
- E2E happy path หนึ่งชุด (Playwright)

## Out of scope

- หลายหมวดหมู่ต่อวิดีโอ / tags / หมวดหมู่ซ้อนชั้น (nested)
- เลือกหมวดหมู่แยกรายไฟล์ในหนึ่ง batch
- Bulk re-categorize ของ asset ที่มีอยู่แล้ว, การ import หมวดหมู่จาก CSV
- หมวดหมู่ที่ผู้ชมเห็นบนหน้า watch/embed หรือใช้จัดกลุ่ม playlist
- pagination ของ `GET /v1/assets` และ streaming export (ดู known debt)

## User flow

1. ผู้ใช้สร้างหมวดหมู่ใน Settings → Categories (ชื่อ + สี) หรือข้ามไปก็ได้
2. เข้า New video, เลือกไฟล์หลายไฟล์เหมือนเดิม
3. เลือกหมวดหมู่หนึ่งค่าจาก dropdown ที่อยู่แถวเดียวกับ AI options (ค่าเริ่มต้น = ไม่ระบุ) และสร้างหมวดหมู่ใหม่ inline ได้จาก dropdown เดียวกัน
4. กด Start processing → ทุก asset ที่สร้างในรอบนั้นถูก `POST /v1/assets` พร้อม `categoryId`
5. ที่ `VideosPage` ผู้ใช้กรองตามหมวดหมู่ และกด Export CSV เพื่อดาวน์โหลดรายการตามตัวกรองที่เลือกอยู่
6. ต้องการแก้ของเดิม → เปิด `VideoDetailPage` เปลี่ยนหมวดหมู่ผ่าน dropdown (บันทึกทันทีแบบเดียวกับ title/description)

## UI states

- loading: dropdown แสดง skeleton ระหว่างโหลด `GET /v1/categories`; ปุ่ม Export disabled ระหว่างสร้างไฟล์
- empty: ยังไม่มีหมวดหมู่ → dropdown แสดง "ยังไม่มีหมวดหมู่ — สร้างใหม่" และยัง upload ต่อได้โดยไม่เลือก
- success: หมวดหมู่ที่เลือกแสดงเป็น chip บน AssetCard และในหน้ารายละเอียด; export ดาวน์โหลดไฟล์ทันที
- error/retry: โหลดหมวดหมู่ไม่สำเร็จ → dropdown เป็น optional + ปุ่ม Retry, ไม่บล็อกการอัปโหลด; ชื่อซ้ำแสดง error ใต้ input โดยไม่ล้างค่าที่พิมพ์
- stale/conflict: หมวดหมู่ถูกลบจากอีก session ระหว่างอัปโหลด → `POST /v1/assets` คืน `CATEGORY_NOT_FOUND`, UI รีเฟรชรายการหมวดหมู่และให้เลือกใหม่ (asset ยังไม่ถูกสร้าง)

## Contracts

- command/query:
  - `GET /v1/categories` → รายการหมวดหมู่ของ org พร้อม `assetCount`
  - `POST /v1/categories` `{ name, color? }`
  - `PATCH /v1/categories/:id` `{ name?, color? }`
  - `DELETE /v1/categories/:id`
  - `POST /v1/assets` เพิ่ม field `categoryId?` (ครอบคลุมทั้ง upload และ import เพราะ import สร้าง asset ผ่าน endpoint นี้ก่อนเสมอ)
  - `PATCH /v1/assets/:id` เพิ่ม field `categoryId?` (ส่ง `null` = เอาออกจากหมวดหมู่)
  - `GET /v1/assets?categoryId=` และ `GET /v1/assets/export.csv?categoryId=`
- input: `name` 1–100 ตัวอักษร trim แล้ว, `color` เป็น hex 7 ตัว (`#rrggbb`) เหมือน `settings.primaryColor`, `categoryId` เป็น varchar(36) ที่ต้องอยู่ใน org เดียวกัน
- output: `{ data: {...} }` ตาม convention เดิม; asset response เพิ่ม `categoryId` และ `category: { id, name, color } | null`; export คืน `text/csv` พร้อม `Content-Disposition: attachment`
- stable error codes: `CATEGORY_NOT_FOUND`, `CATEGORY_NAME_TAKEN`, `CATEGORY_IN_USE`
- auth/precondition: ทุก endpoint ใช้ org auth เดิม (`request.orgId`); การอ้าง `categoryId` ข้าม org ต้องได้ `CATEGORY_NOT_FOUND` ไม่ใช่ 403 (ไม่รั่ว existence)

## State and data

- source of truth: `categories` เป็นทะเบียนหมวดหมู่, `assets.category_id` เป็นความจริงของการจัดหมวดหมู่ต่อวิดีโอ
- records changed:
  - ตารางใหม่ `categories` (`id` varchar(36) PK, `org_id` FK → `organizations.id` ON DELETE CASCADE, `name` varchar(100), `color` varchar(7) NULL, timestamps, UNIQUE `(org_id, name)`, index บน `org_id`)
  - `assets` เพิ่ม `category_id` varchar(36) NULL + index
  - `ID_LENGTH.CATEGORY = 12` ใน `packages/db/src/constants.ts`
- **FK on-delete ของ `assets.category_id` = `SET NULL` ไม่ใช่ `CASCADE`** — FK ทุกตัวที่มีอยู่ใน `schema.ts` เป็น CASCADE, ถ้าลอกมาตรงนี้ "ลบหมวดหมู่" จะกลายเป็น "ลบวิดีโอทั้งหมวด" ตัดสินใจให้ลบหมวดหมู่แล้ววิดีโอกลับไปเป็น uncategorized และ UI ต้องเตือนจำนวนวิดีโอที่กระทบก่อนลบ
- transaction boundary: การสร้าง asset ยังเป็น insert เดียวเหมือนเดิม; validate `categoryId` (SELECT ตาม `id` + `org_id`) ก่อน insert ไม่ต้องมี transaction เพราะ FK เป็นด่านสุดท้ายอยู่แล้ว
- migration/backfill: additive ล้วน ไม่มี backfill — asset เดิมทั้งหมด `category_id = NULL`. เขียนใน `apps/api/src/db.ts` ตาม pattern เดิม: `CREATE TABLE IF NOT EXISTS categories`, ส่วน `ALTER TABLE assets ADD COLUMN category_id ...` ห่อด้วย `.catch(() => {})` แบบเดียวกับ `custom_metadata` (db.ts:41) เพราะ MySQL 8.4 ไม่มี `ADD COLUMN IF NOT EXISTS`

## Async and failure behavior

- queue job identity: ไม่มี job ใหม่ — หมวดหมู่ไม่แตะ transcode pipeline เลย
- idempotency: `PATCH` เป็น idempotent อยู่แล้ว; ตั้งค่าหมวดหมู่ซ้ำค่าเดิมไม่มีผลข้างเคียง
- retryable errors: network error ตอนโหลด/สร้างหมวดหมู่ retry ได้จาก UI; `CATEGORY_NAME_TAKEN` เป็น terminal ให้ผู้ใช้แก้ชื่อ
- terminal failure: ถ้า `POST /v1/assets` ล้มเหลวเพราะ `CATEGORY_NOT_FOUND` แถวนั้นเข้าสถานะ `error` + retry ได้ตาม flow เดิมของ bulk upload — ต้องไม่มี asset ค้างแบบไม่มีไฟล์
- recovery: หมวดหมู่ของ batch เก็บใน `activeCategoryRef` คู่กับ `activeAiOptionsRef` เดิม; asset ที่สร้างแล้วมีหมวดหมู่ติดใน DB แล้ว refresh ไม่ทำให้หาย

## External integrations

- port: ไม่มี integration ใหม่ — ใช้ MySQL ผ่าน Drizzle อย่างเดียว
- real adapter: `db` เดิมใน `apps/api/src/db.ts`
- fake/fixture: seed หมวดหมู่ 2–3 ค่าใน e2e setup ผ่าน API
- timeout/rate limit: export ใช้ query เดียวกับ list (ไม่มี pagination) — จำกัดที่ 10,000 แถวแล้วคืน `X-Truncated: true` header

## Acceptance tests

- [ ] happy path: สร้างหมวดหมู่ → อัปโหลด 5 ไฟล์พร้อมหมวดหมู่นั้น → asset ทั้ง 5 มี `categoryId` ตรงกัน → กรองแล้วเห็นครบ → export CSV ได้ 5 แถว
- [ ] invalid input: ชื่อว่าง/ยาวเกิน/สีผิดรูปแบบถูกปฏิเสธ; ชื่อซ้ำใน org เดียวกันได้ `CATEGORY_NAME_TAKEN`; ชื่อซ้ำข้าม org สร้างได้
- [ ] auth failure: อ่าน/แก้/ลบหมวดหมู่ของอีก org ไม่ได้; ส่ง `categoryId` ของ org อื่นตอนสร้าง asset ได้ `CATEGORY_NOT_FOUND`
- [ ] duplicate/stale command: `PATCH` หมวดหมู่ซ้ำค่าเดิมไม่เปลี่ยนผลลัพธ์; ลบหมวดหมู่ระหว่าง batch แล้วแถวที่เหลือ error แบบ retryable ไม่ใช่ crash
- [ ] provider/worker failure: ไม่เกี่ยว — pipeline ไม่ถูกแตะ แต่ต้องยืนยันว่า asset ที่ `ready` ยังคง `categoryId` ไว้หลัง worker เขียนผลกลับ
- [ ] refresh/resume: refresh ระหว่าง batch แล้ว asset ที่สร้างไปแล้วยังมีหมวดหมู่ติดอยู่
- [ ] ลบหมวดหมู่ที่มีวิดีโออยู่ → วิดีโอไม่ถูกลบ กลายเป็น uncategorized (กันการลอก CASCADE มาผิด)

## E2E

Playwright เป็น dependency ใหม่ตัวเดียวของฟีเจอร์นี้ (repo ยังไม่มี test framework) — spec เดียว, happy path เดียว:

```
e2e/categories.spec.ts
  precondition: docker compose up -d (API + MySQL + Redis + S3) + login
  1. Settings → สร้างหมวดหมู่ "Training"
  2. New video → เลือก 2 ไฟล์ fixture + เลือก "Training" → Start processing
  3. Videos → กรอง "Training" → เห็น 2 รายการ
  4. Export CSV → ไฟล์มี 2 แถว และคอลัมน์ category = Training
```

ใช้ fixture วิดีโอสั้น (~2 วินาที) เพื่อให้ transcode จบเร็ว; assert ที่ `queued` ก็พอสำหรับ step 2 ไม่ต้องรอ `ready`

## Decisions and known debt

- สิ่งที่ตัดสินแล้ว: หนึ่งวิดีโอต่อหนึ่งหมวดหมู่ (ไม่ใช่ M2M) เพราะ `customMetadata` รองรับ label แบบอิสระอยู่แล้ว; หมวดหมู่ระดับ batch ตาม precedent ของ AI options ใน `bulk-video-upload.md`; หมวดหมู่เป็นตารางไม่ใช่ varchar อิสระ เพราะ picker ที่ควบคุมค่าได้คือเหตุผลทั้งหมดของฟีเจอร์นี้ (กันสะกดเพี้ยนตั้งแต่ต้นทาง); `SET NULL` แทน `CASCADE`; CRUD อยู่ใน Settings ไม่ใช่หน้าใหม่
- สิ่งที่จงใจเลื่อนไป: หลายหมวดหมู่ต่อวิดีโอ, หมวดหมู่ซ้อนชั้น, เลือกรายไฟล์, bulk re-categorize, หมวดหมู่ฝั่งผู้ชม
- known debt: Export ใช้ตัวกรองหมวดหมู่อย่างเดียว ไม่รวมช่องค้นหา (ค้นหายังเป็น client-side) — ปุ่มมี tooltip บอกไว้; `GET /v1/assets` ตอนนี้ถูกจำกัดที่ 10,000 แถวเงียบ ๆ (เดิมไม่จำกัด) และมีเฉพาะ CSV ที่ส่ง `X-Truncated`; `apiDownload` อ่าน `Content-Disposition` ข้าม origin ไม่ได้ถ้า CORS ไม่ได้ expose header นั้น จึง fallback เป็นชื่อ `videos.csv`; `GET /v1/assets` ยังไม่มี pagination (`db.select()` ทั้ง org) — export สืบทอดเพดานนี้ไปด้วย จึงตัดที่ 10,000 แถว ถ้า org ไหนเกินค่อยทำ pagination + streaming CSV แยกเป็นอีกฟีเจอร์ ไม่แก้ในนี้
