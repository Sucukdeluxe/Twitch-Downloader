import Hls from 'hls.js';

const sources = new WeakMap();

export function mediaSource(element) {
  return sources.get(element)?.url || element.getAttribute('src');
}

export function clearMediaSource(element) {
  sources.get(element)?.hls?.destroy();
  sources.delete(element);
  element.removeAttribute('src');
  element.load();
}

export function setMediaSource(element, url) {
  if (mediaSource(element) === url) return;
  clearMediaSource(element);
  if (new URL(url, location.href).pathname.endsWith('.m3u8') && Hls.isSupported()) {
    const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30 });
    sources.set(element, { url, hls });
    hls.on(Hls.Events.ERROR, (_, error) => {
      if (error.fatal && sources.get(element)?.hls === hls) {
        element.dataset.playbackError = error.details;
        element.dispatchEvent(new Event('error'));
      }
    });
    hls.loadSource(url);
    hls.attachMedia(element);
  } else {
    sources.set(element, { url });
    element.src = url;
    element.load();
  }
}
