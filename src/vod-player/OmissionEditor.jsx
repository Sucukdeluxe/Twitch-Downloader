import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Scissors, ListVideo, Plus, Pencil, X, Check, Trash2, Play, Square, Files, Undo2, Redo2 } from 'lucide-react';
import { cutTime } from './CutTimeline.jsx';
import { parseExactTime } from './exact-time.js';
import { PlayerPanel } from './PlayerControls.jsx';
import { omissionFits } from './omission-ranges.js';

const messages = {
  de: { overlap:'Überschneidung mit einer Auslassung.', noGap:'Kein freier Bereich im Ausschnitt.', length:'Dauer', clip:'Ausschnitt', downloadExcerpt:'Ausschnitt', omit:'Bereiche auslassen', modes:'Bearbeitung', add:'Neuer Bereich', apply:'Bestätigen', cancel:'Abbrechen', edit:'Bereich bearbeiten', remove:'Bereich löschen', excluded:'Ausgelassene Bereiche', empty:'Keine Bereiche ausgelassen.', output:'Dateivorschau', remaining:'Videolänge', removed:'Ausgelassen', file:'Datei', files:'Dateien', source:'VOD-Zeiten', noOutput:'Kein Inhalt übrig.', invalid:'Ungültige Ausgabeeinstellungen.', range:'Bereich', start:'Startzeit', end:'Endzeit', preview:'Vorschau', stop:'Vorschau beenden', undo:'Rückgängig', redo:'Wiederholen', invalidTime:'HH:MM:SS oder Sekunden; Start vor Ende.', skipped:'Ausgelassene Part-Nummern', close:'Schließen' },
  en: { overlap:'Overlaps an excluded range.', noGap:'No free range in this excerpt.', length:'Duration', clip:'Excerpt', downloadExcerpt:'Download excerpt', omit:'Exclude ranges', modes:'Editing tools', add:'New range', apply:'Confirm', cancel:'Cancel', edit:'Edit range', remove:'Delete range', excluded:'Excluded ranges', empty:'No ranges excluded.', output:'File preview', remaining:'Video length', removed:'Excluded', file:'file', files:'files', source:'VOD times', noOutput:'No content remaining.', invalid:'Invalid output settings.', range:'Range', start:'Start time', end:'End time', preview:'Preview', stop:'Stop preview', undo:'Undo', redo:'Redo', invalidTime:'Use HH:MM:SS or seconds; start before end.', skipped:'Skipped part numbers', close:'Close' },
};

export function OmissionModes({ active, onChange, language, count = 0 }) {
  const t = messages[language];
  return <div className="vod-omission-modes" role="group" aria-label={t.modes}>
    <button type="button" aria-pressed={!active} onClick={() => onChange(false)}><Scissors size={15}/>{t.clip}</button>
    <button type="button" aria-pressed={active} onClick={() => onChange(true)}><ListVideo size={15}/>{t.omit}{count > 0 && <span className="vod-mode-count">{count.toLocaleString(language)}</span>}</button>
  </div>;
}

function DraftRange({ range, selection, gaps, duration, number, language, onRange, onApply, onCancel }) {
  const t = messages[language];
  const row = useRef(null);
  const [inputs, setInputs] = useState({ start:cutTime(range.start), end:cutTime(range.end) });
  useEffect(() => { row.current?.scrollIntoView({ block:'nearest' }); row.current?.querySelector('input')?.focus({ preventScroll:true }); }, []);
  useLayoutEffect(() => {
    setInputs(current => ({ start:parseExactTime(current.start, duration) === range.start ? current.start : cutTime(range.start), end:parseExactTime(current.end, duration) === range.end ? current.end : cutTime(range.end) }));
  }, [range.start, range.end, duration]);
  const start = parseExactTime(inputs.start, duration), end = parseExactTime(inputs.end, duration);
  const validTime = start !== null && end !== null && end > start && start >= selection.start && end <= selection.end;
  const valid = validTime && omissionFits({ start, end }, gaps);
  const error = !gaps.length ? t.noGap : validTime ? t.overlap : t.invalidTime;
  const invalidTime = error + " (" + cutTime(selection.start) + " – " + cutTime(selection.end) + ")";
  function change(which, value) {
    const next = { ...inputs, [which]:value };
    setInputs(next);
    const a = parseExactTime(next.start, duration), b = parseExactTime(next.end, duration);
    if (a !== null && b !== null && omissionFits({ start:a, end:b }, gaps)) onRange(a, b, { source:'input' });
  }
  return <li ref={row} className="vod-omission-row is-editing" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); if (valid) onApply({ start, end }); }
  }}>
    <strong>{t.range} {number.toLocaleString(language)}</strong>
    <div className="vod-omission-times">{['start','end'].map(which => <label key={which}><span aria-hidden="true">{which === 'start' ? 'I' : 'O'}</span><input type="text" aria-label={t[which]} aria-invalid={!valid} title={!valid ? invalidTime : t[which]} spellCheck="false" autoComplete="off" value={inputs[which]} onChange={event => change(which, event.target.value)} onBlur={() => { if (valid) setInputs(current => ({ ...current, [which]:cutTime(which === 'start' ? start : end) })); }}/></label>)}</div>
    <div className="vod-omission-length"><span>{t.length}</span><time>{valid ? cutTime(end - start) : '—'}</time></div>
    <div className="vod-omission-row-actions"><button type="button" className="vod-omission-confirm" disabled={!valid} aria-label={t.apply} title={t.apply} onClick={() => onApply({ start, end })}><Check size={17}/><span>{t.apply}</span></button><button type="button" data-action="cancel-range" aria-label={t.cancel} title={t.cancel} onClick={onCancel}><X size={17}/></button></div>
    {!valid && <p className="vod-omission-validation" role="status">{invalidTime}</p>}
  </li>;
}

export function OmissionEditor({ active, gaps, selection, onSelection, ranges, plan, range, duration, language, editing, onNew, onEdit, onRange, onApply, onCancel, onRemove, onUndo, onRedo, canUndo, canRedo, previewing, onPreview, canPreview, filename, root }) {
  const t = messages[language], number = value => value.toLocaleString(language);
  const rows = ranges.map((value, index) => ({ index, item:index === editing ? range : { start:Math.max(selection.start, value.start), end:Math.min(selection.end, value.end) } })).filter(({ item, index }) => editing === index || item.end > item.start);
  if (editing === -1) rows.push({ index:-1, item:range });
  rows.sort((a, b) => a.item.start - b.item.start || a.item.end - b.item.end || a.index - b.index);
  return <section className="vod-omission-editor" aria-label={t.excluded}>
    <div className="vod-omission-actions">
      {selection && <div className="vod-omission-scope" role="status"><Scissors size={14}/><span>{t.downloadExcerpt}: {cutTime(selection.start)} – {cutTime(selection.end)}</span><button type="button" onClick={onSelection}>{t.clip}</button></div>}
      <button type="button" className="vod-omission-new" onClick={onNew} disabled={editing !== null || ranges.length >= 256 || !gaps.length} title={!gaps.length ? t.noGap : t.add}><Plus size={16}/>{t.add}</button>
      <button type="button" className="vod-omission-preview" onClick={onPreview} disabled={!canPreview || editing !== null || !plan?.parts.length || !ranges.length} aria-pressed={previewing}>{previewing ? <Square size={14}/> : <Play size={14}/>}<span>{previewing ? t.stop : t.preview}</span></button>
      <div className="vod-omission-history"><button type="button" aria-label={t.undo} title={t.undo} onClick={onUndo} disabled={!canUndo || editing !== null}><Undo2 size={16}/></button><button type="button" aria-label={t.redo} title={t.redo} onClick={onRedo} disabled={!canRedo || editing !== null}><Redo2 size={16}/></button></div>
      <div className="vod-output-summary">{plan ? <><span>{t.removed} <b>{cutTime(plan.omittedDuration)}</b></span><span>{t.remaining} <b>{cutTime(plan.duration)}</b></span></> : <span role="status">{t.invalid}</span>}</div>
      {active && <PlayerPanel label={t.output} className="vod-output-trigger" root={root} trigger={<><Files size={16}/><span>{plan ? number(plan.parts.length)+' '+(plan.parts.length === 1 ? t.file : t.files) : t.output}</span></>}>
        {close => <section className="vod-output-preview"><header><strong>{t.output}</strong><button type="button" aria-label={t.close} onClick={close}><X size={17}/></button></header>
          {plan?.parts.length === 0 && <p role="status">{t.noOutput}</p>}
          {!plan && <p role="status">{t.invalid}</p>}
          {Boolean(plan?.skippedNumbers.length) && <p>{t.skipped}: {plan.skippedNumbers.map(number).join(', ')}</p>}
          <ol>{plan?.parts.map(part => <li key={part.number}><div><strong>Part {String(part.number).padStart(2, '0')}</strong><time>{cutTime(part.duration)}</time></div><span className="vod-output-filename">{filename(part)}</span><span className="vod-output-sources">{t.source}: {part.ranges.map(source => cutTime(source.start)+'–'+cutTime(source.end)).join(' · ')}</span></li>)}</ol>
        </section>}
      </PlayerPanel>}
    </div>
    <ol className="vod-omission-list" aria-label={t.excluded}>
      {rows.map(({ item, index }, order) => editing === index ? <DraftRange key={'draft-'+index} selection={selection} gaps={gaps} range={range} duration={duration} number={order + 1} language={language} onRange={onRange} onApply={onApply} onCancel={onCancel}/> : <li key={index} className="vod-omission-row">
        <strong>{t.range} {number(order + 1)}</strong><button type="button" className="vod-omission-time vod-omission-times" aria-label={t.edit + ': ' + cutTime(item.start) + ' – ' + cutTime(item.end)} onClick={() => onEdit(index)} disabled={editing !== null}>{['start','end'].map(which => <span className="vod-omission-time-value" key={which}><span aria-hidden="true">{which === 'start' ? 'I' : 'O'}</span><time>{cutTime(item[which])}</time></span>)}</button><div className="vod-omission-length"><span>{t.length}</span><time>{cutTime(item.end - item.start)}</time></div>
        <div className="vod-omission-row-actions"><button type="button" aria-label={t.edit} title={t.edit} onClick={() => onEdit(index)} disabled={editing !== null}><Pencil size={15}/></button><button type="button" aria-label={t.remove} title={t.remove} onClick={() => onRemove(index)} disabled={editing !== null}><Trash2 size={15}/></button></div>
      </li>)}
      {!ranges.some(value => value.end > selection.start && value.start < selection.end) && editing === null && <li className="vod-omission-empty">{t.empty}</li>}
    </ol>
  </section>;
}

export function OmissionBands({ ranges = [], from = 0, to, compact = false, onSelect, label }) {
  const span = Math.max(.001, to - from);
  return <span className={'vod-omission-bands' + (compact ? ' is-compact' : '')} aria-hidden={!onSelect || undefined}>{ranges.map((range, index) => range.end > from && range.start < to && (onSelect ? <button key={index} type="button" aria-label={label+' '+(index + 1)} title={cutTime(range.start)+' – '+cutTime(range.end)} onClick={event => { event.stopPropagation(); onSelect(index); }} style={{ left:Math.max(0, (range.start - from) / span * 100)+'%', width:(Math.min(to, range.end) - Math.max(from, range.start)) / span * 100+'%' }}/> : <i key={index} style={{ left:Math.max(0, (range.start - from) / span * 100)+'%', width:(Math.min(to, range.end) - Math.max(from, range.start)) / span * 100+'%' }}/>))}</span>;
}
