export function bufferAhead(element) {
  for (let i = 0; i < element.buffered.length; i++) {
    if (element.buffered.start(i) <= element.currentTime + 0.1 && element.buffered.end(i) > element.currentTime) return element.buffered.end(i) - element.currentTime;
  }
  return 0;
}

export function playbackMetrics(now = () => performance.now()) {
  let waiting = null, count = 0, milliseconds = 0;
  return {
    wait() { if (waiting === null) { waiting = now(); count++; } },
    finish() { if (waiting !== null) { milliseconds += now() - waiting; waiting = null; } },
    snapshot(element) {
      return { bufferSeconds: bufferAhead(element).toFixed(2), rebufferCount: String(count), rebufferMs: String(Math.round(milliseconds + (waiting === null ? 0 : now() - waiting))) };
    },
  };
}
