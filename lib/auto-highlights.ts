// lib/auto-highlights.ts
// ดึงท่อนฮุคที่ระบบวิเคราะห์ให้ของคลิปที่กำลังเล่น (เรียก /api/youtube/highlights)
import { useEffect, useState } from "react";
import { combineAudioHighlights } from "./audio-highlights";
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
  audioStatus?: string;
} {
  const [audio, setAudio] = useState<{ id: string; segments: AutoSegment[]; pending: boolean; status: string }>({ id: "", segments: [], pending: false, status: "idle" });
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
    fetch(`/api/youtube/highlights?v=${encodeURIComponent(videoId)}`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30000)]) })
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

  // Independent background analysis: playback never waits for the worker.
  useEffect(() => {
    if (!videoId) return;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setAudio({ id: videoId, segments: [], pending: true, status: "processing" });
    async function poll() {
      try {
        const r = await fetch(`/api/youtube/audio-highlights?v=${encodeURIComponent(videoId!)}`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(8000)]), cache: "no-store" });
        if (!r.ok) throw Error("Audio service unavailable");
        const data = await r.json();
        if (ac.signal.aborted) return;
        if (["queued", "processing", "busy"].includes(data.status) && Date.now() - started < 210000) {
          setAudio({ id: videoId!, segments: [], pending: true,
            status: data.status === "processing" ? (data.stage ?? "processing") : data.status });
          timer = setTimeout(poll, 2000);
          return;
        }
        setAudio({ id: videoId!, segments: data.status === "ready" && Array.isArray(data.segments) ? data.segments : [], pending: false, status: ["queued", "processing", "busy"].includes(data.status) ? "timeout" : data.reason === "timeout" ? "timeout" : data.status });
      } catch {
        if (!ac.signal.aborted) setAudio({ id: videoId!, segments: [], pending: false, status: "failed" });
      }
    }
    void poll();
    return () => { ac.abort(); clearTimeout(timer); };
  }, [videoId]);

  // ผลของคลิปก่อนหน้าต้องไม่โผล่ค้างตอนเปลี่ยนคลิป
  if (!videoId || (state.id !== videoId && audio.id !== videoId)) return { status: videoId ? "loading" : "idle", segments: NO_SEGMENTS };
  const audioSegments = audio.id === videoId ? audio.segments : [];
  const segments = combineAudioHighlights(state.id === videoId ? state.segments : NO_SEGMENTS, audioSegments);
  const audioStatus = audio.id === videoId ? audio.status : undefined;
  if (segments.length) return { status: "ready", segments, audioStatus };
  if (audio.id === videoId && audio.pending) return { status: "loading", segments: NO_SEGMENTS, audioStatus };
  return { status: state.id === videoId ? state.status : "loading", segments, reason: state.id === videoId ? state.reason : undefined, audioStatus };
}
