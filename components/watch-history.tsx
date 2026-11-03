"use client";

import { useEffect, useState } from "react";
import { HISTORY_LIMIT, type WatchHistoryEntry } from "@/lib/watch-history";
import { formatTime, type VideoItem } from "@/lib/youtube";

export default function WatchHistory({ entries, loaded, error, activeId, onPlay, onRemove, onClear }: {
  entries: WatchHistoryEntry[]; loaded: boolean; error?: string; activeId?: string;
  onPlay: (video: VideoItem) => void; onRemove: (id: string) => void; onClear: () => void;
}) {
  const [visible, setVisible] = useState(10);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [activeId]);
  function replay(video: VideoItem) {
    setOpen(false);
    onPlay(video);
  }
  return <section aria-label="ประวัติการเข้าชม">
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary style={{ cursor: "pointer", padding: "0.75rem 0", fontWeight: 700 }}>
        ประวัติการเข้าชม ({entries.length}) · {open ? "ซ่อนประวัติ" : "ดูประวัติ"}
      </summary>
      <p><small>คลิปที่เปิดล่าสุดอยู่ด้านบน จำไว้เฉพาะเบราว์เซอร์นี้ สูงสุด {HISTORY_LIMIT} คลิป</small></p>
      {!loaded ? <p>กำลังโหลดประวัติ…</p> : entries.length === 0 ? <p>ยังไม่มีประวัติการเข้าชม</p> : <>
        <button type="button" onClick={onClear}>ล้างประวัติทั้งหมด</button>
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {entries.slice(0, visible).map(({ video, openedAt }) => <li key={video.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
            <button type="button" onClick={() => replay(video)} style={{ display: "flex", gap: "0.75rem", flex: 1, textAlign: "left", fontWeight: activeId === video.id ? 700 : 400 }}>
              {video.thumbnail && <img src={video.thumbnail} alt="" width={120} height={68} loading="lazy" />}
              <span>{video.title}<br /><small>{video.channel}{video.durationSec > 0 ? ` · ${formatTime(video.durationSec)}` : ""}</small><br />
                <small>เปิดล่าสุด <time dateTime={new Date(openedAt).toISOString()}>{new Date(openedAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}</time></small>
              </span>
            </button>
            <button type="button" aria-label={`ลบประวัติ ${video.title}`} onClick={() => onRemove(video.id)}>ลบ</button>
          </li>)}
        </ul>
        {entries.length > visible && <button type="button" onClick={() => setVisible((count) => count + 10)}>แสดงประวัติเพิ่ม</button>}
      </>}
      {error && <p role="status">{error}</p>}
    </details>
  </section>;
}
