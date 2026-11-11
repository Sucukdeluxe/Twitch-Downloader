import React, { useLayoutEffect, useState } from 'react';
import { chapterColor } from './chapters.js';

export function CategoryColors({ chapters, from = 0, to, endpoint, className, height, opacity = 1, fallback = 'transparent' }) {
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    if (!height) return;
    const measure = () => setPixelRatio(window.devicePixelRatio || 1);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [height]);
  const span = Math.max(.001, to - from);
  return <svg className={className} style={{ overflow: 'visible', height: height ? Math.round(height * pixelRatio) / pixelRatio : undefined }} viewBox="0 0 1000 1" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
    <rect width="1000" height="1" fill={fallback}/>
    {chapters.map(chapter => {
      const ending = chapter === chapters.at(-1) && Number.isFinite(endpoint) ? endpoint : chapter.end;
      const start = Math.max(0, Math.min(1000, (chapter.start - from) / span * 1000));
      const end = Math.max(start, Math.min(1000, (ending - from) / span * 1000));
      return end > start && <rect key={chapter.id} x={start} width={end - start} height="1" fill={chapterColor(chapter, chapters)} fillOpacity={opacity}/>;
    })}
  </svg>;
}
