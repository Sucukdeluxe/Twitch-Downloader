export const SEEK_TOLERANCE = 0.01;

export function seekableEnd(duration) {
  return Math.max(0, duration - 0.01);
}

export function isAtSeekableEnd(position, duration) {
  return !(duration > 0) || position >= seekableEnd(duration) - SEEK_TOLERANCE - 0.000001;
}

export function locateTime(parts, seconds) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.duration || 0), 0);
  const target = Math.max(0, Math.min(Number(seconds) || 0, seekableEnd(total)));
  let start = 0;
  for (let index = 0; index < parts.length; index++) {
    const duration = Math.max(0, parts[index].duration || 0);
    if (target < start + duration || index === parts.length - 1)
      return { index, offset: Math.max(0, target - start), total };
    start += duration;
  }
  return { index: 0, offset: 0, total };
}

export function remapTimelineTime(seconds, previous, current) {
  if (!previous?.length || !current?.length) return seconds;
  let before = 0;
  for (let index = 0; index < previous.length; index++) {
    const part = previous[index], duration = Math.max(0, part.duration || 0);
    if (seconds < before + duration || index === previous.length - 1) {
      const nextIndex = current.findIndex(candidate => candidate.id === part.id);
      if (nextIndex < 0) return seconds;
      const offset = Math.max(0, Math.min(seconds - before, Math.max(0, current[nextIndex].duration || 0)));
      return current.slice(0, nextIndex).reduce((sum, item) => sum + Math.max(0, item.duration || 0), 0) + offset;
    }
    before += duration;
  }
  return seconds;
}

export function timeLabel(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
