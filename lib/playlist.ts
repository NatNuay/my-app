// lib/playlist.ts
// จัดการ playlist ของผู้ใช้ เก็บใน localStorage ของเบราว์เซอร์ (ยังไม่มีระบบบัญชี/ฐานข้อมูล)
// ถ้าภายหลังมี backend แค่เปลี่ยนที่เก็บข้อมูลในไฟล์นี้ ส่วน UI ไม่ต้องแก้

import { useCallback, useEffect, useMemo, useState } from "react";
import type { VideoItem } from "./youtube";

export interface Playlist {
  id: string;
  name: string;
  items: VideoItem[];
  /** รูปปกที่ผู้ใช้ตั้งเอง (data URL) ถ้าไม่มีจะใช้ปกสุ่มจากคลิปใน playlist */
  cover?: string;
}

const STORAGE_KEY = "muverse:playlists";

/** วิธีเล่น: เรียงตามลำดับที่นำเข้า (วนซ้ำ) / สุ่ม (วนซ้ำ ไม่ซ้ำจนกว่าจะครบทุกเพลง) / วนซ้ำคลิปเดียว */
export type PlayMode = "sequential" | "shuffle" | "single";

/** playlist พิเศษ “ถูกใจ”: กดหัวใจที่คลิปไหนก็เข้ามาอยู่ที่นี่ทันที มีเสมอ ลบ/เปลี่ยนชื่อไม่ได้ */
export const LIKED_ID = "liked";
export const isLikedId = (id: string | null | undefined) => id === LIKED_ID;
const emptyLiked = (): Playlist => ({ id: LIKED_ID, name: "ถูกใจ", items: [] });

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isVideo(v: unknown): v is VideoItem {
  const o = v as VideoItem;
  return !!o && typeof o.id === "string" && typeof o.title === "string";
}

function isPlaylist(p: unknown): p is Playlist {
  const o = p as Playlist;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && Array.isArray(o.items);
}

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>(() => [emptyLiked()]);
  const [loaded, setLoaded] = useState(false);

  // อ่านครั้งเดียวหลัง mount (ไม่อ่านตอน render เพื่อกัน hydration ไม่ตรงกับฝั่งเซิร์ฟเวอร์)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const all = parsed.filter(isPlaylist).map((p) => ({ ...p, items: p.items.filter(isVideo) }));
          // ข้อมูลเก่าที่ยังไม่มี “ถูกใจ” จะถูกเติมให้ และ “ถูกใจ” อยู่หน้าสุดเสมอ
          const liked = all.find((p) => p.id === LIKED_ID) ?? emptyLiked();
          setPlaylists([{ ...liked, name: "ถูกใจ" }, ...all.filter((p) => p.id !== LIKED_ID)]);
        }
      }
    } catch {
      /* ข้อมูลเสียหรือ localStorage ใช้ไม่ได้ → เริ่มจากว่าง */
    }
    setLoaded(true);
  }, []);

  // บันทึกทุกครั้งที่เปลี่ยน (รอให้อ่านเสร็จก่อน ไม่งั้นจะเขียนทับของเดิมด้วยค่าว่าง)
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
    } catch {
      /* ignore */
    }
  }, [playlists, loaded]);

  const createPlaylist = useCallback((name: string): string => {
    const id = newId();
    setPlaylists((prev) => [...prev, { id, name: name.trim() || `Playlist ${prev.length}`, items: [] }]); // prev.length นับ “ถูกใจ” อยู่แล้ว จึงไม่ต้อง +1
    return id;
  }, []);

  const renamePlaylist = useCallback((id: string, name: string) => {
    const next = name.trim();
    if (!next || id === LIKED_ID) return;
    setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, name: next } : p)));
  }, []);

  const setCover = useCallback((id: string, cover?: string) => {
    if (id === LIKED_ID) return; // “ถูกใจ” ใช้ปกหัวใจประจำ
    setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, cover } : p)));
  }, []);

  const deletePlaylist = useCallback((id: string) => {
    if (id === LIKED_ID) return;
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // คลิปเดียวกันไม่ใส่ซ้ำใน playlist เดียวกัน
  const addTrack = useCallback((playlistId: string, video: VideoItem) => {
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === playlistId && !p.items.some((v) => v.id === video.id) ? { ...p, items: [...p.items, video] } : p,
      ),
    );
  }, []);

  const removeTrack = useCallback((playlistId: string, videoId: string) => {
    setPlaylists((prev) =>
      prev.map((p) => (p.id === playlistId ? { ...p, items: p.items.filter((v) => v.id !== videoId) } : p)),
    );
  }, []);

  const moveTrack = useCallback((playlistId: string, index: number, direction: -1 | 1) => {
    setPlaylists((prev) =>
      prev.map((p) => {
        const to = index + direction;
        if (p.id !== playlistId || to < 0 || to >= p.items.length) return p;
        const items = [...p.items];
        [items[index], items[to]] = [items[to], items[index]];
        return { ...p, items };
      }),
    );
  }, []);

  // กดหัวใจ: ยังไม่มี → เพิ่มเข้า “ถูกใจ”, มีแล้ว → เอาออก
  const toggleLike = useCallback((video: VideoItem) => {
    setPlaylists((prev) =>
      prev.map((p) => {
        if (p.id !== LIKED_ID) return p;
        return p.items.some((v) => v.id === video.id)
          ? { ...p, items: p.items.filter((v) => v.id !== video.id) }
          : { ...p, items: [...p.items, video] };
      }),
    );
  }, []);

  const likedIds = useMemo(
    () => new Set(playlists.find((p) => p.id === LIKED_ID)?.items.map((v) => v.id) ?? []),
    [playlists],
  );

  return {
    playlists,
    likedIds,
    createPlaylist,
    renamePlaylist,
    setCover,
    deletePlaylist,
    addTrack,
    removeTrack,
    moveTrack,
    toggleLike,
  };
}
