import type { AutoSegment } from "./highlight-analysis";

export function parseHighlightTime(value: string): number | undefined {
  const text = value.trim();
  if (!/^(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parts = text.split(":").map(Number);
  if (parts.length > 1 && parts.slice(1).some((p) => p >= 60)) return undefined;
  const time = parts.reduce((sum, p) => sum * 60 + p, 0);
  return Number.isFinite(time) ? time : undefined;
}

export function readHighlightEdits(raw: string | null): AutoSegment[] | undefined {
  if (raw === null) return undefined;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 100) return undefined;
    if (!data.every((s) => s && typeof s.start === "number" && Number.isFinite(s.start) && s.start >= 0 &&
      typeof s.end === "number" && Number.isFinite(s.end) && s.end > s.start &&
      typeof s.label === "string" && s.label.length <= 100)) return undefined;
    return data.map((s) => ({ start: s.start, end: s.end, label: s.label, confidence: "medium", evidence: "ช่วงที่คุณบันทึกไว้ในเบราว์เซอร์นี้ ไม่ใช่ผลวิเคราะห์อัตโนมัติ" }));
  } catch { return undefined; }
}
