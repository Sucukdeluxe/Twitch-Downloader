import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, ChevronDown } from "lucide-react";
import { PlayerIcon, PlayerButton, PlayerPanel, RateControl } from "./PlayerControls.jsx";
import { locateTime, timeLabel } from "./timeline.js";
import { latestSeek, activateMedia, applyMediaPosition, playWithFallback, frameAtTarget } from "./playback-navigation.js";
import { SeekTimeline } from "./SeekTimeline.jsx";
import { ExactTimeForm } from "./ExactTimeForm.jsx";
import { chapterRange } from "./chapter-range.js";
import { ChannelImage } from "./ChannelImage.jsx";
import { playbackMetrics } from "./playback-metrics.js";
import { viewerCurve, viewerSampleAt } from "./viewer-history.js";
import { streamTimestamp } from "./stream-clock.js";
import { ViewerCount } from "./ViewerHistory.jsx";
import { playerControlsPinned } from "./player-controls-visibility.js";
import { titlePosition } from "./title-history.js";
import { playerKeyAction } from "./player-keyboard.js";
import { createPlaybackCheckpoint, checkpointPosition, checkpointSnapshot } from "./playback-checkpoint.js";
import { clearMediaSource, setMediaSource } from './media-source.js';

import { getPlayerSeekSeconds, subscribePlayerSeekSeconds } from './player-settings.js';

export function ArchivePlayer({ id, userId, parts, live = false, seconds, poster, started = true, broadcastStarted, viewerHistory, viewerGaps, titleHistory = [], vodTitle, requestedAt = 0, prepareMilliseconds, onStart, onProgress, onPosition, onTimeline, onError, t, chapters = [], seekRequest, chapterPreview, excerptRange, onExcerptRange, cutRange, cutLimits, onCutRange, cutText, omissions = [] }) {
  const seekSeconds = useSyncExternalStore(subscribePlayerSeekSeconds, getPlayerSeekSeconds);
  const [checkpointStore] = useState(() => createPlaybackCheckpoint(userId, id));
  const [savedCheckpoint] = useState(() => checkpointStore.read());
  const initialized = useRef(false), lastCheckpoint = useRef(0), autoplayBlockedRef = useRef(false), wasStarted = useRef(started);
  const [restoreWaitExpired, setRestoreWaitExpired] = useState(false);
  const root = useRef(null), videos = useRef([]), slots = useRef([-1, -1]);
  const active = useRef(0), wanted = useRef(savedCheckpoint?.playing ?? true), pending = useRef([null, null]);
  const latest = useRef(null), measured = useRef({}), lastSaved = useRef(0);
  const frameObservers = useRef(new Map());
  const playbackStats = useRef(null), didPlay = useRef(false);
  if (!playbackStats.current) playbackStats.current = playbackMetrics();
  const navigation = useRef(null), scrubbing = useRef(false), positionValue = useRef(savedCheckpoint?.seconds ?? seconds ?? 0);
  const queuedAt = useRef(0);
  const heldFrame = useRef(null), transition = useRef(null), playTasks = useRef(new Map());
  const [holdingFrame,setHoldingFrame] = useState(false), [hasFrame,setHasFrame] = useState(false), [autoplayBlocked,setAutoplayBlocked] = useState(false);
  const seekMeasure = useRef(null), seekFrame = useRef(null), generation = useRef(0);
  const [slot, setSlot] = useState(0), [position, setPosition] = useState(savedCheckpoint?.seconds ?? seconds ?? 0);
  const [playing, setPlaying] = useState(false), [waiting, setWaiting] = useState(true);
  const [volume, setVolume] = useState(savedCheckpoint?.volume ?? 1), [speed, setSpeed] = useState(String(savedCheckpoint?.speed ?? 1)), [revision, setRevision] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true), [cinema, setCinema] = useState(false), [fullscreen, setFullscreen] = useState(false);
  const [feedback, setFeedback] = useState(null), [preview, setPreview] = useState(null);
  const hideTimer = useRef(null), feedbackTimer = useRef(null), clickTimer = useRef(null);
  const menuOpen = useRef(false), lastVolume = useRef(savedCheckpoint?.lastVolume ?? 1);
  latest.current = { parts, live, onProgress, onError, volume, speed };
  if (!navigation.current) navigation.current = latestSeek(value => latest.current.seek(value, queuedAt.current));
  const timeline = () => latest.current.parts.map(part => ({ ...part, duration: measured.current[part.id] ?? part.duration }));
  const total = timeline().reduce((sum, part) => sum + (part.duration || 0), 0);
  const actualParts = useMemo(()=>timeline(),[parts,revision]);
  useEffect(()=>{onTimeline?.(actualParts);},[actualParts,onTimeline]);
  const viewerCurves = useMemo(() => viewerCurve(viewerHistory, timeline(), broadcastStarted, total, live, viewerGaps), [viewerHistory, viewerGaps, parts, broadcastStarted, total, live, revision]);
  const viewerSample = viewerSampleAt(viewerHistory, streamTimestamp(timeline(), broadcastStarted, position));
  const sourceReady = Boolean(parts[0]?.url);
  const appliedSeek = useRef(null);
  const catalogDuration = parts.reduce((sum, part) => sum + (part.duration || 0), 0);
  const waitingForCheckpoint = Boolean(!initialized.current && sourceReady && live && !restoreWaitExpired && savedCheckpoint && savedCheckpoint.seconds > catalogDuration && !parts.some(part => String(part.id) === savedCheckpoint.partId));
  useEffect(() => {
    if (!waitingForCheckpoint) return;
    const timer = setTimeout(() => setRestoreWaitExpired(true), 10000);
    return () => clearTimeout(timer);
  }, [waitingForCheckpoint]);
  const chapterEndpoint = Math.abs(chapters.at(-1)?.end - catalogDuration) < 0.001 ? total : undefined;
  const highlightedRange = useMemo(() => chapterRange(chapters, chapterPreview?.recordingId === id ? chapterPreview.chapterId : null, total), [chapters, chapterPreview, id, total]);
  const coverSources = [...new Set(chapters.map(chapter=>chapter.image).filter(Boolean))].join("\n");
  useEffect(() => {
    for (const src of coverSources.split("\n").filter(Boolean)) { const image = new Image(); image.src = src; }
  }, [coverSources]);
  useEffect(() => { onPosition?.(position); }, [position, onPosition]);
  const offsetFor = index => timeline().slice(0, index).reduce((sum, part) => sum + (part.duration || 0), 0);
  function persistCheckpoint(force = false, sync = false) {
    if (!initialized.current || (!force && Date.now() - lastCheckpoint.current < 1000)) return;
    const element = videos.current[active.current];
    const snapshot = checkpointSnapshot({ parts: timeline(), index: slots.current[active.current], currentTime: element?.currentTime,
      target: navigation.current.pending ? positionValue.current : null,
      pending: pending.current[active.current] ?? transition.current?.offset ?? null,
      playing: wanted.current, volume: latest.current.volume, lastVolume: lastVolume.current, speed: latest.current.speed });
    if (!snapshot) return;
    checkpointStore.write(snapshot);
    lastCheckpoint.current = Date.now();
    if (sync) latest.current.onProgress?.(snapshot.seconds);
  }
  latest.current.persist = persistCheckpoint;
  useEffect(() => {
    const save = () => latest.current.persist(true, true);
    const hide = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", hide); };
  }, []);
  function revealControls() {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!playerControlsPinned(root.current?.querySelector(".archive-controls"), menuOpen.current, scrubbing.current)) setControlsVisible(false);
    }, 2500);
  }
  function showFeedback(value) {
    setFeedback(value);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 700);
  }
  function skip(amount) {
    if ((amount < 0 && positionValue.current <= 0) || (amount > 0 && positionValue.current >= total - .001)) return;
    requestSeek(positionValue.current + amount);
    showFeedback({ seek: amount });
    revealControls();
  }
  function mute() {
    if (volume) { lastVolume.current = volume; setVolume(0); }
    else setVolume(lastVolume.current || 1);
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else await root.current.requestFullscreen?.();
    } catch { showFeedback({ label: t("fullscreenUnavailable") }); }
    revealControls();
  }
  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videos.current[active.current].requestPictureInPicture();
    } catch { showFeedback({ label: t("pictureInPictureUnavailable") }); }
  }
  function panelChanged(open) { menuOpen.current = open; revealControls(); }
  function mark(name) {
    if (root.current && requestedAt > 0 && !root.current.dataset[name]) root.current.dataset[name] = String(Math.round(performance.now() - requestedAt));
  }
  function observeFrame(element) {
    if (!requestedAt || root.current?.dataset.firstFrameMs || frameObservers.current.has(element) || !element.requestVideoFrameCallback) return;
    const callback = element.requestVideoFrameCallback(() => {
      frameObservers.current.delete(element);
      if (element === videos.current[active.current]) mark("firstFrameMs");
    });
    frameObservers.current.set(element, callback);
  }

  function resume(element) {
    const revision = generation.current;
    if (playTasks.current.get(element) === revision) return;
    playTasks.current.set(element,revision);
    const current = () => revision === generation.current && element === videos.current[active.current] && wanted.current;
    void playWithFallback(element,current,()=>{ lastVolume.current=latest.current.volume || 1; latest.current.volume=0; setVolume(0); }, { allowMutedFallback: !savedCheckpoint })
      .then(state=>{if(state === "blocked" && current()){autoplayBlockedRef.current=true;setAutoplayBlocked(true);setWaiting(false);}})
      .catch(()=>{if(current())latest.current.onError("playback_failed");})
      .finally(()=>{if(playTasks.current.get(element)===revision)playTasks.current.delete(element);});
  }
  function retainFrame() {
    const element = videos.current[active.current], canvas = heldFrame.current;
    if (transition.current || !canvas || element.readyState < 2 || !element.videoWidth) return;
    const scale = Math.min(1,1280/element.videoWidth);
    canvas.width = Math.round(element.videoWidth*scale); canvas.height = Math.round(element.videoHeight*scale);
    try { canvas.getContext("2d").drawImage(element,0,0,canvas.width,canvas.height); setHoldingFrame(true); } catch {}
  }
  function presentFrame(which) {
    const element = videos.current[which], target = transition.current;
    if (which !== active.current || !target || target.generation !== generation.current || !frameAtTarget(element,pending.current[which],target.offset)) return;
    transition.current = null; setHoldingFrame(false); setHasFrame(true); mark("firstFrameMs");
  }
  function applyPending(which) {
    const element = videos.current[which];
    if (pending.current[which] !== null && applyMediaPosition(element, pending.current[which])) {
      if (which === active.current && transition.current?.generation === generation.current) transition.current.offset = element.currentTime;
      if (which === active.current && seekMeasure.current?.generation === generation.current) seekMeasure.current.target = element.currentTime;
      pending.current[which] = null;
    }
    if (which === active.current && wanted.current && !autoplayBlockedRef.current && element.paused && pending.current[which] === null) resume(element);
  }
  function switchPart(index, offset = 0, play = wanted.current) {
    const part = latest.current.parts[index];
    if (!part) return;
    playbackStats.current.finish();
    retainFrame();
    generation.current++;
    transition.current = { generation:generation.current, offset };
    setAutoplayBlocked(false);
    autoplayBlockedRef.current = false;
    const previous = active.current;
    let next = slots.current.indexOf(index);
    if (next < 0) next = slots.current[previous] < 0 ? previous : 1 - previous;
    wanted.current = play;
    active.current = next;
    setSlot(next);
    const element = videos.current[next];
    pending.current[next] = offset;
    slots.current[next] = index;
    activateMedia(videos.current[previous], element, part.url, { play, volume: latest.current.volume, speed: latest.current.speed });
    setWaiting(element.readyState < 3);
    setPosition(offsetFor(index) + offset);
    positionValue.current = offsetFor(index) + offset;
    if (play) observeFrame(element);
    applyPending(next);
    presentFrame(next);
  }
  function seek(seconds, requested = performance.now()) {
    const target = locateTime(timeline(), seconds);
    if (seekFrame.current) seekFrame.current.element.cancelVideoFrameCallback?.(seekFrame.current.callback);
    seekFrame.current = null;
    seekMeasure.current = { started: requested, index: target.index, target: target.offset, generation: generation.current + 1 };
    if (root.current) {
      delete root.current.dataset.seekReadyMs;
      delete root.current.dataset.seekFrameMs;
      root.current.dataset.seekTarget = String(seconds);
      root.current.dataset.seekCount = String(Number(root.current.dataset.seekCount || 0) + 1);
    }
    switchPart(target.index, target.offset);
    observeSeekFrame(videos.current[active.current]);
    settleSeek(active.current);
  }
  latest.current.seek = seek;
  function settleSeek(which) {
    const measurement = seekMeasure.current, element = videos.current[which];
    if (which !== active.current || measurement?.generation !== generation.current || pending.current[which] !== null || element.seeking || element.readyState < 2 || Math.abs(element.currentTime - measurement.target) > 1) return;
    if (root.current && !root.current.dataset.seekReadyMs) root.current.dataset.seekReadyMs = String(Math.round(performance.now() - measurement.started));
  }
  function observeSeekFrame(element) {
    const measurement = seekMeasure.current;
    if (!measurement || !element.requestVideoFrameCallback) return;
    const callback = element.requestVideoFrameCallback((now, metadata) => {
      seekFrame.current = null;
      if (seekMeasure.current !== measurement || generation.current !== measurement.generation || element !== videos.current[active.current]) return;
      if (pending.current[active.current] !== null || element.seeking || Math.abs(metadata.mediaTime - measurement.target) > 1) {
        observeSeekFrame(element);
        return;
      }
      if (root.current) root.current.dataset.seekFrameMs = String(Math.round(performance.now() - measurement.started));
    });
    seekFrame.current = { element, callback };
  }
  function requestSeek(value) {
    const target = Math.max(0, Math.min(value, Math.max(0, total - 0.01)));
    positionValue.current = target;
    queuedAt.current = performance.now();
    setPosition(target);
    navigation.current.request(target);
    persistCheckpoint(true);
  }
  function toggle() {
    if (!started) { onStart?.(); return; }
    if (!sourceReady || waitingForCheckpoint) return;
    const element = videos.current[active.current];
    wanted.current = autoplayBlockedRef.current || !wanted.current;
    autoplayBlockedRef.current = false;
    setAutoplayBlocked(false);
    if (wanted.current) resume(element);
    else element.pause();
    persistCheckpoint(true, true);
    showFeedback({ icon: wanted.current ? "play" : "pause" });
    revealControls();
  }
  latest.current.toggle = toggle;
  useEffect(() => {
    const handleSpace = event => {
      if (event.key !== " " || root.current?.contains(event.target)) return;
      const action = playerKeyAction(event);
      if (action !== "toggle" && action !== "consume") return;
      event.preventDefault();
      if (action === "toggle") { clearTimeout(clickTimer.current); latest.current.toggle(); }
    };
    document.addEventListener("keydown", handleSpace);
    return () => document.removeEventListener("keydown", handleSpace);
  }, []);
  function updateTime(which) {
    if (which !== active.current) return;
    const element = videos.current[which], index = slots.current[which];
    if (scrubbing.current || pending.current[which] !== null || element.seeking || navigation.current.pending || transition.current) return;
    const current = offsetFor(index) + element.currentTime;
    setPosition(current);
    positionValue.current = current;
    persistCheckpoint();
    if (Date.now() - lastSaved.current > 15000) {
      lastSaved.current = Date.now();
      latest.current.onProgress(current);
    }
    const next = latest.current.parts[index + 1], other = 1 - which;
    if (next && element.duration - element.currentTime < 20 && slots.current[other] !== index + 1) {
      const preload = videos.current[other];
      preload.pause();
      preload.muted = true;
      preload.preload = "auto";
      slots.current[other] = index + 1;
      pending.current[other] = 0;
      setMediaSource(preload, next.url);
    }
  }
  useEffect(() => {
    if (!sourceReady || waitingForCheckpoint) return;
    const initial = checkpointPosition(savedCheckpoint, timeline(), seconds);
    switchPart(initial.index, initial.offset, started && (savedCheckpoint?.playing ?? true));
    initialized.current = true;
    return () => {
      latest.current.persist(true, true);
      initialized.current = false;
      wanted.current = false;
      navigation.current.cancel();
      if (seekFrame.current) seekFrame.current.element.cancelVideoFrameCallback?.(seekFrame.current.callback);
      seekFrame.current = null;
      for (const [element, callback] of frameObservers.current) element.cancelVideoFrameCallback?.(callback);
      frameObservers.current.clear();
      for (const element of videos.current) {
        element.pause();
        clearMediaSource(element);
      }
    };
  }, [id, sourceReady, waitingForCheckpoint]);
  useEffect(() => {
    const startRequested = !wasStarted.current && started;
    wasStarted.current = started;
    if (!started || !sourceReady || waitingForCheckpoint || !initialized.current) return;
    if (startRequested) wanted.current = true;
    const element = videos.current[active.current];
    element.preload = "auto";
    if (element.readyState >= 1) mark("metadataMs");
    observeFrame(element);
    applyPending(active.current);
  }, [started, sourceReady, waitingForCheckpoint]);
  useEffect(() => {
    if (!seekRequest || !sourceReady || waitingForCheckpoint || !started || appliedSeek.current === seekRequest) return;
    appliedSeek.current = seekRequest;
    if (typeof seekRequest.playing === 'boolean') {
      wanted.current = seekRequest.playing;
      if (seekRequest.playing) { autoplayBlockedRef.current = false; setAutoplayBlocked(false); }
      else { videos.current[active.current]?.pause(); setPlaying(false); }
    }
    const target = seekRequest.title ? titlePosition(seekRequest.title,timeline(),broadcastStarted).seconds : seekRequest.seconds;
    if (target !== null && Number.isFinite(target)) requestSeek(target);
    if (seekRequest.playing) resume(videos.current[active.current]);
    if (typeof seekRequest.playing === 'boolean') persistCheckpoint(true, true);
    revealControls();
  }, [seekRequest, sourceReady, waitingForCheckpoint, started]);
  useEffect(() => {
    for (const [index, element] of videos.current.entries()) {
      element.volume = volume;
      element.muted = index !== active.current || volume === 0;
      element.playbackRate = Number(speed);
    }
    persistCheckpoint(true);
  }, [volume, speed, slot]);
  useEffect(() => {
    const element = videos.current[active.current], index = slots.current[active.current];
    if (element?.ended && wanted.current && parts[index + 1]) switchPart(index + 1, 0, true);
    else if (element?.ended && !live) { wanted.current = false; setWaiting(false); }
  }, [parts.length, live]);
  useEffect(() => {
    const changed = () => { setFullscreen(document.fullscreenElement === root.current); revealControls(); };
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      for (const timer of [hideTimer, feedbackTimer, clickTimer]) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => { revealControls(); }, [playing]);
  useEffect(() => {
    const timer = setInterval(() => {
      const element = videos.current[active.current];
      if (root.current && element) Object.assign(root.current.dataset, playbackStats.current.snapshot(element));
    }, 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div ref={root} className={`archive-player ${cinema ? "cinema" : ""} ${controlsVisible || !playing || waiting || highlightedRange || preview ? "controls-visible" : "controls-hidden"}`} data-prepare-ms={prepareMilliseconds} tabIndex={0} role="region" aria-label={t("recordings")} onPointerMove={revealControls} onKeyDown={event => {
      if (event.key === "Escape" && (cinema || document.fullscreenElement === root.current)) {
        event.preventDefault();
        event.stopPropagation();
        if (document.fullscreenElement === root.current) void document.exitFullscreen();
        else setCinema(false);
        return;
      }
      const action = playerKeyAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "consume") return;
      revealControls();
      if (!started) { if (action === "toggle") onStart?.(); return; }
      if (!sourceReady || waitingForCheckpoint) return;
      if (action === "toggle") { clearTimeout(clickTimer.current); toggle(); }
      if (action === "forward" || action === "back") skip(action === "forward" ? seekSeconds : -seekSeconds);
      if (action === "louder" || action === "quieter") setVolume(value => Math.max(0, Math.min(1, value + (action === "louder" ? .05 : -.05))));
      if (action === "mute") mute();
      if (action === "fullscreen") toggleFullscreen();
      if (action === "start" || action === "end") requestSeek(action === "start" ? 0 : total);
    }}>
      <div className="archive-screen">
        <ViewerCount sample={viewerSample} t={t} overlay/>
        {[0, 1].map(which => <video key={which} ref={element => { if (element) videos.current[which] = element; }}
          className={slot === which ? "active" : "standby"} aria-hidden={slot !== which} tabIndex={-1} playsInline crossOrigin="anonymous" preload="auto" poster={!hasFrame ? poster : undefined}
          onClick={event => { root.current.focus({ preventScroll: true }); clearTimeout(clickTimer.current); if (event.detail !== 2) toggle(); }}
          onDoubleClick={() => { clearTimeout(clickTimer.current); toggle(); toggleFullscreen(); }}
          onLoadedMetadata={() => {
            const element = videos.current[which], part = latest.current.parts[slots.current[which]];
            if (part && Number.isFinite(element.duration)) { measured.current[part.id] = element.duration; setRevision(value => value + 1); }
            applyPending(which);
            if (which === active.current) mark("metadataMs");
          }}
          onTimeUpdate={() => updateTime(which)}
          onSeeking={() => { if (which === active.current) setWaiting(true); }}
          onSeeked={() => {
            if (which !== active.current) return;
            settleSeek(which);
            presentFrame(which);
            setWaiting(videos.current[which].readyState < 3);
            updateTime(which);
          }}
          onLoadedData={()=>presentFrame(which)}
          onPlay={() => { if (which === active.current && initialized.current && !transition.current) { wanted.current = true; persistCheckpoint(true); } }}
          onPlaying={() => { if (which === active.current) { playbackStats.current.finish(); didPlay.current = true; presentFrame(which); setPlaying(true); setWaiting(false); mark("playingMs"); persistCheckpoint(true); } }}
          onPause={() => { if (which === active.current) { playbackStats.current.finish(); setPlaying(false); if (initialized.current && !transition.current && pending.current[which] === null && !navigation.current.pending && !videos.current[which].ended) { wanted.current = false; persistCheckpoint(true, true); } } }}
          onWaiting={() => { if (which === active.current) { if (didPlay.current && wanted.current && !transition.current && !videos.current[which].seeking) playbackStats.current.wait(); setWaiting(true); } }}
          onCanPlay={() => { if (which === active.current) { presentFrame(which); setWaiting(false); mark("canPlayMs"); settleSeek(which); } }}
          onEnded={() => {
            if (which !== active.current) return;
            const index = slots.current[which];
            latest.current.onProgress(offsetFor(index) + videos.current[which].duration);
            if (latest.current.parts[index + 1]) switchPart(index + 1, 0, true);
            else { positionValue.current = offsetFor(index) + videos.current[which].duration; setPosition(positionValue.current); wanted.current = latest.current.live; setPlaying(false); setWaiting(latest.current.live); }
            persistCheckpoint(true, true);
          }}
          onError={() => { if (which === active.current) { setWaiting(false); latest.current.onError("playback_failed"); } }}
        />)}
        {!hasFrame && poster && <ChannelImage className="archive-poster" src={poster} alt="" loading="eager" fetchPriority="high"/>}
        <canvas ref={heldFrame} className={`archive-held-frame${holdingFrame ? " is-visible" : ""}`} aria-hidden="true"/>
        {(!started || autoplayBlocked) && <div className="archive-start"><button className="player-start-button" aria-label={t("playerPlay")} onClick={()=>{if(!started)onStart?.();else{setAutoplayBlocked(false);autoplayBlockedRef.current=false;wanted.current=true;resume(videos.current[active.current]);}}}><PlayerIcon name="play" size={40} /></button></div>}
        {started && waiting && <div className="archive-buffer" role="status" aria-label={t("loading")}><LoaderCircle className="spin" size={30} /></div>}
        {feedback && <div className={`player-feedback ${feedback.seek ? `seek-feedback ${feedback.seek < 0 ? "backward" : "forward"}` : ""}`} key={`${feedback.icon}-${feedback.seek}-${feedback.label}`} aria-hidden="true">
          {feedback.seek ? <><svg width="24" height="18" viewBox="0 0 24 18"><path d="M2,2 L10,9 L2,16 M13,2 L21,9 L13,16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg><span>{feedback.seek > 0 ? "+" : ""}{feedback.seek} s</span></> : <>{feedback.icon && <div className="feedback-circle"><PlayerIcon name={feedback.icon} size={40} /></div>}{feedback.label && <span>{feedback.label}</span>}</>}
        </div>}
      </div>
      <div className="archive-controls" inert={!started || !sourceReady || waitingForCheckpoint} onPointerEnter={revealControls} onPointerLeave={revealControls} onFocus={revealControls} onBlur={revealControls}>
        <div className="archive-timeline-row"><PlayerPanel key={`time-${id}`} label={t("exactTime")} className="archive-clock player-time-button" trigger={timeLabel(position)} root={root} onOpenChange={panelChanged}>
          {close=><ExactTimeForm position={position} total={total} t={t} onClose={close} onCommit={value=>{requestSeek(value);navigation.current.flush();revealControls();}}/>}
        </PlayerPanel>
          <SeekTimeline excerptRange={excerptRange} onExcerptRange={onExcerptRange} omissions={omissions} cutRange={cutRange} cutLimits={cutLimits} onCutRange={onCutRange} cutText={cutText} key={`seek-${id}`} total={total} position={position} parts={actualParts} broadcastStarted={broadcastStarted} viewerHistory={viewerHistory} viewerGaps={viewerGaps} titleHistory={titleHistory} vodTitle={vodTitle} viewerCurves={viewerCurves} chapters={chapters} endpoint={chapterEndpoint} highlightedRange={highlightedRange} root={root} t={t} onPreview={setPreview}
            onScrub={value=>{scrubbing.current=value;navigation.current.cancel();if(!value)updateTime(active.current);}}
            onCommit={value=>{requestSeek(value);navigation.current.flush();revealControls();}}/>
          <span className="archive-clock archive-duration">{timeLabel(total)}</span></div>
        <div className="archive-control-row">
          <PlayerButton name="back" seconds={seekSeconds} label={t("skipBack").replace("{seconds}", seekSeconds)} disabled={!sourceReady || position <= 0} onClick={() => skip(-seekSeconds)} />
          <PlayerButton name={playing ? "pause" : "play"} label={t(playing ? "pause" : "playerPlay")} onClick={toggle} />
          <PlayerButton name="forward" seconds={seekSeconds} label={t("skipForward").replace("{seconds}", seekSeconds)} disabled={!sourceReady || !(total > 0) || position >= total - .001} onClick={() => skip(seekSeconds)} />
          <PlayerButton name={volume ? "volume" : "muted"} label={t(volume ? "mute" : "unmute")} onClick={mute} />
          <div className="player-volume-control"><input className="archive-volume" type="range" min="0" max="1" step="0.01" value={volume} aria-label={t("volume")} onChange={event => setVolume(Number(event.target.value))} style={{ "--range-progress": `${volume * 100}%` }} />
          <label className="player-volume-entry"><input type="number" min="0" max="100" value={Math.round(volume * 100)} aria-label={t("volumePercent")} onChange={event => setVolume(Math.max(0, Math.min(100, Number(event.target.value))) / 100)} /><span>%</span></label></div>
          <div className="archive-control-spacer" />
          <div className="player-secondary-controls">
            <PlayerPanel label={t("playbackSpeed")} className="player-rate-button" trigger={<><span>{speed}×</span><ChevronDown size={14} /></>} root={root} onOpenChange={panelChanged}><RateControl value={speed} onChange={setSpeed} t={t} /></PlayerPanel>
            <PlayerButton name="cinema" label={t("cinema")} aria-pressed={cinema} onClick={() => setCinema(value => !value)} />
            {document.pictureInPictureEnabled && <PlayerButton name="popout" label={t("pictureInPicture")} onClick={togglePictureInPicture} />}
          </div>
          <div className="player-compact-controls"><PlayerPanel label={t("playbackOptions")} trigger={<PlayerIcon name="more" />} root={root} onOpenChange={panelChanged}>
            <RateControl value={speed} onChange={setSpeed} t={t} />
            <label className="player-compact-volume">{t("volume")}<input type="range" min="0" max="1" step="0.01" value={volume} onChange={event => setVolume(Number(event.target.value))} style={{ "--range-progress": `${volume * 100}%` }} /></label>
            <button className="player-menu-action" aria-pressed={cinema} onClick={() => setCinema(value => !value)}><PlayerIcon name="cinema" size={20} />{t("cinema")}</button>
            {document.pictureInPictureEnabled && <button className="player-menu-action" onClick={togglePictureInPicture}><PlayerIcon name="popout" size={20} />{t("pictureInPicture")}</button>}
          </PlayerPanel></div>
          <PlayerButton name={fullscreen ? "exitFullscreen" : "fullscreen"} label={t(fullscreen ? "exitFullscreen" : "fullscreen")} onClick={toggleFullscreen} />
        </div>
      </div>
    </div>
  );
}
