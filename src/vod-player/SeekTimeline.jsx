import { OmissionBands } from './OmissionEditor.jsx';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CategoryColors } from "./CategoryColors.jsx";
import { RangeMarkers, cutTime } from "./CutTimeline.jsx";
import { FineSeekPreview } from "./FineSeekPreview.jsx";
import { ChapterRangePreview } from "./ChapterRangePreview.jsx";
import { chapterAt, chapterGradient } from "./chapters.js";
import { timeLabel, remapTimelineTime } from "./timeline.js";
import { beginFineSeek, alignFineSeek, moveFineSeek, finishFineSeek, pointerTime, fineWindow, clampTime } from "./fine-seek.js";
import "./fine-seek.css";
import { createStreamClock, streamTimestamp } from "./stream-clock.js";
import { viewerSampleAt, viewerGapAt } from "./viewer-history.js";
import { ViewerHistory } from "./ViewerHistory.jsx";
import { projectTitles, titleAt, titleMarkers } from "./title-history.js";
import "./title-history.css";

export function SeekTimeline({ total:availableTotal, position, parts, broadcastStarted, viewerHistory, viewerGaps, titleHistory:availableTitles = [], vodTitle, viewerCurves = [], chapters:availableChapters, endpoint:availableEndpoint, highlightedRange, root, onCommit, onScrub, onPreview, t, excerptRange, onExcerptRange, cutRange, cutLimits, onCutRange, cutText, omissions = [] }) {
  const locale = t("locale");
  const streamClock = useMemo(() => createStreamClock(locale), [locale]);
  const input = useRef(null), drag = useRef(null), callbacks = useRef(null);
  const total = drag.current?.total ?? availableTotal;
  const previewParts = drag.current?.parts ?? parts;
  const chapters = drag.current?.chapters ?? availableChapters;
  const titleHistory = drag.current?.titleHistory ?? availableTitles;
  const titleEvents = useMemo(()=>projectTitles(titleHistory,previewParts,broadcastStarted),[titleHistory,previewParts,broadcastStarted]);
  const [trackWidth,setTrackWidth] = useState(1000), [pixelRatio,setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  useLayoutEffect(()=>{
    const measure = ()=>{ setTrackWidth(input.current?.getBoundingClientRect().width || 1000); setPixelRatio(window.devicePixelRatio || 1); };
    measure();
    const observer = new ResizeObserver(measure);
    if(input.current)observer.observe(input.current);
    window.addEventListener("resize",measure);
    return ()=>{ observer.disconnect(); window.removeEventListener("resize",measure); };
  },[]);
  const endpoint = drag.current ? drag.current.endpoint : availableEndpoint;
  const [preview, setPreview] = useState(null), [panelWidth, setPanelWidth] = useState(480);
  callbacks.current = { onCommit, onScrub };
  const hintId = useId();
  const [rangePreviewOpen, setRangePreviewOpen] = useState(false), [omissionPreviewOpen, setOmissionPreviewOpen] = useState(false);
  const alignPreview = useCallback(bounds => {
    if (!drag.current?.fine) return;
    const aligned = alignFineSeek(drag.current,bounds);
    if (aligned !== drag.current) { drag.current = aligned; setPreview(aligned); }
  }, []);
  useEffect(() => { onPreview(Boolean(preview) || rangePreviewOpen || omissionPreviewOpen); }, [preview, rangePreviewOpen, omissionPreviewOpen, onPreview]);
  function cancel() {
    if (drag.current) { drag.current=null; callbacks.current.onScrub(false); }
    setPreview(null);
  }
  useEffect(() => {
    const blur = () => cancel();
    window.addEventListener("blur",blur);
    window.addEventListener("resize",blur);
    return () => { window.removeEventListener("blur",blur); window.removeEventListener("resize",blur); callbacks.current.onScrub(false); };
  }, []);
  const boundaries = [...new Set(chapters.flatMap(chapter=>[chapter.start,chapter.end]))];
  const gradient = chapterGradient(chapters,total);
  function hover(value) { setPreview({value,anchor:value,window:fineWindow(value,total),fine:false,snapped:false}); }
  function move(event) {
    if (drag.current) {
      if (drag.current.pointerId !== event.pointerId) return;
      drag.current=moveFineSeek(drag.current,event.clientX,event.clientY,boundaries,event.altKey);
      setPreview(drag.current);
    } else if(event.pointerType!=="touch") hover(pointerTime(event.clientX,event.currentTarget.getBoundingClientRect(),total));
  }
  function finish(event) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const selection=finishFineSeek(drag.current,event.clientX,event.clientY,boundaries,event.altKey);
    drag.current=null;
    callbacks.current.onScrub(false);
    setPreview(null);
    if (Math.abs(selection.value-selection.original)>.001) callbacks.current.onCommit(remapTimelineTime(selection.value,selection.parts,parts));
  }
  const value = drag.current ? drag.current.value : position;
  const currentTimestamp = streamClock(streamTimestamp(previewParts, broadcastStarted, value), 0);
  const currentTitle = titleAt(titleHistory,streamTimestamp(previewParts,broadcastStarted,value));
  const currentViewerSample = viewerSampleAt(viewerHistory, streamTimestamp(previewParts, broadcastStarted, value));
  const currentViewerGap = viewerGapAt(viewerGaps, streamTimestamp(previewParts, broadcastStarted, value));
  return <div className="archive-timeline-track" style={{"--category-track-height":`${Math.round(6 * pixelRatio) / pixelRatio}px`}}>
    <ViewerHistory curves={drag.current?.viewerCurves ?? viewerCurves}/>
    {gradient && <CategoryColors className="category-track" height={6} chapters={chapters} to={total} endpoint={endpoint} fallback="#777e8a"/>}
    {excerptRange && total > 0 && <span className="vod-excerpt-scope" role="img" aria-label={cutText.excerpt + ": " + cutTime(excerptRange.start) + " – " + cutTime(excerptRange.end)}>
      <i className="vod-excerpt-dim is-before" style={{ width:Math.max(0, Math.min(100, excerptRange.start / total * 100)) + "%" }}/>
      <i className="vod-excerpt-dim is-after" style={{ width:Math.max(0, Math.min(100, (total - excerptRange.end) / total * 100)) + "%" }}/>
    </span>}
    <OmissionBands ranges={omissions} to={total} compact/>
    <span className="timeline-title-markers" aria-hidden="true">{titleMarkers(titleEvents,total,trackWidth).map(marker=><i key={marker.id} className={marker.count>1?'is-grouped':undefined} style={{left:`${marker.fraction*100}%`}}/>)}</span>
    <ChapterRangePreview range={highlightedRange} suppressed={Boolean(preview)} chapters={chapters} fallback={t("categoryUnavailable")}/>
    {(excerptRange || cutRange) && <RangeMarkers compact minimumRange={1} step={1} trackWidth={trackWidth - 14} duration={total} range={excerptRange || cutRange} onChange={excerptRange ? onExcerptRange : onCutRange}
      text={{ ...cutText, start:`${cutText.excerpt}: ${cutText.start}`, end:`${cutText.excerpt}: ${cutText.end}` }} onInteraction={cancel} onPreviewChange={setRangePreviewOpen}
      finePreview={{root, parts:previewParts, broadcastStarted, chapters, endpoint, titleHistory, vodTitle, viewerHistory, viewerGaps, omissions, t}}/>}
    {excerptRange && cutRange && <RangeMarkers variant="omission" limits={cutLimits || excerptRange} compact minimumRange={1} step={1} trackWidth={trackWidth - 14} duration={total} range={cutRange} onChange={onCutRange}
      text={{ ...cutText, start:`${cutText.omission}: ${cutText.start}`, end:`${cutText.omission}: ${cutText.end}` }} onInteraction={cancel} onPreviewChange={setOmissionPreviewOpen}
      finePreview={{root, parts:previewParts, broadcastStarted, chapters, endpoint, titleHistory, vodTitle, viewerHistory, viewerGaps, omissions, t}}/>}
    <span id={hintId} className="fine-seek-instructions">{t("fineSeekInstructions")}</span>
    <input ref={input} className={`archive-timeline${gradient?" has-chapters":""}`} type="range" aria-label={t("playbackPosition")} aria-describedby={hintId}
      aria-valuetext={`${timeLabel(value)} / ${timeLabel(total)}${currentTimestamp ? ` · ${currentTimestamp.label}` : ""} - ${chapterAt(chapters,value,endpoint)?.name || t("categoryUnavailable")}${currentTitle ? ` · ${currentTitle.title || t('historyEmptyTitle')}` : ''}${currentViewerGap ? ` · ${t("viewerMeasurementMissing")}` : currentViewerSample ? ` · ${currentViewerSample.viewers.toLocaleString(locale)} ${t("viewerCount")}` : ""}`} min="0" max={total||1} step="0.1" value={Math.min(value,total)} disabled={total<=0}
      style={{"--range-progress":`${total?value/total*100:0}%`,"--chapter-gradient":gradient}}
      onPointerDown={event=>{
        if(event.button!==0 || !event.isPrimary || drag.current || total<=0)return;
        event.preventDefault();
        event.currentTarget.focus({preventScroll:true});
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current={...beginFineSeek({x:event.clientX,y:event.clientY,bounds:event.currentTarget.getBoundingClientRect(),total,position,width:panelWidth}),pointerId:event.pointerId,parts,viewerCurves,chapters,endpoint,titleHistory};
        onScrub(true);setPreview(drag.current);
      }} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={cancel} onLostPointerCapture={()=>{if(drag.current)cancel();}}
      onPointerLeave={()=>{if(!drag.current)setPreview(null);}} onBlur={cancel}
      onFocus={()=>{if(!drag.current)hover(position);}}
      onChange={event=>{if(!drag.current){onCommit(Number(event.target.value));hover(Number(event.target.value));}}}
      onKeyDown={event=>{
        if(event.key==="Escape"){event.preventDefault();event.stopPropagation();cancel();return;}
        if(drag.current)return;
        const amount={ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10}[event.key];
        if(amount!==undefined || event.key==="Home" || event.key==="End"){
          event.preventDefault();event.stopPropagation();
          const next=clampTime(event.key==="Home"?0:event.key==="End"?total:position+amount*(event.shiftKey?10:1),total);
          onCommit(next);hover(next);
        }
      }}/>
    <FineSeekPreview preview={preview} anchorRef={input} root={root} total={total} parts={previewParts} broadcastStarted={broadcastStarted}
      chapters={chapters} endpoint={endpoint} titleHistory={titleHistory} vodTitle={vodTitle} viewerHistory={viewerHistory} viewerGaps={viewerGaps} omissions={omissions}
      t={t} onAlign={alignPreview} onWidth={setPanelWidth}/>
  </div>;
}
