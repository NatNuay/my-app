export type VideoCategory = "follow" | "tutorial" | "other";

// Tutorial takes precedence over mirrored/slow/practice: tutorials often include those words too.
const TUTORIAL = /tutorial|สอนเต้น|สอนท่า|วิธีเต้น|ฝึกเต้นทีละ|step[\s-]*by[\s-]*step|breakdown|how\s+to\s+(?:dance|learn)|learn\s+(?:the\s+)?(?:dance|choreo(?:graphy)?)|안무\s*설명|춤\s*강좌/i;
const WORKOUT = /workout|aerobic|zumba|fitness|cardio|exercise|ซุมบ้า|แอโรบิก|ออกกำลังกาย/i;
const FOLLOW = /dance[\s_-]*practice|dance[\s_-]*cover|dance[\s_-]*along|choreo(?:graphy)?|mirrored|dance[\s_-]*performance|performance[\s_-]*video|เต้นตาม|เต้นคัฟเวอร์|ซ้อมเต้น|안무\s*영상/i;

export function classifyVideo(title: string, tags: string[] = [], description = ""): VideoCategory {
  const name = title.normalize("NFKC");
  if (TUTORIAL.test(name)) return "tutorial";
  if (WORKOUT.test(name)) return "other";
  if (FOLLOW.test(name)) return "follow";
  // A clear title wins over promotional tags or links to other video types in the description.
  const metadata = `${tags.join(" ")} ${description.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 300)}`;
  if (TUTORIAL.test(metadata)) return "tutorial";
  if (WORKOUT.test(metadata)) return "other";
  if (FOLLOW.test(metadata)) return "follow";
  return "other";
}
