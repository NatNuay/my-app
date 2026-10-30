import type { AutoSegment, HighlightsResponse } from "./highlight-analysis";

/** Treat the model output as untrusted. Never relabel instrumental breaks as dance breaks. */
export function audioChoruses(value: unknown, engine: "fast" | "full" = "full"): AutoSegment[] {
  if (!Array.isArray(value)) return [];
  const result: AutoSegment[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || item.label !== "chorus" || typeof item.start !== "number" ||
        typeof item.end !== "number" || !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
        item.start < 0 || item.end > 900 || item.end - item.start < 5 || item.end - item.start > 120) continue;
    result.push({ kind: "chorus", start: item.start, end: item.end,
      label: engine === "fast" ? "ท่อนซ้ำที่อาจเป็นฮุค (โหมดเร็ว · ทดลอง)" : "ท่อนฮุค (วิเคราะห์เสียง · ระบบคาดการณ์)", confidence: "medium",
      evidence: engine === "fast" ? "เปรียบเทียบรูปแบบเสียงที่ซ้ำในคลิปนี้ · ยังไม่ยืนยันว่าเป็นฮุค และไม่ได้ตรวจท่าเต้น" : "All-In-One วิเคราะห์เสียงจากคลิปนี้โดยตรง · ยังไม่ได้ยืนยันด้วยคน" });
  }
  result.sort((a, b) => a.start - b.start);
  const merged: AutoSegment[] = [];
  for (const item of result) {
    const previous = merged[merged.length - 1];
    // Only join touching model boundaries. Never extend a chorus into a verse
    // or subtract a song-specific offset to compensate for uncertain timing.
    if (previous && Math.abs(item.start - previous.end) <= 0.25 && item.end > previous.end && item.end - previous.start <= 120) {
      previous.end = item.end;
    } else if (!previous || item.start >= previous.end) {
      merged.push({ ...item });
    }
  }
  return merged;
}

export function combineAudioHighlights(metadata: AutoSegment[], audio: AutoSegment[], preferMetadata = false): AutoSegment[] {
  if (!audio.length || (preferMetadata && metadata.some(item => item.kind !== "dance-break"))) return metadata;
  return [...audio, ...metadata.filter(item => item.kind === "dance-break" &&
    !audio.some(a => a.start < item.end && item.start < a.end))].sort((a, b) => a.start - b.start);
}

/** Resolve source priority BEFORE the first snapshot is published. A lyric
 * repeat may be a pre-chorus or only the sung middle of an instrumental hook.
 * When fast audio is running, wait for that bounded result instead of locking
 * the earlier lyric guess. Existing chapter/comment boundaries remain usable.
 */
export function selectHighlightProposal(metadata: AutoSegment[], audio: AutoSegment[], options: {
  pending: boolean; engine?: string; source?: HighlightsResponse["source"];
}): AutoSegment[] {
  const explicit = options.source === "chapters" || options.source === "comments";
  if (options.pending && options.engine !== "full" && !explicit) {
    return metadata.filter(segment => segment.kind === "dance-break");
  }
  return combineAudioHighlights(metadata, audio, explicit);
}

/** Keep the first displayed chorus set for this visit. Arrival time is not
 * evidence that a newer prediction is more accurate. Later sources may fill an
 * empty chorus set or add a distinct dance break, never silently move a range.
 */
export function retainDisplayedHighlights(displayed: AutoSegment[], incoming: AutoSegment[]): AutoSegment[] {
  if (!displayed.length) return incoming;
  const chorusLocked = displayed.some(segment => segment.kind !== "dance-break");
  const additions: AutoSegment[] = [];
  for (const segment of incoming) {
    if (chorusLocked && segment.kind !== "dance-break") continue;
    if ([...displayed, ...additions].some(existing =>
      existing.start < segment.end && segment.start < existing.end)) continue;
    additions.push(segment);
  }
  return additions.length ? [...displayed, ...additions].sort((a, b) => a.start - b.start) : displayed;
}
