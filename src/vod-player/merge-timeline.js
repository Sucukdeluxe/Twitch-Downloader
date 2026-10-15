export const TIMELINE_INSET = 12;
export function timelineLayout(files) {
  const known = files.map(file => Number(file.durationSeconds)).filter(value => Number.isFinite(value) && value > 0);
  const fallback = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 1;
  let elapsed = 0;
  const clips = files.map(file => {
    const ready = Number.isFinite(file.durationSeconds) && file.durationSeconds > 0;
    const duration = ready ? file.durationSeconds : fallback;
    const clip = { file, start: elapsed, duration, ready };
    elapsed += duration;
    return clip;
  });
  return { clips, duration: elapsed, ready: clips.every(clip => clip.ready) };
}
export function timelinePosition(clips, seconds) {
  const last = clips.at(-1);
  const limit = last ? last.start + last.duration : 0;
  const time = Math.max(0, Math.min(limit, Number.isFinite(seconds) ? seconds : 0));
  const clip = clips.find(entry => time < entry.start + entry.duration) || last;
  return clip ? { id: clip.file.id, offset: time - clip.start, seconds: time } : { id: '', offset: 0, seconds: 0 };
}
export function reorderedPosition(before, after, seconds) {
  const anchor = timelinePosition(before, seconds);
  const clip = after.find(entry => entry.file.id === anchor.id);
  if (clip) return clip.start + Math.min(anchor.offset, clip.duration);
  const index = Math.max(0, before.findIndex(entry => entry.file.id === anchor.id));
  return after[Math.min(index, after.length - 1)]?.start || 0;
}
export function insertionTarget(clips, id, seconds) {
  const remaining = clips.filter(clip => clip.file.id !== id);
  let index = remaining.findIndex(clip => seconds < clip.start + clip.duration / 2);
  if (index < 0) index = remaining.length;
  return { index, seconds: remaining[index]?.start ?? (clips.at(-1)?.start || 0) + (clips.at(-1)?.duration || 0) };
}
export function maximumZoom(clips) {
  const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const shortest = Math.min(...clips.map(clip => clip.duration).filter(value => value > 0));
  return Math.max(12, Math.min(4096, Number.isFinite(shortest) ? total / shortest * 1.2 : 12));
}
export function waveformPath(peaks, width, start = 0, end = 1) {
  if (!peaks?.length || width <= 0 || end <= start) return '';
  const count = Math.min(1000, Math.max(1, Math.ceil(width / 3)));
  let path = '';
  for (let channel = 0; channel < 2; channel++) {
    const values = peaks[channel] || peaks[0], center = channel ? 50 : 30;
    for (let index = 0; index < count; index++) {
      const from = Math.floor((start + index / count * (end - start)) * values.length);
      const to = Math.min(values.length, Math.max(from + 1, Math.ceil((start + (index + 1) / count * (end - start)) * values.length)));
      let value = 0;
      for (let sample = from; sample < to; sample++) value = Math.max(value, values[sample] || 0);
      const amplitude = Math.max(.5, value / 255 * 9);
      path += 'M' + (index * width / count).toFixed(1) + ' ' + (center - amplitude).toFixed(1) + 'v' + (amplitude * 2).toFixed(1);
    }
  }
  return path;
}
