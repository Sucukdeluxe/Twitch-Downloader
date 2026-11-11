export function viewerSampleAt(history, timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  for (let index = (history?.length || 0) - 1; index >= 0; index--) {
    const run = history[index];
    if (!run.length || timestamp < run[0].at || timestamp > run.at(-1).at + 30000) continue;
    let low = 0, high = run.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (run[middle].at <= timestamp) low = middle + 1;
      else high = middle;
    }
    const sample = run[low - 1];
    return sample && timestamp - sample.at <= 30000 ? sample : null;
  }
  return null;
}

export function viewerGapAt(gaps, timestamp) {
  return Number.isFinite(timestamp) && (gaps || []).some(([before, after]) => timestamp > before.at && timestamp < after.at);
}

function viewerBoundary(points, at, maxInterval) {
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].at < at) low = middle + 1;
    else high = middle;
  }
  const after = points[low], before = points[low - 1];
  if (after?.at === at) return after;
  if (!before || !after || after.at - before.at > maxInterval) return null;
  const fraction = (at - before.at) / (after.at - before.at);
  return { at, viewers: before.viewers + (after.viewers - before.viewers) * fraction };
}

function clipViewerRun(points, start, end, maxInterval = 30000) {
  const clipped = points.filter(point => point.at >= start && point.at <= end);
  const first = viewerBoundary(points, start, maxInterval), last = viewerBoundary(points, end, maxInterval);
  if (first && clipped[0]?.at !== start) clipped.unshift(first);
  if (last && clipped.at(-1)?.at !== end) clipped.push(last);
  return clipped;
}

export function viewerLine(points) {
  if (!points.length) return "";
  const pair = (x, y) => `${+x.toFixed(3)},${+y.toFixed(3)}`;
  const slopes = points.slice(1).map(([x,y], index) => {
    const [previousX,previousY] = points[index];
    return x > previousX ? (y - previousY) / (x - previousX) : 0;
  });
  const tangents = points.map((_,index) => {
    const before = slopes[index-1], after = slopes[index];
    return before * after > 0 ? 2 * before * after / (before + after) : 0;
  });
  return points.map(([x,y],index) => {
    if (!index) return `M${pair(x,y)}`;
    const [previousX,previousY] = points[index-1];
    if (points.length < 3 || x <= previousX || y === previousY) return `L${pair(x,y)}`;
    const third = (x - previousX) / 3;
    return `C${pair(previousX + third,previousY + tangents[index-1] * third)} ${pair(x - third,y - tangents[index] * third)} ${pair(x,y)}`;
  }).join(" ");
}

export function viewerCurve(history, parts, started, total, live = false, gaps = []) {
  if (!(total > 0)) return [];
  const spans = [];
  let wall = started, offset = 0;
  for (const part of parts || []) {
    if (Number.isFinite(part.started) && part.started > 0) wall = part.started;
    const duration = Number.isFinite(part.duration) ? Math.max(0, part.duration) : 0;
    if (Number.isFinite(wall) && wall > 0 && duration > 0) {
      const previous = spans.at(-1);
      if (previous && Math.abs(previous.end - wall) < 1) previous.end += duration * 1000;
      else spans.push({ start:wall, end:wall + duration * 1000, offset });
      wall += duration * 1000;
    }
    offset += duration;
  }
  const runs = (history || []).map(run => run.filter(point => Number.isFinite(point.at) && Number.isSafeInteger(point.viewers) && point.viewers >= 0));
  const finalSpan = spans.at(-1);
  const latestRun = runs.reduce((latest, run) => (run.at(-1)?.at ?? -Infinity) > (latest?.at(-1)?.at ?? -Infinity) ? run : latest, null);
  const lastSample = latestRun?.at(-1);
  if (live && finalSpan && lastSample && Math.abs(finalSpan.offset + (finalSpan.end - finalSpan.start) / 1000 - total) < 0.000001) {
    const age = finalSpan.end - lastSample.at;
    if (age > 0 && age <= 60000) latestRun.push({ at:finalSpan.end, viewers:lastSample.viewers });
  }
  const sources = [
    ...runs.map(points => ({ points, gap: false })),
    ...gaps.filter(points => points.length === 2 && points.every(point => Number.isFinite(point.at) && Number.isSafeInteger(point.viewers) && point.viewers >= 0) && points[1].at - points[0].at > 30000 && points[1].at - points[0].at <= 90000).map(points => ({ points, gap: true })),
  ];
  const series = spans.flatMap(span => sources.map(source => ({ gap: source.gap, points: clipViewerRun(source.points, span.start, span.end, source.gap ? 90000 : 30000)
    .map(point => ({ seconds:span.offset + (point.at - span.start) / 1000, viewers:point.viewers }))
  }))).filter(run => run.points.length);
  let peak = 1;
  for (const run of series) for (const point of run.points) peak = Math.max(peak, point.viewers);
  return series.map(({ points: run, gap }) => {
    const buckets = new Map();
    for (const point of run) {
      const key = Math.floor(point.seconds / total * 800);
      const bucket = buckets.get(key);
      if (!bucket) buckets.set(key, { first:point, last:point, min:point, max:point });
      else {
        bucket.last = point;
        if (point.viewers < bucket.min.viewers) bucket.min = point;
        if (point.viewers > bucket.max.viewers) bucket.max = point;
      }
    }
    const points = [...buckets.values()].flatMap(bucket => [...new Set([bucket.first,bucket.min,bucket.max,bucket.last])].sort((a,b) => a.seconds - b.seconds));
    const coordinates = points.map(point => [+(point.seconds / total * 1000).toFixed(3), +(32 - Math.max(point.viewers > 0 ? 2 : 0, point.viewers / peak * 29)).toFixed(3)]);
    const line = viewerLine(coordinates);
    return { line, area:gap ? "" : `${line} L${coordinates.at(-1)[0]},32 L${coordinates[0][0]},32 Z`, point:coordinates.length === 1 ? coordinates[0] : null, edge:Math.abs(points.at(-1).seconds - total) < 0.000001 ? coordinates.at(-1)[1] : null, ...(gap ? { gap:true } : {}) };
  });
}
