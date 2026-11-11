export const clampTime = (value, total) => Math.max(0, Math.min(Number.isFinite(value) ? value : 0, Math.max(0, total)));

export function fineWindow(center, total) {
  const span = Math.min(60, Math.max(0, total));
  const start = Math.max(0, Math.min(center - span / 2, total - span));
  return { start, end:start + span, span };
}

export function pointerTime(x, bounds, total) {
  return clampTime((x - bounds.left - 7) / Math.max(1, bounds.width - 14) * total, total);
}

export function beginFineSeek({ x, y, bounds, total, position, width }) {
  const thumb = bounds.left + 7 + clampTime(position, total) / total * Math.max(1, bounds.width - 14);
  const value = Math.abs(x - thumb) <= 12 ? clampTime(position, total) : pointerTime(x, bounds, total);
  return { x, y, bounds, total, width:Math.max(1, width - 32), value, initialValue:value, original:position, fine:false, snapped:false, anchor:value, anchorX:x, window:fineWindow(value, total) };
}

export function alignFineSeek(state, bounds) {
  if (!state.fine || !(bounds?.width > 0)) return state;
  if (Math.abs(state.rulerLeft - bounds.left) < .01 && Math.abs(state.width - bounds.width) < .01) return state;
  const fraction = Math.max(0, Math.min(1, (state.anchorX - bounds.left) / bounds.width));
  const span = Math.min(60, state.total);
  const start = state.anchor - fraction * span;
  return { ...state, width:bounds.width, rulerLeft:bounds.left, window:{ start, end:start + span, span } };
}

export function moveFineSeek(state, x, y, boundaries, unsnapped = false) {
  if (!state.fine && state.y - y >= 28) {
    return { ...state, fine:true, anchor:state.value, anchorX:x, window:fineWindow(state.value, state.total) };
  }
  if (!state.fine) {
    const value = Math.abs(x-state.x)<2 ? state.initialValue : pointerTime(x, state.bounds, state.total);
    return { ...state, value, anchor:value, window:fineWindow(value, state.total) };
  }
  const minimum = Math.max(0, state.window.start), maximum = Math.min(state.total, state.window.end);
  const raw = Math.max(minimum, Math.min(maximum, state.anchor + (x - state.anchorX) * state.window.span / state.width));
  const threshold = state.window.span / state.width * 6;
  const nearest = unsnapped ? null : boundaries.filter(time => Number.isFinite(time) && time >= minimum && time <= maximum)
    .reduce((best, time) => Math.abs(time - raw) < Math.abs((best ?? Infinity) - raw) ? time : best, null);
  const snapped = nearest !== null && Math.abs(nearest - raw) <= threshold;
  return { ...state, value:snapped ? nearest : Math.max(minimum,Math.min(maximum,Math.round(raw * 10) / 10)), snapped };
}

export function finishFineSeek(state, x, y, boundaries, unsnapped = false) {
  const selection = moveFineSeek(state, x, y, boundaries, unsnapped);
  return selection.fine ? selection : { ...selection, value:pointerTime(x, state.bounds, state.total) };
}

export function fineTicks(window, width) {
  if (!window.span) return [];
  const step = window.span <= 10 ? 1 : 5;
  const labelStep = width < 280 ? (window.span <= 10 ? 4 : 30) : (window.span <= 10 ? 2 : 10);
  const result = [];
  for (let time = Math.ceil(window.start / step) * step; time <= window.end; time += step) {
    result.push({ time, fraction:(time-window.start)/window.span, major:time % labelStep === 0 });
  }
  return result;
}
