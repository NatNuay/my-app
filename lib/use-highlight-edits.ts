import { useEffect, useState } from "react";
import type { AutoSegment } from "./highlight-analysis";
import { readHighlightEdits } from "./highlight-edits";

export function useHighlightEdits(videoId: string) {
  const [state, setState] = useState<{ id: string; segments?: AutoSegment[] }>({ id: "" });
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
    try { setState({ id: videoId, segments: readHighlightEdits(localStorage.getItem(`muverse:highlights:${videoId}`)) }); }
    catch { setState({ id: videoId }); }
  }, [videoId]);
  function save(segments: AutoSegment[] | undefined) {
    setState({ id: videoId, segments });
    try {
      if (segments === undefined) localStorage.removeItem(`muverse:highlights:${videoId}`);
      else localStorage.setItem(`muverse:highlights:${videoId}`, JSON.stringify(segments));
      setError(undefined);
    } catch { setError("เบราว์เซอร์ไม่อนุญาตให้บันทึก ช่วงที่แก้จะอยู่เฉพาะครั้งนี้"); }
  }
  return { segments: state.id === videoId ? state.segments : undefined, save, error };
}
