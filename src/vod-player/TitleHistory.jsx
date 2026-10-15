import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { LocateFixed, Play, Gamepad2, Scissors } from "lucide-react";
import { ChannelImage } from "./ChannelImage.jsx";
import { chapterAt, chapterColor } from "./chapters.js";
import { timeLabel } from "./timeline.js";
import { createStreamClock, streamTimestamp } from "./stream-clock.js";
import { projectTitles, titleAt, historySections, historyCounts, historyDuration, currentHistorySection } from "./title-history.js";
import "./title-history.css";

const historyCategoryColors = ['#66dae7','#e9c66d','#e99ab4','#aedb84','#cbb6ef','#e9a272','#8bcce5','#e8de87','#8bd5ae','#e99191'];

export function TitleHistory({id,loading=false,chapters=[],history=[],parts=[],started,seconds,onSeek,onTitleSeek,onHover,onFocus,onSelectRange,t}) {
  const [filter,setFilter] = useState('all');
  const [animated,setAnimated] = useState(false);
  const list = useRef(null);
  const filters = useRef(null);
  const locale = t('locale') === 'en' ? 'en-GB' : 'de-DE';
  const clock = useMemo(()=>createStreamClock(t('locale')),[t('locale')]);
  const dateFormat = useMemo(()=>new Intl.DateTimeFormat(locale,{day:'2-digit',month:'2-digit',year:'numeric'}),[locale]);
  const timeFormat = useMemo(()=>new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}),[locale]);
  const number = useMemo(()=>new Intl.NumberFormat(locale),[locale]);
  const titles = useMemo(()=>projectTitles(history,parts,started),[history,parts,started]);
  const sections = useMemo(()=>historySections(chapters,titles,parts,started),[chapters,titles,parts,started]);
  const counts = useMemo(()=>historyCounts(chapters,titles),[chapters,titles]);
  const currentChapter = chapterAt(chapters,seconds), currentTitle = titleAt(history,streamTimestamp(parts,started,seconds));
  const activeSectionId = currentHistorySection(sections,filter,currentChapter,currentTitle);
  const hasCurrent = activeSectionId !== null;
  const visible = sections.some(section=>filter === 'all' || (filter === 'games' ? section.chapter : section.titles.length));
  useLayoutEffect(()=>{setFilter('all');setAnimated(false);if(list.current)list.current.scrollTop=0;},[id]);
  function changeFilter(value) {
    if (value === filter) return;
    if (list.current?.contains(document.activeElement)) filters.current?.querySelector('[data-filter="'+value+'"]')?.focus({preventScroll:true});
    setAnimated(true);
    setFilter(value);
    onHover(null);
    onFocus(null);
  }
  function focusCurrent() {
    const card = list.current?.querySelector('.history-card[aria-current="true"]');
    const target = (filter !== 'titles' && card?.querySelector('[data-current-chapter="true"]'))
      || card?.querySelector('[data-current-title="true"]') || card;
    if (!target) return;
    target.scrollIntoView({block:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    const button = target.matches('button:not(:disabled)') ? target : target.querySelector('button:not(:disabled)');
    (button || target).focus({preventScroll:true});
  }
  function seekCard(event, section) {
    if (event.defaultPrevented || event.target.closest('button,a,input,select,textarea,summary,[role="button"],[contenteditable="true"]')) return;
    const entry = event.target.closest('[data-title-id]');
    if (entry) {
      const title = section.titles.find(value=>value.id===entry.dataset.titleId);
      if (Number.isFinite(title?.seconds)) onTitleSeek(title);
      return;
    }
    if (filter !== 'titles' && section.chapter) { onSeek(section.chapter.start); return; }
    const title = section.titles.find(value=>Number.isFinite(value.seconds));
    if (title) onTitleSeek(title);
  }
  function wallTime(timestamp) {
    if (!timestamp) return null;
    const date = new Date(timestamp.dateTime);
    return <time className="history-wall-clock" dateTime={timestamp.dateTime} title={timestamp.label}><span>{dateFormat.format(date)}</span><span>{timeFormat.format(date)}</span></time>;
  }
  function titleEntry(title) {
    const playable = Number.isFinite(title.seconds), timestamp = clock(title.at,0);
    const hint = title.initialSnapshot ? [t('historyInitialSnapshot'),title.observedAt ? clock(title.observedAt,0)?.label : null].filter(Boolean).join(' · ')
      : t(title.precision==='eventsub'?'historyEventTime':title.precision==='observed'?'historyPollTime':title.precision==='minute'?'chapterApproximate':'historySourceTime');
    return <div className={'history-title-entry'+(title.id===currentTitle?.id?' is-current-title':'')} key={title.id} data-title-id={title.id} data-current-title={title.id===currentTitle?.id || undefined} tabIndex={-1}>
      <div className="history-title-heading"><span className="history-kind">{t(title.status==='carried'?'historyTitleAtStart':title.kind==='changed'?'historyTitleChanged':title.kind==='initial'?'historyInitialTitle':'historyFirstObserved')}</span>
        {playable&&<button type="button" className="history-title-position" onClick={()=>onTitleSeek(title)} aria-label={t('play')+': '+timeLabel(title.seconds)} title={[hint,timestamp?.label].filter(Boolean).join(' · ')}><Play size={13}/><time dateTime={timestamp?.dateTime}>{timeLabel(title.seconds)}</time></button>}
      </div>
      <button type="button" className="history-title-seek" disabled={!playable} onClick={()=>onTitleSeek(title)} aria-label={t('play')+': '+(title.title||t('historyEmptyTitle'))+(playable?' · '+timeLabel(title.seconds):'')}>
        <strong>{title.title||t('historyEmptyTitle')}</strong>
      </button>
      {!playable&&<div className="history-title-unavailable"><span>{t(title.status==='gap'?'historyGap':'historyPending')}</span>{timestamp&&<time dateTime={timestamp.dateTime} title={hint}>{timestamp.label}</time>}</div>}
    </div>;
  }
  return <div className={'title-history'+(animated?' history-animated':'')}>
    <div className="history-toolbar">
      <div ref={filters} className="history-filters" role="group" aria-label={t('historyFilter')} style={{'--history-filter-index':['all','games','titles'].indexOf(filter)}}>
        <span className="history-filter-indicator" aria-hidden="true"/>
        {['all','games','titles'].map(value=><button type="button" key={value} data-filter={value} aria-pressed={filter===value} onClick={()=>changeFilter(value)}>{t('history_'+value)}</button>)}
      </div>
      <button type="button" className="history-current" disabled={!hasCurrent} onClick={focusCurrent} aria-label={t('historyCurrent')} title={t('historyCurrent')}><LocateFixed size={18}/></button>
    </div>
    <div className="history-summary"><span><strong>{number.format(counts.categories)}</strong> {t(counts.categories===1?'historyCategorySingular':'historyCategories')}</span><span>{loading?t('historyLoading'):<><strong>{number.format(counts.titleChanges)}</strong> {t(counts.titleChanges===1?'historyChangeSingular':'historyChanges')}</>}</span></div>
    <div ref={list} className="chapter-list history-list" onKeyDown={event=>{if(event.key==='Escape'){onHover(null);onFocus(null);}}}>
      <div className="history-sections">
        {sections.map(section=>{
          const chapter = section.chapter;
          const showCategory = Boolean(chapter) && filter !== 'titles';
          const showTitles = section.titles.length > 0 && filter !== 'games';
          const shown = showCategory || showTitles;
          const active = section.id===activeSectionId;
          const marker = filter === 'titles' ? section.titles[0]?.seconds : section.seconds;
          const markerTitle = section.titles.find(title=>Number.isFinite(title.seconds));
          const timestamp = chapter ? clock(streamTimestamp(parts,started,chapter.start),0) : null;
          return <section key={section.id} className={'history-section'+(!shown?' is-collapsed':'')+(filter==='titles'?' titles-only':'')} aria-hidden={!shown} inert={!shown} data-section-id={section.id}>
            <div className="history-section-inner"><div className="history-section-content">
              <div className="history-time-marker"><i aria-hidden="true"/>{Number.isFinite(marker)?<button type="button" onClick={()=>(!chapter||filter==='titles')&&markerTitle?onTitleSeek(markerTitle):onSeek(marker)} aria-label={t('play')+': '+timeLabel(marker)}>{timeLabel(marker)}</button>:<span>{t(section.titles[0]?.status==='gap'?'historyGap':'historyPending')}</span>}</div>
              <article className={'history-card'+(active?' is-current':'')} aria-current={active?'true':undefined} onClick={event=>seekCard(event,section)}>
                <div className={'history-fold history-category-fold'+(!showCategory?' is-collapsed':'')} aria-hidden={!showCategory} inert={!showCategory}>
                  <div className="history-fold-inner">
                    {chapter&&<>
                      <div className="history-category-head" data-current-chapter={chapter.id===currentChapter?.id || undefined} onPointerEnter={event=>{if(event.pointerType!=='touch')onHover(chapter.id);}} onPointerLeave={()=>onHover(null)} onPointerCancel={()=>onHover(null)} onFocusCapture={()=>onFocus(chapter.id)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))onFocus(null);}}>
                        <div className="history-category-identity"><button type="button" className="chapter-seek" onClick={()=>onSeek(chapter.start)} aria-label={t('play')+': '+(chapter.name||t('categoryUnavailable'))+' · '+timeLabel(chapter.start)}>
                          <span className="chapter-cover">{chapter.image?<ChannelImage src={chapter.image} alt="" loading="lazy"/>:<Gamepad2 size={24}/>}<Play className="chapter-cover-play" size={18}/></span>
                          <span className="chapter-description"><span className="history-kind">{t('historyGame')}</span><strong><i style={{background:chapterColor(chapter,chapters,historyCategoryColors)}}/>{chapter.name||t('categoryUnavailable')}</strong><span className={'history-active-label'+(chapter.id!==currentChapter?.id?' is-inactive':'')}>{t('historyActive')}</span></span>
                        </button></div>
                        <div className="history-category-meta"><strong>{historyDuration(chapter.end-chapter.start,t('locale'))}</strong>{wallTime(timestamp)}</div>
                      </div>
                      <div className="history-category-range">{timeLabel(chapter.start)} <span>–</span> {timeLabel(chapter.end)}{chapter.precision==='minute'&&<span className="history-precision" title={t('chapterApproximate')}>≈</span>}</div>
                      <button type="button" className="history-select-range" onClick={()=>onSelectRange(chapter)}><Scissors size={15}/>{t('selectChapterRange')}</button>
                    </>}
                  </div>
                </div>
                <div className={'history-fold history-title-fold'+(!showTitles?' is-collapsed':'')} aria-hidden={!showTitles} inert={!showTitles}>
                  <div className="history-fold-inner"><div className={'history-title-track'+(chapter?' has-category':'')}>{section.titles.map(titleEntry)}</div></div>
                </div>
              </article>
            </div></div>
          </section>;
        })}
      </div>
      {!visible&&<p className="history-empty">{t(loading?'historyLoading':'historyEmpty')}</p>}
    </div>
  </div>;
}
