import React, { useEffect, useState } from "react";
import { ChapterPreview } from "./ChapterPreview.jsx";
import { timeLabel } from "./timeline.js";
import { chapterColor } from "./chapters.js";

export function ChapterRangePreview({ range, chapters, fallback, suppressed = false }) {
  const [last, setLast] = useState(range);
  useEffect(() => {
    if (range) { setLast(range); return; }
    const timer = setTimeout(() => setLast(null), 180);
    return () => clearTimeout(timer);
  }, [range]);
  const shown = range || last;
  if (!shown) return null;
  return <div className={`chapter-range-preview${range ? " is-visible" : ""}`} hidden={suppressed} aria-hidden="true" style={{ "--chapter-highlight": chapterColor(shown.chapter, chapters) }}>
    <span className="chapter-range-band" style={{ left: `${shown.left * 100}%`, width: `${shown.width * 100}%` }}><i/><i/></span>
    <ChapterPreview fraction={shown.center} chapter={shown.chapter} time={`${timeLabel(shown.start)} – ${timeLabel(shown.end)}`} fallback={fallback} color={chapterColor(shown.chapter, chapters)}/>
  </div>;
}
