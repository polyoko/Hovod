# Feature: อัปโหลดวิดีโอหลายไฟล์พร้อมติดตามและลองใหม่ได้

สถานะ: in-progress

## Outcome

ผู้ใช้เลือกวิดีโอหลายไฟล์จาก Dashboard ได้ในครั้งเดียว เห็นความคืบหน้าและความผิดพลาดรายไฟล์ และไฟล์ที่อัปโหลดสำเร็จจะถูกส่งเข้า transcode ตามปกติ โดยไม่ส่งข้อมูลวิดีโอผ่าน API server

## In scope

- เพิ่มโหมด `Upload files` ในหน้า New video ให้เลือกหรือ drag-and-drop วิดีโอหลายไฟล์ได้
- ตั้งชื่อเริ่มต้นจากชื่อไฟล์ และแก้ title รายไฟล์ได้ก่อนเริ่มงาน
- อัปโหลดตรง Browser → S3 ด้วย presigned URL, จำกัดการอัปโหลดพร้อมกันที่ 3 ไฟล์
- สร้าง asset, ยืนยันไฟล์ใน S3 และ enqueue transcode แยกกันต่อหนึ่งไฟล์
- แสดงสถานะ, progress, error และ Retry เฉพาะไฟล์ที่ล้มเหลว
- ทำ `POST /v1/assets/:id/process` ให้ idempotent และทำ state transition `uploaded → queued` แบบ atomic
- ตั้ง retry/backoff สำหรับ transient transcode failure และให้ retry asset ที่ `error` ได้เมื่อ source ยังอยู่
- เก็บ `assetId` ที่สร้างแล้วใน localStorage เพื่อ recovery หลัง refresh และแสดงลิงก์ไปยัง asset

## Out of scope

- API ที่รับหลาย binary files หรือ bulk-transcode job ใหม่
- URL import แบบหลายรายการ, folder upload, CSV metadata และการย้ายไฟล์ข้าม organization
- resumable/multipart S3 upload; refresh ระหว่าง PUT จะต้องเลือกไฟล์ใหม่
- การเปลี่ยน encoding ladder, queue concurrency หรือระบบ quota

## User flow

1. ผู้ใช้เลือกไฟล์วิดีโอหนึ่งไฟล์หรือหลายไฟล์ใน New video และแก้ title ได้
2. UI ตรวจ file count, MIME type และขนาดก่อนเริ่ม แล้วแสดงรายการที่ไม่ผ่านโดยไม่เริ่ม upload
3. ผู้ใช้เลือก AI options ชุดเดียวสำหรับรายการที่เริ่มในครั้งนั้น แล้วกด Start processing
4. ตัวจัดคิวฝั่ง browser เริ่มได้สูงสุด 3 รายการ: สร้าง asset → ขอ upload URL → PUT ไป S3 → upload-complete → process
5. แต่ละแถวแสดง progress และจบที่ `queued`; transcode ดำเนินใน worker ตามปกติ
6. เมื่อ upload หรือ enqueue ล้มเหลว ผู้ใช้ Retry แถวเดียวได้; ไฟล์อื่นดำเนินต่อ
7. หลัง refresh, UI อ่านรายการ asset ที่เริ่มแล้วจาก localStorage และ query สถานะล่าสุด; งานที่เข้าคิวแล้วไม่ถูกหยุด

## UI states

- loading: กำลังตรวจ config, สร้าง asset, ขอ signed URL, upload หรือ enqueue; ปิดการแก้แถวที่กำลังทำงาน
- empty: drop zone รองรับหลายไฟล์ พร้อมบอกชนิดและขนาดสูงสุดที่รองรับ
- success: แสดงจำนวน `queued/processing/ready`, ลิงก์ไปหน้าวิดีโอ และปุ่มเริ่ม batch ใหม่
- error/retry: แสดง error ที่แก้ไขได้บนแถวนั้น พร้อม `Retry upload` หรือ `Retry processing`; ไม่ล้าง file/title ของแถว
- stale/conflict: ถ้า asset ถูก queue หรือ processing แล้ว ให้ refresh สถานะและแสดงว่าคำสั่งเดิมได้รับแล้ว แทนการสร้าง job ซ้ำ

## Contracts

- command/query: ใช้ `POST /v1/assets`, `POST /v1/assets/:id/upload-url`, `POST /v1/assets/:id/upload-complete`, `POST /v1/assets/:id/process`, `GET /v1/assets/:id`; เพิ่ม `POST /v1/assets/:id/retry` สำหรับ asset สถานะ `error`
- input: create asset รับ `title`, `metadata?`; upload URL ต้องรับและ validate `contentType` ที่อยู่ใน allowlist; process รับ `aiOptions?`
- output: process/retry ตอบ `{ data: { assetId, jobId, status: "queued", accepted: true, alreadyQueued: boolean } }`; upload URL ตอบ URL, method และ expiry
- stable error codes: `UNSUPPORTED_MEDIA_TYPE`, `FILE_TOO_LARGE`, `ASSET_SOURCE_MISSING`, `ASSET_ALREADY_PROCESSING`, `ASSET_NOT_RETRYABLE`, `QUEUE_UNAVAILABLE`, `UPLOAD_NOT_CONFIRMED`
- auth/precondition: ใช้ organization auth เดิมทุก endpoint; process อนุญาตเฉพาะ `uploaded`, หรือคืน accepted result สำหรับ `queued/processing`; retry อนุญาตเฉพาะ `error` ที่มี source object

## State and data

- source of truth: `assets.status` และ `jobs.status` เป็นความจริงของ pipeline; localStorage เป็นเพียง recovery pointer ของ UI และไม่ใช่ source of truth
- records changed: ไม่เพิ่ม batch table ใน v1; เพิ่ม job ต่อ asset เท่านั้น และอาจเพิ่ม `contentType`/`sourceSizeBytes` เฉพาะเมื่อจำเป็นต่อ validation
- transaction boundary: transaction เดียวสร้าง job แบบ `queued` และเปลี่ยน asset จาก `uploaded` เป็น `queued`; ห้าม insert job ก่อนที่ conditional state transition สำเร็จ
- migration/backfill: ไม่มี backfill; schema change ต้องเป็น additive เท่านั้น

## Async and failure behavior

- queue job identity: ใช้ DB `jobs.id` เป็น BullMQ `jobId`; asset เดียวมี active transcode job ได้หนึ่งงาน
- idempotency: process/retry ทำ conditional update ตาม current asset status; duplicate request คืน job เดิมหรือ result ที่บอกว่า already queued โดยไม่ enqueue ซ้ำ
- retryable errors: S3/network/Redis timeout และ worker infrastructure failure retry 3 ครั้งด้วย exponential backoff; validation, unsupported file และ source missing เป็น terminal
- terminal failure: เมื่อหมด retry ให้ job และ asset เป็น `failed/error` พร้อม error code ที่ไม่เปิดเผย secret; UI ให้ retry เมื่อ source ยังอยู่
- recovery: หลัง DB commit ให้ enqueue job; หาก Redis ล้มเหลวให้คง DB job เป็น `queued` แล้ว queue reconciler ตอน API startup/ตาม interval นำ queued jobs กลับเข้า BullMQ. Refresh ระหว่าง upload ไม่ resume bytes แต่ recovery asset ที่สร้างแล้วได้

## External integrations

- port: S3-compatible presigned PUT, `HeadObject`, BullMQ/Redis
- real adapter: ใช้ `s3PublicClient`, `s3Client` และ `transcodeQueue` ที่มีอยู่
- fake/fixture: mock signed URL/XHR progress, S3 HeadObject และ queue add สำหรับ unit/integration tests
- timeout/rate limit: presigned URL อายุ 1 ชั่วโมง; browser upload concurrency 3; API request timeout ไม่ครอบ PUT; bucket CORS ต้องอนุญาต Dashboard origin และ headers ที่ใช้

## Acceptance tests

- [ ] happy path: เลือก 20 MP4, อัปโหลดพร้อมกันไม่เกิน 3 และได้ 20 assets ที่ queued
- [ ] invalid input: MIME/ขนาด/ชื่อที่ไม่ถูกต้องถูกปฏิเสธก่อนสร้าง asset หรือด้วย stable error code
- [ ] auth failure: ไม่สามารถอ่านหรือ process asset ของ organization อื่น
- [ ] duplicate/stale command: double-click, retry request และ refresh ไม่สร้าง active job ซ้ำ
- [ ] provider/worker failure ถ้าเกี่ยวข้อง: S3/Redis/worker ล้มเหลวแล้วแถวเดียว retry ได้; queued job ถูก reconcile กลับเข้า queue
- [ ] refresh/resume: refresh หลัง queued แล้วสถานะกลับมาได้; refresh ระหว่าง PUT แจ้งให้เลือกไฟล์นั้นใหม่โดยไม่รายงานว่า upload สำเร็จ

## Decisions and known debt

- สิ่งที่ตัดสินแล้ว: v1 ใช้ asset ต่อไฟล์และ queue เดิม, direct-to-S3, client concurrency 3, ไม่มี bulk API/schema และ AI options shared ต่อการเริ่มหนึ่งครั้ง
- สิ่งที่จงใจเลื่อนไป: multipart/resumable upload, server-side batch history, per-file metadata/AI options, URL-import หลายรายการ และ cancellation ของ BullMQ job
