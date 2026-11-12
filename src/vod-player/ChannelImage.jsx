import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const readyImages = new Map();
export const loadedImageSource = src => readyImages.get(src) || null;

function RetriedImage({ src, onError, onLoad, style, className = "", ...props }) {
  const [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(() => readyImages.has(src)), timer = useRef(null), element = useRef(null);
  const [cachedSource] = useState(() => loadedImageSource(src)), completed = useRef(null);
  const source = attempt ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}` : cachedSource || src;
  function finish(event) {
    const resolved = event.currentTarget.currentSrc || event.currentTarget.src;
    if (completed.current === resolved) return;
    completed.current = resolved;
    readyImages.delete(src);
    readyImages.set(src, resolved);
    if (readyImages.size > 256) readyImages.delete(readyImages.keys().next().value);
    setFailed(false);
    setLoaded(true);
    onLoad?.(event);
  }
  useLayoutEffect(() => {
    const image = element.current;
    if (image?.complete && image.naturalWidth > 0) finish({ currentTarget:image, target:image });
  }, [source]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <img {...props} ref={element} className={`channel-image ${className}`} src={source} style={{ ...style, opacity: loaded && !failed ? 1 : 0, visibility: failed ? "hidden" : style?.visibility }} onLoad={finish} onError={event => {
    readyImages.delete(src);
    completed.current = null;
    setFailed(true);
    if (attempt >= 2) { onError?.(event); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAttempt(value => value + 1), attempt ? 5000 : 1000);
  }} />;
}

export function ChannelImage(props) {
  return <RetriedImage key={props.src} {...props} />;
}
