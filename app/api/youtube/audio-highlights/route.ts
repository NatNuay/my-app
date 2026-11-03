import { NextRequest, NextResponse } from "next/server";
import { audioChoruses } from "@/lib/audio-highlights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const workerReasons = new Set(["timeout", "download-timeout", "download-failed", "download-rejected",
  "decode-timeout", "decode-failed", "dependency-missing", "tool-missing", "analysis-failed"]);

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return NextResponse.json({ error: "id คลิปไม่ถูกต้อง" }, { status: 400 });
  const service = process.env.AUDIO_ANALYSIS_URL;
  if (!service) return NextResponse.json({ status: "disabled", segments: [] });
  let failureReason = "worker-configuration";
  try {
    const url = new URL(service);
    if (!["http:", "https:"].includes(url.protocol)) throw Error("Invalid service URL");
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!local && (url.protocol !== "https:" || !process.env.AUDIO_ANALYSIS_TOKEN)) throw Error("Remote service requires HTTPS and token");
    url.pathname = `/jobs/${videoId}`;
    url.search = "";
    failureReason = "worker-unreachable";
    const response = await fetch(url, { method: "POST", cache: "no-store",
      signal: AbortSignal.timeout(5000), redirect: "error",
      headers: process.env.AUDIO_ANALYSIS_TOKEN ? { Authorization: `Bearer ${process.env.AUDIO_ANALYSIS_TOKEN}` } : {} });
    if (response.status === 429) {
      const busy = await response.json().catch(() => ({}));
      return NextResponse.json({ status: "busy", ...(busy.engine === "fast" ? { engine: "fast" } : {}), segments: [] });
    }
    if (!response.ok) {
      failureReason = response.status === 401 || response.status === 403 ? "worker-auth" : "worker-unavailable";
      throw Error("Service unavailable");
    }
    failureReason = "worker-response";
    const data = await response.json();
    if (!["queued", "processing", "ready", "failed"].includes(data.status)) throw Error("Invalid job status");
    const engine = data.engine === "fast" ? "fast" : "full";
    return NextResponse.json({ status: data.status, engine,
      ...(["processing", "failed"].includes(data.status) && ["downloading", "decoding", "separating", "features", "loading-model", "analyzing"].includes(data.stage) ? { stage: data.stage } : {}),
      ...(data.status === "failed" && workerReasons.has(data.reason) ? { reason: data.reason } : {}),
      segments: data.status === "ready" ? audioChoruses(data.segments, engine) : [] });
  } catch {
    // Optional audio worker errors must not break existing metadata highlights.
    return NextResponse.json({ status: "failed", reason: failureReason, segments: [] });
  }
}
