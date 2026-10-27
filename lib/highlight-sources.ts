import { parseChapters, parseTimestamps, type AutoSegment, type Chapter, type CommentInput, type Occurrence } from "./highlight-analysis";

// Explicit section names only: "pre-chorus", "post chorus", "chorus tutorial" are not chorus boundaries.
export function isChorusLabel(label: string): boolean {
  return !/pre[\s-]*chorus|post[\s-]*chorus|สอน|tutorial|breakdown/i.test(label) &&
    /\bchorus\b|\bhook\b|ฮุค|คอรัส|후렴/i.test(label);
}

export function chapterHighlights(description: string, comments: CommentInput[], duration: number): AutoSegment[] {
  const fromChapters = (chapters: Chapter[], uploader: boolean) => chapters
    .filter((c) => isChorusLabel(c.label) && c.end - c.start >= 3 && c.end - c.start <= 90)
    .map((c): AutoSegment => ({
      start: c.start, end: c.end,
      label: `${c.label} (${uploader ? "ผู้อัปโหลดระบุ" : "คอมเมนต์ระบุ — โปรดตรวจสอบ"})`,
      confidence: uploader ? "high" : "medium",
      evidence: uploader ? "ใช้เวลาเริ่มและจบจาก chapter ของคลิปนี้ ไม่ได้เทียบเสียงหรือท่าเต้น" :
        "ใช้รายการแบ่งท่อนในคอมเมนต์เดียวกัน ทั้งจุดเริ่มและขอบเขตถัดไป ยังไม่ได้ยืนยันด้วยเสียงหรือภาพ",
    }));
  const official = fromChapters(parseChapters(description, duration), true);
  if (official.length) return official;
  // A full section list provides an end boundary; an isolated "1:02 chorus" does not.
  const lists = comments.map((c) => parseChapters(c.text, duration))
    .filter((chapters) => chapters.length >= 4 && chapters.filter((c) => isChorusLabel(c.label)).length >= 2);
  return lists.map((chapters) => fromChapters(chapters, false)).sort((a, b) => b.length - a.length)[0] ?? [];
}

/** Align by multiple explicitly labelled hook timestamps, never by arbitrary popular timestamps. */
export function inferChorusOffset(occurrences: Occurrence[], texts: string[], duration: number): number | undefined {
  const stamps = [...new Set(texts.flatMap((text) => text.split(/\r?\n/)
    .filter(isChorusLabel).flatMap((line) => parseTimestamps(line, duration))))].sort((a, b) => a - b);
  if (occurrences.length < 2 || stamps.length < 2 || stamps.length > 12) return undefined;
  const candidates: { offset: number; count: number; error: number }[] = [];
  for (const stamp of stamps) for (const occurrence of occurrences) {
    const offset = stamp - occurrence.start;
    if (Math.abs(offset) > 120) continue;
    const used = new Set<number>();
    const deltas: number[] = [];
    for (const o of occurrences) {
      const match = stamps.map((t, i) => ({ i, delta: t - o.start }))
        .filter((x) => !used.has(x.i) && Math.abs(x.delta - offset) <= 2)
        .sort((a, b) => Math.abs(a.delta - offset) - Math.abs(b.delta - offset))[0];
      if (match) { used.add(match.i); deltas.push(match.delta); }
    }
    if (deltas.length < 2) continue;
    const mean = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
    candidates.push({ offset: mean, count: deltas.length, error: deltas.reduce((sum, d) => sum + Math.abs(d - mean), 0) });
  }
  candidates.sort((a, b) => b.count - a.count || a.error - b.error);
  const best = candidates[0];
  if (!best || candidates.some((c) => c.count === best.count && Math.abs(c.offset - best.offset) > 3 && c.error <= best.error + 0.5)) return undefined;
  return best.offset;
}

/** Bounded fallbacks retain quoted track names and remove duplicated bilingual artist aliases. */
export function lyricQueries(title: string, cleaned: string): string[] {
  const quoted = /['"‘“]([^'"’”]+)['"’”]/.exec(title)?.[1]?.trim();
  const latin = cleaned.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([cleaned, latin, quoted].filter((q): q is string => !!q && q.length >= 2))].slice(0, 3);
}
