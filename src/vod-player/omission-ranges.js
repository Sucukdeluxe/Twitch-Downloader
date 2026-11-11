export function omissionGaps(selection, ranges, editing = null) {
  const from = Math.round(selection.start * 1000), to = Math.round(selection.end * 1000);
  const occupied = ranges.filter((_, index) => index !== editing).map(range => ({
    start:Math.max(from, Math.round(range.start * 1000)), end:Math.min(to, Math.round(range.end * 1000)),
  })).filter(range => range.end > range.start).sort((a, b) => a.start - b.start);
  const gaps = [];
  let cursor = from;
  for (const range of occupied) {
    if (range.start > cursor) gaps.push({ start:cursor / 1000, end:range.start / 1000 });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < to) gaps.push({ start:cursor / 1000, end:to / 1000 });
  return gaps;
}

export function omissionFits(range, gaps) {
  const start = Math.round(range.start * 1000), end = Math.round(range.end * 1000);
  return end > start && gaps.some(gap => start >= Math.round(gap.start * 1000) && end <= Math.round(gap.end * 1000));
}

export function omissionGap(range, gaps) {
  return gaps.find(gap => range.start >= gap.start && range.end <= gap.end)
    || gaps.find(gap => range.start >= gap.start && range.start < gap.end)
    || gaps.find(gap => gap.start >= range.start) || gaps.at(-1) || null;
}

export function boundOmission(range, bounds) {
  const from = Math.round(bounds.start * 1000), to = Math.round(bounds.end * 1000);
  const start = Math.max(from, Math.min(Math.round(range.start * 1000), to - 1));
  return { start:start / 1000, end:Math.max(start + 1, Math.min(Math.round(range.end * 1000), to)) / 1000 };
}
