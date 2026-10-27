// lib/auto-highlights.ts
// ดึงท่อนฮุคที่ระบบวิเคราะห์ให้ของคลิปที่กำลังเล่น (เรียก /api/youtube/highlights)
import { useEffect, useState } from "react";
import type { AutoSegment, HighlightsResponse } from "@/lib/highlight-analysis";

type Status = "idle" | "loading" | "ready" | "none" | "error";

interface Result {
  segments: AutoSegment[];
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
} {
  const [state, setState] = useState<State>({ status: "idle", segments: NO_SEGMENTS });

  useEffect(() => {
    if (!videoId) return;
    const cached = cache.get(videoId);
    if (cached) {
      setState({ id: videoId, status: cached.segments.length > 0 ? "ready" : "none", ...cached });
      return;
    }
    setState({ id: videoId, status: "loading", segments: NO_SEGMENTS });
    const ac = new AbortController();
    fetch(`/api/youtube/highlights?v=${encodeURIComponent(videoId)}`, { signal: ac.signal })
      .then(async (r) => {
        const data = (await r.json().catch(() => null)) as (HighlightsResponse & { error?: string }) | null;
        if (!data) throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${r.status}) ตรวจว่ามีไฟล์ app/api/youtube/highlights/route.ts`);
        if (!r.ok && !data.error) throw new Error(`เซิร์ฟเวอร์ตอบกลับ HTTP ${r.status}`);
        if (data.error) throw new Error(data.error);
        const result: Result = { segments: data.segments ?? NO_SEGMENTS, reason: data.reason };
        cache.set(videoId, result);
        setState({ id: videoId, status: result.segments.length > 0 ? "ready" : "none", ...result });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const reason = err instanceof Error ? err.message : "ไม่ทราบสาเหตุ";
        setState({ id: videoId, status: "error", segments: NO_SEGMENTS, reason });
      });
    return () => ac.abort();
  }, [videoId]);

  // ผลของคลิปก่อนหน้าต้องไม่โผล่ค้างตอนเปลี่ยนคลิป
  if (!videoId || state.id !== videoId) return { status: videoId ? "loading" : "idle", segments: NO_SEGMENTS };
  return { status: state.status, segments: state.segments, reason: state.reason };
}
