// lib/highlight-analysis.ts
// หา "ท่อนฮุค" ของคลิปเต้นตามแบบอัตโนมัติ จากโครงสร้างการซ้ำของเนื้อเพลง (ตรรกะล้วน ๆ ไม่ต่อเน็ต ไม่ใช้ React ทดสอบแยกได้)
//
// แนวคิด: ท่อนฮุคคือท่อนที่เนื้อเพลงวนกลับมาซ้ำ 2-3 รอบ ท่าเด็ดของเพลงส่วนใหญ่อยู่ในท่อนนี้
//  1) ดึงเนื้อเพลงที่มีเวลากำกับ (LRC) ของเพลงที่ตรงกับคลิป แล้วหาบล็อกของบรรทัดที่ซ้ำกัน
//  2) ถ้าความยาวต่างกัน ต้องมีจุดอ้างอิงที่ผู้ใช้ยืนยัน หรือให้ผู้ใช้ปรับเวลาเอง (ไม่เดาจากความยาว)
//  3) คอมเมนต์ที่มีไทม์สแตมป์ใช้เป็นแค่ตัวยืนยัน ไม่ได้เป็นตัวสร้างท่อนเอง
//
// ข้อจำกัดที่ต้องรู้: ฮุคไม่ใช่ท่อนไวรัลเสมอไป (ท่าอาจเปลี่ยนในแต่ละรอบ หรือท่อนเด็ดอาจเป็นช่วงดนตรีล้วนที่ไม่มีเนื้อ)
// ป้ายที่ระบบสร้างจึงเป็น "ระบบคาดการณ์" และแนบหลักฐานให้ผู้ใช้เห็นเสมอ เนื้อเพลงใช้คำนวณเวลาเท่านั้น ไม่ถูกแสดงหรือเก็บ

export type Confidence = "high" | "medium";

export interface AutoSegment {
  start: number; // วินาที (ตามเวลาของคลิป)
  end: number;
  label: string;
  confidence: Confidence;
  evidence: string; // ข้อความอธิบายว่าระบบเห็นอะไรถึงเสนอท่อนนี้
}

/** รูปแบบข้อมูลที่ /api/youtube/highlights ส่งกลับ */
export interface HighlightsResponse {
  eligible: boolean;
  /** เหตุผลที่ไม่มีท่อน: tutorial | aerobic | not-dance-along | duration | not-found | no-lyrics | duration-mismatch | no-chorus */
  reason?: string;
  segments: AutoSegment[];
  source?: "chapters" | "comments" | "lyrics";
  appliedOffset?: number;
  /** เวลาตามเพลง ยังไม่ใช่เวลาคลิป ต้องให้ผู้ใช้ยืนยันจุดเริ่มเพลงก่อน */
  alignment?: { songDuration: number; clipDuration: number; firstChorusStart: number };
}

export interface CommentInput {
  text: string;
  likes: number;
}

export interface Chapter {
  start: number;
  end: number;
  label: string;
}

export interface LyricLine {
  t: number; // วินาที
  text: string;
}

export interface Occurrence {
  start: number;
  end: number;
}

export interface LrclibRecord {
  trackName: string;
  artistName: string;
  duration: number;
  syncedLyrics?: string | null;
  instrumental?: boolean;
}

// ---------- ค่าที่ปรับจูนได้ ----------
export const DURATION_TOLERANCE_SEC = 4; // ความยาวเพลงกับคลิปต่างกันได้ไม่เกินนี้ ถึงจะถือว่าเวลาตรงกัน
const PICKUP_WINDOW_SEC = 3; // ขยายคำขึ้นต้นสั้น ๆ ที่มีอีกรอบรองรับ ไม่ลากย้อนเข้า pre-chorus
const MIN_CHORUS_SEC = 10;
const MAX_CHORUS_SEC = 40;
const MERGE_GAP_SEC = 3; // บรรทัดฮุคที่ซ้ำติดกันห่างไม่เกินนี้ นับเป็นรอบเดียว
const MAX_OCCURRENCES = 8; // ซ้ำถี่เกินนี้น่าจะเป็นคำแทรก ไม่ใช่ฮุค
const MIN_SUPPORT = 3; // คอมเมนต์ยืนยันอย่างน้อยเท่านี้ ถึงเพิ่มระดับความมั่นใจ
const MAX_STAMPS_PER_COMMENT = 4; // คอมเมนต์ที่ไล่เวลาเกินนี้ถือเป็นรายการเวลาทั้งคลิป ไม่นับเป็นเสียงโหวต

// ---------- ไทม์สแตมป์ (คอมเมนต์) ----------
// จับ m:ss หรือ h:mm:ss (ไม่ใช้ lookbehind เพื่อให้ใช้ได้กับทุกเป้าหมายของคอมไพเลอร์)
const TS_RE = /(^|[^\d:])((?:\d{1,2}:)?\d{1,2}:[0-5]\d)(?![\d:])/g;
// คอมเมนต์ที่ชมหน้าตา/ตัวคน ไม่ใช่เรื่องท่าเต้น ไม่นับเป็นหลักฐาน
const PRAISE_RE = /beautiful|pretty|handsome|gorgeous|visuals?|\bface\b|\bcute\b|สวย|หล่อ|หน้าตา|น่ารัก/i;

export function toSeconds(ts: string): number {
  const p = ts.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/** ไทม์สแตมป์ที่ไม่ซ้ำกันในข้อความหนึ่งชิ้น ตัดอันที่เกินความยาวคลิปทิ้ง (เช่น "12:30" ที่ไม่ใช่เวลาในคลิป) */
export function parseTimestamps(text: string, durationSec: number): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(TS_RE)) {
    const sec = toSeconds(m[2]);
    if (sec <= durationSec) found.add(sec);
  }
  return Array.from(found);
}

/** จำนวนคอมเมนต์ที่อ้างถึงช่วง [start, end] (นับคอมเมนต์ละครั้ง ไม่นับคอมเมนต์ชมหน้าตา/รายการเวลาทั้งคลิป) */
export function countCommentSupport(comments: CommentInput[], start: number, end: number, durationSec: number): number {
  let n = 0;
  for (const c of comments) {
    if (PRAISE_RE.test(c.text)) continue;
    const stamps = parseTimestamps(c.text, durationSec);
    if (stamps.length === 0 || stamps.length > MAX_STAMPS_PER_COMMENT) continue;
    if (stamps.some((t) => t >= start - 2 && t <= end + 2)) n++;
  }
  return n;
}

// ---------- Chapters ----------
const CHAPTER_RE = /^[^\d\n]{0,4}((?:\d{1,2}:)?\d{1,2}:[0-5]\d)[ \t]*[-–—:.)\]|]*[ \t]*(\S.*)$/;
const STRONG_LABEL_RE = /chorus|hook|dance break|point|challenge|drop|ฮุค|คอรัส|ท่อนเด็ด|ท่าเด็ด|ท่าหลัก/i;

export function parseChapters(description: string, durationSec: number): Chapter[] {
  const raw: { start: number; label: string }[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = CHAPTER_RE.exec(line.trim());
    if (!m) continue;
    const start = toSeconds(m[1]);
    if (start <= durationSec) raw.push({ start, label: m[2].trim().slice(0, 60) });
  }
  raw.sort((a, b) => a.start - b.start);
  const uniq = raw.filter((c, i) => i === 0 || c.start !== raw[i - 1].start);
  if (uniq.length < 2) return [];
  return uniq.map((c, i) => ({ start: c.start, end: uniq[i + 1]?.start ?? durationSec, label: c.label }));
}

// ---------- คลิปนี้เข้าข่ายไหม (เต้นตาม ไม่ใช่แอโรบิก/คลิปสอน) ----------
const AEROBIC_RE = /aerobic|zumba|workout|fitness|cardio|exercise|calorie|weight loss|แอโรบิก|ซุมบ้า|ออกกำลังกาย|ลดน้ำหนัก/i;
const TUTORIAL_RE = /tutorial|how to dance|step[- ]by[- ]step|breakdown|สอนเต้น|วิธีเต้น/i;
const DANCE_RE = /dance|choreo|challenge|practice|mirrored|k-?pop in public|เต้น|ท่าเต้น/i;

export function checkEligibility(
  title: string,
  description: string,
  tags: string[],
): { eligible: boolean; reason?: string } {
  const text = `${title} ${tags.join(" ")} ${description.slice(0, 300)}`;
  if (AEROBIC_RE.test(text)) return { eligible: false, reason: "aerobic" };
  if (TUTORIAL_RE.test(text)) return { eligible: false, reason: "tutorial" };
  if (!DANCE_RE.test(`${title} ${tags.join(" ")}`)) return { eligible: false, reason: "not-dance-along" };
  return { eligible: true };
}

// ---------- ชื่อเพลงจากชื่อคลิป ----------
/** ตัดคำฟุ่มเฟือยออกจากชื่อคลิป เหลือ "ศิลปิน เพลง" เพื่อใช้ค้นหาเนื้อเพลง */
export function cleanSongTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|#\S+/g, " ")
    .replace(
      /\b(dance practice|dance cover|dance challenge|choreography|choreo|mirrored|official|m\/v|mv|performance|video|4k|hd|ver\.?|version|k-?pop in public|dance|practice|cover|challenge|shorts)\b/gi,
      " ",
    )
    .replace(/['"‘’“”]/g, "")
    .replace(/[-–—|:/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- เนื้อเพลงที่มีเวลากำกับ (LRC) ----------
const LRC_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseSyncedLyrics(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const times: number[] = [];
    LRC_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LRC_TAG.exec(raw)) !== null) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0));
    }
    if (times.length === 0) continue; // บรรทัดข้อมูลเช่น [ar:ศิลปิน] ข้ามไป
    const text = raw.replace(LRC_TAG, "").trim();
    for (const t of times) out.push({ t, text });
  }
  return out.sort((a, b) => a.t - b.t);
}

// เครื่องหมายวรรคตอน/ช่องว่างทั่วไป (ASCII + เครื่องหมายทั่วไปของ Unicode) ไม่ใช้ \p{} เพื่อรองรับทุกเป้าหมายของคอมไพเลอร์
const PUNCT_RE = /[\s\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u00bf\u2000-\u206f\u3000-\u303f]+/g;

function normalizeLine(s: string): string {
  return s.toLowerCase().replace(PUNCT_RE, " ").trim();
}

/** บรรทัดที่มีเนื้อหาพอจะใช้เทียบการซ้ำ: ตัดคำแทรกอย่าง "oh oh oh" "yeah yeah" "la la la" ออก */
function isInformative(n: string): boolean {
  if (n.length < 5) return false;
  const distinct = new Set(n.replace(/ /g, "")).size;
  if (distinct < 5) return false;
  const tokens = new Set(n.split(" "));
  return tokens.size >= 2 || n.length >= 8;
}

/**
 * หาท่อนฮุค = บล็อกของบรรทัดที่เนื้อเพลงวนกลับมาซ้ำ 2-8 รอบ ให้คะแนนจากจำนวนรอบก่อน แล้วค่อยดูความยาวบล็อก
 * คืนเวลาเริ่ม-จบของแต่ละรอบ (เวลาตามเพลงต้นฉบับ) หรือ [] ถ้าไม่พบ
 */
export function detectChorus(lines: LyricLine[]): Occurrence[] {
  const n = lines.length;
  if (n < 6) return [];
  const norm = lines.map((l) => normalizeLine(l.text));
  const info = norm.map(isInformative);
  const same = (a: number, b: number) => a >= 0 && b >= 0 && a < n && b < n && norm[a].length > 0 && norm[a] === norm[b];

  const seen = new Set<string>();
  let best: { score: number; occ: Occurrence[] } | null = null;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!same(i, j) || same(i - 1, j - 1)) continue; // ต้องเป็นจุดเริ่มของบล็อกที่ซ้ำ
      let run = 0;
      while (i + run < j && same(i + run, j + run)) run++; // ไม่ให้บล็อกซ้อนทับตัวเอง
      if (run < 2 || info.slice(i, i + run).filter(Boolean).length < 2) continue;
      const key = JSON.stringify(norm.slice(i, i + run));
      if (seen.has(key)) continue;
      seen.add(key);

      // ทุกตำแหน่งที่บล็อกนี้โผล่ (ไม่ซ้อนทับกัน)
      const starts: number[] = [];
      for (let p = 0; p + run <= n; ) {
        let ok = true;
        for (let k = 0; k < run; k++) {
          if (!same(i + k, p + k)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          starts.push(p);
          p += run;
        } else p++;
      }
      if (starts.length < 2) continue;

      // คำสั้นยังเป็นส่วนหนึ่งของบล็อก แต่ไม่บังคับทุกรอบให้ยาวเท่ารอบที่ยาวที่สุด
      // ขยายด้านหน้าถ้ามีอย่างน้อยอีกรอบรองรับ (รอบสุดท้ายอาจตัดคำขึ้นต้นออก)
      const raw: Occurrence[] = starts.map((a) => {
        let first = a;
        while (first > 0 && starts.some((b) => b !== a && same(first - 1, b - (a - first) - 1)) &&
          lines[a].t - lines[first - 1].t <= PICKUP_WINDOW_SEC) first--;
        const start = lines[first].t;
        const endIdx = a + run;
        const end = endIdx < n ? lines[endIdx].t : lines[n - 1].t + 4;
        // ไม่สร้างความยาวขั้นต่ำด้วยการลากเข้า verse ที่ไม่มีหลักฐานการซ้ำ
        return { start, end: Math.min(end, start + MAX_CHORUS_SEC) };
      });
      if (raw.some((o) => o.end - o.start < MIN_CHORUS_SEC)) continue;

      // รวมรอบที่ติดกัน (เช่น บรรทัดฮุคเดียวร้องซ้ำต่อกัน) ให้เป็นรอบเดียว
      const occ: Occurrence[] = [];
      for (const o of raw) {
        const prev = occ[occ.length - 1];
        if (prev && o.start - prev.end <= MERGE_GAP_SEC) prev.end = Math.max(prev.end, o.end);
        else occ.push({ ...o });
      }
      if (occ.length < 2 || occ.length > MAX_OCCURRENCES) continue;

      const score = Math.min(occ.length, 4) * 30 + occ.reduce((sum, o) => sum + Math.min(o.end - o.start, MAX_CHORUS_SEC), 0) / occ.length;
      if (!best || score > best.score) best = { score, occ };
    }
  }
  return best ? best.occ : [];
}

// ---------- จับคู่เพลงกับคลิป ----------
function normalizeForMatch(s: string): string {
  return normalizeLine(s);
}
const hasNonAscii = (s: string) => /[^\x00-\x7f]/.test(s);

function containsName(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return hasNonAscii(needle) ? haystack.includes(needle) : ` ${haystack} `.includes(` ${needle} `);
}

export type LyricsMatch =
  | { status: "ok"; record: LrclibRecord; lines: LyricLine[] }
  | { status: "alignment"; record: LrclibRecord; lines: LyricLine[] }
  | { status: "mismatch" } // เจอเพลงแต่ความยาวไม่ตรงกับคลิป
  | { status: "none" };

/**
 * เลือกเนื้อเพลงที่ตรงกับคลิปที่สุดจากผลค้นหา: ชื่อเพลงต้องอยู่ในชื่อคลิป, ศิลปินต้องอยู่ในชื่อคลิป/ช่อง/แท็ก
 * (หรือความยาวตรงกันภายใน 2 วินาที) ความยาวต่างเล็กน้อยจับเวลาอัตโนมัติ
 * ถ้าต่างเกิน tolerance แต่ไม่เกิน 120 วินาทีและยืนยันศิลปินได้ ให้ส่งกลับเพื่อขอจัดเวลา
 */
export function matchLyrics(
  records: LrclibRecord[],
  clipTitle: string,
  extraText: string,
  clipDurationSec: number,
): LyricsMatch {
  const title = normalizeForMatch(clipTitle);
  const extra = normalizeForMatch(`${clipTitle} ${extraText}`);
  let nameMatched = false;
  let best: { record: LrclibRecord; delta: number } | null = null;
  let unaligned: { record: LrclibRecord; delta: number } | null = null;

  for (const rec of records) {
    if (!rec.syncedLyrics || rec.instrumental || !Number.isFinite(rec.duration) || rec.duration <= 0) continue;
    const track = normalizeForMatch(rec.trackName);
    if (!containsName(title, track)) continue;

    const delta = Math.abs(rec.duration - clipDurationSec);
    const firstArtist = normalizeForMatch(rec.artistName.split(/,|&|feat\.?|\(/i)[0] ?? "");
    const artistWords = firstArtist.split(" ").filter((w) => w.length >= 3);
    const artistOk =
      containsName(extra, firstArtist) || (artistWords.length > 0 && artistWords.every((w) => containsName(extra, w)));
    if (!artistOk && delta > 2) continue;

    nameMatched = true;
    if (artistOk && delta <= 120 && (!unaligned || delta < unaligned.delta)) unaligned = { record: rec, delta };
    if (delta <= DURATION_TOLERANCE_SEC && (!best || delta < best.delta)) best = { record: rec, delta };
  }

  if (best) {
    const lines = parseSyncedLyrics(best.record.syncedLyrics ?? "");
    if (lines.length >= 6) return { status: "ok", record: best.record, lines };
  }
  if (unaligned) {
    const lines = parseSyncedLyrics(unaligned.record.syncedLyrics ?? "");
    if (lines.length >= 6) return { status: "alignment", record: unaligned.record, lines };
  }
  return nameMatched ? { status: "mismatch" } : { status: "none" };
}

// ---------- สร้างท่อนที่จะแสดง ----------
export function buildChorusSegments(
  occurrences: Occurrence[],
  comments: CommentInput[],
  chapters: Chapter[],
  durationSec: number,
): AutoSegment[] {
  const total = occurrences.length;
  const out: AutoSegment[] = [];
  occurrences.forEach((o, idx) => {
    const start = Math.max(0, Math.floor(o.start));
    const end = Math.min(Math.floor(durationSec), Math.ceil(o.end));
    if (end - start < 3) return; // นอกช่วงของคลิป
    const support = countCommentSupport(comments, start, end, durationSec);
    const chapter = chapters.find((c) => STRONG_LABEL_RE.test(c.label) && c.start < end && c.end > start);

    const parts = [`เนื้อเพลงท่อนนี้วนซ้ำ ${total} รอบในเพลง (ดูจากเนื้อเพลงที่มีเวลากำกับ)`, "เวลาอิงเพลงต้นฉบับ อาจคลาดในคลิปที่ตัดต่อหรือเปลี่ยนความเร็ว"];
    if (support > 0) parts.push(`มีคอมเมนต์ ${support} รายการอ้างถึงช่วงนี้`);
    if (chapter) parts.push(`ผู้อัปโหลดแบ่งช่วงนี้เป็น "${chapter.label}"`);

    out.push({
      start,
      end,
      label: `ท่อนฮุค รอบ ${idx + 1}/${total} (ระบบคาดการณ์)`,
      confidence: support >= MIN_SUPPORT ? "high" : "medium",
      evidence: parts.join(" · "),
    });
  });
  return out;
}
