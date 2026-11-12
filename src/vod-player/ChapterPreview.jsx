import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Gamepad2 } from "lucide-react";
import { ChannelImage } from "./ChannelImage.jsx";

export function ChapterPreview({ fraction, chapter, time, timestamp, viewer, fallback, color, children }) {
  const element = useRef(null), measurement = useRef(null), [width, setWidth] = useState(0), [targetWidth, setTargetWidth] = useState(0);
  const name = chapter?.name || fallback, image = chapter?.image;
  const identity = `${chapter?.id || ""}:${name || ""}:${image || ""}`;
  const previous = useRef({ identity, name, image, time, timestamp }), [outgoing, setOutgoing] = useState(null);
  useLayoutEffect(() => {
    if (previous.current.identity !== identity) setOutgoing(previous.current);
    previous.current = { identity, name, image, time, timestamp };
  }, [identity, name, image, time, timestamp]);
  useEffect(() => {
    if (!outgoing) return;
    const timer = setTimeout(() => setOutgoing(null), 220);
    return () => clearTimeout(timer);
  }, [outgoing]);
  useLayoutEffect(() => {
    const measure = () => {
      setWidth(element.current?.getBoundingClientRect().width || 0);
      if (measurement.current) setTargetWidth(Math.ceil(measurement.current.getBoundingClientRect().width + 82));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element.current);
    if (measurement.current) observer.observe(measurement.current);
    return () => observer.disconnect();
  }, [children, name, time, timestamp?.label]);
  const half = width / 2;
  const cover = (source) => <span className="chapter-preview-cover"><Gamepad2 size={21}/>{source && <ChannelImage src={source} alt="" loading="eager"/>}</span>;
  return <span ref={element} className={`archive-seek-preview chapter-preview${name ? " has-cover" : ""}${viewer ? " has-viewers" : ""}`} style={{ ...(name && targetWidth ? {width:targetWidth} : {}), "--preview-color":color, left: `clamp(min(${half}px, 50%), ${fraction * 100}%, max(calc(100% - ${half}px), 50%))` }}>
    {name ? <>
      <span ref={measurement} className="chapter-preview-measure" aria-hidden="true"><span>{time} - {name}</span>{timestamp && <span>{timestamp.label}</span>}</span>
      {outgoing && <span key={`out-${outgoing.identity}`} className="chapter-preview-layer is-outgoing" aria-hidden="true">{cover(outgoing.image)}<span className="chapter-preview-copy"><span className="chapter-preview-title">{outgoing.time} - {outgoing.name}</span>{outgoing.timestamp && <time className="chapter-preview-timestamp" dateTime={outgoing.timestamp.dateTime}>{outgoing.timestamp.label}</time>}</span></span>}
      <span key={identity} className="chapter-preview-layer is-incoming">{cover(image)}<span className="chapter-preview-copy"><span className="chapter-preview-title"><span className="chapter-preview-time">{time}</span> - {name}</span>{timestamp && <time className="chapter-preview-timestamp" dateTime={timestamp.dateTime}>{timestamp.label}</time>}{viewer}</span></span>
    </> : children}
  </span>;
}
