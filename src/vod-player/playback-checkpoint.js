import { locateTime } from "./timeline.js";

const lifetime = 30 * 86400000;
const finite = value => typeof value === "number" && Number.isFinite(value);

export function validCheckpoint(value, now = Date.now()) {
  return value?.version === 1 && finite(value.updated) && value.updated <= now + 60000 && value.updated >= now - lifetime
    && finite(value.seconds) && value.seconds >= 0 && value.seconds <= 31536000
    && typeof value.partId === "string" && value.partId.length <= 256
    && finite(value.offset) && value.offset >= 0 && value.offset <= 31536000
    && typeof value.playing === "boolean"
    && finite(value.volume) && value.volume >= 0 && value.volume <= 1
    && finite(value.lastVolume) && value.lastVolume > 0 && value.lastVolume <= 1
    && finite(value.speed) && value.speed >= .25 && value.speed <= 4;
}

export function createPlaybackCheckpoint(userId, recordingId, environment = globalThis, now = Date.now) {
  const key = userId && recordingId ? `sr-playback:v1:${encodeURIComponent(userId)}` : null;
  let memory = [];
  function records() {
    try {
      const parsed = JSON.parse(environment.sessionStorage.getItem(key) || "[]");
      if (Array.isArray(parsed)) memory = parsed.filter(item => typeof item.id === "string" && validCheckpoint(item.state, now()));
    } catch {}
    return memory;
  }
  return {
    read() { return key ? records().find(item => item.id === recordingId)?.state || null : null; },
    write(value) {
      if (!key) return;
      const state = { ...value, version: 1, updated: now() };
      if (!validCheckpoint(state, now())) return;
      memory = [{ id: recordingId, state }, ...records().filter(item => item.id !== recordingId)].slice(0, 50);
      try { environment.sessionStorage.setItem(key, JSON.stringify(memory)); } catch {}
    },
  };
}

export function checkpointPosition(checkpoint, parts, fallback = 0) {
  const index = checkpoint ? parts.findIndex(part => String(part.id) === checkpoint.partId) : -1;
  if (index >= 0) return {
    index, offset: Math.min(checkpoint.offset, Math.max(0, (parts[index].duration || 0) - .01)),
    total: parts.reduce((sum, part) => sum + Math.max(0, part.duration || 0), 0),
  };
  return locateTime(parts, checkpoint?.seconds ?? fallback);
}

export function checkpointSnapshot({ parts, index, currentTime, target = null, pending = null, playing, volume, lastVolume, speed }) {
  if (!parts.length || index < 0 || !parts[index]) return null;
  if (target !== null) {
    const located = locateTime(parts, target);
    index = located.index;
    currentTime = located.offset;
  } else if (pending !== null) currentTime = pending;
  if (!finite(currentTime)) return null;
  const offset = Math.max(0, Math.min(currentTime, Math.max(0, parts[index].duration || 0)));
  return {
    seconds: parts.slice(0, index).reduce((sum, part) => sum + Math.max(0, part.duration || 0), 0) + offset,
    partId: String(parts[index].id), offset, playing: Boolean(playing), volume, lastVolume, speed: Number(speed),
  };
}
