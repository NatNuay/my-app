"use client";

import { useState } from "react";
import { parseHighlightTime } from "@/lib/highlight-edits";
import { formatTime } from "@/lib/youtube";
import type { AutoSegment } from "@/lib/highlight-analysis";

export default function HighlightEditor({ segments, custom, time, duration, onSave, storageError }: {
  segments: AutoSegment[]; custom: boolean; time: number; duration: number;
  onSave: (segments: AutoSegment[] | undefined) => void; storageError?: string;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [label, setLabel] = useState("ท่อนฮุค");
  const [editing, setEditing] = useState<number>();
  const [error, setError] = useState<string>();
  const reset = () => { setStart(""); setEnd(""); setLabel("ท่อนฮุค"); setEditing(undefined); setError(undefined); };
  return <details>
    <summary>เพิ่มหรือแก้ช่วงฮุค</summary>
    <p>ใช้ได้แม้ระบบหาเพลงไม่พบ เมื่อบันทึกจะใช้รายการของคุณแทนอัตโนมัติสำหรับคลิปนี้ จำไว้ในเบราว์เซอร์นี้เท่านั้น</p>
    <ul>{segments.map((s, i) => <li key={`${i}:${s.start}:${s.end}`}>
      {formatTime(s.start)}–{formatTime(s.end)} {s.label}{" "}
      <button type="button" onClick={() => { setStart(String(s.start)); setEnd(String(s.end)); setLabel(s.label); setEditing(i); setError(undefined); }}>แก้ช่วงนี้</button>{" "}
      <button type="button" onClick={() => { onSave(segments.filter((_, index) => index !== i)); reset(); }}>ลบช่วงนี้</button>
    </li>)}</ul>
    <form onSubmit={(e) => {
      e.preventDefault();
      const a = parseHighlightTime(start), b = parseHighlightTime(end);
      if (a === undefined || b === undefined || b - a < 1 || !duration || b > duration) {
        setError("ใส่เวลาเป็น นาที:วินาที หรือวินาที โดยจบหลังเริ่มอย่างน้อย 1 วินาทีและไม่เกินความยาวคลิป"); return;
      }
      if (editing === undefined && segments.length >= 100) { setError("บันทึกได้ไม่เกิน 100 ช่วงต่อคลิป"); return; }
      const segment: AutoSegment = { start: a, end: b, label: label.trim().slice(0, 100) || "ท่อนฮุค", confidence: "medium", evidence: "ช่วงที่คุณกำหนดและบันทึกไว้ในเบราว์เซอร์นี้" };
      const next = editing === undefined ? [...segments, segment] : segments.map((s, i) => i === editing ? segment : s);
      onSave(next.sort((a, b) => a.start - b.start)); reset();
    }}>
      <p><label>ชื่อช่วง <input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} /></label></p>
      <p><label>เริ่ม <input value={start} placeholder="1:02" required onChange={(e) => setStart(e.target.value)} /></label>{" "}
        <button type="button" disabled={!duration} onClick={() => setStart(time.toFixed(2))}>ใช้เวลาปัจจุบันเป็นจุดเริ่ม</button></p>
      <p><label>จบ <input value={end} placeholder="1:20" required onChange={(e) => setEnd(e.target.value)} /></label>{" "}
        <button type="button" disabled={!duration} onClick={() => setEnd(time.toFixed(2))}>ใช้เวลาปัจจุบันเป็นจุดจบ</button></p>
      <button type="submit" disabled={!duration}>{editing === undefined ? "เพิ่มช่วง" : "บันทึกการแก้ไข"}</button>{" "}
      <button type="button" onClick={reset}>ล้างช่องกรอก</button>
    </form>
    {custom && <p><button type="button" onClick={() => { onSave(undefined); reset(); }}>ล้างรายการที่บันทึกและกลับไปใช้อัตโนมัติ</button></p>}
    {(error || storageError) && <p role="alert">{error || storageError}</p>}
  </details>;
}
