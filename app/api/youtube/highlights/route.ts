// app/api/youtube/highlights/route.ts
// หา "ท่อนฮุค" ของคลิปเต้นตามแบบอัตโนมัติ (ตรรกะอยู่ใน lib/highlight-analysis.ts)
//
// chapter ของคลิป -> รายการแบ่งท่อนในคอมเมนต์ -> เนื้อเพลงซ้ำพร้อมหลักฐานจัดเวลา
// โควตา YouTube ต่อคลิปใหม่ไม่เกิน 4 หน่วย (videos 1 + comments ไม่เกิน 3 หน้า) ผลถูกแคชไว้
// เนื้อเพลงใช้คำนวณเวลาเท่านั้น ไม่ถูกส่งไปที่เบราว์เซอร์และไม่ถูกเก็บ
// หมายเหตุ: ไฟล์นี้ต้องอยู่ที่ app/api/youtube/highlights/route.ts (คนละโฟลเดอร์กับ search/route.ts)
import { chapterHighlights, inferChorusOffset, inferLyricOffset, lyricQueries, mergeHighlights } from "@/lib/highlight-sources";
import { NextRequest, NextResponse } from "next/server";
import {
  buildChorusSegments,
  cleanSongTitle,
  detectChorus,
  matchLyrics,
  parseChapters,
  type CommentInput,
  type HighlightsResponse,
  type LrclibRecord,
} from "@/lib/highlight-analysis";

const YT_API = "https://www.googleapis.com/youtube/v3";
const LRCLIB_API = "https://lrclib.net/api";
const YT_CACHE_SECONDS = 86400;
const LYRICS_CACHE_SECONDS = 604800; // เนื้อเพลงไม่เปลี่ยนบ่อย แคช 7 วัน
const COMMENT_PAGES = 3; // 3 หน้า x 100 = คอมเมนต์ที่เกี่ยวข้องที่สุดราว 300 รายการ

async function ytJson(path: string, params: Record<string, string>, key: string) {
  const url = new URL(`${YT_API}/${path}`);
  url.search = new URLSearchParams({ ...params, key }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), next: { revalidate: YT_CACHE_SECONDS } });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, json };
}

function parseDuration(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** ค้นหาเนื้อเพลงใน LRCLIB แยกบริการล่มออกจากการไม่พบเพลง */
async function searchLyrics(query: string): Promise<LrclibRecord[] | null> {
  try {
    const res = await fetch(`${LRCLIB_API}/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Muverse/0.1 (dance practice web app)" },
      next: { revalidate: LYRICS_CACHE_SECONDS },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return null;
    return data.filter((r): r is LrclibRecord => !!r && typeof r.trackName === "string" &&
      typeof r.artistName === "string" && typeof r.duration === "number" &&
      (typeof r.syncedLyrics === "string" || r.syncedLyrics == null) &&
      (typeof r.plainLyrics === "string" || r.plainLyrics == null));
  } catch {
    return null;
  }
}

function respond(body: HighlightsResponse) {
  return NextResponse.json(body);
}

export async function GET(req: NextRequest) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return NextResponse.json({ error: "ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY" }, { status: 500 });

  const videoId = req.nextUrl.searchParams.get("v") ?? "";
  if (!/^[\w-]{11}$/.test(videoId)) return NextResponse.json({ error: "id คลิปไม่ถูกต้อง" }, { status: 400 });

  if (req.nextUrl.searchParams.has("offset")) {
    return NextResponse.json({ error: "ไฮไลท์รองรับการตรวจจับอัตโนมัติเท่านั้น" }, { status: 400 });
  }
  const listedResponse = (segments: HighlightsResponse["segments"], source: "chapters" | "comments") =>
    respond({ eligible: true, source, segments });

  try {
    // 1) ข้อมูลคลิป
    const detail = await ytJson("videos", { part: "snippet,contentDetails", id: videoId }, key);
    const item = detail.json?.items?.[0];
    if (!detail.ok) return NextResponse.json({ error: "YouTube ไม่สามารถส่งข้อมูลคลิปได้ กรุณาตรวจโควตาและสิทธิ์ API" }, { status: detail.json?.error?.code === 403 ? 503 : 502 });
    if (!item) return respond({ eligible: false, reason: "not-found", segments: [] });

    const title: string = item.snippet?.title ?? "";
    const description: string = item.snippet?.description ?? "";
    const tags: string[] = item.snippet?.tags ?? [];
    const channel: string = item.snippet?.channelTitle ?? "";
    const duration = parseDuration(item.contentDetails?.duration);

    if (!Number.isFinite(duration) || duration <= 0) return respond({ eligible: false, reason: "duration", segments: [] });

    // คลิปทุกประเภทใช้ chapter ได้ ไม่ตัดสิทธิ์ด้วย keyword ในชื่อ
    const comments: CommentInput[] = [];
    const uploaderSegments = chapterHighlights(description, [], duration);

    // ไม่ผูกการอ่านรายการแบ่งท่อนในคอมเมนต์กับการหาเนื้อเพลงสำเร็จ
    let pageToken = "";
    for (let page = 0; page < COMMENT_PAGES; page++) {
      try {
        const r = await ytJson("commentThreads", {
          part: "snippet", videoId, order: "relevance", maxResults: "100", textFormat: "plainText",
          ...(pageToken ? { pageToken } : {}),
        }, key);
        if (!r.ok) break;
        for (const t of r.json?.items ?? []) {
          const c = t.snippet?.topLevelComment?.snippet;
          if (c?.textDisplay) comments.push({ text: c.textDisplay, likes: Number(c.likeCount ?? 0) });
        }
        pageToken = r.json?.nextPageToken ?? "";
        if (!pageToken) break;
      } catch { break; } // comments are optional; failure must not prevent lyric analysis
    }
    const listedSegments = chapterHighlights(description, comments, duration);
    const metadataSource = uploaderSegments.length ? "chapters" as const : "comments" as const;
    const fallback = (reason: string) => listedSegments.length
      ? listedResponse(listedSegments, metadataSource)
      : respond({ eligible: true, reason, segments: [] });

    // 2) เนื้อเพลงที่มีเวลากำกับ ที่ตรงกับคลิป (ชื่อ + ความยาว)
    const records: LrclibRecord[] = [];
    const extraText = `${channel} ${tags.join(" ")} ${description.slice(0, 300)}`;
    let successfulQueries = 0;
    let match = matchLyrics(records, title, extraText, duration);
    for (const query of lyricQueries(title, cleanSongTitle(title))) {
      const result = await searchLyrics(query);
      if (result === null) continue;
      successfulQueries++;
      records.push(...result);
      match = matchLyrics(records, title, extraText, duration);
      if (match.status === "ok" || match.status === "alignment") break;
    }
    if (!successfulQueries && listedSegments.length) return listedResponse(listedSegments, metadataSource);
    if (!successfulQueries) return NextResponse.json({ error: "บริการค้นหาเนื้อเพลงไม่พร้อมใช้งาน กรุณาลองอีกครั้ง" }, { status: 503 });
    if (match.status === "none") return fallback("no-lyrics");
    if (match.status === "mismatch") return fallback("duration-mismatch");
    if (match.status === "untimed") return fallback("untimed-lyrics");

    // 3) ท่อนที่เนื้อเพลงวนซ้ำ = ท่อนฮุค
    const occurrences = detectChorus(match.lines, match.record.trackName, match.record.artistName);
    if (occurrences.length < 2) return fallback("no-chorus");

    const texts = [description, ...comments.map((c) => c.text)];
    const chorusOffset = inferChorusOffset(occurrences, texts, duration);
    const lyricOffset = inferLyricOffset(match.lines, texts, duration);
    const conflicting = chorusOffset !== undefined && lyricOffset !== undefined && Math.abs(chorusOffset - lyricOffset) > 3;
    const inferredOffset = conflicting ? undefined : lyricOffset ?? chorusOffset;
    const appliedOffset = inferredOffset ?? 0;
    if (conflicting || (match.status === "alignment" && inferredOffset === undefined)) {
      return fallback("alignment-required");
    }
    const aligned = occurrences.map((o) => ({ start: o.start + appliedOffset, end: o.end + appliedOffset }));

    const segments = buildChorusSegments(aligned, comments, parseChapters(description, duration), duration);
    if (inferredOffset !== undefined) for (const segment of segments) {
      segment.confidence = "medium";
      segment.evidence += ` · เลื่อนเวลา ${appliedOffset.toFixed(2)} วินาทีจาก${lyricOffset !== undefined ? "ไทม์สแตมป์ที่อ้างเนื้อร้อง" : "ไทม์สแตมป์ฮุค"}หลายตำแหน่ง (ยังไม่ได้เทียบเสียงหรือภาพ)`;
    }
    const combined = mergeHighlights(listedSegments, segments);
    return respond({ eligible: true, segments: combined, appliedOffset,
      source: listedSegments.length ? (combined.length > listedSegments.length ? "mixed" : metadataSource) : "lyrics" });
  } catch {
    return NextResponse.json({ error: "วิเคราะห์ไม่สำเร็จ" }, { status: 502 });
  }
}
