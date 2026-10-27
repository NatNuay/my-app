// lib/auto-highlights.ts
// ดึงท่อนฮุคที่ระบบวิเคราะห์ให้ของคลิปที่กำลังเล่น (เรียก /api/youtube/highlights)
import { useEffect, useState } from "react";
import type { AutoSegment, HighlightsResponse } from "@/lib/highlight-analysis";

type Status = "idle" | "loading" | "ready" | "none" | "error";

interface Result {
  segments: AutoSegment[];
  appliedOffset?: number;
  alignment?: HighlightsResponse["alignment"];
  reason?: string; // เหตุผลที่ไม่มีท่อน (เช่น tutorial, aerobic) หรือข้อความ error
}
interface State extends Result {
  id?: string;
  status: Status;
}

// จำผลไว้ตลอดการใช้งานหน้านี้ เปิดคลิปเดิมซ้ำไม่ต้องรอ/ไม่ต้องยิง API อีก
const cache = new Map<string, Result>();
const NO_SEGMENTS: AutoSegment[] = [];

export function useAutoHighlights(videoId: string | undefined): {
  status: Status;
  segments: AutoSegment[];
  reason?: string;
  appliedOffset?: number;
  alignment?: HighlightsResponse["alignment"];
  offset?: number;
  setOffset: (offset: number | undefined) => void;
} {
  const [offsets, setOffsets] = useState<Record<string, number | undefined>>({});
  const [offsetsLoaded, setOffsetsLoaded] = useState(false);
  useEffect(() => {
    try {
      const data: unknown = JSON.parse(localStorage.getItem("muverse:highlight-offsets") ?? "{}");
      if (data && typeof data === "object" && !Array.isArray(data)) setOffsets(Object.fromEntries(Object.entries(data)
        .filter(([id, value]) => /^[\w-]{11}$/.test(id) && typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 120)));
    } catch { /* no saved offsets */ }
    setOffsetsLoaded(true);
  }, []);
  useEffect(() => {
    if (offsetsLoaded) try { localStorage.setItem("muverse:highlight-offsets", JSON.stringify(offsets)); } catch { /* playback still works */ }
  }, [offsets, offsetsLoaded]);
  const offset = videoId ? offsets[videoId] : undefined;
  const requestId = videoId ? `${videoId}:${offset ?? "auto"}` : undefined;
  const setOffset = (value: number | undefined) => {
    if (videoId) setOffsets((old) => ({ ...old, [videoId]: value }));
  };
  const controls = { offset, setOffset };
  const [state, setState] = useState<State>({ status: "idle", segments: NO_SEGMENTS });

  useEffect(() => {
    if (!videoId || !offsetsLoaded) return;
    const cached = cache.get(requestId!);
    if (cached) {
      setState({ id: requestId, status: cached.segments.length > 0 ? "ready" : "none", ...cached });
      return;
    }
    setState({ id: requestId, status: "loading", segments: NO_SEGMENTS });
    const ac = new AbortController();
    fetch(`/api/youtube/highlights?v=${encodeURIComponent(videoId)}${offset === undefined ? "" : `&offset=${offset}`}`, { signal: ac.signal })
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as (HighlightsResponse & { error?: string }) | null;
        if (!data) throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${r.status}) ตรวจว่ามีไฟล์ app/api/youtube/highlights/route.ts`);
        if (!r.ok && !data.error) throw new Error(`เซิร์ฟเวอร์ตอบกลับ HTTP ${r.status}`);
        if (data.error) throw new Error(data.error);
        const result: Result = { segments: data.segments ?? NO_SEGMENTS, reason: data.reason, alignment: data.alignment, appliedOffset: data.appliedOffset };
        cache.set(requestId!, result);
        setState({ id: requestId, status: result.segments.length > 0 ? "ready" : "none", ...result });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const reason = err instanceof Error ? err.message : "ไม่ทราบสาเหตุ";
        setState({ id: requestId, status: "error", segments: NO_SEGMENTS, reason });
      });
    return () => ac.abort();
  }, [videoId, offset, requestId, offsetsLoaded]);

  // ผลของคลิปก่อนหน้าต้องไม่โผล่ค้างตอนเปลี่ยนคลิป
  if (!videoId || state.id !== requestId) return { status: videoId ? "loading" : "idle", segments: NO_SEGMENTS, ...controls };
  return { status: state.status, segments: state.segments, reason: state.reason, alignment: state.alignment, appliedOffset: state.appliedOffset, ...controls };
}
