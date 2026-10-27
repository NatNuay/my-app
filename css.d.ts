// บอก TypeScript ว่าการ import ไฟล์ .css เฉย ๆ (เช่น import "./youtube-player.css") ใช้ได้
// ไม่เกี่ยวกับการทำงานของเว็บ Next.js จัดการ CSS ให้เอง แต่ช่วยให้ VS Code ไม่ขีดเส้นแดง
declare module "*.css";
