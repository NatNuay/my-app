"use client";
// components/playlist-panel.tsx
// หน้า playlist สไตล์คลังเพลง:
//   1) รายการ playlist ทั้งหมด (ปก + ชื่อ + จำนวนคลิป) กดเพื่อเข้าไปดู
//   2) หน้ารายละเอียด: เปลี่ยนปก/ชื่อ, เล่นทั้งหมด, เรียง/ลบเพลง
// ปก: ผู้ใช้อัปโหลดเองได้ ถ้าไม่ตั้งจะสุ่มใช้ภาพจากคลิปหนึ่งใน playlist (คงที่ ไม่เปลี่ยนทุกครั้งที่เปิดหน้า)

import { useRef, useState } from "react";
import HeartButton from "@/components/heart-button";
import { formatTime, type VideoItem } from "@/lib/youtube";
import { isLikedId, type PlayMode, type Playlist } from "@/lib/playlist";
import "./playlist-panel.css";

interface Props {
  playlists: Playlist[];
  selected: Playlist | null;
  /** id คลิปที่กำลังเล่น ใช้ไฮไลต์เฉพาะเมื่อกำลังเล่นจาก playlist ที่เลือกอยู่ */
  playingId?: string;
  playingFromSelected: boolean;
  /** id คลิปที่กดหัวใจไว้แล้ว */
  likedIds: Set<string>;
  onToggleLike: (video: VideoItem) => void;
  mode: PlayMode;
  onModeChange: (mode: PlayMode) => void;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  /** ตั้งปก (data URL) หรือส่ง undefined เพื่อกลับไปใช้ปกสุ่ม */
  onSetCover: (id: string, cover?: string) => void;
  onDelete: (id: string) => void;
  onPlay: (video: VideoItem) => void;
  onRemove: (videoId: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}

// ---------- ไอคอน ----------
const PlayIcon = ({ size = 28 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const MinusIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);
const HeartFilled = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
  </svg>
);

// ---------- ปก ----------
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** เลือกคลิปที่ใช้เป็นปกสุ่ม: คงที่ตาม id ของ playlist (ไม่กระพริบเปลี่ยนทุกครั้งที่ render) */
function coverSource(p: Playlist): string | null {
  if (p.cover) return p.cover;
  if (p.items.length === 0) return null;
  return p.items[hash(p.id) % p.items.length].thumbnail || null;
}

function Cover({ playlist, size }: { playlist: Playlist; size: number }) {
  const box = { width: size, height: size };
  if (isLikedId(playlist.id)) {
    return (
      <span className="pl-cover pl-cover--liked" style={box}>
        <HeartFilled size={Math.round(size * 0.45)} />
      </span>
    );
  }
  const src = coverSource(playlist);
  if (!src) {
    return (
      <span className="pl-cover pl-cover--empty" style={box} aria-hidden="true">
        <svg viewBox="0 0 24 24" width={size * 0.4} height={size * 0.4} fill="currentColor">
          <path d="M9 18V6l10-2v12.2A3 3 0 1 1 17 14V7.6L11 8.8V18a3 3 0 1 1-2-2.8z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="pl-cover" style={box}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" />
    </span>
  );
}

/** ย่อรูปที่ผู้ใช้เลือกเป็นสี่เหลี่ยมจัตุรัส 320px (ตัดกลางภาพ) เพื่อไม่ให้ localStorage เต็ม */
async function fileToCover(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));
      el.src = url;
    });
    const SIZE = 320;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("เบราว์เซอร์นี้ย่อรูปไม่ได้");
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function PlaylistPanel({
  playlists,
  selected,
  playingId,
  playingFromSelected,
  likedIds,
  onToggleLike,
  mode,
  onModeChange,
  onSelect,
  onCreate,
  onRename,
  onSetCover,
  onDelete,
  onPlay,
  onRemove,
  onMove,
}: Props) {
  const [newName, setNewName] = useState("");
  const [open, setOpen] = useState(false); // false = หน้ารายการ playlist, true = หน้ารายละเอียดของ selected
  const fileRef = useRef<HTMLInputElement>(null);

  const detail = open ? selected : null;
  const isLiked = isLikedId(detail?.id);

  async function handleCoverFile(file: File | undefined) {
    if (!file || !detail) return;
    try {
      onSetCover(detail.id, await fileToCover(file));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "ตั้งปกไม่สำเร็จ");
    }
  }

  // ---------- หน้ารายละเอียด ----------
  if (detail) {
    const totalSec = detail.items.reduce((sum, v) => sum + v.durationSec, 0);
    return (
      <section>
        <button type="button" className="pl-back" onClick={() => setOpen(false)}>
          ← Playlist ทั้งหมด
        </button>

        <div className="pl-head">
          <Cover playlist={detail} size={160} />
          <div className="pl-head-info">
            <small>เพลย์ลิสต์</small>
            <h3>{detail.name}</h3>
            <small>
              {detail.items.length} คลิป{totalSec > 0 ? ` · ${formatTime(totalSec)}` : ""}
            </small>
          </div>
        </div>

        <div className="pl-actions">
          <button
            type="button"
            className="pl-play-all"
            disabled={detail.items.length === 0}
            onClick={() => onPlay(detail.items[0])}
            aria-label="เล่นทั้งหมด"
            title="เล่นทั้งหมด"
          >
            <PlayIcon size={26} />
          </button>
          {/* วิธีเล่น: เรียง / สุ่มไม่ซ้ำจนกว่าจะครบทุกเพลง / วนซ้ำคลิปเดียว (ทุกแบบวนไม่จบ) */}
          <span className="pl-mode" role="group" aria-label="วิธีเล่น">
            {(
              [
                ["sequential", "วนซ้ำแบบเรียง"],
                ["shuffle", "วนซ้ำแบบสุ่ม"],
                ["single", "วนซ้ำคลิปเดียว"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={(e) => {
                  onModeChange(value);
                  e.currentTarget.blur(); // คืนโฟกัสให้คีย์ลัดของเครื่องเล่นใช้ต่อได้
                }}
              >
                {label}
              </button>
            ))}
          </span>

          {/* “ถูกใจ” เป็น playlist ระบบ: ปกเป็นหัวใจประจำ เปลี่ยนปก/ชื่อ/ลบไม่ได้ */}
          {!isLiked && (
            <>
              <button type="button" onClick={() => fileRef.current?.click()}>
                เปลี่ยนปก
              </button>
              {detail.cover && (
                <button type="button" onClick={() => onSetCover(detail.id, undefined)}>
                  ใช้ปกสุ่มจากคลิป
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const name = window.prompt("ชื่อ playlist ใหม่", detail.name);
                  if (name) onRename(detail.id, name);
                }}
              >
                เปลี่ยนชื่อ
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`ลบ playlist “${detail.name}” ?`)) {
                    onDelete(detail.id);
                    setOpen(false);
                  }
                }}
              >
                ลบ playlist
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void handleCoverFile(e.target.files?.[0]);
                  e.target.value = ""; // เลือกไฟล์เดิมซ้ำได้
                }}
              />
            </>
          )}
        </div>

        {detail.items.length === 0 ? (
          <p>{isLiked ? "ยังไม่มีคลิปที่กดถูกใจ กดหัวใจที่คลิปได้เลย" : "playlist นี้ยังว่าง ค้นหาแล้วกด “+ playlist” ที่คลิปที่ต้องการ"}</p>
        ) : (
          <ol className="pl-tracks">
            {detail.items.map((v, i) => {
              const isPlaying = playingFromSelected && v.id === playingId;
              return (
                <li key={v.id} className={`pl-row ${isPlaying ? "is-playing" : ""}`}>
                  <span className="pl-num">{i + 1}</span>

                  {/* ปุ่มเล่น = สามเหลี่ยมบนปกคลิป */}
                  <span className="pl-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.thumbnail} alt="" loading="lazy" />
                    <button type="button" className="pl-thumb-play" onClick={() => onPlay(v)} aria-label={`เล่น ${v.title}`} title="เล่น">
                      <PlayIcon />
                    </button>
                  </span>

                  <span className="pl-title">
                    {v.title}
                    <br />
                    <span className="pl-meta">
                      {v.channel}
                      {v.durationSec > 0 ? ` · ${formatTime(v.durationSec)}` : ""}
                    </span>
                  </span>

                  <span className="pl-row-actions">
                    <button type="button" className="pl-icon-btn" onClick={() => onMove(i, -1)} disabled={i === 0} aria-label="เลื่อนขึ้น">
                      ↑
                    </button>
                    <button
                      type="button"
                      className="pl-icon-btn"
                      onClick={() => onMove(i, 1)}
                      disabled={i === detail.items.length - 1}
                      aria-label="เลื่อนลง"
                    >
                      ↓
                    </button>
                    <HeartButton liked={likedIds.has(v.id)} onClick={() => onToggleLike(v)} />
                    {/* ใน “ถูกใจ” หัวใจทำหน้าที่เอาออกอยู่แล้ว จึงไม่ต้องมีปุ่มลบซ้ำ */}
                    {!isLiked && (
                      <button type="button" className="pl-icon-btn" onClick={() => onRemove(v.id)} aria-label="ลบออกจาก playlist" title="ลบออกจาก playlist">
                        <MinusIcon />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    );
  }

  // ---------- หน้ารายการ playlist ----------
  return (
    <section>
      <h2>Playlist</h2>

      <form
        className="pl-create"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(newName);
          setNewName("");
          (document.activeElement as HTMLElement | null)?.blur(); // คืนโฟกัสให้คีย์ลัดของเครื่องเล่น
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="ชื่อ playlist ใหม่"
          aria-label="ชื่อ playlist ใหม่"
        />
        <button type="submit">สร้าง playlist</button>
      </form>

      {playlists.every((p) => isLikedId(p.id)) && (
        <p>ยังไม่มี playlist ของคุณ ตั้งชื่อแล้วกด “สร้าง playlist” หรือกด “+ playlist” ที่คลิปเพื่อสร้างอัตโนมัติ (กดหัวใจที่คลิปเพื่อเก็บเข้า “ถูกใจ”)</p>
      )}

      <ul className="pl-lib">
        {playlists.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="pl-lib-row"
              onClick={() => {
                onSelect(p.id);
                setOpen(true);
              }}
            >
              <Cover playlist={p} size={64} />
              <span>
                <span className="pl-lib-name">{p.name}</span>
                <br />
                <span className="pl-lib-sub">เพลย์ลิสต์ • {p.items.length} คลิป</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
