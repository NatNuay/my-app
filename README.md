# Muverse: YouTube search + player (ชุดทดสอบฟีเจอร์ ไม่มีดีไซน์)

## วิธีรัน (VS Code)

1. ติดตั้ง [Node.js](https://nodejs.org) เวอร์ชัน 18.18 ขึ้นไป (แนะนำ 20 LTS)
2. เปิดโฟลเดอร์ `muverse` ด้วย VS Code (File > Open Folder)
3. ใส่คีย์ในไฟล์ `.env.local` ให้เป็น `YOUTUBE_API_KEY=คีย์ของคุณ`
4. เปิด Terminal ใน VS Code (Ctrl+`) แล้วรัน:

```
npm install
npm run dev
```

5. เปิด http://localhost:3100

โปรเจกต์นี้ใช้พอร์ต **3100** เพื่อไม่ชนกับโปรเจกต์เดิมที่ใช้พอร์ต 3000

หลังแก้ `.env.local` ต้องหยุดแล้วรัน `npm run dev` ใหม่

## ขอ YouTube API key

1. เข้า Google Cloud Console แล้วสร้างโปรเจกต์
2. เปิดใช้ **YouTube Data API v3**
3. สร้าง API key (จำกัดให้ใช้ได้เฉพาะ YouTube Data API v3)

อย่า commit `.env.local` ขึ้น Git (ถูกใส่ใน `.gitignore` แล้ว)

## โครงสร้าง

```
app/
  page.tsx                              หน้าเดียวที่ "/" (ค้นหา + เล่น)
  layout.tsx, globals.css
  api/youtube/search/route.ts           ค้นหาผ่าน YouTube Data API (ฝั่งเซิร์ฟเวอร์)
components/
  youtube-player.tsx / .css             เครื่องเล่น (IFrame API + ตัวควบคุมเอง)
  youtube-search.tsx                    ช่องค้นหา + ผลลัพธ์
lib/youtube.ts                          ชนิดข้อมูล + ตัวโหลด IFrame API
```

## ฟีเจอร์ (เฉพาะที่กำหนด)

- ค้นหาคลิปจาก YouTube + ตัวกรอง ทั้งหมด / เต้นตาม / สอนเต้น
- เล่น/หยุด
- Seekbar กรอไปมาได้
- แตะสองครั้งฝั่งขวา = ข้าม 10 วิ, ฝั่งซ้าย = ย้อน 10 วิ
- ปรับระดับเสียง
- กลับด้านซ้าย-ขวา (Mirror)

ปุ่มข้าม/ย้อนคลิป (Skip & Previous) จะเพิ่มตอนมีระบบ Playlist

## โควตา

โควตาเริ่มต้น 10,000 หน่วยต่อวัน การค้นหาหนึ่งครั้งใช้ราว 101 หน่วย (ประมาณ 99 ครั้งต่อวัน)
ผลลัพธ์ถูกแคชฝั่งเซิร์ฟเวอร์ 1 ชั่วโมง คำค้นเดิมจึงไม่กินโควตาซ้ำ

## ถ้าเจอปัญหา

- ขึ้น "ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY": ยังไม่ได้ใส่คีย์ หรือยังไม่ได้รัน dev ใหม่หลังใส่
- ขึ้นข้อความ API key not valid / quota: ตรวจว่าเปิด YouTube Data API v3 แล้ว และโควตายังไม่หมด
- คลิปเล่นไม่ได้: เจ้าของคลิปปิดการฝัง ให้เลือกคลิปอื่น
