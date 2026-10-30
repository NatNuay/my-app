// lib/auto-highlights.ts
// ดึงท่อนฮุคที่ระบบวิเคราะห์ให้ของคลิปที่กำลังเล่น (เรียก /api/youtube/highlights)
import { useEffect, useMemo, useState } from "react";
import { selectHighlightProposal, retainDisplayedHighlights } from "./audio-highlights";
import type { AutoSegment, HighlightsResponse } from "@/lib/highlight-analysis";

type Status = "idle" | "loading" | "ready" | "none" | "error";

interface Result {
  source?: HighlightsResponse["source"];
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
// Remember what was actually displayed, separately from raw source caches.
// Revisiting a clip must not change the winner just because a cache is faster.
const displayedCache = new Map<string, AutoSegment[]>();

export function useAutoHighlights(videoId: string | undefined): {
  status: Status;
  segments: AutoSegment[];
  reason?: string;
  audioStatus?: string;
  audioStage?: string;
} {
  const [audio, setAudio] = useState<{ id: string; segments: AutoSegment[]; pending: boolean; status: string; stage?: string; engine?: string }>({ id: "", segments: [], pending: false, status: "idle" });
  const [state, setState] = useState<State>({ status: "idle", segments: NO_SEGMENTS });
  const [shown, setShown] = useState<{ id?: string; segments: AutoSegment[] }>({ segments: NO_SEGMENTS });

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
        if (ac.signal.aborted) return;
        if (!data) throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${r.status}) ตรวจว่ามีไฟล์ app/api/youtube/highlights/route.ts`);
        if (!r.ok && !data.error) throw new Error(`เซิร์ฟเวอร์ตอบกลับ HTTP ${r.status}`);
        if (data.error) throw new Error(data.error);
        const result: Result = { source: data.source, segments: data.segments ?? NO_SEGMENTS, reason: data.reason };
        cache.set(videoId, result);
        setState({ id: videoId, status: result.segments.length > 0 ? "ready" : "none", ...result });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
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
        if (["queued", "processing", "busy"].includes(data.status) && Date.now() - started < (data.engine === "fast" ? 30000 : 210000)) {
          setAudio({ id: videoId!, segments: [], pending: true,
            engine: data.engine, stage: data.stage, status: data.status === "processing" ? (data.stage ?? "processing") : data.status });
          timer = setTimeout(poll, 2000);
          return;
        }
        setAudio({ id: videoId!, segments: data.status === "ready" && Array.isArray(data.segments) ? data.segments : [], pending: false, engine: data.engine, stage: data.stage, status: ["queued", "processing", "busy"].includes(data.status) ? "timeout" : data.reason === "timeout" ? "timeout" : data.status });
      } catch {
        if (!ac.signal.aborted) setAudio({ id: videoId!, segments: [], pending: false, status: "failed" });
      }
    }
    void poll();
    return () => { ac.abort(); clearTimeout(timer); };
  }, [videoId]);

  const proposed = useMemo(() => selectHighlightProposal(
    state.id === videoId ? state.segments : NO_SEGMENTS,
    audio.id === videoId ? audio.segments : NO_SEGMENTS,
    { pending: audio.id !== videoId || audio.pending,
      engine: audio.id === videoId ? audio.engine : undefined,
      source: state.id === videoId ? state.source : undefined },
  ), [videoId, state.id, state.segments, state.source, audio.id, audio.segments, audio.engine, audio.pending]);

  const previous = shown.id === videoId ? shown.segments : (videoId && displayedCache.get(videoId)) || NO_SEGMENTS;
  const segments = useMemo(() => retainDisplayedHighlights(previous, proposed), [previous, proposed]);
  useEffect(() => {
    if (!videoId) return;
    const accepted = retainDisplayedHighlights(displayedCache.get(videoId) ?? NO_SEGMENTS, proposed);
    if (accepted.length) {
      displayedCache.delete(videoId);
      displayedCache.set(videoId, accepted);
      if (displayedCache.size > 128) displayedCache.delete(displayedCache.keys().next().value!);
    }
    setShown(old => old.id === videoId && old.segments === accepted ? old : { id: videoId, segments: accepted });
  }, [videoId, proposed]);

  // Clip IDs isolate both pending source responses and the displayed snapshot.
  if (!videoId) return { status: "idle", segments: NO_SEGMENTS };
  const audioStatus = audio.id === videoId ? audio.status : undefined;
  const audioStage = audio.id === videoId ? audio.stage : undefined;
  if (segments.length) return { status: "ready", segments, audioStatus, audioStage };
  if (audio.id === videoId && audio.pending) return { status: "loading", segments: NO_SEGMENTS, audioStatus, audioStage };
  const fastEmpty = audio.id === videoId && audio.engine === "fast" && audio.status === "ready" && state.id === videoId && state.status !== "loading";
  return { status: fastEmpty ? "none" : state.id === videoId ? state.status : "loading", segments,
    reason: fastEmpty ? "fast-no-repeat" : state.id === videoId ? state.reason : undefined, audioStatus, audioStage };
}
