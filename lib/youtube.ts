// lib/youtube.ts
// ชนิดข้อมูลกลาง + ตัวโหลด YouTube IFrame API (โหลดสคริปต์ครั้งเดียวทั้งแอป)

export interface VideoItem {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  durationSec: number;
}

export type SearchMode = "all" | "follow" | "tutorial";

// ชนิดขั้นต่ำของ YT.Player ที่เราใช้ (ไม่ต้องติดตั้ง @types/youtube)
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  unloadModule(module: string): void;
  setPlaybackQuality(quality: string): void;
  getPlaybackQuality(): string;
  getAvailableQualityLevels(): string[];
  loadVideoById(
    arg: string | { videoId: string; startSeconds?: number; suggestedQuality?: string },
  ): void;
  destroy(): void;
}

export interface YTEvent {
  data: number;
}

export const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

export function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube IFrame API ใช้ได้เฉพาะฝั่งเบราว์เซอร์"));
  }
  if (window.YT?.Player) return Promise.resolve();

  if (!apiPromise) {
    apiPromise = new Promise<void>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        apiPromise = null;
        reject(new Error("โหลด YouTube IFrame API ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่"));
      };
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
