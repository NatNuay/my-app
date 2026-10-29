import { cleanSongTitle, normalizeLine, parseChapters, parseTimestamps, type AutoSegment, type Chapter, type CommentInput, type LyricLine, type Occurrence } from "./highlight-analysis";

// Explicit section names only: "pre-chorus", "post chorus", "chorus tutorial" are not chorus boundaries.
export function isChorusLabel(label: string): boolean {
  return !/pre[\s-]*chorus|post[\s-]*chorus|(?:ก่อน|หลัง|พรี)\s*(?:ท่อน\s*)?ฮุ[คก]|สอน|tutorial|breakdown/i.test(label) &&
    /\bchorus\b|\bhook\b|ฮุ[คก]|คอรัส|ท่อนสร้อย|후렴/i.test(label);
}

export function isDanceBreakLabel(label: string): boolean {
  return !/tutorial|breakdown|สอน|no dance|without/i.test(label) &&
    /dance[\s-]*break|เบร[กค]แดนซ์|แดนซ์เบร[กค]|댄스\s*브레이크/i.test(label);
}

export function chapterHighlights(description: string, comments: CommentInput[], duration: number): AutoSegment[] {
  const fromChapters = (chapters: Chapter[], uploader: boolean) => chapters
    .filter((c) => (isChorusLabel(c.label) || isDanceBreakLabel(c.label)) && c.end - c.start >= 3 && c.end - c.start <= 90)
    .map((c): AutoSegment => ({
      start: c.start, end: c.end,
      kind: isDanceBreakLabel(c.label) ? "dance-break" : "chorus",
      label: `${c.label} (${uploader ? "ผู้อัปโหลดระบุ" : "คอมเมนต์ระบุ — โปรดตรวจสอบ"})`,
      confidence: uploader ? "high" : "medium",
      evidence: uploader ? "ใช้เวลาเริ่มและจบจาก chapter ของคลิปนี้ ไม่ได้เทียบเสียงหรือท่าเต้น" :
        "ใช้รายการแบ่งท่อนในคอมเมนต์เดียวกัน ทั้งจุดเริ่มและขอบเขตถัดไป ยังไม่ได้ยืนยันด้วยเสียงหรือภาพ",
    }));
  const official = fromChapters(parseChapters(description, duration), true);
  // A full section list provides an end boundary; an isolated "1:02 chorus" does not.
  const lists = comments.map((c) => parseChapters(c.text, duration))
    .filter((chapters) => chapters.some((c) => c.explicitEnd && (isChorusLabel(c.label) || isDanceBreakLabel(c.label))) ||
      (chapters.length >= 2 && chapters.some((c) => isDanceBreakLabel(c.label))) ||
      (chapters.length >= 4 && chapters.filter((c) => isChorusLabel(c.label)).length >= 2));
  const listed = lists.map((chapters) => fromChapters(chapters, false)).sort((a, b) => b.length - a.length)[0] ?? [];
  return mergeHighlights(official, mergeHighlights(listed, supportedDanceBreakRanges(comments, duration)));
}

export function mergeHighlights(primary: AutoSegment[], extra: AutoSegment[]): AutoSegment[] {
  return [...primary, ...extra.filter((candidate) => !primary.some((s) =>
    Math.min(s.end, candidate.end) > Math.max(s.start, candidate.start)))]
    .sort((a, b) => a.start - b.start);
}

/** Named dance-break cues + an explicit range + independent timestamp support.
 * Never invent an end by adding a fixed number of seconds to a popular timestamp.
 */
function supportedDanceBreakRanges(comments: CommentInput[], duration: number): AutoSegment[] {
  const clock = "((?:\\d{1,2}:)?\\d{1,2}:[0-5]\\d)";
  const name = "(?:dance[\\s-]*break|เบร[กค]แดนซ์|แดนซ์เบร[กค]|댄스\\s*브레이크)";
  const before = new RegExp(`${name}[^\\d\\n]{0,20}${clock}`, "gi");
  const after = new RegExp(`${clock}[^\\d\\n]{0,10}${name}(?![^\\n]{0,8}\\d{1,2}:[0-5]\\d)`, "gi");
  const ranges = new RegExp(`${clock}\\s*[-–—~〜]\\s*${clock}`, "g");
  const cues = comments.flatMap((c) => {
    if (/tutorial|สอน|no dance|without/i.test(c.text)) return [];
    return [...c.text.matchAll(before), ...c.text.matchAll(after)]
      .flatMap((m) => parseTimestamps(m[0], duration));
  });
  const out: AutoSegment[] = [];
  for (const comment of comments) for (const range of comment.text.matchAll(ranges)) {
    const times = parseTimestamps(range[0], duration);
    if (times.length !== 2) continue;
    const [start, end] = times;
    if (end - start < 3 || end - start > 90 || !cues.some((cue) => Math.abs(cue - start) <= 5)) continue;
    const supporters = new Set(comments.filter((c) => parseTimestamps(c.text, duration)
      .some((stamp) => Math.abs(stamp - start) <= 2)).map((c) => normalizeLine(c.text)));
    if (supporters.size < 3 || out.some((s) => Math.min(s.end, end) > Math.max(s.start, start))) continue;
    out.push({ start, end, kind: "dance-break", confidence: "medium",
      label: "เบรคแดนซ์ (คอมเมนต์ระบุ — โปรดตรวจสอบ)",
      evidence: `มีคอมเมนต์ระบุ dance break ใกล้จุดนี้ พร้อมช่วงเริ่ม–จบที่ระบุไว้และไทม์สแตมป์สนับสนุน ${supporters.size} ข้อความ ไม่ได้วิเคราะห์เสียงหรือภาพ`,
    });
  }
  return out;
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

/** Match timestamped lyric quotes to actual LRC lines, not unrelated popular moments. */
export function inferLyricOffset(lines: LyricLine[], texts: string[], duration: number): number | undefined {
  const anchors: { stamp: number; songTime: number; lyric: string }[] = [];
  for (const text of texts) for (const row of text.split(/\r?\n/)) {
    const stamps = parseTimestamps(row, duration);
    if (stamps.length !== 1) continue;
    const quote = ` ${normalizeLine(row)} `;
    for (const line of lines) {
      const lyric = normalizeLine(line.text);
      const thai = /[\u0e00-\u0e7f]/.test(lyric);
      if (lyric.length < 12 || (!thai && lyric.split(" ").length < 3)) continue;
      if (thai ? quote.includes(lyric) : quote.includes(` ${lyric} `)) anchors.push({ stamp: stamps[0], songTime: line.t, lyric });
    }
  }
  if (anchors.length < 2 || anchors.length > 200) return undefined;
  const candidates = anchors.map((anchor) => {
    const offset = anchor.stamp - anchor.songTime;
    const compatible = anchors.filter((a) => Math.abs(a.stamp - a.songTime - offset) <= 1.5);
    const unique = [...new Map(compatible.map((a) => [a.stamp, a])).values()];
    if (Math.abs(offset) > 120 || new Set(unique.map((a) => a.lyric)).size < 2 ||
      Math.max(...unique.map((a) => a.songTime)) - Math.min(...unique.map((a) => a.songTime)) < 20) return undefined;
    return { offset: unique.reduce((sum, a) => sum + a.stamp - a.songTime, 0) / unique.length, count: unique.length };
  }).filter((c): c is { offset: number; count: number } => !!c).sort((a, b) => b.count - a.count);
  const best = candidates[0];
  if (!best || candidates.some((c) => c.count === best.count && Math.abs(c.offset - best.offset) > 3)) return undefined;
  return best.offset;
}

/** Bounded fallbacks retain quoted track names and remove duplicated bilingual artist aliases. */
export function lyricQueries(title: string, cleaned: string): string[] {
  const quoted = /['"‘“]([^'"’”]+)['"’”]/.exec(title)?.[1]?.trim();
  const latin = cleaned.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  const base = [cleaned, latin, quoted].filter((q): q is string => !!q && q.length >= 2);
  const separated = title.split(/\s*[:|]\s*|\s+[-–—/]\s+/).slice(1)
    .map(cleanSongTitle).filter((part) => part.length >= 3 && !/^by\s/i.test(part));
  if (/[\u0e00-\u0e7f]/.test(title)) {
    // Thai track names must survive English aliases, artist prefixes and sponsor suffixes.
    const thaiNames = [...(quoted ?? title).matchAll(/[\u0e00-\u0e7f]+(?:\s+[\u0e00-\u0e7f]+)*/g)]
      .map((m) => m[0].trim()).filter((name) => name.length >= 3 && !/^(?:สอนเต้น|ฝึกเต้น|เต้นตาม|ซ้อมเต้น|เวอร์ชั่น|เวอร์ชัน)$/.test(name));
    const aliases = [...title.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim())
      .filter((name) => name.length >= 3 && !/\b(?:practice|mirrored?|official|video|version|ver|4k|hd)\b|สอนเต้น/i.test(name));
    return [...new Set([quoted, ...thaiNames, ...aliases, ...base, ...separated].filter((q): q is string => !!q && q.length >= 2))].slice(0, 6);
  }
  // A title such as [CHARM - ARTIST] should not disappear with formatting brackets.
  if (!cleaned) {
    const bracket = /\[([^\]]+)\]/.exec(title)?.[1]?.trim();
    if (bracket && !/^(?:dance practice|mirrored|official|4k|hd)$/i.test(bracket)) base.push(bracket);
  }
  return [...new Set([...base, ...separated])].slice(0, 3);
}
