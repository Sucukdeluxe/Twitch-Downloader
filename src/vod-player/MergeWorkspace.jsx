import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Files, GripVertical, Layers, MonitorPlay, Plus, Redo2, Trash2, Undo2, Volume2, VolumeX, Magnet, RotateCw, ScanLine } from 'lucide-react';
import { ArchivePlayer } from './ArchivePlayer.jsx';
import { Tooltip } from './Tooltip.jsx';
import { playerTexts } from './texts.js';
import { TIMELINE_INSET, timelineLayout, timelinePosition, reorderedPosition, insertionTarget, maximumZoom, waveformPath } from './merge-timeline.js';
import './merge-workspace.css';

const clock = value => { const seconds = Math.floor(Math.max(0, value || 0)); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); };
function IconButton({ label, children, ...props }) { return <Tooltip content={label}><button type="button" className="merge-icon-button" aria-label={label} {...props}>{children}</button></Tooltip>; }
function TrackClip({ clip, asset, index, left, width, viewport, audio, selected, onPointerDown, onKeyDown, language, locked, moving }) {
  const text = (de, en) => language === 'en' ? en : de, file = clip.file;
  const images = asset?.thumbnails || [];
  const from = Math.max(0, viewport.left - left - 96), to = Math.min(width, viewport.left + viewport.width - left + 96);
  const visibleWidth = Math.max(0, to - from), headerLeft = Math.max(0, viewport.left - left);
  const headerWidth = Math.max(0, Math.min(width - headerLeft, viewport.width - Math.max(0, left - viewport.left)));
  const d = useMemo(() => waveformPath(asset?.peaks, visibleWidth, from / width, to / width), [asset?.peaks, visibleWidth, from, to, width]);
  const frames = [];
  if (!audio && images.length && visibleWidth > 0) {
    for (let frame = Math.floor(from / 96); frame * 96 < to; frame++) {
      frames.push(<img key={frame} src={images[Math.min(images.length - 1, Math.floor((frame * 96 + 48) / width * images.length))]} style={{ left: frame * 96, width: Math.min(96, width - frame * 96) }} alt="" draggable={false}/>);
    }
  }
  return <div role="button" tabIndex={0} className={'merge-track-clip ' + (audio ? 'merge-audio-clip' : 'merge-video-clip') + (selected ? ' selected' : '') + (file.missing ? ' missing' : '') + (moving ? ' moving' : '') + (width < 40 ? ' compact' : width < 180 ? ' narrow' : '')} style={{ left, width: Math.max(0, width - Math.min(4, width * .1)) }} data-merge-file={file.id} data-track={audio ? 'audio' : 'video'} aria-label={file.name + ', ' + (index + 1)} aria-pressed={selected} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
    {visibleWidth > 0 && <>
      <div className={'merge-clip-title ' + (audio ? 'merge-audio-title' : '')} data-reorder-handle style={{ left: headerLeft, width: headerWidth }}>
        <GripVertical aria-hidden="true" className={locked || !clip.ready ? 'disabled' : ''}/>
        {!audio && <span className="merge-clip-index">{String(index + 1).padStart(2, '0')}</span>}<strong>{file.name}</strong>{!audio && <span className="merge-clip-duration">{clip.ready ? clock(clip.duration) : '…'}</span>}
      </div>
      {audio ? asset?.info?.hasAudio === false ? <span className="merge-media-status" style={{ left: from, width: visibleWidth }}>{text('Keine Audiospur', 'No audio track')}</span> : d ? <svg style={{ left: from, width: visibleWidth }} viewBox={'0 0 ' + visibleWidth + ' 64'} preserveAspectRatio="none" aria-label={text('Wellenform', 'Waveform')}><path d={d}/></svg> : <span className="merge-media-status" style={{ left: from, width: visibleWidth }}>{asset?.waveDone ? text('Wellenform nicht verfügbar', 'Waveform unavailable') : text('Audiospur wird geladen …', 'Loading waveform …')}</span> : <div className="merge-filmstrip">{images.length ? frames : <span className="merge-media-status" style={{ left: from, width: visibleWidth }}>{file.missing ? text('Datei nicht verfügbar', 'File unavailable') : asset?.thumbDone ? text('Keine Vorschaubilder', 'No preview frames') : text('Vorschaubilder werden geladen …', 'Loading preview frames …')}</span>}</div>}
    </>}
  </div>;
}
export function MergeWorkspace({ files, language, locked, active, history, callbacks, timelineHost }) {
  const text = (de, en) => language === 'en' ? en : de;
  const [assets, setAssets] = useState({}), [selected, setSelected] = useState(files[0]?.id || ''), [, setPosition] = useState(0), [zoom, setZoom] = useState(1), [snap, setSnap] = useState(true), [viewport, setViewport] = useState({ left: 0, width: 1000 }), [muted, setMuted] = useState(false), [drag, setDrag] = useState(null), [seekRequest, setSeekRequest] = useState(null), [error, setError] = useState(false), [sourcesOpen, setSourcesOpen] = useState(false), [loadingPreview, setLoadingPreview] = useState(false);
  const host = useRef(null), scroll = useRef(null), cache = useRef(new Map()), pointer = useRef(null), latest = useRef(null), previous = useRef(null), mounted = useRef(true), dialog = useRef(null), playerClock = useRef(0), clockOutput = useRef(null), head = useRef(null), activeClip = useRef(''), notifySelection = useRef(''), animation = useRef(0), seekFrame = useRef(0), pendingSeek = useRef(null), lastSeek = useRef(0), expectedSeek = useRef(null), pendingScroll = useRef(null), scrollFrame = useRef(0), pendingPreview = useRef(null);
  const layout = useMemo(() => timelineLayout(files), [files]);
  const duration = layout.duration, displayDuration = Math.max(1, duration), contentWidth = Math.max(1, viewport.width - TIMELINE_INSET * 2) * zoom, canvasWidth = contentWidth + TIMELINE_INSET * 2, scale = contentWidth / displayDuration, maxZoom = maximumZoom(layout.clips);
  const parts = useMemo(() => files.map(file => ({ id: file.id, url: assets[file.id]?.url || '', duration: file.durationSeconds || 0 })), [files, assets]);
  latest.current = { files, layout, scale, selected, locked, active, callbacks, duration, snap, viewport, zoom, maxZoom };
  const publish = useCallback(() => { if (mounted.current) setAssets(Object.fromEntries(cache.current)); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelAnimationFrame(animation.current); cancelAnimationFrame(seekFrame.current); cancelAnimationFrame(scrollFrame.current); }; }, []);
  const key = files.map(file => file.id + ':' + file.token + ':' + !!file.missing).join('|');
  useEffect(() => {
    if (!active) return;
    const index = files.findIndex(file => file.id === selected);
    const visible = layout.clips.filter(clip => clip.duration * scale > 24 && TIMELINE_INSET + clip.start * scale < viewport.left + viewport.width && TIMELINE_INSET + (clip.start + clip.duration) * scale > viewport.left).slice(0, 12);
    const wanted = new Set([...files.slice(0, 3), ...files.slice(Math.max(0, index - 1), index + 3), ...visible.map(clip => clip.file)].map(file => file.id));
    for (const file of files) {
      if (!wanted.has(file.id) || file.missing || cache.current.has(file.id)) continue;
      const asset = {}; cache.current.set(file.id, asset);
      void window.api.getMergeVideoInfo(file.id).then(result => { asset.info = result?.info; publish(); }).catch(() => {});
      void window.api.getMergePreview(file.id).then(url => { asset.url = url; asset.previewDone = true; publish(); }).catch(() => { asset.previewDone = true; publish(); });
      void window.api.getMergeAssets(file.id, 'thumbnails').then(images => { asset.thumbnails = images || []; asset.thumbDone = true; publish(); }).catch(() => { asset.thumbDone = true; publish(); });
      void window.api.getMergeAssets(file.id, 'waveform').then(peaks => { asset.peaks = peaks; asset.waveDone = true; publish(); }).catch(() => { asset.waveDone = true; publish(); });
    }
  }, [key, selected, publish, active, layout, scale, viewport]);
  const updateViewport = useCallback(() => {
    if (!scroll.current) return;
    const next = { left: scroll.current.scrollLeft, width: scroll.current.clientWidth };
    setViewport(old => old.left === next.left && old.width === next.width ? old : next);
  }, []);
  useLayoutEffect(() => { const node = scroll.current; if (!node) return; const observer = new ResizeObserver(updateViewport); observer.observe(node); updateViewport(); return () => observer.disconnect(); }, [updateViewport]);
  const playing = () => Boolean(host.current?.querySelector('video.active') && !host.current.querySelector('video.active').paused);
  const boundedTime = useCallback((value, shouldSnap = true) => {
    const current = latest.current; let time = Math.max(0, Math.min(current.duration, Number.isFinite(value) ? value : 0));
    if (current.snap && shouldSnap) {
      const edges = [0, ...current.layout.clips.map(clip => clip.start + clip.duration)];
      const nearest = edges.reduce((a, b) => Math.abs(b - time) < Math.abs(a - time) ? b : a, 0);
      if (Math.abs(nearest - time) * current.scale < 7) time = nearest;
    }
    return time;
  }, []);
  const paintPosition = useCallback(value => {
    playerClock.current = value;
    if (clockOutput.current) clockOutput.current.textContent = clock(value);
    if (head.current) { head.current.style.left = TIMELINE_INSET + value * latest.current.scale + 'px'; head.current.setAttribute('aria-valuenow', String(value)); head.current.setAttribute('aria-valuetext', clock(value)); }
  }, []);
  const dispatchSeek = useCallback((time, resume) => {
    const anchor = timelinePosition(latest.current.layout.clips, time), asset = cache.current.get(anchor.id);
    if (anchor.id && !asset?.url) { pendingPreview.current = { id: anchor.id, time, resume }; setLoadingPreview(true); return; }
    pendingPreview.current = null; setLoadingPreview(false);
    expectedSeek.current = { time, until: performance.now() + 2000 };
    setSeekRequest({ seconds: time, playing: resume, immediate: true });
  }, []);
  useEffect(() => {
    const pending = pendingPreview.current;
    if (!pending) return;
    const asset = assets[pending.id];
    if (asset?.url) dispatchSeek(pending.time, pending.resume);
    else if (asset?.previewDone) { pendingPreview.current = null; setLoadingPreview(false); setError(true); }
  }, [assets, dispatchSeek]);
  const commitSeek = useCallback((value, resume = false, selectClip = true, shouldSnap = false) => {
    const time = boundedTime(value, shouldSnap);
    paintPosition(time); setPosition(time); setError(false);
    expectedSeek.current = { time, until: performance.now() + 2000 };
    if (selectClip) { const anchor = timelinePosition(latest.current.layout.clips, time); setSelected(anchor.id); activeClip.current = anchor.id; }
    dispatchSeek(time, resume);
  }, [boundedTime, paintPosition, dispatchSeek]);
  const scheduleSeek = value => {
    const time = boundedTime(value); paintPosition(time); pendingSeek.current = time;
    const anchor = timelinePosition(latest.current.layout.clips, time); setSelected(anchor.id); activeClip.current = anchor.id;
    if (seekFrame.current) return;
    const flush = timestamp => {
      if (timestamp - lastSeek.current >= 60 && pendingSeek.current !== null) { lastSeek.current = timestamp; const target = pendingSeek.current; pendingSeek.current = null; expectedSeek.current = { time: target, until: performance.now() + 2000 }; dispatchSeek(target, false); }
      seekFrame.current = pendingSeek.current !== null ? requestAnimationFrame(flush) : 0;
    };
    seekFrame.current = requestAnimationFrame(flush);
  };
  useLayoutEffect(() => {
    const before = previous.current;
    if (before && before.map(clip => clip.file.id).join('|') !== layout.clips.map(clip => clip.file.id).join('|')) {
      const value = reorderedPosition(before, layout.clips, playerClock.current);
      if (!files.some(file => file.id === selected)) setSelected(timelinePosition(layout.clips, value).id);
      commitSeek(value, playing(), false);
    }
    previous.current = layout.clips;
  }, [layout, files, selected, commitSeek]);
  useLayoutEffect(() => {
    if (pendingScroll.current && scroll.current) { scroll.current.scrollLeft = Math.max(0, TIMELINE_INSET + pendingScroll.current.time * scale - viewport.width * pendingScroll.current.fraction); pendingScroll.current = null; updateViewport(); }
    paintPosition(Math.min(playerClock.current, duration));
  }, [zoom, scale, duration, viewport.width, paintPosition, updateViewport]);
  useEffect(() => { if (!active) { pointer.current = null; setDrag(null); cancelAnimationFrame(animation.current); cancelAnimationFrame(seekFrame.current); seekFrame.current = 0; pendingSeek.current = null; setSeekRequest({ playing: false }); } }, [active]);
  useEffect(() => { const element = host.current; const sync = () => requestAnimationFrame(() => { if (mounted.current) setMuted(Number(element?.querySelector('.archive-volume')?.value ?? 1) === 0); }); element?.addEventListener('volumechange', sync, true); return () => element?.removeEventListener('volumechange', sync, true); }, []);
  const onPosition = useCallback(value => {
    if (pointer.current?.kind === 'scrub' || pendingPreview.current) return;
    const expected = expectedSeek.current;
    if (expected && performance.now() < expected.until && Math.abs(value - expected.time) > .25) return;
    expectedSeek.current = null; paintPosition(value);
    if (pointer.current || !latest.current.active) return;
    const anchor = timelinePosition(latest.current.layout.clips, value);
    if (activeClip.current !== anchor.id) { activeClip.current = anchor.id; setSelected(anchor.id); setError(false); }
    const scroller = scroll.current;
    if (scroller && host.current?.querySelector('video.active')?.paused === false) { const x = TIMELINE_INSET + value * latest.current.scale; if (x > scroller.scrollLeft + scroller.clientWidth - 24 || x < scroller.scrollLeft) { scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * .3); updateViewport(); } }
  }, [paintPosition, updateViewport]);
  const currentFile = files.find(file => file.id === selected), info = assets[selected]?.info;
  useEffect(() => { const value = JSON.stringify([selected, info]); if (notifySelection.current !== value) { notifySelection.current = value; callbacks.selection?.(currentFile, info); } }, [selected, info, currentFile, callbacks]);
  const select = (id, fit = false) => { const clip = layout.clips.find(entry => entry.file.id === id); if (!clip) return; setSelected(id); commitSeek(clip.start); if (fit) fitSelection(id); };
  const reorder = (id, offset) => { const ids = files.map(file => file.id), index = ids.indexOf(id), target = index + offset; if (index < 0 || target < 0 || target >= ids.length || locked) return; [ids[index], ids[target]] = [ids[target], ids[index]]; callbacks.reorder(ids); };
  const pointerTime = clientX => { const bounds = scroll.current.getBoundingClientRect(); return (clientX - bounds.left + scroll.current.scrollLeft - TIMELINE_INSET) / latest.current.scale; };
  const movePointer = clientX => {
    const current = pointer.current; if (!current) return; current.clientX = clientX;
    if (current.kind === 'scrub') { scheduleSeek(pointerTime(clientX)); return; }
    if (!current.moving && Math.abs(clientX - current.x) < 5) return;
    current.moving = true;
    const clips = latest.current.layout.clips, clip = clips.find(entry => entry.file.id === current.id), time = pointerTime(clientX), target = insertionTarget(clips, current.id, time);
    current.target = target.index;
    setDrag({ id: current.id, left: Math.max(TIMELINE_INSET, Math.min(TIMELINE_INSET + latest.current.duration * latest.current.scale - clip.duration * latest.current.scale, TIMELINE_INSET + time * latest.current.scale - current.grab)), insert: TIMELINE_INSET + target.seconds * latest.current.scale });
  };
  const autoScroll = () => {
    const current = pointer.current, node = scroll.current;
    if (!current || !node) { animation.current = 0; return; }
    const bounds = node.getBoundingClientRect(), edge = 32;
    const distance = current.clientX < bounds.left + edge ? current.clientX - bounds.left - edge : current.clientX > bounds.right - edge ? current.clientX - bounds.right + edge : 0;
    if (distance && (current.kind === 'scrub' || current.moving)) { const before = node.scrollLeft; node.scrollLeft += Math.sign(distance) * Math.min(24, Math.max(2, Math.abs(distance) / edge * 16)); if (node.scrollLeft !== before) { updateViewport(); movePointer(current.clientX); } }
    animation.current = requestAnimationFrame(autoScroll);
  };
  const beginPointer = (event, file) => {
    if (event.button !== 0 || pointer.current || !layout.ready || !files.length) return;
    if (file && locked) return;
    event.preventDefault(); event.stopPropagation(); (event.currentTarget.closest('.merge-playhead') || event.currentTarget).focus({ preventScroll: true });
    if (file) {
      setSelected(file.id);
      pointer.current = { kind: 'reorder', id: file.id, x: event.clientX, clientX: event.clientX, grab: event.clientX - event.currentTarget.getBoundingClientRect().left, moving: false, target: files.findIndex(entry => entry.id === file.id) };
    } else {
      pointer.current = { kind: 'scrub', clientX: event.clientX, original: playerClock.current, resume: playing() };
      commitSeek(pointerTime(event.clientX), false, true, true);
    }
    event.currentTarget.setPointerCapture(event.pointerId); animation.current = requestAnimationFrame(autoScroll);
  };
  const endPointer = event => {
    const current = pointer.current; if (!current) return;
    const target = boundedTime(pointerTime(event.clientX)); pointer.current = null; setDrag(null); cancelAnimationFrame(animation.current); cancelAnimationFrame(seekFrame.current); seekFrame.current = 0; pendingSeek.current = null;
    if (current.kind === 'scrub') commitSeek(target, current.resume);
    else if (current.moving) { const ids = latest.current.files.filter(file => file.id !== current.id).map(file => file.id); ids.splice(current.target, 0, current.id); callbacks.reorder(ids); }

  };
  const cancelPointer = () => { const current = pointer.current; pointer.current = null; setDrag(null); cancelAnimationFrame(animation.current); cancelAnimationFrame(seekFrame.current); seekFrame.current = 0; pendingSeek.current = null; if (current?.kind === 'scrub') commitSeek(current.original, current.resume); };
  const changeZoom = useCallback((value, fraction = .5) => {
    const current = latest.current, node = scroll.current;
    if (!node) return;
    const next = Math.max(1, Math.min(current.maxZoom, value));
    if (next === current.zoom) return;
    pendingScroll.current = { time: (node.scrollLeft + node.clientWidth * fraction - TIMELINE_INSET) / current.scale, fraction };
    current.zoom = next; setZoom(next);
  }, []);
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const onWheel = event => {
      const current = latest.current;
      if (!current.active || !current.files.length || pointer.current) return;
      event.preventDefault(); event.stopPropagation();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
        node.scrollLeft += (event.deltaX || event.deltaY) * multiplier;
        updateViewport(); return;
      }
      if (!event.deltaY) return;
      const fraction = Math.max(0, Math.min(1, (event.clientX - node.getBoundingClientRect().left) / node.clientWidth));
      const delta = Math.max(-240, Math.min(240, event.deltaY * multiplier));
      changeZoom(current.zoom * Math.exp(-delta * .0035), fraction);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [changeZoom, updateViewport]);
  const fitAll = () => { pendingScroll.current = null; setZoom(1); scroll.current.scrollLeft = 0; updateViewport(); };
  function fitSelection(id = selected) { const clip = layout.clips.find(entry => entry.file.id === id); if (!clip) return; pendingScroll.current = { time: clip.start + clip.duration / 2, fraction: .5 }; setZoom(Math.min(maxZoom, Math.max(1, displayDuration / clip.duration * .8))); if (zoom === Math.min(maxZoom, Math.max(1, displayDuration / clip.duration * .8))) { scroll.current.scrollLeft = Math.max(0, TIMELINE_INSET + (clip.start + clip.duration / 2) * scale - viewport.width / 2); pendingScroll.current = null; updateViewport(); } }
  const keyDown = (event, file) => { if (locked) return; if (event.key === 'Delete') { event.preventDefault(); callbacks.remove(file.id); } else if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); reorder(file.id, event.key === 'ArrowLeft' ? -1 : 1); } else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); (event.key.toLowerCase() === 'y' || event.shiftKey ? callbacks.redo : callbacks.undo)(); } else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(file.id); } };
  const step = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200].find(value => value * scale >= 80) || 14400;
  const startTick = Math.max(0, Math.floor((viewport.left - TIMELINE_INSET) / scale / step));
  const endTick = Math.min(Math.floor(displayDuration / step), Math.ceil((viewport.left + viewport.width - TIMELINE_INSET) / scale / step));
  const ticks = Array.from({ length: Math.max(0, Math.min(100, endTick - startTick + 1)) }, (_, index) => (startTick + index) * step).filter(time => (displayDuration - time) * scale >= 85);
  const timeline = <section className="merge-timeline" aria-label={text('Timeline für Video und Audio', 'Video and audio timeline')}>
    <header className="merge-timeline-toolbar"><strong>{text('Sequenz', 'Sequence')}</strong><output ref={clockOutput}>{clock(playerClock.current)}</output><span className="merge-total">/ {clock(duration)}</span><span className="merge-separator"/>
      <IconButton label={text('Rückgängig · Strg+Z', 'Undo · Ctrl+Z')} disabled={locked || !history.undo} onClick={callbacks.undo}><Undo2/></IconButton><IconButton label={text('Wiederholen · Strg+Y', 'Redo · Ctrl+Y')} disabled={locked || !history.redo} onClick={callbacks.redo}><Redo2/></IconButton><span className="merge-separator"/>
      <IconButton label={text('Clip nach links', 'Move clip left')} disabled={locked || !selected || files[0]?.id === selected} onClick={() => reorder(selected, -1)}><ChevronLeft/></IconButton><IconButton label={text('Clip nach rechts', 'Move clip right')} disabled={locked || !selected || files.at(-1)?.id === selected} onClick={() => reorder(selected, 1)}><ChevronRight/></IconButton><IconButton label={text('Clip entfernen', 'Remove clip')} disabled={locked || !selected} onClick={() => callbacks.remove(selected)}><Trash2/></IconButton>
      <span className="merge-grow"/><button type="button" className={'merge-tool ' + (snap ? 'active' : '')} aria-pressed={snap} onClick={() => setSnap(!snap)}><span>{text('Einrasten', 'Snap')}</span><Magnet/></button><button type="button" className="merge-tool" onClick={() => { setSourcesOpen(true); requestAnimationFrame(() => dialog.current?.showModal()); }}><Files/><span>{text('Quelldateien', 'Source files')}</span></button><span className="merge-separator"/><button type="button" className="merge-tool" onClick={fitAll}>{text('Gesamt', 'Fit')}</button><button type="button" className="merge-tool" disabled={!currentFile || !layout.ready} onClick={() => fitSelection()}><ScanLine/><span>{text('Auswahl', 'Selection')}</span></button><div className="merge-zoom"><IconButton label={text('Verkleinern', 'Zoom out')} onClick={() => changeZoom(zoom / 1.4)}>−</IconButton><input aria-label={text('Timeline-Zoom', 'Timeline zoom')} aria-valuetext={zoom.toFixed(1) + '×'} type="range" min="0" max="100" step=".1" value={Math.log(Math.min(zoom, maxZoom)) / Math.log(maxZoom) * 100} onChange={event => changeZoom(Math.pow(maxZoom, Number(event.target.value) / 100))}/><IconButton label={text('Vergrößern', 'Zoom in')} onClick={() => changeZoom(zoom * 1.4)}>+</IconButton><output className="merge-zoom-value">{zoom.toLocaleString(language === 'en' ? 'en-US' : 'de-DE', { maximumFractionDigits: 1 })}×</output></div>
    </header>
    <div className="merge-tracks"><aside className="merge-track-labels"><span className="merge-ruler-label">{text('Spuren', 'Tracks')}</span><div className="merge-track-heading"><b>V1</b><span>Video</span></div><div className="merge-track-heading"><b>A1</b><span>Audio</span><IconButton label={muted ? text('Audio aktivieren', 'Unmute audio') : text('Stummschalten', 'Mute audio')} aria-pressed={muted} onClick={() => host.current?.querySelector('.archive-control-row button[aria-label="' + playerTexts[language]?.[muted ? 'unmute' : 'mute'] + '"]')?.click()}>{muted ? <VolumeX/> : <Volume2/>}</IconButton></div></aside>
    <div className="merge-timeline-scroll" ref={scroll} onScroll={() => { if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = 0; updateViewport(); }); }}><div className={'merge-timeline-canvas ' + (muted ? 'audio-muted' : '')} style={{ width: canvasWidth, '--merge-tick-step': step * scale + 'px' }} onPointerMove={event => movePointer(event.clientX)} onPointerUp={endPointer} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}>
      <div className="merge-ruler" onPointerDown={event => beginPointer(event)}>{ticks.map(time => <span key={time} style={{ left: TIMELINE_INSET + time * scale }}>{clock(time)}</span>)}{!!files.length && <span className="merge-ruler-end" style={{ left: TIMELINE_INSET + duration * scale }}>{layout.ready ? clock(duration) : '…'}</span>}</div>
      <div className="merge-video-track">{layout.clips.map((clip, index) => <TrackClip key={clip.file.id} clip={clip} asset={assets[clip.file.id]} language={language} index={index} left={TIMELINE_INSET + clip.start * scale} width={clip.duration * scale} viewport={viewport} selected={selected === clip.file.id} locked={locked} moving={drag?.id === clip.file.id} onPointerDown={event => beginPointer(event, clip.file)} onKeyDown={event => keyDown(event, clip.file)}/>)}</div>
      <div className="merge-audio-track">{layout.clips.map((clip, index) => <TrackClip key={clip.file.id} clip={clip} asset={assets[clip.file.id]} language={language} index={index} left={TIMELINE_INSET + clip.start * scale} width={clip.duration * scale} viewport={viewport} selected={selected === clip.file.id} locked={locked} moving={drag?.id === clip.file.id} audio onPointerDown={event => beginPointer(event, clip.file)} onKeyDown={event => keyDown(event, clip.file)}/>)}</div>
      {!!files.length && <div className="merge-playhead" ref={head} style={{ left: TIMELINE_INSET + playerClock.current * scale }} role="slider" tabIndex={0} aria-label={text('Abspielposition', 'Playback position')} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={playerClock.current} aria-valuetext={clock(playerClock.current)} onKeyDown={event => { const step = event.shiftKey ? 10 : 1; const target = event.key === 'Home' ? 0 : event.key === 'End' ? duration : event.key === 'ArrowLeft' ? playerClock.current - step : event.key === 'ArrowRight' ? playerClock.current + step : null; if (target !== null) { event.preventDefault(); event.stopPropagation(); commitSeek(target, playing()); } }}><span className="merge-playhead-handle" onPointerDown={event => beginPointer(event)}/></div>} {drag && <><div className={'merge-insert' + (drag.insert - viewport.left > viewport.width - 150 ? ' at-end' : '')} style={{ left: drag.insert }}><span>{text('Hier einfügen', 'Insert here')}</span></div><div className="merge-drag-ghost" style={{ left: drag.left, width: (layout.clips.find(clip => clip.file.id === drag.id)?.duration || 0) * scale }}><Layers/>{files.find(file => file.id === drag.id)?.name}</div></>}
      {!files.length && <div className="merge-empty"><Files/><strong>{text('Keine Videos ausgewählt', 'No videos selected')}</strong><span>{text('Videos hinzufügen und an der Kopfzeile in die gewünschte Reihenfolge ziehen.', 'Add videos and drag their headers into order.')}</span><button type="button" onClick={callbacks.add} disabled={locked}><Plus/>{text('Videos hinzufügen', 'Add videos')}</button></div>}
    </div></div></div>
    <footer><Tooltip content={text('Clips ziehen: Umordnen · Zeitleiste oder Abspielgriff ziehen: Spulen · Mausrad: Zoom · Umschalt+Mausrad: Horizontal scrollen', 'Drag clips: reorder · Drag ruler or playhead handle: seek · Mouse wheel: zoom · Shift+wheel: scroll horizontally')}><span><Layers/>{layout.ready ? text('Video und Audio gekoppelt', 'Video and audio linked') : text('Videodauern werden geladen …', 'Loading video durations …')}</span></Tooltip><span>{currentFile?.name || text('Keine Auswahl', 'No selection')}{currentFile ? ' · ' + clock(currentFile.durationSeconds) : ''}</span></footer>
  </section>;
  return <><section className="merge-preview"><header><MonitorPlay/><strong>{text('Vorschau', 'Preview')}</strong><span className="merge-grow"/><span>{text('Gesamte Sequenz', 'Entire sequence')}</span><span>{clock(duration)}</span></header><div className="merge-player-host" ref={host}>
    {parts[0]?.url ? <ArchivePlayer id="merge-workspace" userId="merge-workspace" parts={parts} seconds={0} initialPlaying={false} rememberPlayback={false} started t={key => playerTexts[language]?.[key] || playerTexts.de[key] || key} onProgress={() => {}} onPosition={onPosition} onError={() => setError(true)} seekRequest={seekRequest}/> : <div className="merge-player-empty">{files.length ? text('Vorschau wird vorbereitet …', 'Preparing preview …') : text('Videos für die Vorschau hinzufügen', 'Add videos to preview')}</div>}
    {loadingPreview && <div className="merge-preview-loading" role="status">{text('Vorschau wird vorbereitet …', 'Preparing preview …')}</div>}
    {(error || currentFile?.missing || (assets[selected]?.previewDone && !assets[selected]?.url)) && <div className="merge-preview-error"><span>{text('Vorschau nicht verfügbar. Quelldatei und Format prüfen.', 'Preview unavailable. Check the source file and format.')}</span><IconButton label={text('Erneut laden', 'Retry')} onClick={() => { cache.current.delete(selected); setError(false); void window.api.getMergePreview(selected).then(url => { cache.current.set(selected, { ...assets[selected], url, previewDone: true }); publish(); select(selected); }); }}><RotateCw/></IconButton></div>}
    </div><footer><span>{currentFile ? (files.indexOf(currentFile) + 1) + ' / ' + files.length : '0 / 0'}</span><strong>{currentFile?.name || '—'}</strong><span className="merge-grow"/><IconButton label={text('Vorheriger Clip', 'Previous clip')} disabled={!selected || files.indexOf(currentFile) <= 0} onClick={() => select(files[files.indexOf(currentFile) - 1].id)}><ChevronLeft/></IconButton><IconButton label={text('Nächster Clip', 'Next clip')} disabled={!selected || files.indexOf(currentFile) >= files.length - 1} onClick={() => select(files[files.indexOf(currentFile) + 1].id)}><ChevronRight/></IconButton></footer></section>
    {timelineHost && createPortal(timeline, timelineHost)}
    {sourcesOpen && createPortal(<dialog className="merge-sources-dialog" ref={dialog} onCancel={() => setSourcesOpen(false)} onPointerDown={event => { if (event.target === event.currentTarget) event.currentTarget.dataset.outside = 'true'; else delete event.currentTarget.dataset.outside; }} onClick={event => { if (event.target === event.currentTarget && event.currentTarget.dataset.outside === 'true') { event.currentTarget.close(); setSourcesOpen(false); } }}><h2>{text('Quelldateien', 'Source files')}</h2><div className="merge-sources">{files.map(file => <button type="button" className="merge-source-entry" key={file.id} onClick={() => { dialog.current.close(); setSourcesOpen(false); select(file.id, true); }}><strong>{file.name}</strong><span>{clock(file.durationSeconds)}</span></button>)}</div><footer><button type="button" onClick={() => { dialog.current.close(); setSourcesOpen(false); }}>{text('Schließen', 'Close')}</button><button type="button" onClick={() => { dialog.current.close(); setSourcesOpen(false); callbacks.add(); }}>{text('Videos hinzufügen', 'Add videos')}</button></footer></dialog>, document.body)}
  </>;
}
