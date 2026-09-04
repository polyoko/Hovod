# Feature: ลบวิดีโอหลายรายการจากหน้า Videos ได้อย่างปลอดภัย

สถานะ: done

## Outcome

ผู้ใช้เลือกวิดีโอได้สูงสุด 100 รายการจากหน้า Videos และสั่งลบถาวรในครั้งเดียวได้ โดยวิดีโอที่รับคำสั่งแล้วหายจากรายการทันที ส่วนไฟล์ต้นฉบับ, HLS, thumbnail และข้อมูลที่สัมพันธ์กันถูกลบเบื้องหลังแบบ retry ได้ โดยไม่ปล่อยให้การลบชนกับ transcode ที่กำลังทำงาน

## In scope

- เพิ่มโหมด `Select` บนหน้า Videos; checkbox บน card, `Select all visible`, จำนวนที่เลือก, `Cancel` และ `Delete N videos`
- คง selection ข้าม search/category filter ได้ แต่เลือกได้ไม่เกิน 100 รายการ; ไม่มี "select all results" ที่ข้าม pagination/filter
- modal ยืนยันระบุจำนวนและผลกระทบ (ไฟล์ต้นฉบับ, stream, thumbnail และข้อมูลวิดีโอถูกลบถาวร); เมื่อเกิน 10 รายการ ต้องพิมพ์ `DELETE` ก่อนกดยืนยัน
- รับคำสั่งเป็น bulk command เดียว, mark asset เป็น `deleted` แบบ atomic, ซ่อนจาก list/playback และทำ S3/DB cleanup ผ่าน worker
- ปรับ single delete ให้ใช้กฎสถานะเดียวกัน และแสดงเหตุผลเมื่อยังลบไม่ได้

## Out of scope

- undo, recycle bin, retention policy, delete-by-query หรือการเลือกเกิน 100 รายการ
- ยกเลิก FFmpeg/BullMQ job ที่กำลังรัน หรือการลบ asset สถานะ `queued`/`processing`
- หน้าประวัติการลบและปุ่ม retry สำหรับผู้ใช้; งาน cleanup ที่ล้มเหลวให้ระบบ retry/reconcile เอง

## User flow

1. ผู้ใช้กด `Select`; card เปลี่ยนเป็น selectable และไม่เปิด detail เมื่อกดบน card/checkbox
2. ผู้ใช้เลือกทีละรายการหรือ `Select all visible` (ถ้าเกิน 100 ให้บอกให้กรองรายการก่อน); card ที่ `queued` หรือ `processing` มี checkbox disabled พร้อมเหตุผล
3. แถบ action แสดง `N selected`, `Cancel` และปุ่มแดง `Delete N videos`; ปุ่มลบ disabled เมื่อ N = 0
4. modal ยืนยันแสดงตัวอย่างชื่อไม่เกิน 3 รายการ, จำนวนที่เหลือ, ผลว่าเป็น permanent delete และสำหรับมากกว่า 10 รายการให้พิมพ์ `DELETE`
5. เมื่อยืนยัน UI ปิด modal, ปิด action ซ้ำ, เอารายการที่ accepted ออกจาก grid และแจ้ง `Deletion scheduled for N videos`;
6. หากบาง ID เปลี่ยนสถานะ/หายไปก่อน commit ให้คงเฉพาะรายการนั้นไว้เลือกต่อ พร้อมข้อความและปุ่ม `Refresh`; ไม่ถือว่า batch ทั้งหมดสำเร็จ

## UI states

- loading: หน้าแรกแสดง skeleton cards; ระหว่างส่งคำสั่ง disable modal/action bar และรักษา selection
- empty: ไม่มีวิดีโอแสดง CTA `New video`; search/filter ที่ไม่พบผลแสดง `No matching videos` และ `Clear filters`
- success: card ที่ accepted หายทันที, selection เหลือเฉพาะ rejected IDs และ live region แจ้งจำนวนที่ตั้งคิวลบแล้ว
- error/retry: คำสั่งทั้งก้อนล้มเหลวให้ปิดสถานะ loading แต่คง selection/modal และแสดง error พร้อม `Try again`; partial failure แสดงชื่อ/จำนวนที่ไม่รับคำสั่ง
- stale/conflict: `queued`/`processing`, asset ที่ถูกลบแล้ว หรือ ID ต่าง organization ไม่ถูก mark; refresh list ก่อน retry

## Contracts

- command/query: เพิ่ม `POST /v1/assets/bulk-delete`; คง `DELETE /v1/assets/:id` แต่ให้เรียก use case เดียวกัน
- input: `{ assetIds: string[1..100], idempotencyKey: string }`; dedupe IDs ก่อน validate
- output: `{ data: { acceptedIds: string[], rejected: [{ id, code }], deletionTaskIds: string[], queuedForReconciliation: boolean } }`; duplicate `idempotencyKey` คืนผลเดิม
- stable error codes: `BULK_DELETE_LIMIT_EXCEEDED`, `ASSET_DELETE_IN_PROGRESS`, `ASSET_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, `DELETION_CLEANUP_FAILED`
- auth/precondition: ต้อง authenticated และทุก asset ต้องอยู่ใน `request.orgId`; v1 รักษาสิทธิ์ลบของ asset endpoint เดิมไว้ (role policy ไม่เปลี่ยนในฟีเจอร์นี้); รับเฉพาะ `created`, `uploaded`, `ready`, `error`

## State and data

- source of truth: `assets.status = deleted` คือ asset ถูกถอนจากผลิตภัณฑ์แล้ว; `asset_deletion_tasks.status` คือความคืบหน้าการ purge storage
- records changed: เพิ่ม `asset_deletion_tasks` (`id`, `assetId` unique, `orgId`, `status`, `attempts`, `lastError`, timestamps) และ idempotency record ที่ unique ต่อ `orgId + key` และเก็บ payload digest + response; `deleted` ถูก exclude จาก list/detail/playback
- transaction boundary: transaction เดียว lock candidate rows, ตรวจ org/status, mark asset `deleted`, สร้าง deletion task และบันทึก idempotency response; ห้าม purge S3 ก่อน commit
- migration/backfill: migration additive; ไม่มี backfill. Existing single delete เปลี่ยนเป็นสร้าง deletion task เช่นเดียวกับ bulk command แต่คง response shape เดิมและเพิ่ม `deletionPending: true` ได้แบบ backward-compatible

## Async and failure behavior

- queue job identity: ใช้ `asset_deletion_tasks.id` เป็น BullMQ `jobId`; task หนึ่งต่อ asset และลบ prefix `sources/{assetId}/` กับ `playback/{assetId}/` แบบ paginated/idempotent
- idempotency: asset ที่ `deleted` แล้วเป็น accepted no-op เมื่อมาจาก command เดิม; key เดียวกับ payload ต่างกันคืน `IDEMPOTENCY_KEY_REUSED`; duplicate IDs ไม่สร้าง task ซ้ำ
- retryable errors: S3 timeout หรือ temporary provider failure retry 3 ครั้ง exponential backoff; หลัง DB commit หาก Redis ใช้ไม่ได้ command ยังตอบ accepted พร้อม `queuedForReconciliation: true` และ reconciler ส่ง task `queued` กลับเข้า queue
- terminal failure: task บันทึก `failed` และ `lastError` โดย asset ยังคง hidden/`deleted`; cleanup monitor requeue task ตาม policy เพื่อไม่คืน asset ที่ผู้ใช้ลบแล้ว
- recovery: refresh ไม่คืน asset ที่ accepted; worker ลบ DB row และ FK-cascade records หลัง S3 purge สำเร็จ. ห้ามรับ asset ที่ `queued`/`processing` เพื่อไม่เกิด race กับ FFmpeg ที่อาจเขียน S3 หลัง purge

## External integrations

- port: S3 `ListObjectsV2`/`DeleteObjects`, BullMQ deletion queue, DB transaction/outbox reconciler
- real adapter: ใช้ `s3Client` และเพิ่ม `asset-deletion` queue/worker; แยกออกจาก transcode worker เพื่อให้ cleanup ไม่แย่ง capacity FFmpeg
- fake/fixture: fake paginated S3 delete, queue add/remove และ clock/backoff; fixture มี asset แต่ละ lifecycle status
- timeout/rate limit: API ทำเฉพาะ DB transaction; worker ลบ S3 เป็น page ละไม่เกิน 1,000 keys และจำกัด concurrency ต่ำ (เช่น 2)

## Acceptance tests

- [ ] happy path: เลือก ready/error 20 รายการ, ยืนยัน, cards หายทันที และ worker purge S3 prefixes/DB records ครบ
- [ ] invalid input: empty, malformed, duplicate และเกิน 100 IDs ให้ผลตาม contract โดยไม่สร้าง task เกินหนึ่งต่อ asset
- [ ] auth failure: ID ต่าง organization ไม่ถูก mark หรือ purge; unauthenticated ได้ 401
- [ ] duplicate/stale command: double-click/key เดิม, asset ที่ถูกลบแล้ว และสถานะเปลี่ยนเป็น processing ไม่สร้าง cleanup ซ้ำหรือซ่อน asset ผิดรายการ
- [ ] provider/worker failure ถ้าเกี่ยวข้อง: S3/Redis ล้มเหลวแล้ว task retry/reconcile ได้; asset ยังคงไม่กลับเข้า list/playback
- [ ] refresh/resume: refresh ระหว่าง queued cleanup ไม่คืน card; completed cleanup ลบ DB + S3; queued/processing card เลือกไม่ได้และอธิบายเหตุผล

## Decisions and known debt

- สิ่งที่ตัดสินแล้ว: v1 เป็น permanent async delete, command ละสูงสุด 100, selection เฉพาะสิ่งที่เห็น, ใช้ typed confirmation เมื่อมากกว่า 10, และไม่ลบงาน transcode ที่กำลังทำงาน
- สิ่งที่จงใจเลื่อนไป: cancellation แบบ cooperative ของ FFmpeg, recycle bin/restore, delete-by-filter ทั้งหมด, user-facing deletion history/retry และ role policy ที่ละเอียดกว่า auth ปัจจุบัน
