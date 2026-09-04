# Feature: ควบคุมการเก็บไฟล์ต้นฉบับหลังประมวลผลวิดีโอ

สถานะ: done

## Outcome

ผู้ดูแล organization เลือกได้จากหน้า Settings ว่าจะเก็บไฟล์ต้นฉบับของวิดีโอ upload ไว้ใน object storage หลัง HLS พร้อมใช้งานหรือไม่ ค่าเริ่มต้นคือเปิดเพื่อรองรับ Original download และ retry; เมื่อปิด ระบบคง `playback/{assetId}/` ไว้ แต่ลบ `sources/{assetId}/` และทำให้ดาวน์โหลด original ไม่ได้

## In scope

- เพิ่ม section `Storage` ใน Settings พร้อม switch `Keep original source files` (default: on)
- ข้อความใต้ switch อธิบายผลกระทบ: ปิดแล้วลด storage แต่ original download และ reprocess หลังงานสำเร็จจะใช้ไม่ได้
- ใช้ policy ตอน asset เปลี่ยนเป็น `ready`; ไม่ purge ไฟล์ original ของ asset เดิมในทันทีเมื่อเปลี่ยน setting
- สำหรับ upload ปกติ ลบ prefix `sources/{assetId}/` แบบ async/idempotent และตั้ง `assets.sourceKey = null` เมื่อ purge สำเร็จ
- สำหรับ proxy upload ไม่ archive source ไป object storage เมื่อ policy ปิด; local temporary source ยังถูกลบหลัง worker จบตามเดิม
- เพิ่ม durable source-cleanup task/queue/reconciler สำหรับ S3 failure โดยแยกจาก asset-deletion task

## Out of scope

- ลบ original ที่มีอยู่ก่อนตั้งค่านี้, purge-all button, retention days, quota UI หรือคืน original ที่ลบไปแล้ว
- เปลี่ยนพฤติกรรม URL import (ไม่มี original ใน R2/S3 อยู่แล้ว) และการเก็บ HLS/playback
- ทำให้ reprocess asset `ready` ได้เมื่อ original ถูกลบ หรือเปลี่ยน download rendition ที่มีอยู่

## User flow

1. ผู้ดูแลเปิด Settings → `Storage` แล้วเห็น switch เปิดอยู่ตาม default
2. เมื่อปิด switch จะเห็นคำเตือน inline ว่า policy ใช้กับวิดีโอที่เสร็จหลังบันทึก และไม่ได้ลบ original เดิม
3. ผู้ใช้กด `Save changes`; success state ยืนยันว่า storage policy ถูกบันทึก
4. วิดีโอ upload ที่ HLS สำเร็จหลังจากนั้น: worker เก็บ `playback/` ตามเดิม, ไม่ archive original สำหรับ proxy upload หรือสร้าง source-cleanup task สำหรับ direct upload
5. cleanup worker ลบ `sources/{assetId}/`; เมื่อสำเร็จจึง clear `sourceKey` ทำให้ UI/API ไม่เสนอ Original download อีก

## UI states

- loading: switch disabled จน Settings โหลด; ใช้ค่า server เป็น source of truth
- empty: ไม่มี state พิเศษ; section แสดงได้แม้ยังไม่มีวิดีโอ
- success: แสดง Settings saved เดิม และ switch สะท้อนค่าที่ refetch จาก server
- error/retry: save ล้มเหลวคงค่า draft และแจ้ง error เดิม; cleanup S3 ล้มเหลวไม่ย้อน switch และระบบ retry เบื้องหลัง
- stale/conflict: last write wins ตาม Settings endpoint ปัจจุบัน; การเปลี่ยนค่าไม่เปลี่ยน policy ที่ asset ทำเสร็จและ cleanup สำเร็จแล้ว

## Contracts

- command/query: ขยาย `GET/PATCH /v1/settings` ด้วย `keepOriginalSourceFiles: boolean`
- input: PATCH รับ boolean optional; omitted คงค่าเดิม
- output: GET/PATCH คืน boolean นี้; `GET /v1/assets/:id/download` คืน `ORIGINAL_SOURCE_NOT_AVAILABLE` เมื่อ original ถูก purge
- stable error codes: `ORIGINAL_SOURCE_NOT_AVAILABLE`, `SOURCE_CLEANUP_QUEUE_UNAVAILABLE`, `SOURCE_CLEANUP_FAILED`
- auth/precondition: ใช้ organization auth ของ Settings เดิม; policy เป็น per-organization ไม่ใช่ global instance setting

## State and data

- source of truth: `settings.keep_original_source_files` (default `true`); `assets.source_key` มีค่าเฉพาะเมื่อ original ยังพร้อมใช้
- records changed: additive column ใน `settings`; เพิ่ม `asset_source_cleanup_tasks` (`id`, `assetId` unique, `orgId`, `status`, `attempts`, `lastError`, timestamps)
- transaction boundary: worker mark `ready` ตาม flow เดิม แล้ว transaction สร้าง cleanup task เฉพาะเมื่อ policy ปิด; cleanup worker ลบ S3 prefix ก่อน conditional update `sourceKey = null`
- migration/backfill: ค่า default `true` รักษา behavior ทุก instance และ asset เดิม; ไม่ทำ backfill/purge

## Async and failure behavior

- queue job identity: `asset_source_cleanup_tasks.id` เป็น jobId และ task เดียวต่อ asset
- idempotency: S3 prefix delete ทำซ้ำได้; task ซ้ำไม่สร้างเพิ่มด้วย unique `assetId`; clear sourceKey แบบ conditional หลัง storage purge
- retryable errors: S3/Redis transient failure retry 3 ครั้ง exponential backoff; task ที่ commit แต่ enqueue ไม่ได้ให้ reconciler ส่งซ้ำ
- terminal failure: บันทึก task `failed` พร้อม error และคง `sourceKey` เพื่อไม่อ้างว่า original หายแล้ว; การ requeue หลังหมด retry เป็นงาน operator/observability ในอนาคต
- recovery: asset ที่ `error` ยังมี source สำหรับ retry เพราะ cleanup เกิดเฉพาะหลัง ready; bulk asset deletion cancel task ผ่าน FK cascade และลบ source prefix ทั้งหมดตามเดิม

## External integrations

- port: S3 `ListObjectsV2`/`DeleteObjects`, BullMQ source-cleanup queue
- real adapter: ใช้ `s3Client`/worker S3 client ที่มีอยู่; queue/reconciler แยกจาก `asset-deletion`
- fake/fixture: direct upload ที่มี source object, proxy upload ที่มี local source, URL import, S3 pagination/failure และ queue outage
- timeout/rate limit: API setting update ไม่รอ S3; worker page ละไม่เกิน 1,000 keys, concurrency ต่ำ

## Acceptance tests

- [ ] happy path: default on เก็บ original; ปิดแล้ว upload ใหม่จบเป็น ready โดยมี playback และไม่มี source prefix/sourceKey
- [ ] invalid input: PATCH ที่ไม่ใช่ boolean ถูกปฏิเสธ; omitted field ไม่เปลี่ยนค่าเดิม
- [ ] auth failure: organization อื่นอ่านหรือแก้ policy ไม่ได้ และไม่ schedule cleanup ข้าม org
- [ ] duplicate/stale command: worker/reconciler ส่ง task ซ้ำไม่ลบ playback และไม่ clear sourceKey ก่อน S3 purge สำเร็จ
- [ ] provider/worker failure ถ้าเกี่ยวข้อง: S3/Redis failure retry ได้; sourceKey คงอยู่เมื่อ cleanup terminal failure
- [ ] refresh/resume: refresh Settings เห็นค่าที่บันทึก; setting ใหม่ไม่ purge source ของ asset เดิม

## Decisions and known debt

- สิ่งที่ตัดสินแล้ว: default on, policy per organization, forward-only, cleanup หลัง asset ready, และ clear sourceKey เพื่อปิด original download อย่างถูกต้อง
- สิ่งที่จงใจเลื่อนไป: bulk purge existing originals, retention window/restore, user-visible cleanup history, configurable retry policy และ re-encode จาก HLS
