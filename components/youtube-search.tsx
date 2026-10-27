"use client";
// components/youtube-search.tsx
// ช่องค้นหา + ตัวกรองประเภท (ทั้งหมด / เต้นตาม / สอนเต้น) + รายการผลลัพธ์

import { useEffect, useRef, useState } from "react";
import HeartButton from "@/components/heart-button";
import { formatTime, type SearchMode, type VideoItem } from "@/lib/youtube";

interface Props {
  activeId?: string;
  onSelect: (video: VideoItem) => void;
  /** กดปุ่ม “+ playlist” ที่ผลลัพธ์ */
  onAdd?: (video: VideoItem) => void;
  /** id คลิปที่อยู่ใน playlist ปลายทางแล้ว (ใช้ปิดปุ่มกันเพิ่มซ้ำ) */
  addedIds?: Set<string>;
  /** ชื่อ playlist ปลายทาง ถ้ายังไม่มีจะสร้างใหม่ให้ตอนกดเพิ่ม */
  targetName?: string;
  /** id คลิปที่กดหัวใจไว้แล้ว */
  likedIds?: Set<string>;
  /** กดหัวใจที่ผลลัพธ์ (เข้า/ออกจาก playlist “ถูกใจ”) */
  onToggleLike?: (video: VideoItem) => void;
}

const MODES: { value: SearchMode; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "follow", label: "เต้นตาม" },
  { value: "tutorial", label: "สอนเต้น" },
];

export default function YouTubeSearch({ activeId, onSelect, onAdd, addedIds, targetName, likedIds, onToggleLike }: Props) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("all");
  const [results, setResults] = useState<VideoItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function search(nextMode: SearchMode = mode) {
    const q = query.trim();
    if (!q) return;
    const requestId = ++request.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setResults(null);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}&mode=${nextMode}`, { signal: ac.signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "ค้นหาไม่สำเร็จ");
      if (requestId === request.current) setResults(json.items);
    } catch (err) {
      if (requestId !== request.current || ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : "ค้นหาไม่สำเร็จ");
      setResults(null);
    } finally {
      if (requestId === request.current) setLoading(false);
    }
  }

  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ค้นหาชื่อเพลงหรือชื่อท่าเต้น"
          aria-label="คำค้นหา"
          style={{ width: "min(420px, 70%)" }}
        />{" "}
        <button type="submit" disabled={loading || !query.trim()}>
          ค้นหา
        </button>
      </form>

      <fieldset style={{ border: 0, padding: 0, margin: "0.5rem 0" }}>
        {MODES.map((m) => (
          <label key={m.value} style={{ marginRight: "1rem" }}>
            <input
              type="radio"
              name="mode"
              checked={mode === m.value}
              onChange={() => {
                setMode(m.value);
                if (results !== null || loading) search(m.value);
              }}
            />{" "}
            {m.label}
          </label>
        ))}
      </fieldset>

      {loading && <p>กำลังค้นหา…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && results?.length === 0 && <p>ไม่พบคลิปที่ตรงกับประเภทที่เลือก ลองเปลี่ยนคำค้นหาหรือเลือก “ทั้งหมด”</p>}

      {onAdd && results && results.length > 0 && (
        <p>
          <small>ปุ่ม “+ playlist” จะเพิ่มเข้า: {targetName ? `“${targetName}”` : "playlist ใหม่ (สร้างให้อัตโนมัติ)"}</small>
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
        {results?.map((v) => (
          <li key={v.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
            <button
              type="button"
              onClick={() => onSelect(v)}
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "flex-start",
                textAlign: "left",
                flex: 1,
                fontWeight: v.id === activeId ? 700 : 400,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={v.thumbnail} alt="" width={120} height={68} loading="lazy" />
              <span>
                {v.title}
                <br />
                <small>
                  {v.channel}
                  {v.durationSec > 0 ? ` · ${formatTime(v.durationSec)}` : ""}
                </small>
              </span>
            </button>
            {onToggleLike && <HeartButton liked={likedIds?.has(v.id) ?? false} onClick={() => onToggleLike(v)} />}
            {onAdd && (
              <button type="button" onClick={() => onAdd(v)} disabled={addedIds?.has(v.id)} style={{ whiteSpace: "nowrap" }}>
                {addedIds?.has(v.id) ? "✓ เพิ่มแล้ว" : "+ playlist"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
