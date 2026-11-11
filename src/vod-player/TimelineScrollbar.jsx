import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function TimelineScrollbar({ viewport, contentWidth, language, onChange }) {
  const rail = useRef(null), drag = useRef(null), latest = useRef(null);
  const [width, setWidth] = useState(0), [dragging, setDragging] = useState(false);
  const max = Math.max(0, contentWidth - viewport.width);
  const thumbWidth = Math.min(width, Math.max(64, width * viewport.width / Math.max(1, contentWidth)));
  const travel = Math.max(0, width - thumbWidth), left = max > 0 ? Math.min(max, viewport.left) / max * travel : 0;
  latest.current = { max, travel, thumbWidth, viewport, onChange };
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return;
    const resize = () => setWidth(node.clientWidth), observer = new ResizeObserver(resize);
    observer.observe(node); resize(); return () => observer.disconnect();
  }, []);
  const position = (clientX, grab) => {
    const current = latest.current;
    const offset = clientX - rail.current.getBoundingClientRect().left - grab;
    return current.travel > 0 ? Math.max(0, Math.min(current.max, offset / current.travel * current.max)) : 0;
  };
  const begin = event => {
    if (event.button !== 0 || !max) return;
    event.preventDefault(); event.stopPropagation(); rail.current.dataset.pointerFocus = 'true'; rail.current.focus({ preventScroll: true });
    const onThumb = event.target.closest('.merge-scrollbar-thumb');
    if (!onThumb) { onChange(position(event.clientX, thumbWidth / 2), true); return; }
    drag.current = { grab: event.clientX - onThumb.getBoundingClientRect().left };
    setDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
    onChange(viewport.left, false);
  };
  const finish = () => { drag.current = null; setDragging(false); };
  return <div className="merge-scrollbar" data-dragging={dragging}>
    <div className="merge-scrollbar-spacer" aria-hidden="true"/>
    <button type="button" className="merge-scrollbar-arrow" aria-label={language === 'en' ? 'Scroll timeline left' : 'Timeline nach links scrollen'} disabled={viewport.left < 1 || max === 0} onClick={() => onChange(Math.max(0, viewport.left - viewport.width * .7), true)}><ChevronLeft/></button>
    <div className="merge-scrollbar-rail" ref={rail} role="scrollbar" tabIndex={max > 0 ? 0 : -1} aria-label={language === 'en' ? 'Horizontal timeline position' : 'Horizontale Timeline-Position'} aria-controls="merge-timeline-viewport" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(Math.min(max, viewport.left))} aria-disabled={max === 0} onPointerDown={begin} onPointerMove={event => { if (drag.current) onChange(position(event.clientX, drag.current.grab), false); }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onBlur={() => { delete rail.current.dataset.pointerFocus; }} onKeyDown={event => {
      delete rail.current.dataset.pointerFocus;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? max : event.key === 'ArrowLeft' ? viewport.left - 40 : event.key === 'ArrowRight' ? viewport.left + 40 : event.key === 'PageUp' ? viewport.left - viewport.width * .8 : event.key === 'PageDown' ? viewport.left + viewport.width * .8 : null;
      if (target !== null) { event.preventDefault(); event.stopPropagation(); onChange(Math.max(0, Math.min(max, target)), true); }
    }}><div className="merge-scrollbar-thumb" style={{ width: thumbWidth, transform: 'translateX(' + left + 'px)' }}><span/></div></div>
    <button type="button" className="merge-scrollbar-arrow" aria-label={language === 'en' ? 'Scroll timeline right' : 'Timeline nach rechts scrollen'} disabled={viewport.left >= max - 1 || max === 0} onClick={() => onChange(Math.min(max, viewport.left + viewport.width * .7), true)}><ChevronRight/></button>
  </div>;
}
