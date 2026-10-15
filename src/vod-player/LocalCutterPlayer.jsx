import { AudioMeter } from './AudioMeter.jsx';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { RangeMarkers } from './CutTimeline.jsx';
import { ChevronDown, SkipBack, SkipForward } from 'lucide-react';
import { PlayerButton, PlayerPanel, RateControl } from './PlayerControls.jsx';
import { ExactTimeForm } from './ExactTimeForm.jsx';
import { playerTexts } from './texts.js';
import './local-cutter.css';

function LocalCutterRanges({ state, options, root, t }) {
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    const timeline = document.getElementById('timeline');
    const measure = () => setWidth(previous => Math.abs(previous - timeline.getBoundingClientRect().width) > .01 ? timeline.getBoundingClientRect().width : previous);
    const observer = new ResizeObserver(measure);
    observer.observe(timeline); measure();
    return () => observer.disconnect();
  }, []);
  const chapters = useMemo(() => [{ id:'local', name:state.name, start:0, end:state.duration }], [state.name, state.duration]);
  const finePreview = { root, chapters, t, formatTime: options.format };
  const text = state.labels;
  if (!state.range) return null;
  const markers = (range, cutId, variant, limits) => <RangeMarkers key={variant + state.generation} compact trackInset={0} trackWidth={width} duration={state.duration}
    range={range} variant={variant} limits={limits} text={text} finePreview={finePreview} minimumRange={1 / state.fps} step={1 / state.fps} format={options.format}
    disabled={!state.enabled || (!cutId && Boolean(state.cut))}
    handleIds={cutId ? { start:'cutterOmitStartHandle', end:'cutterOmitEndHandle' } : { start:'cutterTrimStartHandle', end:'cutterTrimEndHandle' }}
    onChange={(start, end, interaction) => options.changeRange(start, end, cutId, interaction)}
    onDragStart={() => options.beginRange(cutId)} onDragEnd={() => options.finishRange(true)} onDragCancel={() => options.finishRange(false)}/>;
  return createPortal(<>{markers(state.range, null, 'excerpt')}{state.cut && markers(state.cut, state.cut.id, 'omission', state.cutLimits)}</>, document.getElementById('cutterRangeMarkers'));
}

import { getPlayerSeekSeconds, subscribePlayerSeekSeconds } from './player-settings.js';

function LocalCutterPlayer({ options, bind }) {
  const seekSeconds = useSyncExternalStore(subscribePlayerSeekSeconds, getPlayerSeekSeconds);
  const [state, setState] = useState(options.state);
  const [media, setMedia] = useState({ playing: false, volume: 1, muted: false, rate: 1 });
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState('');
  const root = useRef(document.getElementById('cutterPlayer'));
  const lastVolume = useRef(1);
  const position = useRef(0);
  const [seekBounds, setSeekBounds] = useState({ start: true, end: false });
  const timeLabel = useRef(null);
  bind.current = setState;
  function updateSeekBounds(time) {
    const start = time <= 0, end = !(state.duration > 0) || time >= state.duration - 1 / (state.fps || 30) - .000001;
    setSeekBounds(previous => previous.start === start && previous.end === end ? previous : { start, end });
  }
  bind.position = time => {
    position.current = time;
    updateSeekBounds(time);
    if (timeLabel.current) timeLabel.current.textContent = options.format(time);
  };
  const t = key => playerTexts[state.language === 'de' ? 'de' : 'en'][key] || key;
  const de = state.language === 'de';
  const video = options.video;
  useEffect(() => {
    const update = () => updateSeekBounds(video.currentTime);
    const events = ['timeupdate', 'seeked', 'ended', 'loadedmetadata', 'emptied'];
    events.forEach(event => video.addEventListener(event, update));
    update();
    return () => events.forEach(event => video.removeEventListener(event, update));
  }, [state.duration, state.fps, state.active, video]);
  useEffect(() => {
    const update = () => setMedia({ playing: !video.paused, volume: video.volume, muted: video.muted, rate: video.playbackRate });
    const events = ['play', 'pause', 'volumechange', 'ratechange', 'loadedmetadata', 'emptied'];
    events.forEach(event => video.addEventListener(event, update));
    const full = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', full);
    update();
    return () => { events.forEach(event => video.removeEventListener(event, update)); document.removeEventListener('fullscreenchange', full); };
  }, [video]);
  useEffect(() => {
    if (!state.active) { root.current.classList.remove('cinema'); }
  }, [state.active]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  function volume(value) {
    video.volume = Math.max(0, Math.min(1, value)); video.muted = video.volume === 0;
  }
  function mute() {
    if (media.muted || !media.volume) volume(lastVolume.current || 1);
    else { lastVolume.current = media.volume; volume(0); }
  }
  async function toggleFullscreen() {
    try { if (document.fullscreenElement === root.current) await document.exitFullscreen(); else await root.current.requestFullscreen(); }
    catch { setMessage(t('fullscreenUnavailable')); }
  }
  async function picture() {
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }
    catch { setMessage(t('pictureInPictureUnavailable')); }
  }
  function toggleCinema() { root.current.classList.toggle('cinema'); }
  if (!state.active) return null;
  const rate = <PlayerPanel root={root} label={t('playbackSpeed')} className="player-rate-button" trigger={<>{media.rate}×<ChevronDown size={14}/></>}>
    <RateControl value={String(media.rate)} onChange={value => { video.playbackRate = Number(value); }} t={t}/>
  </PlayerPanel>;
  return <><LocalCutterRanges state={state} options={options} root={root} t={t}/><div className="archive-controls local-cutter-controls" hidden={!state.active}>
    <div className="archive-control-row">
      <PlayerButton name="back" seconds={seekSeconds} label={t('skipBack').replace('{seconds}', seekSeconds)} disabled={!state.enabled || seekBounds.start} onClick={() => options.seek(video.currentTime - seekSeconds)}/>
      <PlayerButton name={media.playing ? 'pause' : 'play'} label={media.playing ? t('pause') : t('playerPlay')} disabled={!state.enabled} onClick={options.play}/>
      <PlayerButton name="forward" seconds={seekSeconds} label={t('skipForward').replace('{seconds}', seekSeconds)} disabled={!state.enabled || seekBounds.end} onClick={() => options.seek(video.currentTime + seekSeconds)}/>
      <div className="player-volume-control">
        <PlayerButton name={media.muted || !media.volume ? 'muted' : 'volume'} label={t(media.muted ? 'unmute' : 'mute')} onClick={mute}/>
        <input className="archive-volume" type="range" min="0" max="1" step="0.01" aria-label={t('volume')} value={media.muted ? 0 : media.volume} onChange={event => volume(Number(event.target.value))} style={{ '--range-progress': (media.muted ? 0 : media.volume * 100) + '%' }}/>
        <label className="player-volume-entry"><input type="number" min="0" max="100" aria-label={t('volumePercent')} value={Math.round(media.muted ? 0 : media.volume * 100)} onChange={event => volume(Number(event.target.value) / 100)}/>%</label>
      </div>
      <PlayerPanel root={root} label={t('exactTime')} className="player-time-button" trigger={<span ref={timeLabel}>{options.format(position.current)}</span>}>
        {close => <ExactTimeForm position={position.current} total={state.duration} format={options.format} parse={options.parse} placeholder="00:00:00:00" hint="HH:MM:SS:FF" onCommit={options.seek} onClose={close} t={t}/>}
      </PlayerPanel>
      <AudioMeter video={video} active={state.active} playing={media.playing} language={state.language}/>
      <span className="archive-control-spacer"/>
      <div className="local-frame-controls">
        <button type="button" className="player-button" aria-label={de ? 'Ein Bild zurück' : 'Previous frame'} title={de ? 'Ein Bild zurück' : 'Previous frame'} disabled={!state.enabled} onClick={() => options.frame(-1)}><SkipBack size={20}/></button>
        <button type="button" className="player-button" aria-label={de ? 'Ein Bild vor' : 'Next frame'} title={de ? 'Ein Bild vor' : 'Next frame'} disabled={!state.enabled} onClick={() => options.frame(1)}><SkipForward size={20}/></button>
      </div>
      {rate}
      <PlayerPanel root={root} label={t('playbackOptions')} className="local-player-options" trigger={<ChevronDown size={20}/>}>
        {close => <>
          <button type="button" className="player-menu-action" onClick={() => { toggleCinema(); close(); }}>{t('cinema')}</button>
          <button className="player-menu-action" disabled={!state.enabled} onClick={() => { void picture(); close(); }}>{t('pictureInPicture')}</button>
          <button className="player-menu-action" disabled={!state.enabled} onClick={() => options.frame(-1)}>{de ? 'Ein Bild zurück' : 'Previous frame'}</button>
          <button className="player-menu-action" disabled={!state.enabled} onClick={() => options.frame(1)}>{de ? 'Ein Bild vor' : 'Next frame'}</button>
          <label className="player-compact-volume">{t('volume')}<input type="range" min="0" max="1" step="0.01" value={media.muted ? 0 : media.volume} onChange={event => volume(Number(event.target.value))}/></label>
        </>}
      </PlayerPanel>
      <PlayerButton name={fullscreen ? 'exitFullscreen' : 'fullscreen'} label={t(fullscreen ? 'exitFullscreen' : 'fullscreen')} disabled={!state.enabled} onClick={toggleFullscreen}/>
    </div>
    {message && <div className="local-player-message" role="status">{message}</div>}
  </div></>;
}

window.LocalCutterPlayer = {
  mount(element, options) {
    const root = createRoot(element), bind = { current: null };
    root.render(<LocalCutterPlayer options={options} bind={bind}/>);
    return { update(state) { if (bind.current) bind.current(state); else options.state = state; }, updatePosition(time) { bind.position?.(time); }, destroy() { root.unmount(); } };
  },
};
