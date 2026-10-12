import './LocalCutterPlayer.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ArchivePlayer } from './ArchivePlayer.jsx';
import { TitleHistory } from './TitleHistory.jsx';
import { OmissionModes, OmissionEditor } from './OmissionEditor.jsx';
import { normalizeOmissions, planEditedVod } from '../main/domain/vod-edit-plan';
import { ListVideo } from 'lucide-react';
import { CutTimeline } from './CutTimeline.jsx';
import { omissionGaps, omissionFits, omissionGap, boundOmission } from './omission-ranges.js';
import { playerTexts } from './texts.js';
import './player.css';
import './chapters.css';
import './workspace.css';

const labels = {
  de: { loading: 'VOD wird geöffnet …', failed: 'VOD konnte nicht geladen werden.', retry: 'Erneut laden', recover: 'Player wiederherstellen', renderFailed: 'Player konnte nicht angezeigt werden.', range: 'Schnittbereich', excerpt: 'Download-Ausschnitt', omission: 'Auslassung', timeline: 'Schnittzeitleiste', timelineView: 'Ansicht der Schnittzeitleiste', overview: 'Gesamtes VOD', zoomSelection: 'Ausschnitt anzeigen', start: 'Start', end: 'Ende', setHere: 'Hier setzen', markStart: 'Start hier setzen', markEnd: 'Ende hier setzen', playRange: 'Auswahl abspielen', stopRange: 'Auswahl anhalten', full: 'Gesamtes VOD wählen', source: 'Streamqualität', keyboard: 'Leertaste / K: Wiedergabe · ← / →: 10 Sekunden · I / O: Schnittmarken · F: Vollbild', active: 'Auswahl wird abgespielt', sourceBest: 'Source' },
  en: { loading: 'Opening VOD …', failed: 'Could not load the VOD.', retry: 'Retry', recover: 'Restore player', renderFailed: 'Could not display the player.', range: 'Selected range', excerpt: 'Download excerpt', omission: 'Omission', timeline: 'Cut timeline', timelineView: 'Cut timeline view', overview: 'Entire VOD', zoomSelection: 'Show selection', start: 'Start', end: 'End', setHere: 'Set here', markStart: 'Set start here', markEnd: 'Set end here', playRange: 'Play selection', stopRange: 'Pause selection', full: 'Select entire VOD', source: 'Stream quality', keyboard: 'Space / K: playback · ← / →: 10 seconds · I / O: cut markers · F: fullscreen', active: 'Playing selection', sourceBest: 'Source' },
};

class WorkspaceBoundary extends React.Component {
  state = { failed:false };
  static getDerivedStateFromError() { return { failed:true }; }
  componentDidCatch(error, info) {
    console.error('vod-workspace-render-failed', JSON.stringify({ name:error?.name || 'Error', message:String(error?.message ?? error), stack:error?.stack, componentStack:info.componentStack }));
    this.props.onFailure();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="vod-player-error" role="alert"><span>{this.props.text.renderFailed}</span><button type="button" className="btn-secondary" data-action="restore-player" onClick={() => this.setState({ failed:false })}>{this.props.text.recover}</button></div>;
  }
}


function Workspace({ options, bind }) {
  const language = options.language === 'en' ? 'en' : 'de';
  const text = labels[language];
  const t = useCallback(key => playerTexts[language][key] || key, [language]);
  const [metadata, setMetadata] = useState(null), [metadataState, setMetadataState] = useState('loading'), [historyAttempt, setHistoryAttempt] = useState(0);
  const [chapterPreview, setChapterPreview] = useState(null);
  const [hoveredChapter, setHoveredChapter] = useState(null), [focusedChapter, setFocusedChapter] = useState(null);
  const [session, setSession] = useState(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [duration, setDuration] = useState(options.duration), [position, setPosition] = useState(0);
  const [range, setRange] = useState({ start: options.start, end: options.end });
  const modeRanges = useRef({ excerpt:{ start:options.start, end:options.end }, omission:{ start:0, end:options.duration } });
  const [omitting, setOmitting] = useState(false), [omissions, setOmissions] = useState([]), [editing, setEditing] = useState(null);
  const partMinutes = Number(options.partMinutes || 60);
  const [outputRevision, setOutputRevision] = useState(0), [, setInputValid] = useState(true);
  const [undo, setUndo] = useState([]), [redo, setRedo] = useState([]), [previewing, setPreviewing] = useState(false);
  const previewPlayback = useRef(false), previewPlan = useRef(null);
  const outputSettings = options.outputSettings?.() || { startPart: 1 };
  const selection = omitting ? modeRanges.current.excerpt : range;
  const combined = omitting || omissions.length > 0 || editing !== null;
  const gaps = useMemo(() => omissionGaps(selection, omissions, editing), [selection.start, selection.end, omissions, editing]);
  const draftRange = omitting ? range : modeRanges.current.omission;
  const draftBounds = omissionGap(draftRange, gaps);
  const editedPlan = useMemo(() => {
    try { return Number.isInteger(Number(partMinutes)) && Number(partMinutes) >= 1 && Number(partMinutes) <= 1440 ? planEditedVod(duration, Number(partMinutes) * 60, omissions, outputSettings.startPart, selection) : null; }
    catch { return null; }
  }, [duration, partMinutes, omissions, outputRevision, outputSettings.startPart, selection.start, selection.end]);
  const visibleOmissions = useMemo(() => { try { return normalizeOmissions(omissions.filter((_, index) => !omitting || index !== editing), duration).map(value => ({ start:Math.max(selection.start, value.start), end:Math.min(selection.end, value.end) })).filter(value => value.end > value.start); } catch { return []; } }, [omitting, omissions, duration, editing, selection.start, selection.end]);
  useEffect(() => { options.onOmissions?.(combined ? { editing: editing !== null, config: editedPlan ? { version: 1, partDurationSec: Number(partMinutes) * 60, ranges: editedPlan.omitted, ...(selection.start > 0 || selection.end < duration ? { selection:{ ...selection } } : {}) } : null, plan: editedPlan } : null); }, [combined, editedPlan, partMinutes, editing, options, selection.start, selection.end, duration]);
  useEffect(() => {
    const modal = document.getElementById('clipModal');
    modal.classList.toggle('is-omitting', omitting);
    return () => modal.classList.remove('is-omitting');
  }, [omitting]);
  previewPlan.current = editedPlan;
  function stopPreview() {
    if (previewPlayback.current) setSeekRequest({ playing:false });
    previewPlayback.current = false; setPreviewing(false);
  }
  function changeMode(active) {
    if (active === omitting) return;
    stopPreview();
    modeRanges.current[omitting ? 'omission' : 'excerpt'] = { ...range };
    const saved = modeRanges.current[active ? 'omission' : 'excerpt'];
    const bounds = active && omissionGap(saved, omissionGaps(modeRanges.current.excerpt, omissions, editing));
    const next = active ? boundOmission(saved, bounds || modeRanges.current.excerpt) : saved;
    selectedPlayback.current = false; setSelectionPlaying(false);
    setOmitting(active); options.onMode?.(active); setRange(next); options.onRange(modeRanges.current.excerpt.start, modeRanges.current.excerpt.end);
    setOutputRevision(value => value + 1);
  }
  function commitRanges(next) {
    stopPreview(); setUndo(current => [...current.slice(-49), omissions]); setRedo([]); setOmissions(next); setEditing(null);
  }
  function restoreRanges(direction) {
    const source = direction === 'undo' ? undo : redo;
    if (!source.length || editing !== null) return;
    stopPreview();
    if (direction === 'undo') { setUndo(source.slice(0, -1)); setRedo(current => [...current, omissions]); }
    else { setRedo(source.slice(0, -1)); setUndo(current => [...current, omissions]); }
    setOmissions(source.at(-1));
  }
  function beginRange(index = -1, value) {
    if (editing !== null || (index === -1 && omissions.length >= 256)) return;
    if (value && (value.end <= selection.start || value.start >= selection.end)) return;
    stopPreview();
    const available = omissionGaps(selection, omissions, index);
    const requested = value || (index === -1 ? { start:position, end:position + 60 } : omissions[index]);
    const candidates = value ? available.filter(gap => gap.end > value.start && gap.start < value.end) : available;
    const bounds = omissionGap(requested, candidates);
    if (!bounds) return;
    const start = Math.max(bounds.start, Math.min(requested.start, bounds.end - Math.min(60, bounds.end - bounds.start)));
    const next = boundOmission(index === -1 && !value ? { start, end:start + 60 } : requested, bounds);
    selectedPlayback.current = false; setSelectionPlaying(false);
    setEditing(index); setRange(next); setSeekRequest({ seconds:next.start, playing:false });
  }
  function preview() {
    if (previewPlayback.current) { stopPreview(); return; }
    const first = editedPlan?.ranges[0];
    if (!first) return;
    selectedPlayback.current = false; setSelectionPlaying(false);
    previewPlayback.current = true; setPreviewing(true); setSeekRequest({ seconds:first.start, playing:true });
  }
  const [seekRequest, setSeekRequest] = useState(null), [selectionPlaying, setSelectionPlaying] = useState(false);
  const host = useRef(null), rangeRef = useRef(range), selectedPlayback = useRef(false);
  rangeRef.current = range;
  const requestId = useMemo(() => crypto.randomUUID(), [options.url, attempt]);
  const started = metadata?.started ?? Date.parse(options.date);
  const parts = useMemo(() => [{ id: options.url, url: session?.sourceUrl, duration, started }], [session, duration, options.url, started]);
  const chapters = useMemo(() => (metadata?.chapters || []).map(chapter => ({ ...chapter, end: Math.min(duration, chapter.end) })).filter(chapter => chapter.end > chapter.start), [metadata, duration]);
  useEffect(() => {
    setChapterPreview(hoveredChapter || focusedChapter ? { recordingId: options.url, chapterId: hoveredChapter || focusedChapter } : null);
  }, [hoveredChapter, focusedChapter, options.url]);
  const changeRange = useCallback((start, end, interaction) => {
    stopPreview();
    if (omitting) {
      if (!draftBounds || (interaction?.source === 'input' && !omissionFits({ start, end }, gaps))) return;
      if (interaction?.source !== 'input') ({ start, end } = boundOmission({ start, end }, draftBounds));
    }
    selectedPlayback.current = false; setSelectionPlaying(false);
    setRange({ start, end });
    if (!omitting) options.onRange(start, end);
    if (interaction?.source === 'pointer' && interaction.boundary === 'start') setSeekRequest({ seconds: start });
  }, [options, omitting, draftBounds?.start, draftBounds?.end, gaps]);
  function setExcerpt(start, end) {
    const next = { start:Math.round(start * 1000) / 1000, end:Math.round(end * 1000) / 1000 };
    const bounds = omissionGap(range, omissionGaps(next, omissions, editing));
    const draft = boundOmission(range, bounds || next);
    modeRanges.current.excerpt = next;
    modeRanges.current.omission = draft;
    setRange(draft);
    return next;
  }
  function changeExcerpt(start, end, interaction) {
    stopPreview();
    selectedPlayback.current = false; setSelectionPlaying(false);
    const next = setExcerpt(start, end);
    options.onRange(next.start, next.end);
    if (interaction?.source === 'pointer' && interaction.boundary === 'start') setSeekRequest({ seconds:next.start });
  }
  const seek = useCallback(seconds => { setSeekRequest({ seconds }); }, []);
  bind.current = {
    snapshot() { return editing !== null ? null : { seconds:position, duration, range:{ ...selection }, omissions:visibleOmissions.map(value => ({ ...value })) }; },
    applyExcerpt(value) {
      const selected = normalizeOmissions([value.range], duration)[0];
      const ranges = normalizeOmissions(value.omissions, duration);
      if (ranges.some(item => item.start < selected.start || item.end > selected.end) || !planEditedVod(duration, partMinutes * 60, ranges, 1, selected).duration) throw new Error('Invalid excerpt');
      stopPreview(); setOmitting(false); options.onMode?.(false);
      modeRanges.current = { excerpt:selected, omission:selected };
      setRange(selected); setOmissions(ranges); setEditing(null); setUndo([]); setRedo([]);
      selectedPlayback.current = false; setSelectionPlaying(false);
      options.onRange(selected.start, selected.end); seek(selected.start);
    },
    updateRange(start, end) { stopPreview(); if (omitting) setExcerpt(start, end); else setRange({ start, end }); selectedPlayback.current = false; setSelectionPlaying(false); }, seek, refreshOutput() { setOutputRevision(value => value + 1); }, setInputValid };
  useEffect(() => {
    const id = requestId;
    let closed = false;
    setSession(null); setError(false);
    window.api.openVodPlayback({ id, url: options.url }).then(result => {
      if (closed) return;
      if (result) setSession(result);
      else setError(true);
    }).catch(() => { if (!closed) setError(true); });
    return () => { closed = true; void window.api.closeVodPlayback(id).catch(() => undefined); };
  }, [options.url, requestId]);
  useEffect(() => {
    let closed = false;
    setMetadataState('loading');
    window.api.getVodTimeline({ id: requestId, url: options.url }).then(result => {
      if (closed) return;
      setMetadata(result); setMetadataState(result ? 'ready' : 'error');
    }).catch(() => { if (!closed) setMetadataState('error'); });
    return () => { closed = true; };
  }, [options.url, requestId, historyAttempt]);
  const onTimeline = useCallback(timeline => {
    const total = Math.round(timeline.reduce((sum, part) => sum + part.duration, 0) * 1000) / 1000;
    if (total > 0 && total !== duration) {
      const current = rangeRef.current;
      const start = Math.min(current.start, Math.max(0, total - .001));
      const end = Math.abs(current.end - duration) < .0005 ? total : Math.min(total, Math.max(start + .001, current.end));
      rangeRef.current = { start, end };
      for (const key of ['excerpt', 'omission']) {
        const saved = modeRanges.current[key];
        const savedStart = Math.min(saved.start, Math.max(0, total - .001));
        modeRanges.current[key] = { start:savedStart, end:Math.abs(saved.end - duration) < .0005 ? total : Math.min(total, Math.max(savedStart + .001, saved.end)) };
      }
      setDuration(total); setRange(rangeRef.current);
      setOmissions(current => current.map(value => ({ start: value.start, end: Math.abs(value.end - duration) < .0005 ? total : Math.min(total, value.end) })).filter(value => value.end > value.start));
      setUndo([]); setRedo([]);
      const shown = omitting ? modeRanges.current.excerpt : rangeRef.current;
      options.onDuration(total); options.onRange(shown.start, shown.end);
    }
  }, [duration, options, omitting]);
  const onPosition = useCallback(seconds => {
    setPosition(seconds);
    if (previewPlayback.current) {
      const plan = previewPlan.current;
      const first = plan?.ranges[0], last = plan?.ranges.at(-1);
      if (!first || !last || seconds >= last.end - .02) {
        previewPlayback.current = false; setPreviewing(false); setSeekRequest({ playing:false });
      } else if (seconds < first.start) {
        setSeekRequest({ seconds:first.start });
      } else {
        const excluded = plan.omitted.find(item => seconds >= item.start && seconds < item.end);
        if (excluded) setSeekRequest({ seconds:excluded.end });
      }
    }
    if (selectedPlayback.current && seconds >= rangeRef.current.end) {
      selectedPlayback.current = false; setSelectionPlaying(false);
      setSeekRequest({ playing:false });
    }
  }, []);
  function mark(which, excerpt = false) {
    const value = Math.min(duration, Math.max(0, Math.round(position * 10) / 10));
    if (omitting && excerpt) {
      const current = modeRanges.current.excerpt;
      changeExcerpt(which === 'start' ? Math.min(value, current.end - .001) : current.start, which === 'end' ? Math.max(value, current.start + .001) : current.end);
      return;
    }
    if (omitting && editing === null) { beginRange(); return; }
    changeRange(which === 'start' ? Math.min(value, range.end - .001) : range.start,
      which === 'end' ? Math.max(value, range.start + .001) : range.end);
  }
  function playRange() {
    if (omissions.length) { preview(); return; }
    if (selectionPlaying) { selectedPlayback.current = false; setSelectionPlaying(false); setSeekRequest({ playing:false }); return; }
    selectedPlayback.current = true; setSelectionPlaying(true);
    setSeekRequest({ seconds:range.start, playing:true });
  }
  function selectChapter(chapter) {
    if (editing !== null) setEditing(null);
    if (omitting) {
      modeRanges.current.omission = { ...range };
      modeRanges.current.excerpt = { start:chapter.start, end:chapter.end };
      setOmitting(false);
      options.onMode?.(false);
    }
    setRange({ start:chapter.start, end:chapter.end });
    options.onRange(chapter.start, chapter.end);
    seek(chapter.start);
  }
  return <div ref={host} className="vod-player-workspace" onKeyDown={event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input, textarea, button, [contenteditable="true"]')) return;
    if (event.key.toLowerCase() === 'i' || event.key.toLowerCase() === 'o') { event.preventDefault(); mark(event.key.toLowerCase() === 'i' ? 'start' : 'end'); }
  }}>
    <WorkspaceBoundary text={text} onFailure={() => { stopPreview(); selectedPlayback.current = false; setSelectionPlaying(false); setSeekRequest({ seconds:position, playing:false }); }}>
    {session ? <ArchivePlayer key={session.id} id={options.url} userId="tvm-local" parts={parts} seconds={range.start}
      broadcastStarted={started} started t={t} chapters={chapters} titleHistory={metadata?.titleHistory || []} vodTitle={metadata?.title || options.title} chapterPreview={chapterPreview} onProgress={() => {}} onError={() => setError(true)}
      onPosition={onPosition} onTimeline={onTimeline} seekRequest={seekRequest} excerptRange={omitting ? selection : null} onExcerptRange={changeExcerpt} cutRange={omitting && (editing === null || !draftBounds) ? null : range} cutLimits={omitting ? draftBounds : null} onCutRange={changeRange} cutText={text} omissions={visibleOmissions}/>
      : !error && <div className="vod-player-loading" role="status"><span className="vod-loading-symbol"/>{text.loading}</div>}
    {error && <div className="vod-player-error" role="status"><span>{text.failed}</span><button type="button" className="btn-secondary" onClick={() => setAttempt(value => value + 1)}>{text.retry}</button></div>}
    <div className="vod-player-source"><span>{session?.quality ? text.sourceBest : '…'}</span>{selectionPlaying && <span>{text.active}</span>}</div>
    {createPortal(<div className="vod-history">
      <h3 className="vod-history-title" id="clipHistoryTitle"><ListVideo size={17}/>{t('streamHistory')}</h3>
       {metadataState === 'loading' && <p className="vod-history-status" role="status">{t('historyLoading')}</p>}
      {metadataState === 'error' && <div className="vod-history-status" role="status"><span>{t('historyUnavailable')}</span><button type="button" className="btn-secondary" onClick={() => setHistoryAttempt(value => value + 1)}>{text.retry}</button></div>}
      {metadataState === 'ready' && <>
        <TitleHistory id={options.url} chapters={chapters} history={metadata.titleHistory} parts={parts} started={started} seconds={position}
          onSeek={seek} onTitleSeek={title => seek(title.seconds)} onHover={setHoveredChapter} onFocus={setFocusedChapter}
          onSelectRange={selectChapter} t={t}/>
        {metadata.chaptersStatus === 'unavailable' && <p className="vod-history-status">{t('historyNoChapterSource')}</p>}
      </>}
    </div>, document.getElementById('clipHistory'))}
    {createPortal(<OmissionModes active={omitting} onChange={changeMode} language={language} count={omissions.filter(value => value.end > selection.start && value.start < selection.end).length}/>, document.getElementById('clipEditMode'))}
    {createPortal(<OmissionEditor active={omitting} gaps={gaps} selection={selection} onSelection={() => changeMode(false)} ranges={omissions} plan={editedPlan} range={omitting ? range : modeRanges.current.omission} duration={duration} language={language} editing={editing}
      onNew={() => beginRange()} onEdit={beginRange} onRange={changeRange} onCancel={() => setEditing(null)}
      onApply={value => { if (editing !== null && omissionFits(value, gaps)) commitRanges(editing === -1 ? [...omissions, value] : omissions.map((item, index) => index === editing ? value : item)); }}
      onRemove={index => commitRanges(omissions.filter((_, at) => at !== index))} onUndo={() => restoreRanges('undo')} onRedo={() => restoreRanges('redo')}
      canUndo={undo.length > 0} canRedo={redo.length > 0} previewing={previewing} onPreview={preview} canPreview={Boolean(session)} root={host}
      filename={part => options.filename?.(part) || ''}/>, document.getElementById('clipOmissionPanel'))}
    {['start', 'end'].map(which => createPortal(<button type="button" className="vod-set-boundary" disabled={!session} aria-label={which === 'start' ? text.markStart : text.markEnd} title={which === 'start' ? text.markStart : text.markEnd} onClick={() => mark(which, true)}>{text.setHere}</button>, document.getElementById(which === 'start' ? 'clipMarkStart' : 'clipMarkEnd'), which))}
    {!omitting && createPortal(<><CutTimeline omissions={visibleOmissions} chapters={chapters} duration={Math.max(.1, duration)} range={range} position={position} onChange={changeRange} onSeek={seek} text={text}
      finePreview={{root:host, parts, broadcastStarted:started, chapters, titleHistory:metadata?.titleHistory || [], vodTitle:metadata?.title || options.title, omissions:visibleOmissions, t}}/>
    <div className="vod-mark-actions" title={text.keyboard}>
      <button type="button" className="btn-secondary" disabled={!session} onClick={playRange}>{selectionPlaying || previewing ? text.stopRange : text.playRange}</button>
      <button type="button" className="btn-secondary" onClick={() => changeRange(0, duration)}>{text.full}</button>
    </div>
</>, document.getElementById('clipSelectionTools'))}
    </WorkspaceBoundary>
  </div>;
}

window.VodPlayer = {
  mountPreview(element, options) {
    const root = createRoot(element);
    const language = options.language === 'en' ? 'en' : 'de';
    const t = key => playerTexts[language][key] || key;
    root.render(<ArchivePlayer id={options.id} userId="tvm-clip-preview" parts={[{ id:options.id, url:options.sourceUrl, duration:options.duration }]} seconds={0} started t={t} onProgress={() => {}} onError={options.onError}/>);
    return { destroy() { root.unmount(); } };
  },
  planEditedVod,
  mount(element, options) {
    const root = createRoot(element), bind = { current: null };
    root.render(<Workspace options={options} bind={bind}/>);
    return {
      destroy() { root.unmount(); },
      snapshot() { return bind.current?.snapshot() ?? null; },
      applyExcerpt(value) { if (!bind.current) throw new Error('Player not ready'); bind.current.applyExcerpt(value); },
      updateRange(start, end) { bind.current?.updateRange(start, end); },
      seek(seconds) { bind.current?.seek(seconds); },
      refreshOutput() { bind.current?.refreshOutput(); },
      setInputValid(valid) { bind.current?.setInputValid(valid); },
    };
  },
};
