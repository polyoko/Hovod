# Feature: Choose video output qualities

สถานะ: done

## Outcome
ผู้ดูแลองค์กรเลือก rendition 360p, 480p, 720p และ 1080p ที่จะสร้างสำหรับวิดีโอใหม่ เพื่อลดเวลา encode และพื้นที่จัดเก็บ

## In scope
- เลือก output quality หลายรายการใน Settings โดยต้องเลือกอย่างน้อยหนึ่งรายการ
- Settings API และ worker ใช้ค่าเดียวกันต่อ organization
- มีผลกับงานที่เริ่ม transcode หลังบันทึกเท่านั้น

## Out of scope
- re-transcode วิดีโอที่ ready แล้ว, bitrate ที่กำหนดเอง, และ per-video override

## User flow
1. ผู้ดูแลเลือกหรือยกเลิก output quality ใน Settings
2. กด Save changes
3. งานใหม่สร้างเฉพาะ rendition ที่เลือก

## UI states
- loading: โหลดค่าล่าสุด
- success: แสดง Settings saved
- error/retry: คงค่าที่เลือกไว้และแสดงข้อความจาก API
- stale/conflict: การบันทึกล่าสุดชนะ; refresh ดึงค่าปัจจุบัน

## Contracts
- command/query: `GET/PATCH /v1/settings`
- input/output: `enabledRenditions: (360p | 480p | 720p | 1080p)[]`
- stable error codes: `INVALID_RENDITIONS`
- auth/precondition: authenticated และมีอย่างน้อย 1 คุณภาพ

## State and data
- source of truth: `settings.enabled_renditions` ต่อ organization
- migration/backfill: เพิ่ม column แบบ additive โดย default เลือกครบ 4 ค่า

## Async and failure behavior
- queue job identity: transcode job เดิมของ asset
- idempotency: การเปลี่ยน setting ไม่สร้าง job ใหม่
- retryable errors: worker ใช้ default 4 คุณภาพหากอ่าน setting ไม่ได้
- recovery: retry ใช้ค่าขณะ worker เริ่มทำงาน

## Acceptance tests
- [ ] เลือก 360p และ 720p แล้วงานใหม่สร้างสอง rendition นี้
- [ ] ส่ง array ว่างหรือค่าที่ไม่รองรับได้ `INVALID_RENDITIONS`
- [ ] refresh/resume

## Decisions and known debt
- สิ่งที่ตัดสินแล้ว: ไม่แก้ rendition ของวิดีโอเก่าอัตโนมัติ
- สิ่งที่จงใจเลื่อนไป: profile/bitrate ที่ตั้งเองและ override รายวิดีโอ
