// app/api/youtube/highlights/route.ts
// หา "ท่อนฮุค" ของคลิปเต้นตามแบบอัตโนมัติ (ตรรกะอยู่ใน lib/highlight-analysis.ts)
//
// chapter ของคลิป -> รายการแบ่งท่อนในคอมเมนต์ -> เนื้อเพลงซ้ำพร้อมหลักฐานจัดเวลา
// โควตา YouTube ต่อคลิปใหม่ไม่เกิน 4 หน่วย (videos 1 + comments ไม่เกิน 3 หน้า) ผลถูกแคชไว้
// เนื้อเพลงใช้คำนวณเวลาเท่านั้น ไม่ถูกส่งไปที่เบราว์เซอร์และไม่ถูกเก็บ
// หมายเหตุ: ไฟล์นี้ต้องอยู่ที่ app/api/youtube/highlights/route.ts (คนละโฟลเดอร์กับ search/route.ts)
import { chapterHighlights, inferChorusOffset, lyricQueries } from "@/lib/highlight-sources";
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
      (typeof r.syncedLyrics === "string" || r.syncedLyrics == null));
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

  const offsetParam = req.nextUrl.searchParams.get("offset");
  const offset = offsetParam === null ? null : Number(offsetParam);
  if (offsetParam !== null && (!offsetParam.trim() || !Number.isFinite(offset) || Math.abs(offset!) > 120)) {
    return NextResponse.json({ error: "ระยะเลื่อนเวลาต้องเป็นตัวเลขระหว่าง -120 ถึง 120 วินาที" }, { status: 400 });
  }

  const listedResponse = (segments: HighlightsResponse["segments"], source: "chapters" | "comments", duration: number) => respond({
    eligible: true, source, appliedOffset: offset ?? 0,
    segments: segments.map((segment) => ({ ...segment,
      start: Math.max(0, segment.start + (offset ?? 0)), end: Math.min(duration, segment.end + (offset ?? 0)),
      confidence: offset ? "medium" as const : segment.confidence,
      evidence: segment.evidence + (offset ? ` · ผู้ใช้เลื่อนเวลา ${offset} วินาที` : ""),
    })).filter((s) => s.end - s.start >= 1),
  });

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

    // คลิปทุกประเภทใช้ chapter และการกำหนดเองได้ ไม่ตัดสิทธิ์ด้วย keyword ในชื่อ
    const comments: CommentInput[] = [];
    const uploaderSegments = chapterHighlights(description, [], duration);
    if (uploaderSegments.length) return listedResponse(uploaderSegments, "chapters", duration);

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
    if (listedSegments.length) return listedResponse(listedSegments, "comments", duration);

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
    if (!successfulQueries) return NextResponse.json({ error: "บริการค้นหาเนื้อเพลงไม่พร้อมใช้งาน กรุณาลองอีกครั้ง หรือกำหนดช่วงฮุคเอง" }, { status: 503 });
    if (match.status === "none") return respond({ eligible: true, reason: "no-lyrics", segments: [] });
    if (match.status === "mismatch") return respond({ eligible: true, reason: "duration-mismatch", segments: [] });

    // 3) ท่อนที่เนื้อเพลงวนซ้ำ = ท่อนฮุค
    const occurrences = detectChorus(match.lines);
    if (occurrences.length < 2) return respond({ eligible: true, reason: "no-chorus", segments: [] });

    const inferredOffset = inferChorusOffset(occurrences, [description, ...comments.map((c) => c.text)], duration);
    const appliedOffset = offset ?? inferredOffset ?? 0;
    if (match.status === "alignment" && offset === null && inferredOffset === undefined) {
      return respond({ eligible: true, reason: "alignment-required", segments: [], alignment: {
        songDuration: match.record.duration, clipDuration: duration, firstChorusStart: occurrences[0].start,
      } });
    }
    const aligned = occurrences.map((o) => ({ start: o.start + appliedOffset, end: o.end + appliedOffset }));

    const segments = buildChorusSegments(aligned, comments, parseChapters(description, duration), duration);
    if (offset !== null || inferredOffset !== undefined) for (const segment of segments) {
      segment.confidence = "medium";
      segment.evidence += ` · เลื่อนเวลา ${appliedOffset.toFixed(2)} วินาทีจาก${offset !== null ? "ค่าที่ผู้ใช้กำหนด" : "ไทม์สแตมป์ฮุคหลายตำแหน่ง"} (ยังไม่ได้เทียบเสียงหรือภาพ)`;
    }
    return respond({ eligible: true, segments, appliedOffset, source: "lyrics" });
  } catch {
    return NextResponse.json({ error: "วิเคราะห์ไม่สำเร็จ" }, { status: 502 });
  }
}
