"use client";

import { useState } from "react";
import type { HighlightsResponse } from "@/lib/highlight-analysis";

export default function HighlightTiming({ alignment, offset, onChange }: {
  alignment?: HighlightsResponse["alignment"];
  offset?: number;
  onChange: (value: number | undefined) => void;
}) {
  const [value, setValue] = useState(String(Math.round((offset ?? 0) * 100) / 100));
  const seconds = Number(value);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (value.trim() && Number.isFinite(seconds) && Math.abs(seconds) <= 120) onChange(seconds); }}>
      {alignment && <p>
        พบเพลงยาว {alignment.songDuration} วินาที แต่คลิปยาว {alignment.clipDuration} วินาที
        จึงยังยืนยันตำแหน่งฮุคไม่ได้ ฮุคแรกในเนื้อเพลงอยู่ที่ {alignment.firstChorusStart.toFixed(1)} วินาที
        หากคลิปมีอินโทรก่อนเพลง ให้เพิ่มเวลาตามอินโทร หากต่างกันเฉพาะท้ายคลิป ให้ใช้ 0
      </p>}
      <label>เลื่อนเวลาฮุค (วินาที บวก = ช้าลง ลบ = เร็วขึ้น){" "}
        <input type="number" min="-120" max="120" step="0.01" required value={value} onChange={(e) => setValue(e.target.value)} />
      </label>{" "}
      <button type="submit">ใช้เวลานี้</button>{" "}
      {offset !== undefined && <button type="button" onClick={() => { setValue("0"); onChange(undefined); }}>กลับไปตรวจอัตโนมัติ</button>}
      <p><small>เวลาที่ปรับจำแยกคลิปไว้ในเบราว์เซอร์นี้เมื่ออนุญาตให้บันทึก กรุณาฟังตรวจสอบอีกครั้ง ระบบยังไม่ได้วิเคราะห์เสียงหรือท่าเต้น</small></p>
    </form>
  );
}
