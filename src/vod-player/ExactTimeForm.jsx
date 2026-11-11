import React, { useId, useState } from 'react';
import { exactTimeLabel, parseExactTime } from './exact-time.js';

export function ExactTimeForm({ position, total, onCommit, onClose, t, format = exactTimeLabel, parse = parseExactTime, placeholder = "1:23:45,250", hint }) {
  const [value, setValue] = useState(() => format(position));
  const hintId = useId(), error = useId();
  const parsed = parse(value, total), invalid = parsed === null;
  return <form className="player-exact-time" onSubmit={event => {
    event.preventDefault();
    if (invalid) return;
    onCommit(parsed); onClose();
  }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <label><strong>{t('exactTime')}</strong><input type="text" value={value} placeholder={placeholder} aria-invalid={invalid} aria-describedby={`${hintId}${invalid ? ` ${error}` : ''}`}
      onChange={event => setValue(event.target.value)} spellCheck={false} autoComplete="off" /></label>
    <p id={hintId}>{hint || t('exactTimeHint')} · {format(0)} – {format(total)}</p>
    {invalid && <p id={error} role="status">{t('exactTimeInvalid')}</p>}
    <div><button type="button" onClick={onClose}>{t('close')}</button><button type="submit" disabled={invalid}>{t('jumpToTime')}</button></div>
  </form>;
}
