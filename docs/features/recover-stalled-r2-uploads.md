# Feature: งาน transcode ไม่ค้างเมื่อ R2 หยุดตอบ

สถานะ: in-progress

## Outcome

งานที่ R2 หยุดตอบระหว่างอัปโหลด HLS จะ timeout แล้วใช้ retry เดิมหรือจบเป็น error ที่ผู้ใช้ retry ได้ แทนการค้างที่ `processing` ตลอดไป

## In scope

- กำหนด deadline ต่อการอัปโหลดไฟล์ HLS ไป S3/R2
- ใช้ retry และ terminal error path ของ worker ที่มีอยู่

## Out of scope

- เปลี่ยน encoding ladder, concurrency, R2 credentials หรือ multipart upload

## User flow

1. Worker อัปโหลด HLS ไป R2
2. หาก request หนึ่งไม่ตอบภายใน deadline จะ throw และ retry
3. เมื่อ retry หมด งานเป็น `error` และผู้ใช้กด Retry ได้

## UI states

- loading: แสดง processing ระหว่าง worker ทำงาน
- error/retry: แสดง error หลัง retry หมด และใช้ปุ่ม Retry เดิม

## Contracts

- command/query: ไม่มี API ใหม่
- stable error codes: คง error contract เดิม

## State and data

- source of truth: `jobs.status` และ `assets.status`
- records changed: worker อัปเดตสถานะเดิมเท่านั้น
- migration/backfill: ไม่มี

## Async and failure behavior

- queue job identity: DB job id เป็น BullMQ job id
- idempotency: upload ซ้ำ key เดิมปลอดภัย
- retryable errors: timeout ของ PutObject ใช้ exponential retry เดิม
- terminal failure: worker ตั้ง asset/job เป็น error/failed เมื่อหมด attempts
- recovery: deploy ใหม่ทำให้ active job เก่าถูก BullMQ ตรวจ stalled และเริ่มใหม่

## External integrations

- port: S3-compatible PutObject
- real adapter: AWS SDK S3Client เดิม
- timeout/rate limit: 120 วินาทีต่อไฟล์ HLS

## Acceptance tests

- [ ] PutObject ไม่ตอบภายใน 120 วินาทีแล้ว retry
- [ ] retry หมดแล้ว asset ไม่ค้างที่ processing
- [ ] refresh/resume แสดง error และ Retry เดิม

## Decisions and known debt

- สิ่งที่ตัดสินแล้ว: ใช้ AbortSignal ของ Node โดยไม่เพิ่ม dependency หรือ config ใหม่
- สิ่งที่จงใจเลื่อนไป: multipart upload และ per-file progress ใน worker
