import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoItem } from "./youtube";
import { HISTORY_KEY, readWatchHistory, recordVisit, type WatchHistoryEntry } from "./watch-history";

export function useWatchHistory() {
  const [entries, setEntries] = useState<WatchHistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const canPersist = useRef(true);
  useEffect(() => {
    try {
      const saved = readWatchHistory(localStorage.getItem(HISTORY_KEY));
      setEntries((old) => old.length ? readWatchHistory(JSON.stringify([...old, ...saved])) : saved);
    } catch {
      canPersist.current = false;
      setError("เบราว์เซอร์ไม่อนุญาตให้บันทึกประวัติ ประวัติจะอยู่เฉพาะการเปิดหน้านี้");
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded || !canPersist.current) return;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); setError(undefined); }
    catch { setError("บันทึกประวัติในเบราว์เซอร์ไม่ได้ ประวัติใหม่จะอยู่เฉพาะการเปิดหน้านี้"); }
  }, [entries, loaded]);
  const record = useCallback((video: VideoItem) => setEntries((old) => recordVisit(old, video)), []);
  return {
    entries, loaded, error, record,
    remove: (id: string) => setEntries((old) => old.filter((entry) => entry.video.id !== id)),
    clear: () => setEntries([]),
  };
}
