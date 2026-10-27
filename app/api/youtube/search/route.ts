// app/api/youtube/search/route.ts
// ค้นหาวิดีโอจาก YouTube Data API v3 ฝั่งเซิร์ฟเวอร์ เพื่อไม่ให้ API key รั่วไปที่เบราว์เซอร์
import { NextRequest, NextResponse } from "next/server";
import { classifyVideo } from "@/lib/search-category";
import type { VideoItem } from "@/lib/youtube";

const API = "https://www.googleapis.com/youtube/v3";

// คำที่ต่อท้ายเพื่อให้ผลลัพธ์ตรงกับโหมดของ Muverse
const MODE_SUFFIX: Record<string, string> = {
  all: "",
  follow: " dance along",
  tutorial: " dance tutorial",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseDuration(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export async function GET(req: NextRequest) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY ในไฟล์ .env.local" },
      { status: 500 }
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  const mode = req.nextUrl.searchParams.get("mode") ?? "all";
  if (!["all", "follow", "tutorial"].includes(mode)) return NextResponse.json({ error: "ประเภทการค้นหาไม่ถูกต้อง" }, { status: 400 });
  if (!q) return NextResponse.json({ items: [] });

  try {
    // 1) ค้นหา (กินโควตา 100 หน่วยต่อครั้ง)
    const searchUrl = new URL(`${API}/search`);
    searchUrl.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: mode === "all" ? "12" : "50",
      videoEmbeddable: "true", // เอาเฉพาะคลิปที่ฝังเล่นได้
      safeSearch: "moderate",
      q: q + (MODE_SUFFIX[mode] ?? ""),
      key,
    }).toString();

    const searchRes = await fetch(searchUrl, { next: { revalidate: 3600 } });
    const searchJson = await searchRes.json();
    if (!searchRes.ok) {
      return NextResponse.json(
        { error: searchJson?.error?.message ?? "ค้นหาไม่สำเร็จ" },
        { status: searchRes.status }
      );
    }

    const ids: string[] = (searchJson.items ?? []).map(
      (it: { id: { videoId: string } }) => it.id.videoId
    );
    if (ids.length === 0) return NextResponse.json({ items: [] });

    // 2) ดึงความยาวคลิป (กินโควตา 1 หน่วย)
    const detailUrl = new URL(`${API}/videos`);
    detailUrl.search = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id: ids.join(","),
      key,
    }).toString();
    const detailRes = await fetch(detailUrl, { next: { revalidate: 3600 } });
    const detailJson = await detailRes.json();

    if (!detailRes.ok) return NextResponse.json({ error: detailJson?.error?.message ?? "ดึงข้อมูลคลิปไม่สำเร็จ" }, { status: detailRes.status });

    const categories = new Map<string, string>();
    const durations = new Map<string, number>();
    const embeddable = new Set<string>();
    for (const v of detailJson.items ?? []) {
      categories.set(v.id, classifyVideo(decodeEntities(v.snippet?.title ?? ""), v.snippet?.tags ?? [], v.snippet?.description ?? ""));
      durations.set(v.id, parseDuration(v.contentDetails?.duration));
      if (v.status?.embeddable) embeddable.add(v.id);
    }

    const items: VideoItem[] = (searchJson.items ?? [])
      .filter((it: { id: { videoId: string } }) => embeddable.has(it.id.videoId) && (mode === "all" || categories.get(it.id.videoId) === mode))
      .slice(0, 12)
      .map(
        (it: {
          id: { videoId: string };
          snippet: {
            title: string;
            channelTitle: string;
            thumbnails: { medium?: { url: string }; default?: { url: string } };
          };
        }) => ({
          id: it.id.videoId,
          title: decodeEntities(it.snippet.title),
          channel: decodeEntities(it.snippet.channelTitle),
          thumbnail: it.snippet.thumbnails.medium?.url ?? it.snippet.thumbnails.default?.url ?? "",
          durationSec: durations.get(it.id.videoId) ?? 0,
        })
      );

    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ error: "เชื่อมต่อ YouTube ไม่ได้ ลองใหม่อีกครั้ง" }, { status: 502 });
  }
}
