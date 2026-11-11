export function chapterRange(chapters, id, total) {
  if (!id || !Number.isFinite(total) || total <= 0) return null;
  const chapter = chapters.find(row => row.id === id);
  if (!chapter || !Number.isFinite(chapter.start) || !Number.isFinite(chapter.end)) return null;
  const start = Math.max(0, chapter.start), end = Math.min(total, chapter.end);
  if (end <= start) return null;
  return { chapter, start, end, left: start / total, width: (end - start) / total, center: (start + end) / (2 * total) };
}
