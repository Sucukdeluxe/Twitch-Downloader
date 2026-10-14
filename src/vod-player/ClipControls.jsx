import React, { useEffect, useRef } from 'react';
import { Tooltip } from './Tooltip.jsx';
import { PlayerPanel } from './PlayerControls.jsx';

export function ClipStatus({ kind, label }) {
  return <Tooltip content={label}><span className="clip-result-state-trigger" tabIndex={0} role="img" aria-label={label}>
    {kind === 'loading' ? <span className="clip-result-loader"/> : <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r={kind === 'done' ? 12 : 9} fill={kind === 'done' ? '#2E9E5B' : 'none'} stroke={kind === 'done' ? 'none' : 'currentColor'} strokeWidth="1.5"/>
      <path d={kind === 'done' ? 'M6.6 12.3 10.4 16 17.4 8.6' : kind === 'error' ? 'M12 7v6m0 4h.01' : 'M12 7v5l3 2'} fill="none" stroke={kind === 'done' ? 'white' : 'currentColor'} strokeWidth={kind === 'done' ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>}
  </span></Tooltip>;
}

export function ClipControls({ kind, label, available, removable, disabled, labels, open, folder, remove }) {
  const actions = useRef(null), previous = useRef(available);
  useEffect(() => {
    if (available && !previous.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      actions.current?.querySelectorAll('.clip-file-action').forEach((element, index) => element.animate([
        { opacity: 0, transform: 'translateY(-7px)' }, { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 200, delay: index * 45, easing: 'ease-out', fill: 'backwards' }));
    }
    previous.current = available;
  }, [available]);
  const buttons = [
    { name: labels.open, click: open, path: 'm8 5 11 7-11 7z', file: true },
    { name: labels.folder, click: folder, path: 'M3 7V4h6l2 3h10v13H3z', file: true },
    ...(removable ? [{ name: labels.remove, click: remove, path: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5', file: false }] : []),
  ];
  return <><div className="clip-result-actions" ref={actions}>
    {buttons.map(button => <Tooltip key={button.path} content={button.name}><button type="button" className={'clip-row-action ' + (button.file ? 'clip-file-action' : 'clip-remove-action')}
      aria-label={button.name} disabled={button.file ? !available : disabled} style={button.file && !available ? { visibility: 'hidden' } : undefined} onClick={button.click}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={button.path}/></svg>
    </button></Tooltip>)}
  </div><span className="clip-result-symbol"><ClipStatus kind={kind} label={label}/></span></>;
}

export function ClipFolderMenu({ host, disabled, labels, select, reset }) {
  const root = useRef(host);
  return <PlayerPanel root={root} label={labels.options} disabled={disabled} className="clip-options-trigger" trigger={<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>}>
    {close => <div className="clip-folder-menu" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      <button type="button" onClick={() => { close(); select(); }}>{labels.select}</button>
      <button type="button" onClick={() => { close(); reset(); }}>{labels.reset}</button>
    </div>}
  </PlayerPanel>;
}
