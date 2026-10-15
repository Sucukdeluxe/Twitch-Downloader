import { mediaSource, setMediaSource } from './media-source.js';
import { seekableEnd, SEEK_TOLERANCE } from './timeline.js';

export function latestSeek(apply, delay = 50, timers = globalThis) {
  let timer = null, target = null;
  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    target = null;
  };
  const flush = () => {
    const value = target;
    cancel();
    if (value !== null) apply(value);
  };
  return {
    get pending() { return target !== null; },
    request(value) {
      cancel();
      target = value;
      timer = timers.setTimeout(flush, delay);
    },
    flush,
    cancel,
  };
}

export async function playWithFallback(element, current, onMuted, { allowMutedFallback = true } = {}) {
  try { await element.play(); return current() ? "playing" : "obsolete"; }
  catch (error) {
    if (!current()) return "obsolete";
    if (error.name !== "NotAllowedError") {
      if (error.name === "AbortError") return "interrupted";
      throw error;
    }
    if (element.muted || !allowMutedFallback) return "blocked";
    element.muted = true;
    onMuted();
    try { await element.play(); return current() ? "muted" : "obsolete"; }
    catch (fallback) {
      if (!current()) return "obsolete";
      if (fallback.name === "NotAllowedError") return "blocked";
      if (fallback.name === "AbortError") return "interrupted";
      throw fallback;
    }
  }
}

export function frameAtTarget(element, pending, target) {
  return pending === null && element.readyState >= 2 && !element.seeking && Math.abs(element.currentTime-target) < 1;
}

export function activateMedia(previous, element, source, { play, volume, speed }) {
  const changed = mediaSource(element) !== source;
  if (previous !== element) {
    previous.pause();
    previous.muted = true;
    previous.preload = "none";
  } else if (changed && !element.paused) element.pause();
  element.volume = volume;
  element.muted = volume === 0;
  element.playbackRate = Number(speed);
  element.preload = play ? "auto" : "metadata";
  if (changed) {
    setMediaSource(element, source);
  }
  if (!play && !element.paused) element.pause();
  return changed;
}

export function applyMediaPosition(element, seconds) {
  if (element.readyState < 1 || !Number.isFinite(element.duration)) return false;
  const target = Math.max(0, Math.min(seconds, seekableEnd(element.duration)));
  if (Math.abs(element.currentTime - target) > SEEK_TOLERANCE) element.currentTime = target;
  return true;
}
