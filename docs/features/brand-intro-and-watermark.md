# Feature: วิดีโอที่ถูกดาวน์โหลดไปติด intro และลายน้ำ URL

สถานะ: in-progress

## Outcome
ทุกวิดีโอที่ transcode ใหม่จะมี intro แบรนด์อยู่หน้าวิดีโอ และมีข้อความ URL กะพริบอยู่ด้านบนตลอดเรื่อง ทั้งสองอย่าง burn-in ลงใน HLS และ `download.mp4` คนที่ดาวน์โหลดด้วยเครื่องมือใดๆ จะได้ intro และลายน้ำติดไปด้วย ส่วนคนดูบนเว็บจะเริ่มดูหลัง intro เลย แต่ยังเห็นลายน้ำ

## In scope
- worker ต่อ intro (จาก `videotocopy/intros/`) ไว้หน้า source ก่อน encode ทุก rendition
- ลายน้ำ `drawtext` ด้านบนกลางจอ เฉพาะช่วงหลัง intro กะพริบ: แสดง 5 วินาที ซ่อน 5 วินาที วนตลอด
- เก็บ `introDurationSec` ต่อ asset และส่งออกใน playback API
- player ของ Hovod (`Player.tsx`) และ TDED Web (`video-explore.tsx`) เริ่มเล่นที่จุดจบ intro และ seek ถอยกลับเข้าไปใน intro ไม่ได้ เวลาที่แสดงใน UI ไม่นับ intro

## Out of scope
- re-transcode วิดีโอเก่า (asset เก่ามี `introDurationSec = 0` และเล่นแบบเดิม)
- ลายน้ำเฉพาะราย viewer, โลโก้รูปภาพ, และการเปิด/ปิดแยกราย org หรือรายวิดีโอ
- การกันไม่ให้ตัด intro ทิ้ง (ตัดได้ด้วย ffmpeg คำสั่งเดียว ลายน้ำเป็นชั้นป้องกันหลัก)

## User flow
1. อัปโหลดวิดีโอตามปกติ
2. worker encode ออกมาเป็น intro ตามด้วยวิดีโอที่มีลายน้ำ
3. คนดูเปิดวิดีโอแล้วเริ่มเล่นที่เนื้อหาเลย โดยเห็นลายน้ำ
4. คนที่ดาวน์โหลด HLS หรือ `download.mp4` ได้ไฟล์ที่มี intro และลายน้ำ

## UI states
- loading: player รอ metadata ก่อน แล้วค่อยกระโดดไปที่ `introDurationSec`
- success: progress bar เริ่มที่ 0:00 ซึ่งตรงกับจุดจบ intro
- error/retry: เหมือนเดิม
- stale/conflict: asset เก่ามี `introDurationSec = 0` จึงเล่นแบบเดิม

## Contracts
- command/query: `GET /v1/playback/:playbackId` และ `GET /v1/assets/:id` เพิ่ม field `introDurationSec: number` (ไม่มี = 0)
- input: ไม่มีอะไรใหม่
- stable error codes: ไม่มีอะไรใหม่
- auth/precondition: เหมือนเดิม

## State and data
- source of truth: `assets.intro_duration_ms` (INT, default 0) API ส่งออกเป็น `introDurationSec`
- `duration_sec` ยังเป็นความยาวของ source ที่ไม่รวม intro
- เวลาทุกอย่างอิง timeline ของ HLS ที่รวม intro: worker เลื่อน thumbnails VTT, transcript, subtitles และ chapters ไปเท่า `introDurationSec` ส่วนคอมเมนต์และ analytics ใช้ `video.currentTime` อยู่แล้ว component อื่นจึงไม่ต้องแก้
- player ของ Hovod dashboard แสดงเวลาตาม timeline ของ HLS จึงเริ่มที่ประมาณ 0:03 (ให้ตรงกับ transcript/chapters) ส่วน player ของ TDED Web ไม่มีข้อมูลพวกนี้ จึงแสดงเวลาที่หัก intro แล้ว
- TDED Web อ่าน `introDurationMs` จาก snapshot ของ asset ที่ sync มา ไม่ต้องแก้ schema
- migration: เพิ่ม column แบบ additive (`CREATE`/`ALTER` ใน `apps/api/src/db.ts`)

## Async and failure behavior
- เปิดใช้เมื่อตั้ง env ของ worker ไว้: `WATERMARK_TEXT` (ของเราใช้ `b.link/tded89`) และ `INTRO_DIR` ถ้าไม่ตั้ง ก็ encode แบบเดิม (Hovod เป็น open-source จึงต้องปิดได้)
- ถ้าไฟล์ intro หายหรืออ่านไม่ได้ ให้ job fail พร้อมข้อความที่ชัดเจน ไม่ publish วิดีโอโดยไม่มี intro แบบเงียบๆ
- retry ใช้ job เดิม ผลลัพธ์ deterministic

## Implementation notes
- เลือก intro ตามสัดส่วนภาพเหมือน `videotocopy/prepend-intro.sh` (16:9 ใช้ landscape, 9:16 ใช้ portrait, สัดส่วนอื่นใช้ square) แล้ว scale+crop กลางภาพให้เท่าขนาด source, ปรับ fps/sar ให้ตรงกัน แล้วใช้ `concat` filter
- source ที่ไม่มีเสียงต้องเติม `anullsrc` เพราะ concat ต้องการ audio ทั้งสองฝั่ง จึงต้องขยาย `ffprobe()` ให้คืนค่า `hasAudio` และ `fps`
- `drawtext`: `enable='gte(t,I)*lt(mod(t-I,10),5)'`, `fontsize=h*0.045`, `y=h*0.04`, สีขาว alpha 0.7 มีขอบดำ font ใช้ `fonts-dejavu-core` (ต้องเพิ่มใน Dockerfile ของ worker)
- `-force_key_frames` ต้องมี keyframe ตรงจุดจบ intro ด้วย player จะได้ seek ไปตรงเนื้อหาแรกได้พอดี
- hls.js ใช้ `startPosition: introDurationSec` ส่วน Safari native ตั้ง `currentTime` ตอน `loadedmetadata`
- ต้องคัดลอกไฟล์ intro เข้า worker image หรือ mount เป็น volume

## Acceptance tests
- [ ] วิดีโอ 16:9, 9:16 และ 4:3 ออกมามี intro ที่ถูกสัดส่วน ไม่มีขอบดำ
- [ ] source ที่ไม่มีเสียง encode ผ่าน
- [ ] ลายน้ำไม่ขึ้นทับ intro และกะพริบตามรอบ 5/5 วินาที
- [ ] `download.mp4` มี intro และลายน้ำ
- [ ] player เริ่มที่ 0:00 ของเนื้อหา และลาก progress ไปที่ 0 แล้วไม่เห็น intro (ทั้ง hls.js และ Safari)
- [ ] ปิด env แล้วได้ output เหมือนเดิม
- [ ] asset เก่าเล่นได้ปกติ

## Decisions and known debt
- สิ่งที่ตัดสินแล้ว: ใช้กับทุกวิดีโอใหม่, ไม่ทำกับวิดีโอเก่า, ลายน้ำเป็นข้อความ URL ด้านบนแบบกะพริบ แสดง/ซ่อน
- ความเสี่ยงที่รับไว้: ช่วงที่ลายน้ำซ่อน 5 วินาที (ครึ่งหนึ่งของเวลาทั้งหมด) ตัดเอาไปใช้ได้โดยไม่มีลายน้ำ ผู้ใช้เลือกเอง
- สิ่งที่จงใจเลื่อนไป: ลายน้ำราย viewer และตั้งค่าราย org
- ช่องโหว่ที่ยังเปิดอยู่: `GET /v1/playback/:id/download` (เมื่อ `allowDownload`) ส่งไฟล์ original ที่ไม่มีลายน้ำ
