import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFloating, offset, flip, shift, size, autoUpdate, FloatingPortal, useTransitionStyles } from "@floating-ui/react";
import { CategoryColors } from "./CategoryColors.jsx";
import { ChapterPreview } from "./ChapterPreview.jsx";
import { chapterAt, chapterColor } from "./chapters.js";
import { timeLabel } from "./timeline.js";
import { playerPortalRoot } from "./player-settings.js";
import { fineTicks, clampTime } from "./fine-seek.js";
import { createStreamClock, streamTimestamp } from "./stream-clock.js";
import { viewerSampleAt, viewerGapAt } from "./viewer-history.js";
import { ViewerCount } from "./ViewerHistory.jsx";
import { projectTitles, titleAt } from "./title-history.js";
import "./fine-seek.css";

export function FineSeekPreview({ wholeSeconds = false, formatTime, preview, anchorRef, root, total, parts = [], broadcastStarted, chapters = [], endpoint, titleHistory = [], vodTitle, viewerHistory, viewerGaps, omissions = [], t, onAlign, onWidth, kind }) {
  const lastPreview = useRef(null), ruler = useRef(null);
  const [panelWidth, setPanelWidth] = useState(480);
  const streamClock = useMemo(() => createStreamClock(t("locale")), [t("locale")]);
  const { refs, floatingStyles, context } = useFloating({ open:Boolean(preview), placement:"top", strategy:"fixed", whileElementsMounted:autoUpdate,
    middleware:[offset(12), flip({padding:12}), shift({padding:12}), size({padding:12,apply({availableWidth,elements}) {
      const width = Math.min(480, Math.max(0, availableWidth));
      elements.floating.style.width = width + "px";
      setPanelWidth(width);
      onWidth?.(width);
    }})] });
  const { isMounted, styles } = useTransitionStyles(context, { duration:{open:140,close:140}, initial:{opacity:0,transform:"translateY(4px)"} });
  if (preview) lastPreview.current = preview;
  const shown = preview || lastPreview.current;
  const open = Boolean(preview), fine = Boolean(preview?.fine);
  const anchor = fine ? preview.anchorX : preview?.value;
  useLayoutEffect(() => {
    const element = anchorRef.current;
    if (!open || !element) return;
    refs.setPositionReference({contextElement:element,getBoundingClientRect() {
      const bounds = element.getBoundingClientRect();
      const x = fine ? anchor : bounds.left + 7 + clampTime(anchor,total) / Math.max(1,total) * Math.max(1,bounds.width-14);
      return {x,y:bounds.top,left:x,right:x,top:bounds.top,bottom:bounds.top,width:0,height:0};
    }});
  }, [open, fine, anchor, total, refs, anchorRef]);
  useLayoutEffect(() => {
    if (fine && ruler.current) onAlign?.(ruler.current.getBoundingClientRect());
  }, [fine, floatingStyles.transform, panelWidth, onAlign]);
  const boundaries = [...new Set(chapters.flatMap(chapter => [chapter.start, chapter.end]))];
  const titleEvents = useMemo(() => projectTitles(titleHistory,parts,broadcastStarted), [titleHistory,parts,broadcastStarted]);
  const shownChapter = shown && chapterAt(chapters,shown.value,endpoint);
  const timestamp = shown ? streamClock(streamTimestamp(parts,broadcastStarted,shown.value),0) : null;
  const shownTitle = shown && titleAt(titleHistory,streamTimestamp(parts,broadcastStarted,shown.value));
  const viewerSample = shown && viewerSampleAt(viewerHistory,streamTimestamp(parts,broadcastStarted,shown.value));
  const shownViewerGap = shown && viewerGapAt(viewerGaps,streamTimestamp(parts,broadcastStarted,shown.value));
  const time = shown ? (formatTime ? formatTime(shown.value) : wholeSeconds ? timeLabel(Math.round(shown.value)) : timeLabel(shown.value) + (shown.fine ? (t("locale") === "de" ? "," : ".") + Math.floor((shown.value+.00001)%1*10) : "")) : "";
  return <>    {isMounted && shown && <FloatingPortal root={playerPortalRoot(root?.current || anchorRef.current,document.fullscreenElement,document.body)}>
      <div ref={refs.setFloating} className="fine-seek-position" data-fine-seek-kind={kind} style={floatingStyles} aria-hidden="true">
        <div className={`fine-seek-preview${shown.fine?" is-fine":""}${shown.snapped?" is-snapped":""}`} style={styles}>
          <div className="fine-seek-heading"><ChapterPreview fraction={.5} chapter={shownChapter} time={time} timestamp={timestamp} viewer={shownViewerGap ? <span className="viewer-count">{t("viewerMeasurementMissing")}</span> : viewerSample ? <ViewerCount sample={viewerSample} t={t}/> : null} fallback={t("categoryUnavailable")} color={chapterColor(shownChapter,chapters)}/></div>
          {(titleHistory.length>0 || vodTitle)&&<div className="fine-seek-title"><span>{shownTitle ? shownTitle.title || t('historyEmptyTitle') : vodTitle ? `${t('vodTitle')}: ${vodTitle}` : t('historyTitleUnknown')}</span></div>}
          <div ref={ruler} className="fine-seek-ruler">
            <CategoryColors className="fine-seek-colors" height={5} chapters={chapters} from={shown.window.start} to={shown.window.end} endpoint={endpoint}/>
            {omissions.filter(item => item.end > shown.window.start && item.start < shown.window.end).map((item,index)=><i key={'omission-'+index} className='fine-seek-omission' style={{left:((Math.max(item.start,shown.window.start)-shown.window.start)/shown.window.span*100)+'%',width:((Math.min(item.end,shown.window.end)-Math.max(item.start,shown.window.start))/shown.window.span*100)+'%'}} title={t('omission') || 'Ausgelassener Bereich'}/>)}
            {boundaries.filter(b=>b>=shown.window.start&&b<=shown.window.end).map(b=><i key={b} className="fine-seek-boundary" style={{left:`${(b-shown.window.start)/shown.window.span*100}%`}}/>)}
            {titleEvents.filter(event=>event.kind==='changed'&&event.status==='ready'&&event.seconds>=shown.window.start&&event.seconds<=shown.window.end).map(event=><i key={event.id} className="fine-seek-title-marker" style={{left:`${(event.seconds-shown.window.start)/shown.window.span*100}%`}}/>)}
            {fineTicks(shown.window,panelWidth).filter(tick=>tick.time>=0&&tick.time<=total).map(tick=><span key={tick.time} className={`fine-seek-tick${tick.major?" is-major":""}`} style={{left:`${tick.fraction*100}%`}}>{tick.major&&tick.fraction>.07&&tick.fraction<.93&&<small>{timeLabel(tick.time)}</small>}</span>)}
            <span className="fine-seek-cursor" style={{left:`${(shown.value-shown.window.start)/Math.max(.001,shown.window.span)*100}%`}}/>
          </div>
          <div className="fine-seek-limits">{[Math.max(0,shown.window.start),Math.min(total,shown.window.end)].map((limit,index)=><span key={index} style={{left:`${(limit-shown.window.start)/Math.max(.001,shown.window.span)*100}%`,transform:index?"translateX(-100%)":undefined}}>{timeLabel(limit)}</span>)}</div>
        </div>
      </div>
    </FloatingPortal>}
  </>;
}
