export function chapterAt(chapters, seconds, endpoint = chapters.at(-1)?.end) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const match = chapters.find(chapter => seconds >= chapter.start && seconds < chapter.end);
  if (match) return match;
  const last = chapters.at(-1);
  if (last && last.end > last.start && Number.isFinite(endpoint) && endpoint >= last.end && endpoint-last.end <= 2 && seconds >= last.end && seconds <= endpoint) return last;
  return last && last.end > last.start && Number.isFinite(endpoint) && Math.abs(seconds - endpoint) <= 0.000001 ? last : null;
}
export function chapterDuration(chapter) {
  const difference = chapter.end - chapter.start;
  const seconds = Number.isFinite(difference) ? Math.max(0, Math.floor(difference)) : 0;
  return `(${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s)`;
}
const signalColors = ['#00e5ff', '#ffb300', '#ff4081', '#76ff03', '#b388ff', '#ff6d00', '#40c4ff', '#ffea00', '#00e676', '#ff5252'];
const categoryKey = chapter => chapter?.game_id || chapter?.name || '';
export function chapterColor(chapter, chapters = [], colors = signalColors) {
  if (!colors.length) colors = signalColors;
  const key = categoryKey(chapter);
  if (!key) return '#777e8a';
  const keys = [...new Set(chapters.map(categoryKey).filter(Boolean))];
  const index = keys.indexOf(key);
  return colors[(index < 0 ? [...key].reduce((hash,char)=>(hash*31+char.charCodeAt(0))%colors.length,0) : index) % colors.length];
}
export function chapterGradient(chapters,total) {
  if (!total || !chapters.length) return null;
  return `linear-gradient(to right, ${chapters.map(chapter=>`${chapterColor(chapter,chapters)} ${Math.max(0,chapter.start/total*100)}% ${Math.min(100,chapter.end/total*100)}%`).join(', ')})`;
}
