import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Files, Layers, MonitorPlay, Plus, Redo2, Trash2, Undo2, Volume2, VolumeX, Check, RotateCw } from 'lucide-react';
import { ArchivePlayer } from './ArchivePlayer.jsx';
import { Tooltip } from './Tooltip.jsx';
import { playerTexts } from './texts.js';
import './merge-workspace.css';

const clock = value => { const s = Math.floor(Math.max(0, value || 0)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const startOf = (files, id) => { let time = 0; for (const file of files) { if (file.id === id) return time; time += file.durationSeconds || 0; } return 0; };
function IconButton({ label, children, ...props }) { return <Tooltip content={label}><button type="button" className="merge-icon-button" aria-label={label} {...props}>{children}</button></Tooltip>; }
const wavePath = (peaks, width) => {
  if (!peaks?.length) return '';
  let path = ''; const count = Math.min(400, Math.max(8, Math.floor(width / 3)));
  for (let c = 0; c < 2; c++) { const values = peaks[c] || peaks[0], center = c ? 44 : 23;
    for (let i = 0; i < count; i++) { let value = 0; const from = Math.floor(i * values.length / count), to = Math.max(from + 1, Math.floor((i + 1) * values.length / count)); for (let j = from; j < to; j++) value = Math.max(value, values[j] || 0); const peak = Math.max(.6, value / 255 * 11); path += 'M' + (i * width / count).toFixed(1) + ' ' + (center - peak).toFixed(1) + 'v' + (peak * 2).toFixed(1); }
  } return path;
};
function TrackClip({ file, asset, index, left, width, audio, selected, onPointerDown, onKeyDown, language }) {
  const text = (de, en) => language === 'en' ? en : de;
  const images = asset?.thumbnails || [];
  const count = Math.min(30, Math.max(1, Math.ceil(width / 96)));
  const d = useMemo(() => wavePath(asset?.peaks, width), [asset?.peaks, width]);
  return <div role="button" tabIndex={0} className={'merge-track-clip ' + (audio ? 'merge-audio-clip' : 'merge-video-clip') + (selected ? ' selected' : '') + (file.missing ? ' missing' : '')} style={{ left: left + 2, width: Math.max(4, width - 4) }} data-merge-file={file.id} data-track={audio ? 'audio' : 'video'} aria-label={file.name + ', ' + (index + 1)} aria-pressed={selected} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
    {audio ? <><span className="merge-audio-caption">{file.name}</span>{asset?.info?.hasAudio === false ? <span className="merge-media-status">{text('Keine Audiospur', 'No audio track')}</span> : d ? <svg viewBox={'0 0 ' + width + ' 64'} preserveAspectRatio="none" aria-label="Wellenform"><path d={d}/></svg> : <span className="merge-media-status">{asset?.waveDone ? text('Wellenform nicht verfügbar', 'Waveform unavailable') : text('Audiospur wird geladen …', 'Loading waveform …')}</span>}</> : <><div className="merge-clip-title"><span>{String(index + 1).padStart(2, '0')}</span><strong>{file.name}</strong><span>{clock(file.durationSeconds)}</span></div><div className="merge-filmstrip">{images.length ? Array.from({ length: count }, (_, i) => <img key={i} src={images[Math.min(images.length - 1, Math.floor(i * images.length / count))]} alt="" draggable={false}/>) : <span className="merge-media-status">{file.missing ? text('Datei nicht verfügbar', 'File unavailable') : asset?.thumbDone ? text('Keine Vorschaubilder', 'No preview frames') : text('Vorschaubilder werden geladen …', 'Loading preview frames …')}</span>}</div></>}
  </div>;
}
export function MergeWorkspace({ files, language, locked, active, history, callbacks, timelineHost }) {
  const de = language !== 'en', text = (a, b) => de ? a : b;
  const [assets, setAssets] = useState({}), [selected, setSelected] = useState(files[0]?.id || ''), [, setPosition] = useState(0), [zoom, setZoom] = useState(1), [snap, setSnap] = useState(true), [width, setWidth] = useState(1000), [muted, setMuted] = useState(false), [drag, setDrag] = useState(null), [seekRequest, setSeekRequest] = useState(null), [error, setError] = useState(false), [sourcesOpen, setSourcesOpen] = useState(false);
  const host = useRef(null), scroll = useRef(null), cache = useRef(new Map()), pointer = useRef(null), latest = useRef(null), previous = useRef(files), mounted = useRef(true), dialog = useRef(null), playerClock = useRef(0), clockOutput = useRef(null), head = useRef(null), notifySelection = useRef('');
  const duration = files.reduce((sum, file) => sum + (file.durationSeconds || 0), 0), displayDuration = duration || Math.max(1, files.length), canvasWidth = width * zoom, scale = canvasWidth / displayDuration;
  const parts = useMemo(() => files.map(file => ({ id: file.id, url: assets[file.id]?.url || '', duration: file.durationSeconds || 0 })), [files, assets]);
  latest.current = { files, scale, selected, locked, active, callbacks, duration };
  const publish = useCallback(() => { if (mounted.current) setAssets(Object.fromEntries(cache.current)); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = files.map(f => f.id + ':' + f.token + ':' + !!f.missing).join('|');
  useEffect(() => {
    if (!active) return;
    const index = files.findIndex(file => file.id === selected);
    const wanted = new Set([...files.slice(0, 6), ...files.slice(Math.max(0, index - 1), index + 3)].map(file => file.id));
    for (const file of files) {
      if (!wanted.has(file.id)) continue;
      if (file.missing || cache.current.has(file.id)) continue;
      const asset = {}; cache.current.set(file.id, asset);
      void window.api.getMergeVideoInfo(file.id).then(result => { asset.info = result?.info; publish(); }).catch(() => {});
      void window.api.getMergePreview(file.id).then(url => { asset.url = url; asset.previewDone = true; publish(); }).catch(() => { asset.previewDone = true; publish(); });
      void window.api.getMergeAssets(file.id, 'thumbnails').then(images => { asset.thumbnails = images || []; asset.thumbDone = true; publish(); }).catch(() => { asset.thumbDone = true; publish(); });
      void window.api.getMergeAssets(file.id, 'waveform').then(peaks => { asset.peaks = peaks; asset.waveDone = true; publish(); }).catch(() => { asset.waveDone = true; publish(); });
    }
  }, [key, selected, publish, active]);
  const seek = useCallback((value, playing = false) => {
    const current = latest.current; let target = Math.max(0, Math.min(current.duration, value));
    if (snap) { const edges = [0, ...current.files.map(f => startOf(current.files, f.id) + (f.durationSeconds || 0))]; const nearest = edges.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a, 0); if (Math.abs(nearest - target) * current.scale < 7) target = nearest; }
    playerClock.current = target; setPosition(target); setSeekRequest({ seconds: target, playing }); setError(false);
  }, [snap]);
  useLayoutEffect(() => {
    const before = previous.current, beforeKey = before.map(f => f.id).join('|');
    if (beforeKey !== files.map(f => f.id).join('|')) {
      const id = files.some(f => f.id === selected) ? selected : files[0]?.id;
      const local = Math.max(0, playerClock.current - startOf(before, id));
      setSelected(id || ''); seek(id ? startOf(files, id) + Math.min(local, Math.max(0, (files.find(f => f.id === id)?.durationSeconds || 0) - .01)) : 0);
    }
    previous.current = files;
  }, [files, selected, seek]);
  useLayoutEffect(() => { if (!scroll.current) return; const observer = new ResizeObserver(entries => setWidth(Math.max(1, entries[0].contentRect.width))); observer.observe(scroll.current); return () => observer.disconnect(); }, []);
  useEffect(() => { if (!active) setSeekRequest({ playing: false }); }, [active]);
  useEffect(() => {
    const element = host.current;
    const sync = () => requestAnimationFrame(() => { if (mounted.current) setMuted(Number(element?.querySelector('.archive-volume')?.value ?? 1) === 0); });
    element?.addEventListener('volumechange', sync, true);
    return () => element?.removeEventListener('volumechange', sync, true);
  }, []);
  const onPosition = useCallback(value => {
    playerClock.current = value;
    if (clockOutput.current) clockOutput.current.textContent = clock(value);
    if (head.current) head.current.style.left = Math.min(latest.current.scale * value, latest.current.scale * latest.current.duration - 1) + 'px';
    if (pointer.current || !latest.current.active) return;
    let sum = 0; const file = latest.current.files.find(f => { sum += f.durationSeconds || 0; return value < sum; }) || latest.current.files.at(-1);
    if (file && file.id !== latest.current.selected) { setSelected(file.id); setError(false); }
    const scroller = scroll.current, video = host.current?.querySelector('video.active');
    if (scroller && video && !video.paused) { const x = value * latest.current.scale; if (x > scroller.scrollLeft + scroller.clientWidth - 24 || x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * .3); }
  }, []);
  const currentFile = files.find(f => f.id === selected), info = assets[selected]?.info;
  useEffect(() => { const value = JSON.stringify([selected, info]); if (notifySelection.current !== value) { notifySelection.current = value; callbacks.selection?.(currentFile, info); } }, [selected, info, currentFile, callbacks]);
  const select = (id, play = false) => { setSelected(id); seek(startOf(files, id), play); };
  const reorder = (id, offset) => { const ids = files.map(f => f.id), index = ids.indexOf(id), target = index + offset; if (index < 0 || target < 0 || target >= ids.length || locked) return; [ids[index], ids[target]] = [ids[target], ids[index]]; callbacks.reorder(ids); };
  const pointerTime = event => { const bounds = scroll.current.getBoundingClientRect(); return (event.clientX - bounds.left + scroll.current.scrollLeft) / latest.current.scale; };
  const beginDrag = (event, file) => {
    if (event.button !== 0 || locked || !file.durationSeconds) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); setSelected(file.id);
    pointer.current = { id: file.id, x: event.clientX, grab: event.clientX - event.currentTarget.getBoundingClientRect().left, moving: false, target: files.findIndex(f => f.id === file.id) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = event => {
    const value = pointer.current; if (!value) return;
    if (!value.moving && Math.abs(event.clientX - value.x) < 5) return;
    value.moving = true; const current = latest.current, bounds = scroll.current.getBoundingClientRect();
    if (event.clientX > bounds.right - 36) scroll.current.scrollLeft += 20; else if (event.clientX < bounds.left + 36) scroll.current.scrollLeft -= 20;
    const point = Math.max(0, pointerTime(event)), remaining = current.files.filter(f => f.id !== value.id);
    let elapsed = 0, target = remaining.length;
    for (let i = 0; i < remaining.length; i++) { if (point < elapsed + (remaining[i].durationSeconds || 0) / 2) { target = i; break; } elapsed += remaining[i].durationSeconds || 0; }
    value.target = target;
    setDrag({ id: value.id, left: Math.max(0, point * current.scale - value.grab), insert: remaining.slice(0, target).reduce((sum, f) => sum + (f.durationSeconds || 0), 0) * current.scale });
  };
  const endDrag = event => {
    const value = pointer.current; if (!value) return; pointer.current = null; setDrag(null);
    if (value.moving) { const ids = latest.current.files.filter(f => f.id !== value.id).map(f => f.id); ids.splice(value.target, 0, value.id); callbacks.reorder(ids); }
    else seek(pointerTime(event));
  };
  const cancelDrag = () => { pointer.current = null; setDrag(null); };
  const changeZoom = value => { const center = (scroll.current.scrollLeft + width / 2) / scale; const next = Math.max(1, Math.min(12, value)); setZoom(next); requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollLeft = Math.max(0, center * width * next / displayDuration - width / 2); }); };
  const keyDown = (event, file) => {
    if (locked) return;
    if (event.key === 'Delete') { event.preventDefault(); callbacks.remove(file.id); }
    else if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); reorder(file.id, event.key === 'ArrowLeft' ? -1 : 1); }
    else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); (event.key.toLowerCase() === 'y' || event.shiftKey ? callbacks.redo : callbacks.undo)(); }
    else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(file.id); }
  };
  let elapsed = 0; const layout = files.map(file => { const left = elapsed * scale, w = (file.durationSeconds || displayDuration / Math.max(1, files.length)) * scale; elapsed += file.durationSeconds || 0; return { file, left, width: w }; });
  const step = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200].find(s => s * scale >= 76) || 14400;
  const ticks = Array.from({ length: Math.min(1000, Math.floor(displayDuration / step) + 1) }, (_, i) => i * step);
  const timeline = <section className="merge-timeline" aria-label={text('Timeline für Video und Audio', 'Video and audio timeline')}>
    <header className="merge-timeline-toolbar"><strong>Timeline</strong><output ref={clockOutput}>{clock(playerClock.current)}</output><span className="merge-total">/ {clock(duration)}</span><span className="merge-separator"/>
      <IconButton label={text('Rückgängig · Strg+Z', 'Undo · Ctrl+Z')} disabled={locked || !history.undo} onClick={callbacks.undo}><Undo2/></IconButton><IconButton label={text('Wiederholen · Strg+Y', 'Redo · Ctrl+Y')} disabled={locked || !history.redo} onClick={callbacks.redo}><Redo2/></IconButton><span className="merge-separator"/>
      <IconButton label={text('Clip nach links', 'Move clip left')} disabled={locked || !selected || files[0]?.id === selected} onClick={() => reorder(selected, -1)}><ChevronLeft/></IconButton><IconButton label={text('Clip nach rechts', 'Move clip right')} disabled={locked || !selected || files.at(-1)?.id === selected} onClick={() => reorder(selected, 1)}><ChevronRight/></IconButton><IconButton label={text('Clip entfernen', 'Remove clip')} disabled={locked || !selected} onClick={() => callbacks.remove(selected)}><Trash2/></IconButton>
      <span className="merge-grow"/><button type="button" className={'merge-tool ' + (snap ? 'active' : '')} aria-pressed={snap} onClick={() => setSnap(!snap)}><span>{text('Einrasten', 'Snap')}</span><Check/></button><button type="button" className="merge-tool" onClick={() => { setSourcesOpen(true); requestAnimationFrame(() => dialog.current?.showModal()); }}><Files/><span>{text('Quelldateien', 'Source files')}</span></button><span className="merge-separator"/><button type="button" className="merge-tool" onClick={() => { setZoom(1); scroll.current.scrollLeft = 0; }}>{text('Gesamt', 'Fit')}</button><div className="merge-zoom"><IconButton label={text('Verkleinern', 'Zoom out')} onClick={() => changeZoom(zoom - .5)}>−</IconButton><input aria-label={text('Timeline-Zoom', 'Timeline zoom')} type="range" min="1" max="12" step=".1" value={zoom} onChange={e => changeZoom(Number(e.target.value))}/><IconButton label={text('Vergrößern', 'Zoom in')} onClick={() => changeZoom(zoom + .5)}>+</IconButton></div>
    </header>
    <div className="merge-tracks"><aside className="merge-track-labels"><span className="merge-ruler-label">{text('Spuren', 'Tracks')}</span><div><b>V1</b><span>Video</span></div><div><b>A1</b><IconButton label={muted ? text('Audio aktivieren', 'Unmute audio') : text('Stummschalten', 'Mute audio')} aria-pressed={muted} onClick={() => host.current?.querySelector('.archive-control-row button[aria-label="' + playerTexts[language]?.[muted ? 'unmute' : 'mute'] + '"]')?.click()}>{muted ? <VolumeX/> : <Volume2/>}</IconButton><span>Audio</span></div></aside>
    <div className="merge-timeline-scroll" ref={scroll}><div className={'merge-timeline-canvas ' + (muted ? 'audio-muted' : '')} style={{ width: canvasWidth }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag}>
      <div className="merge-ruler" onPointerDown={e => { if (!pointer.current) seek(pointerTime(e)); }}>{ticks.map(t => <span key={t} style={{ left: t * scale }}>{clock(t)}</span>)}</div>
      <div className="merge-video-track">{layout.map(({ file, left, width }, i) => <TrackClip key={file.id} language={language} file={file} asset={assets[file.id]} index={i} left={left} width={width} selected={selected === file.id} onPointerDown={e => beginDrag(e, file)} onKeyDown={e => keyDown(e, file)}/>)}</div>
      <div className="merge-audio-track">{layout.map(({ file, left, width }, i) => <TrackClip key={file.id} language={language} file={file} asset={assets[file.id]} index={i} left={left} width={width} audio selected={selected === file.id} onPointerDown={e => beginDrag(e, file)} onKeyDown={e => keyDown(e, file)}/>)}</div>
      {!!files.length && <div className="merge-playhead" ref={head} style={{ left: Math.min(canvasWidth - 1, playerClock.current * scale) }}/>} {drag && <><div className="merge-insert" style={{ left: Math.min(canvasWidth - 3, drag.insert) }}><span>{text('Hier einfügen', 'Insert here')}</span></div><div className="merge-drag-ghost" style={{ left: drag.left, width: (files.find(f => f.id === drag.id)?.durationSeconds || 0) * scale }}><Layers/>{files.find(f => f.id === drag.id)?.name}</div></>}
      {!files.length && <div className="merge-empty"><Files/><strong>{text('Keine Videos ausgewählt', 'No videos selected')}</strong><span>{text('Videos hinzufügen und unten in die gewünschte Reihenfolge ziehen.', 'Add videos and drag them into order below.')}</span><button type="button" onClick={callbacks.add} disabled={locked}><Plus/>{text('Videos hinzufügen', 'Add videos')}</button></div>}
    </div></div></div>
    <footer><span><Layers/>{text('Bild und Ton gekoppelt', 'Video and audio linked')}</span><span>{currentFile?.name || text('Keine Auswahl', 'No selection')}{currentFile ? ' · ' + clock(currentFile.durationSeconds) : ''}</span></footer>
  </section>;
  return <><section className="merge-preview"><header><MonitorPlay/><strong>{text('Vorschau', 'Preview')}</strong><span className="merge-grow"/><span>{text('Gesamte Sequenz', 'Entire sequence')}</span><span>{clock(duration)}</span></header><div className="merge-player-host" ref={host}>
    {parts[0]?.url ? <ArchivePlayer id="merge-workspace" userId="merge-workspace" parts={parts} seconds={0} initialPlaying={false} rememberPlayback={false} started t={key => playerTexts[language]?.[key] || playerTexts.de[key] || key} onProgress={() => {}} onPosition={onPosition} onError={() => setError(true)} seekRequest={seekRequest}/> : <div className="merge-player-empty">{files.length ? text('Vorschau wird vorbereitet …', 'Preparing preview …') : text('Videos für die Vorschau hinzufügen', 'Add videos to preview')}</div>}
    {(error || currentFile?.missing || (assets[selected]?.previewDone && !assets[selected]?.url)) && <div className="merge-preview-error"><span>{text('Vorschau nicht verfügbar. Quelldatei und Format prüfen.', 'Preview unavailable. Check the source file and format.')}</span><IconButton label={text('Erneut laden', 'Retry')} onClick={() => { cache.current.delete(selected); setError(false); void window.api.getMergePreview(selected).then(url => { cache.current.set(selected, { ...assets[selected], url, previewDone: true }); publish(); seek(startOf(files, selected)); }); }}><RotateCw/></IconButton></div>}
    </div><footer><span>{currentFile ? (files.indexOf(currentFile) + 1) + ' / ' + files.length : '0 / 0'}</span><strong>{currentFile?.name || '—'}</strong><span className="merge-grow"/><IconButton label={text('Vorheriger Clip', 'Previous clip')} disabled={!selected || files.indexOf(currentFile) <= 0} onClick={() => select(files[files.indexOf(currentFile) - 1].id)}><ChevronLeft/></IconButton><IconButton label={text('Nächster Clip', 'Next clip')} disabled={!selected || files.indexOf(currentFile) >= files.length - 1} onClick={() => select(files[files.indexOf(currentFile) + 1].id)}><ChevronRight/></IconButton></footer></section>
    {timelineHost && createPortal(timeline, timelineHost)}
    {sourcesOpen && createPortal(<dialog className="merge-sources-dialog" ref={dialog} onCancel={() => setSourcesOpen(false)} onPointerDown={event => { if (event.target === event.currentTarget) event.currentTarget.dataset.outside = 'true'; else delete event.currentTarget.dataset.outside; }} onClick={event => { if (event.target === event.currentTarget && event.currentTarget.dataset.outside === 'true') { event.currentTarget.close(); setSourcesOpen(false); } }}><h2>{text('Quelldateien', 'Source files')}</h2><div className="merge-sources">{files.map(f => <div key={f.id}><strong>{f.name}</strong><span>{clock(f.durationSeconds)}</span></div>)}</div><footer><button type="button" onClick={() => { dialog.current.close(); setSourcesOpen(false); }}>{text('Schließen', 'Close')}</button><button type="button" onClick={() => { dialog.current.close(); setSourcesOpen(false); callbacks.add(); }}>{text('Videos hinzufügen', 'Add videos')}</button></footer></dialog>, document.body)}
  </>;
}
