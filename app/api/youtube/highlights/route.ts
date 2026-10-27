// app/api/youtube/highlights/route.ts
// หา "ท่อนฮุค" ของคลิปเต้นตามแบบอัตโนมัติ (ตรรกะอยู่ใน lib/highlight-analysis.ts)
//
// ขั้นตอน: ข้อมูลคลิป (YouTube) -> เนื้อเพลงที่มีเวลากำกับ (LRCLIB) -> หาบล็อกที่เนื้อเพลงวนซ้ำ -> ยืนยันด้วยคอมเมนต์
// โควตา YouTube ต่อคลิปใหม่ ~4 หน่วย (videos 1 + comments 3 เฉพาะเมื่อเจอท่อนฮุค) ผลถูกแคชไว้
// เนื้อเพลงใช้คำนวณเวลาเท่านั้น ไม่ถูกส่งไปที่เบราว์เซอร์และไม่ถูกเก็บ
// หมายเหตุ: ไฟล์นี้ต้องอยู่ที่ app/api/youtube/highlights/route.ts (คนละโฟลเดอร์กับ search/route.ts)
import { NextRequest, NextResponse } from "next/server";
import {
  buildChorusSegments,
  checkEligibility,
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
const MAX_CLIP_SECONDS = 600; // คลิปเต้นตามส่วนใหญ่สั้นกว่า 10 นาที ยาวกว่านี้ไม่วิเคราะห์
const COMMENT_PAGES = 3; // 3 หน้า x 100 = คอมเมนต์ที่เกี่ยวข้องที่สุดราว 300 รายการ

async function ytJson(path: string, params: Record<string, string>, key: string) {
  const url = new URL(`${YT_API}/${path}`);
  url.search = new URLSearchParams({ ...params, key }).toString();
  const res = await fetch(url, { next: { revalidate: YT_CACHE_SECONDS } });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, json };
}

function parseDuration(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** ค้นหาเนื้อเพลงใน LRCLIB (ฐานข้อมูลเปิด ไม่ต้องใช้คีย์) ล้มเหลวคืน [] */
async function searchLyrics(query: string): Promise<LrclibRecord[]> {
  try {
    const res = await fetch(`${LRCLIB_API}/search?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Muverse/0.1 (dance practice web app)" },
      next: { revalidate: LYRICS_CACHE_SECONDS },
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return Array.isArray(data) ? (data as LrclibRecord[]) : [];
  } catch {
    return [];
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

  try {
    // 1) ข้อมูลคลิป
    const detail = await ytJson("videos", { part: "snippet,contentDetails", id: videoId }, key);
    const item = detail.json?.items?.[0];
    if (!detail.ok || !item) return respond({ eligible: false, reason: "not-found", segments: [] });

    const title: string = item.snippet?.title ?? "";
    const description: string = item.snippet?.description ?? "";
    const tags: string[] = item.snippet?.tags ?? [];
    const channel: string = item.snippet?.channelTitle ?? "";
    const duration = parseDuration(item.contentDetails?.duration);

    if (duration <= 0 || duration > MAX_CLIP_SECONDS) return respond({ eligible: false, reason: "duration", segments: [] });
    const eligibility = checkEligibility(title, description, tags);
    if (!eligibility.eligible) return respond({ eligible: false, reason: eligibility.reason, segments: [] });

    // 2) เนื้อเพลงที่มีเวลากำกับ ที่ตรงกับคลิป (ชื่อ + ความยาว)
    const query = cleanSongTitle(title);
    const records = query.length >= 3 ? await searchLyrics(query) : [];
    const match = matchLyrics(records, title, `${channel} ${tags.join(" ")} ${description.slice(0, 300)}`, duration);
    if (match.status === "none") return respond({ eligible: true, reason: "no-lyrics", segments: [] });
    if (match.status === "mismatch") return respond({ eligible: true, reason: "duration-mismatch", segments: [] });

    // 3) ท่อนที่เนื้อเพลงวนซ้ำ = ท่อนฮุค
    const occurrences = detectChorus(match.lines);
    if (occurrences.length < 2) return respond({ eligible: true, reason: "no-chorus", segments: [] });

    // 4) คอมเมนต์ใช้ยืนยันเท่านั้น (ดึงเมื่อเจอท่อนฮุคแล้ว เพื่อประหยัดโควตา) ถ้าปิดคอมเมนต์ก็ข้ามไป
    const comments: CommentInput[] = [];
    let pageToken = "";
    for (let page = 0; page < COMMENT_PAGES; page++) {
      const r = await ytJson(
        "commentThreads",
        {
          part: "snippet",
          videoId,
          order: "relevance",
          maxResults: "100",
          textFormat: "plainText",
          ...(pageToken ? { pageToken } : {}),
        },
        key,
      );
      if (!r.ok) break;
      for (const t of r.json?.items ?? []) {
        const s = t.snippet?.topLevelComment?.snippet;
        if (s?.textDisplay) comments.push({ text: s.textDisplay, likes: Number(s.likeCount ?? 0) });
      }
      pageToken = r.json?.nextPageToken ?? "";
      if (!pageToken) break;
    }

    const segments = buildChorusSegments(occurrences, comments, parseChapters(description, duration), duration);
    return respond({ eligible: true, segments });
  } catch {
    return NextResponse.json({ error: "วิเคราะห์ไม่สำเร็จ" }, { status: 502 });
  }
}
