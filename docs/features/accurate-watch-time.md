# Feature: Watch time นับจากเวลาที่เล่นจริง ไม่ใช่ heartbeat × 10

สถานะ: in-progress

## Outcome
Watch time ใน dashboard คือเวลาที่วิดีโอเล่นจริง (ตามนาฬิกา ไม่รวม pause/seek) ละเอียดระดับ ms ไม่ปัดลงทีละ 10 วินาที

## In scope
- Player ของ Hovod (dashboard/embed/watch) และ TDED Web สะสม `playedMs` จาก `timeupdate` แล้วส่งไปกับทุก event
- Ingest แปลงเป็น `watch_ms` = ส่วนที่เพิ่มจาก max เดิมของ session แล้วจำกัดไม่ให้เกินเวลาจริงที่ผ่านไป + 60s
- ทุก query watch time (API + worker) ใช้ `SUM(watch_ms)`

## Out of scope
- Engagement score (ยังใช้สูตรเดิม)
- แก้ข้อมูลย้อนหลัง

## Contracts
- input: event field `playedMs` (int ≥ 0, ≤ INT max, optional) ใน `POST /v1/analytics/events`
- output: `watchTimeSec` เดิม ความหมายใหม่
- ยอมรับ event เก่าที่ไม่มี `playedMs`: heartbeat ที่ `played_ms IS NULL` ยังนับ 10 วินาที

## State and data
- columns ใหม่: `analytics_events.played_ms`, `analytics_events.watch_ms` (ALTER แบบ idempotent ใน `apps/api/src/db.ts`)
- migration/backfill: ไม่มี ข้อมูลเก่าคงสูตรเดิม

## Async and failure behavior
- idempotency: event ซ้ำหรือมาไม่เรียงได้ increment 0
- batch หาย: ค่า cumulative ถัดไปชดเชยให้ (ภายในเพดานเวลา)
- ข้อจำกัด: อ่าน max แล้ว insert ไม่ atomic batch ที่มาพร้อมกันของ session เดียวอาจนับซ้ำ (หายาก)

## Acceptance tests
- [x] increment/clamp: `node apps/api/scripts/check-watch-time.mjs` (หลัง build api)
- [x] TDED Web รับ/ปฏิเสธ/ส่งต่อ `playedMs`: `pnpm test` ใน `Web/apps/api`
- [ ] เล่นจริง 45s แล้ว watch time ≈ 45s (หลัง deploy)

## Decisions and known debt
- ตัดสินแล้ว: นับเวลาตามนาฬิกา (หารด้วย playbackRate) และนับตอนแท็บซ่อนด้วยถ้ายังเล่นอยู่
- เลื่อนไป: แยก playing time กับ rebuffer time, engagement score ใหม่
