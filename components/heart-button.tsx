"use client";
// components/heart-button.tsx
// ปุ่มหัวใจ “ถูกใจ” ใช้ร่วมกันทุกที่ (คลิปที่กำลังเล่น / ผลการค้นหา / รายการใน playlist)
// กดแล้วเป็นหัวใจแดงทึบ ยังไม่กดเป็นหัวใจเส้นขอบ

const RED = "#e5254f";

interface Props {
  liked: boolean;
  onClick: () => void;
  size?: number;
}

export default function HeartButton({ liked, onClick, size = 22 }: Props) {
  const label = liked ? "เอาออกจากถูกใจ" : "กดถูกใจ";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={liked}
      aria-label={label}
      title={label}
      style={{ background: "none", border: 0, padding: "0.25rem", cursor: "pointer", lineHeight: 0, color: "#666" }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={liked ? RED : "none"}
        stroke={liked ? RED : "currentColor"}
        strokeWidth="2"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    </button>
  );
}
