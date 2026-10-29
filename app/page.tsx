"use client";
// หน้าทดสอบฟีเจอร์ค้นหา + เล่นวิดีโอ + playlist (ยังไม่มีดีไซน์ ส่วนหน้าตาเป็นงานของคนที่หนึ่ง)

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import HeartButton from "@/components/heart-button";
import PlaylistPanel from "@/components/playlist-panel";
import YouTubePlayer from "@/components/youtube-player";
import YouTubeSearch from "@/components/youtube-search";
import WatchHistory from "@/components/watch-history";
import { useWatchHistory } from "@/lib/use-watch-history";
import { useAutoHighlights } from "@/lib/auto-highlights";
import { isLikedId, usePlaylists, type PlayMode, type Playlist } from "@/lib/playlist";
import type { VideoItem } from "@/lib/youtube";

const MODE_KEY = "muverse:playmode";
const MODE_LABEL: Record<PlayMode, string> = { sequential: "วนซ้ำแบบเรียง", shuffle: "วนซ้ำแบบสุ่ม", single: "วนซ้ำคลิปเดียว" };

// สถานะการสุ่มของ playlist ที่กำลังเล่น (เก็บใน ref เพราะไม่ต้องให้หน้า re-render)
interface ShuffleSession {
  sourceId: string | null;
  history: string[]; // ลำดับเพลงที่เล่นไปแล้ว ใช้กด “ก่อนหน้า” ย้อนกลับได้ตรงกับที่เล่นจริง
  cursor: number; // ตำแหน่งปัจจุบันใน history
  round: Set<string>; // เพลงที่เล่นไปแล้วในรอบนี้ จะไม่ถูกสุ่มซ้ำจนกว่าจะครบทุกเพลง
}

// ข้อความบอกผู้ใช้ว่าทำไมคลิปนี้ไม่มีท่อนฮุคให้ (เพื่อให้รู้ว่าระบบทำงานแล้ว ไม่ใช่พัง)
const NO_HIGHLIGHT_REASON: Record<string, string> = {
  tutorial: "ไม่แสดงท่อนฮุค: เป็นคลิปสอนเต้น (ฟีเจอร์นี้ใช้กับคลิปเต้นตาม)",
  aerobic: "ไม่แสดงท่อนฮุค: เป็นคลิปแอโรบิก/ออกกำลังกาย",
  "not-dance-along": "ไม่แสดงท่อนฮุค: ระบบไม่เห็นว่าเป็นคลิปเต้นตาม",
  duration: "ไม่แสดงท่อนฮุค: ยังไม่ทราบความยาวคลิป (อาจเป็นไลฟ์)",
  "not-found": "ไม่แสดงท่อนฮุค: ไม่พบข้อมูลคลิปจาก YouTube",
  "no-lyrics": "ยังไม่พบข้อมูลที่ใช้ตรวจจับท่อนฮุคอัตโนมัติของคลิปนี้",
  "untimed-lyrics": "พบเนื้อเพลงแล้ว แต่ไม่มีเวลาประกอบแต่ละบรรทัด จึงยังระบุช่วงฮุคอัตโนมัติไม่ได้",
  "alignment-required": "ยังไม่แสดงท่อนฮุค: ระบบยืนยันตำแหน่งเพลงในคลิปนี้ไม่ได้",
  "duration-mismatch": "ไม่แสดงท่อนฮุค: เพลงที่พบมีความยาวไม่ตรงกับคลิป (คลิปอาจมีอินโทรหรือตัดต่อ) จึงไม่เดาตำแหน่ง",
  "no-chorus": "ไม่แสดงท่อนฮุค: ไม่พบท่อนที่เนื้อเพลงวนซ้ำ",
  default: "ยังไม่พบท่อนฮุคอัตโนมัติของคลิปนี้",
};

// สิ่งที่เก็บในประวัติเบราว์เซอร์ต่อหนึ่งหน้า: คลิปที่เล่นอยู่ (null = หน้าหลักที่ยังไม่ได้เล่นอะไร) และ playlist ต้นทาง
interface NavEntry {
  mv: { video: VideoItem | null; sourceId: string | null };
}

export default function Page() {
  const pl = usePlaylists();
  const [current, setCurrent] = useState<VideoItem | null>(null);
  const visits = useWatchHistory();
  const recordVisit = visits.record;
  const [selectedId, setSelectedId] = useState<string | null>(null); // playlist ที่เปิดดู/เป็นปลายทางของปุ่ม “+ playlist”
  const [sourceId, setSourceId] = useState<string | null>(null); // playlist ที่กำลังเล่นต่อเนื่องอยู่ (null = เล่นคลิปเดี่ยวจากการค้นหา)
  const [mode, setMode] = useState<PlayMode>("sequential");
  const auto = useAutoHighlights(current?.id); // ท่อนฮุคที่ระบบวิเคราะห์ให้ของคลิปที่กำลังเล่น
  const [homeKey, setHomeKey] = useState(0); // เปลี่ยนค่านี้เพื่อรีเซ็ตหน้าค้นหา/หน้า playlist กลับสู่สภาพเริ่มต้น
  const session = useRef<ShuffleSession>({ sourceId: null, history: [], cursor: -1, round: new Set() });

  // จำวิธีเล่นที่เลือกไว้ (อ่านหลัง mount เพื่อกัน hydration ไม่ตรงกับฝั่งเซิร์ฟเวอร์)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_KEY);
      if (saved === "sequential" || saved === "shuffle" || saved === "single") setMode(saved);
    } catch {
      /* ใช้ค่าเริ่มต้น */
    }
  }, []);

  // ปุ่ม Back/Forward ของเบราว์เซอร์: กลับไปคลิปที่เลือกไว้ก่อนหน้า หรือกลับหน้าหลักถ้ายังไม่ได้เลือกอะไร
  // (ผลการค้นหาและหน้า playlist ไม่ถูกรีเซ็ต จึงย้อนกลับมาเห็นรายการเดิมได้)
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const mv = (e.state as Partial<NavEntry> | null)?.mv;
      const video = mv?.video ?? null;
      if (video) recordVisit(video);
      setCurrent(video);
      setSourceId(video ? mv?.sourceId ?? null : null);
    };
    // รีโหลดหน้าตอนที่รายการประวัติปัจจุบันเป็นหน้าที่มีคลิป: คืนคลิปนั้นกลับมา ไม่งั้นหน้าจอ (หน้าหลัก) กับประวัติจะไม่ตรงกัน
    // ทำให้กด Back ครั้งแรกดูเหมือนไม่เกิดอะไรขึ้น
    const initial = (window.history.state as Partial<NavEntry> | null)?.mv;
    if (initial?.video) {
      setCurrent(initial.video);
      setSourceId(initial.sourceId ?? null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [recordVisit]);

  // ถ้า id ที่จำไว้ถูกลบไปแล้ว จะตกมาที่ playlist แรก/null เองโดยไม่ต้อง sync state
  // ค่าเริ่มต้นเป็น playlist ของผู้ใช้อันแรก (ไม่ใช่ “ถูกใจ”) ถ้ายังไม่มีเลยจึงตกมาที่ “ถูกใจ”
  const firstUserPlaylist = pl.playlists.find((p) => !isLikedId(p.id)) ?? null;
  const selected = pl.playlists.find((p) => p.id === selectedId) ?? firstUserPlaylist ?? pl.playlists[0] ?? null;
  // ปลายทางของปุ่ม “+ playlist”: playlist ที่เลือกอยู่ ยกเว้น “ถูกใจ” (อันนั้นใช้ปุ่มหัวใจ) → ใช้ playlist ของผู้ใช้อันแรกแทน
  const target = selected && !isLikedId(selected.id) ? selected : firstUserPlaylist;
  const source = pl.playlists.find((p) => p.id === sourceId) ?? null;

  // กดชื่อเว็บ: กลับหน้าหลัก หยุดเล่น ล้างผลค้นหา และกลับไปหน้ารายการ playlist (playlist และโหมดที่เลือกไว้ยังอยู่)
  function goHome(e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // เปิดแท็บใหม่ตามปกติ
    e.preventDefault();
    if (current) window.history.pushState({ mv: { video: null, sourceId: null } } satisfies NavEntry, "");
    setCurrent(null);
    setSourceId(null);
    setHomeKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function play(video: VideoItem, fromPlaylistId: string | null, scroll = true, nav: "push" | "replace" = "push") {
    recordVisit(video);
    const entry: NavEntry = { mv: { video, sourceId: fromPlaylistId } };
    if (nav === "push") window.history.pushState(entry, "");
    else window.history.replaceState(entry, "");
    setCurrent(video);
    setSourceId(fromPlaylistId);
    // เครื่องเล่นอยู่ด้านบน เลื่อนขึ้นไปให้เห็นทันทีหลังเลือกคลิป (ตอนเล่นเพลงถัดไปอัตโนมัติไม่เลื่อน)
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // เพิ่มคลิปเข้า playlist ปลายทาง ถ้ายังไม่มี playlist ของผู้ใช้เลยจะสร้างให้อัตโนมัติ
  function addToPlaylist(video: VideoItem) {
    let id = target?.id;
    if (!id) id = pl.createPlaylist(`Playlist ${pl.playlists.length}`);
    setSelectedId(id);
    pl.addTrack(id, video);
  }

  // ---------- วิธีเล่นต่อเนื่อง ----------
  function startSession(sourceId: string, videoId: string) {
    session.current = { sourceId, history: [videoId], cursor: 0, round: new Set([videoId]) };
  }

  // ผู้ใช้เลือกเพลงเองจาก playlist: ต่อท้ายประวัติ (ตัดส่วนที่ย้อนกลับมาแล้วทิ้ง) และนับว่าเล่นแล้วในรอบนี้
  function recordManual(sourceId: string, videoId: string) {
    const s = session.current;
    if (s.sourceId !== sourceId) return startSession(sourceId, videoId);
    s.history = [...s.history.slice(0, s.cursor + 1), videoId];
    s.cursor = s.history.length - 1;
    s.round.add(videoId);
  }

  function changeMode(next: PlayMode) {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
    // เปลี่ยนมาโหมดสุ่มระหว่างเล่น: เริ่มรอบใหม่โดยนับเพลงที่กำลังเล่นว่าเล่นแล้ว
    if (next === "shuffle" && source && current) startSession(source.id, current.id);
  }

  // สุ่มเพลงถัดไปจากเพลงที่ยังไม่ได้เล่นในรอบนี้ ถ้าครบทุกเพลงแล้วเริ่มรอบใหม่ (เพลงที่เพิ่งจบจะไม่มาซ้ำทันที)
  function pickShuffleNext(items: VideoItem[], currentId: string): VideoItem | null {
    if (items.length < 2) return null;
    const s = session.current;
    let pool = items.filter((v) => !s.round.has(v.id));
    if (pool.length === 0) {
      s.round = new Set();
      pool = items.filter((v) => v.id !== currentId);
    }
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  function stepShuffle(src: Playlist, cur: VideoItem, delta: 1 | -1, scroll: boolean) {
    const s0 = session.current;
    if (s0.sourceId !== src.id || s0.history[s0.cursor] !== cur.id) startSession(src.id, cur.id);
    const s = session.current;
    const find = (id: string) => src.items.find((v) => v.id === id);

    if (delta < 0) {
      // ก่อนหน้า = ย้อนไปเพลงที่เพิ่งเล่นจริง (ข้ามเพลงที่ถูกลบออกจาก playlist ไปแล้ว)
      let c = s.cursor - 1;
      while (c >= 0 && !find(s.history[c])) c--;
      const prev = c >= 0 ? find(s.history[c]) : undefined;
      if (!prev) return;
      s.cursor = c;
      play(prev, src.id, scroll, "replace");
      return;
    }

    // ถัดไป: ถ้าเคยย้อนกลับมา เล่นตามประวัติเดิมก่อน หมดแล้วค่อยสุ่มเพลงใหม่
    let c = s.cursor + 1;
    while (c < s.history.length && !find(s.history[c])) c++;
    const forward = c < s.history.length ? find(s.history[c]) : undefined;
    if (forward) {
      s.cursor = c;
      play(forward, src.id, scroll, "replace");
      return;
    }
    const next = pickShuffleNext(src.items, cur.id);
    if (!next) return; // มีเพลงเดียว ไม่มีอะไรให้สุ่ม
    s.history.push(next.id);
    s.cursor = s.history.length - 1;
    s.round.add(next.id);
    play(next, src.id, scroll, "replace");
  }

  // ไปคลิปถัดไป (+1) / ก่อนหน้า (-1) ใน playlist ที่กำลังเล่น (ทั้งสองแบบวนซ้ำไม่จบ)
  function step(delta: 1 | -1, scroll: boolean) {
    if (!source || !current) return;
    const idx = source.items.findIndex((v) => v.id === current.id);
    if (idx < 0) return; // คลิปปัจจุบันถูกลบออกจาก playlist ไปแล้ว

    if (mode === "shuffle") return stepShuffle(source, current, delta, scroll);

    // วนซ้ำแบบเรียง: ตามลำดับที่นำเข้า จบเพลงสุดท้ายกลับไปเพลงแรก
    const n = source.items.length;
    const nextVideo = source.items[(idx + delta + n) % n];
    if (!nextVideo || nextVideo.id === current.id) return; // มีเพลงเดียว
    play(nextVideo, source.id, scroll, "replace");
  }

  const addedIds = new Set(target?.items.map((v) => v.id) ?? []);

  return (
    <main>
      <h1>
        <Link href="/" onClick={goHome} style={{ color: "inherit", textDecoration: "none" }}>
          Muverse
        </Link>
      </h1>

      {current && (
        <section>
          <h2>{current.title}</h2>
          <p>
            <button type="button" onClick={() => addToPlaylist(current)} disabled={addedIds.has(current.id)}>
              {addedIds.has(current.id) ? "✓ อยู่ใน playlist แล้ว" : "+ playlist"}
            </button>{" "}
            <HeartButton liked={pl.likedIds.has(current.id)} onClick={() => pl.toggleLike(current)} />
            {source && (
              <>
                {" "}
                <button type="button" onClick={() => step(-1, false)}>
                  ⏮ ก่อนหน้า
                </button>{" "}
                <button type="button" onClick={() => step(1, false)}>
                  ถัดไป ⏭
                </button>{" "}
                <small>
                  กำลังเล่นจาก “{source.name}” · {MODE_LABEL[mode]}
                </small>
              </>
            )}
            {!source && mode === "single" && <small> {MODE_LABEL.single}</small>}
          </p>
          <YouTubePlayer
            videoId={current.id}
            onEnded={() => step(1, false)}
            loopOne={mode === "single"}
            highlights={auto.segments}
          />
          {auto.status === "loading" && <small>กำลังวิเคราะห์ท่อนฮุคของคลิปนี้…</small>}
          {auto.status === "none" && <small>{NO_HIGHLIGHT_REASON[auto.reason ?? ""] ?? NO_HIGHLIGHT_REASON.default}</small>}
          {auto.status === "error" && <small>วิเคราะห์ท่อนฮุคไม่สำเร็จ: {auto.reason}</small>}
        </section>
      )}

      <WatchHistory entries={visits.entries} loaded={visits.loaded} error={visits.error}
        activeId={current?.id} onPlay={(video) => play(video, null)} onRemove={visits.remove} onClear={visits.clear} />

      <PlaylistPanel
        key={`pl-${homeKey}`}
        playlists={pl.playlists}
        selected={selected}
        playingId={current?.id}
        playingFromSelected={!!selected && selected.id === sourceId}
        likedIds={pl.likedIds}
        onToggleLike={pl.toggleLike}
        mode={mode}
        onModeChange={changeMode}
        onSelect={setSelectedId}
        onCreate={(name) => setSelectedId(pl.createPlaylist(name))}
        onRename={pl.renamePlaylist}
        onSetCover={pl.setCover}
        onDelete={pl.deletePlaylist}
        onPlay={(video) => {
          if (!selected) return;
          recordManual(selected.id, video.id);
          play(video, selected.id);
        }}
        onRemove={(videoId) => selected && pl.removeTrack(selected.id, videoId)}
        onMove={(index, dir) => selected && pl.moveTrack(selected.id, index, dir)}
      />

      <YouTubeSearch
        key={`search-${homeKey}`}
        activeId={current?.id}
        onSelect={(video) => play(video, null)}
        onAdd={addToPlaylist}
        addedIds={addedIds}
        targetName={target?.name}
        likedIds={pl.likedIds}
        onToggleLike={pl.toggleLike}
      />
    </main>
  );
}
