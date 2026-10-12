import { OmissionBands } from './OmissionEditor.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, ZoomIn } from 'lucide-react';
import { CategoryColors } from './CategoryColors.jsx';
import { timeLabel } from './timeline.js';
import { beginFineSeek, alignFineSeek, moveFineSeek, fineWindow } from './fine-seek.js';
import { FineSeekPreview } from './FineSeekPreview.jsx';
import { Tooltip } from './Tooltip.jsx';

export function cutTime(seconds) {
  const value = Math.round(Math.max(0, seconds) * 1000);
  return `${timeLabel(Math.floor(value / 1000))}.${String(value % 1000).padStart(3, '0')}`;
}

export function RangeMarkers({ duration, range, onChange, text, from = 0, to = duration, compact = false, onInteraction, trackWidth = 1000, finePreview, onPreviewChange, limits, variant = 'excerpt', disabled = false, minimumRange = .001, format = cutTime, handleIds, onDragStart, onDragEnd, onDragCancel, trackInset = 7 }) {
  const track = useRef(null), drag = useRef(null);
  const [preview, setPreview] = useState(null), [dragging, setDragging] = useState(false);
  const alignPreview = useCallback(bounds => {
    if (!drag.current?.fineState?.fine) return;
    const aligned = alignFineSeek(drag.current.fineState, bounds);
    if (aligned !== drag.current.fineState) { drag.current.fineState = aligned; setPreview(aligned); }
  }, []);
  const lifecycle = useRef(null);
  lifecycle.current = { onDragStart, onDragEnd, onDragCancel };
  const cancelDrag = useCallback((commit = false) => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    setPreview(null);
    if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
    if (current) {
      if (commit === true) lifecycle.current.onDragEnd?.();
      else lifecycle.current.onDragCancel?.();
    }
  }, []);
  useEffect(() => {
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('resize', cancelDrag);
    return () => { window.removeEventListener('blur', cancelDrag); window.removeEventListener('resize', cancelDrag); cancelDrag(); };
  }, [cancelDrag]);
  const previewOpen = Boolean(preview);
  useEffect(() => {
    onPreviewChange?.(previewOpen);
    return () => onPreviewChange?.(false);
  }, [previewOpen, onPreviewChange]);
  const span = Math.max(.001, to - from);
  const minimum = limits?.start ?? 0, maximum = limits?.end ?? duration;
  const width = Math.max(62, trackWidth);
  const clampCenter = value => Math.max(14, Math.min(width - 14, value));
  const boundary = { start: (range.start - from) / span, end: (range.end - from) / span };
  let startCenter = clampCenter(boundary.start * width), endCenter = clampCenter(boundary.end * width);
  if (endCenter - startCenter < 34) {
    const center = Math.max(31, Math.min(width - 31, (startCenter + endCenter) / 2));
    startCenter = center - 17; endCenter = center + 17;
  }
  const grip = compact ? { start: startCenter / width, end: endCenter / width } : boundary;
  function update(which, value, source = 'keyboard') {
    const start = which === 'start' ? Math.max(minimum, Math.min(value, range.end - minimumRange)) : range.start;
    const end = which === 'end' ? Math.min(maximum, Math.max(value, range.start + minimumRange)) : range.end;
    if (start === range.start && end === range.end) return;
    onChange(start, end, { source, boundary: which });
  }
  return <div ref={track} className={`vod-range-markers is-${variant}${compact ? ' is-compact' : ''}`} data-dragging={dragging || undefined} style={compact ? { left:trackInset, right:trackInset } : undefined}>
    {compact && <svg className="vod-range-connectors" viewBox={`0 0 1000 ${variant === 'omission' ? 88 : 60}`} preserveAspectRatio="none" aria-hidden="true">
      {['start', 'end'].map(which => <path key={which} d={variant === 'omission' ? `M ${grip[which] * 1000} 64 L ${boundary[which] * 1000} 56 V 36` : `M ${grip[which] * 1000} 24 L ${boundary[which] * 1000} 34 V 54`}/>)}
    </svg>}
    <span className="vod-range-band" style={{ left: `${(range.start - from) / span * 100}%`, width: `${(range.end - range.start) / span * 100}%` }}/>
    {['start', 'end'].map(which => <button key={which} type="button" role="slider" className={`vod-range-handle is-${which}`}
      id={handleIds?.[which]} disabled={disabled} aria-disabled={disabled || undefined} aria-label={text[which]} aria-orientation="horizontal" aria-valuemin={which === 'start' ? minimum : range.start + minimumRange}
      aria-valuemax={which === 'start' ? range.end - minimumRange : maximum} aria-valuenow={range[which]} aria-valuetext={format(range[which])}
      title={`${text[which]}: ${format(range[which])}`} style={{ left: `${grip[which] * 100}%` }}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault(); event.stopPropagation(); onInteraction?.();
        lifecycle.current.onDragStart?.(which);
        event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        const bounds = track.current.getBoundingClientRect();
        const fineState = { ...beginFineSeek({ x:event.clientX, y:event.clientY, bounds, total:duration, position:range[which], width:480 }),
          value:range[which], initialValue:range[which], anchor:range[which], window:fineWindow(range[which], duration) };
        drag.current = { id:event.pointerId, element:event.currentTarget, x:event.clientX, value:range[which], span, width:bounds.width, fineState, previewContext:finePreview };
      }}
      onPointerMove={event => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation();
        const current = drag.current;
        if (which === 'start' && current.previewContext && (current.fineState.fine || current.fineState.y - event.clientY >= 28)) {
          const boundaries = current.previewContext.chapters.flatMap(chapter => [chapter.start, chapter.end]);
          const next = moveFineSeek(current.fineState, event.clientX, event.clientY, boundaries, event.altKey);
          const value = Math.max(from, minimum, Math.min(to, maximum, range.end - minimumRange, next.value));
          current.fineState = { ...next, value, snapped:next.snapped && value === next.value };
          setPreview(current.fineState);
          update(which, value, 'pointer');
        } else {
          const raw = current.value + (event.clientX - current.x) / Math.max(1, current.width) * current.span;
          const value = Math.max(from, minimum, Math.min(to, maximum, Math.round(raw * 10) / 10));
          const anchor = which === 'start' ? Math.max(0, Math.min(value, range.end - minimumRange)) : value;
          current.fineState = { ...current.fineState, value:anchor, anchor, window:fineWindow(anchor, duration) };
          update(which, value, 'pointer');
        }
      }}
      onPointerUp={event => { event.stopPropagation(); if (drag.current?.id === event.pointerId) cancelDrag(true); }}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancelDrag(); return; }
        if (drag.current) return;
        const step = event.shiftKey ? 10 : event.altKey ? .001 : .1;
        const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
        if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); event.stopPropagation(); onInteraction?.();
        update(which, delta === undefined ? event.key === 'Home' ? minimum : maximum : Math.round((range[which] + delta) * 1000) / 1000);
      }}><span>{which === 'start' ? 'I' : 'O'}</span></button>)}
    {finePreview && <FineSeekPreview {...(drag.current?.previewContext || finePreview)} preview={preview} anchorRef={track} total={duration}
      onAlign={alignPreview} kind="cut-start"/>}
  </div>;
}

export function CutTimeline({ duration, range, position, chapters, onChange, onSeek, text, finePreview, omissions = [], active = true, onSelectOmission }) {
  const track = useRef(null);
  const [view, setView] = useState(null);
  function selectionView() {
    const padding = Math.max(2, (range.end - range.start) * .15);
    return { from: Math.max(0, range.start - padding), to: Math.min(duration, range.end + padding) };
  }
  useEffect(() => {
    if (view && (range.start < view.from || range.end > view.to || view.to > duration)) setView(selectionView());
  }, [range.start, range.end, duration]);
  const from = view?.from ?? 0, to = view?.to ?? duration, span = Math.max(.001, to - from);
  const ticks = Array.from({ length: 7 }, (_, index) => from + span * index / 6);
  const visibleChapters = chapters.filter(chapter => chapter.end > from && chapter.start < to).map(chapter => ({
    chapter, start: (Math.max(from, chapter.start) - from) / span, end: (Math.min(to, chapter.end) - from) / span,
  }));
  function seekAt(event) {
    const bounds = track.current.getBoundingClientRect();
    onSeek(Math.max(from, Math.min(to, from + (event.clientX - bounds.left) / bounds.width * span)));
  }
  return <div className="vod-selection">
    {createPortal(<div className="vod-timeline-view" role="group" aria-label={text.timelineView}>
      <button type="button" aria-pressed={!view} onClick={() => setView(null)}><Maximize2 size={15} aria-hidden="true"/>{text.overview}</button>
      <button type="button" aria-pressed={Boolean(view)} disabled={!active} onClick={() => setView(selectionView())}><ZoomIn size={15} aria-hidden="true"/>{text.zoomSelection}</button>
    </div>, document.getElementById('clipTimelineView'))}
    <div ref={track} className="vod-selection-track" onClick={seekAt}>
      <div className="vod-selection-chapters">
        <CategoryColors className="vod-selection-colors" chapters={chapters} from={from} to={to} opacity={.12}/>
        {visibleChapters.map(({ chapter, start, end }) => <Tooltip key={chapter.id} content={<><strong>{chapter.name}</strong><time>{cutTime(chapter.start)} – {cutTime(chapter.end)}</time></>}>
          <span tabIndex={0} style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }}><span>{chapter.name}</span></span>
        </Tooltip>)}
      </div>
      <CategoryColors className="vod-selection-stripe" height={3} chapters={chapters} from={from} to={to}/>
      <OmissionBands ranges={omissions} from={from} to={to} onSelect={onSelectOmission} label={text.range}/>
      {active && <RangeMarkers duration={duration} range={range} onChange={onChange} text={text} from={from} to={to} finePreview={finePreview}/>}
      {position >= from && position <= to && <i className="vod-selection-playhead" title={cutTime(position)} style={{ left: `${(position - from) / span * 100}%` }}/>} 
    </div>
    <div className="vod-selection-labels" aria-hidden="true">{ticks.map((value, index) => <span key={index}>{view && span < 10 ? cutTime(value) : timeLabel(value)}</span>)}</div>
  </div>;
}
