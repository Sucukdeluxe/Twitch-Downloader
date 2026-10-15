import { streamTimestamp } from "./stream-clock.js";

export function titleAt(history = [], timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  timestamp = Math.round(timestamp);
  let found = null;
  for (const event of history) if (event.at <= timestamp && event.until > timestamp &&
    (!found || event.priority > found.priority || event.priority === found.priority && event.at > found.at)) found = event;
  return found;
}

export function titlePosition(event, parts = [], started) {
  let cursor = 0, wall = started, first = true;
  for (const part of parts) {
    wall = part.started ?? wall;
    const duration = Number.isFinite(part.duration) ? Math.max(0,part.duration) : 0;
    if (Number.isFinite(wall) && duration > 0) {
      if (event.at >= wall && event.at < wall + duration*1000) return {seconds:cursor+(event.at-wall)/1000,status:'ready'};
      if (first && event.at < wall && event.until > wall) return {seconds:0,status:'carried'};
      if (event.at < wall) return {seconds:null,status:'gap'};
      first = false;
    }
    cursor += duration;
    if (Number.isFinite(wall)) wall += duration*1000;
  }
  return {seconds:null,status:'pending'};
}

export function projectTitles(history = [], parts = [], started) {
  return history.map(event=>({...event,...titlePosition(event,parts,started)}));
}

export function titleMarkers(events, total, width = 1000) {
  const markers = [];
  if (!(total > 0)) return markers;
  for (const event of events) {
    if (event.kind !== 'changed' || event.status !== 'ready' || event.seconds >= total) continue;
    const fraction = event.seconds / total;
    const last = markers.at(-1);
    if (last && (fraction-last.fraction)*width < 7) last.count++;
    else markers.push({id:event.id,fraction,count:1});
  }
  return markers;
}

export function timelineEntries(chapters, titles, parts, started) {
  const rows = chapters.filter(chapter=>chapter.end>chapter.start).map(chapter=>({id:chapter.id,chapter,titles:[],seconds:chapter.start,at:streamTimestamp(parts,started,chapter.start)}));
  const firstTitle = titles[0];
  const openingTitle = firstTitle?.seconds !== null && (firstTitle?.kind === 'initial' || firstTitle?.kind === 'observed' || firstTitle?.status === 'carried') ? firstTitle : null;
  for (const title of titles) {
    if (title === openingTitle) continue;
    const same = title.status === 'ready' && rows.find(row=>row.chapter && Math.abs(row.seconds-title.seconds)<.002);
    if (same) same.titles.push(title);
    else rows.push({id:title.id,titles:[title],seconds:title.seconds,at:title.at});
  }
  rows.sort((a,b)=>(a.at ?? Infinity)-(b.at ?? Infinity) || a.id.localeCompare(b.id));
  if (openingTitle) rows.unshift({id:openingTitle.id,titles:[openingTitle],seconds:openingTitle.seconds,at:openingTitle.at});
  return rows;
}

export function historySections(chapters = [], titles = [], parts = [], started) {
  const sections = chapters.filter(chapter => Number.isFinite(chapter.start) && Number.isFinite(chapter.end) && chapter.end > chapter.start)
    .map(chapter => ({ id:'chapter:'+chapter.id, chapter, titles:[], seconds:chapter.start, at:streamTimestamp(parts,started,chapter.start) }));
  for (const title of titles) {
    const section = Number.isFinite(title.seconds) ? sections.find(row => row.chapter && title.seconds >= row.chapter.start && title.seconds < row.chapter.end) : null;
    if (section) section.titles.push(title);
    else sections.push({ id:'title:'+title.id, chapter:null, titles:[title], seconds:title.seconds, at:title.at });
  }
  for (const section of sections) section.titles.sort((a,b) => a.at-b.at || a.id.localeCompare(b.id));
  return sections.sort((a,b) => (a.at ?? Infinity)-(b.at ?? Infinity) || (a.seconds ?? Infinity)-(b.seconds ?? Infinity) || Number(!a.chapter)-Number(!b.chapter) || a.id.localeCompare(b.id));
}

export function historyCounts(chapters = [], titles = []) {
  const categories = new Set(chapters.filter(chapter => chapter.end > chapter.start).map(chapter => chapter.game_id || chapter.name?.trim().toLowerCase()).filter(Boolean));
  return { categories:categories.size, titleChanges:titles.filter(title => title.kind === 'changed').length };
}

export function historyDuration(seconds, locale = 'de') {
  const value = Number.isFinite(seconds) ? Math.max(0,Math.floor(seconds)) : 0;
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'de-DE');
  return [[Math.floor(value/3600),'h'],[Math.floor(value/60)%60,'min'],[value%60,'s']]
    .filter(([count]) => count > 0).map(([count,unit]) => number.format(count)+' '+unit).join(' ') || '0 s';
}
