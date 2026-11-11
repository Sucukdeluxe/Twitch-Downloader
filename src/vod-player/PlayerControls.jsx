import React, { useEffect, useState } from "react";
import { useFloating, offset, flip, shift, size, autoUpdate, useClick, useDismiss, useRole, useInteractions, FloatingPortal, FloatingFocusManager, useTransitionStyles } from "@floating-ui/react";
import { ratePosition, positionRate, playerPortalRoot } from "./player-settings.js";

const paths = {
  play: "M7,4 L20,12 L7,20 Z",
  pause: "M6,4 L10,4 L10,20 L6,20 Z M14,4 L18,4 L18,20 L14,20 Z",
  stop: "M5,5 L19,5 L19,19 L5,19 Z",
  back: "M7,2 L3,6 L7,10 M3,6 L12,6 C17,6 21,9.6 21,14 C21,18.8 17,22 12,22 C7,22 3,18.8 3,14",
  forward: "M17,2 L21,6 L17,10 M21,6 L12,6 C7,6 3,9.6 3,14 C3,18.8 7,22 12,22 C17,22 21,18.8 21,14",
  fullscreen: "M3,9 L3,3 L9,3 M15,3 L21,3 L21,9 M21,15 L21,21 L15,21 M9,21 L3,21 L3,15",
  exitFullscreen: "M9,3 L9,9 L3,9 M21,9 L15,9 L15,3 M15,21 L15,15 L21,15 M3,15 L9,15 L9,21",
  popout: "M14,3 L3,3 L3,21 L21,21 L21,14 M14,10 L21,3 M15,3 L21,3 L21,9",
  cinema: "M2,5 L22,5 L22,19 L2,19 Z M2,9 L22,9 M2,15 L22,15",
  more: "M5,11 L5,13 M12,11 L12,13 M19,11 L19,13",
  volume: "M3,9 L7,9 L12,5 L12,19 L7,15 L3,15 Z M16,8 C18,10 18,14 16,16 M19,5 C23,9 23,15 19,19",
  muted: "M3,9 L7,9 L12,5 L12,19 L7,15 L3,15 Z M16,9 L22,15 M22,9 L16,15",
};

export function PlayerIcon({ name, size = 26, seconds = 10 }) {
  const solid = ["play", "pause", "stop"].includes(name);
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={solid ? "currentColor" : "none"} stroke={solid ? "none" : "currentColor"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
    {(name === "back" || name === "forward") && <text x="12" y="14.5" textAnchor="middle" dominantBaseline="middle" fill="currentColor" stroke="none" fontFamily="Segoe UI, sans-serif" fontSize="10" fontWeight="600">{seconds}</text>}
  </svg>;
}

export function PlayerButton({ name, label, seconds, className = "", ...props }) {
  return <button type="button" className={`player-button ${className}`} aria-label={label} title={label} {...props}><PlayerIcon name={name} seconds={seconds} /></button>;
}

export function PlayerPanel({ label, trigger, root, children, className = "", onOpenChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const dialog = root.current?.closest('dialog[open]');
    if (!open || !dialog) return;
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      onOpenChange?.(false);
    };
    dialog.addEventListener('keydown', escape, true);
    return () => dialog.removeEventListener('keydown', escape, true);
  }, [open, root, onOpenChange]);
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange(value) { setOpen(value); onOpenChange?.(value); },
    placement: "top-end", strategy: "fixed", whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12, crossAxis: true }), size({ padding: 12, apply({ availableHeight, availableWidth, elements }) {
      Object.assign(elements.floating.style, { maxHeight: `${Math.max(0, availableHeight)}px`, maxWidth: `${Math.max(0, availableWidth)}px` });
    } })],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([useClick(context), useDismiss(context), useRole(context, { role: "dialog" })]);
  const { isMounted, styles } = useTransitionStyles(context, { duration: { open: 160, close: 120 }, initial: { opacity: 0, transform: "translateY(4px) scale(.98)" } });
  return <>
    <button type="button" ref={refs.setReference} className={`player-button ${className}`} disabled={disabled} aria-label={label} title={label} {...getReferenceProps()}>{trigger}</button>
    {isMounted && <FloatingPortal root={playerPortalRoot(root.current, document.fullscreenElement, document.body)}><FloatingFocusManager context={context} modal={false} returnFocus>
      <div ref={refs.setFloating} className="player-panel-position" style={floatingStyles} aria-label={label} {...getFloatingProps()}>
        <div className="player-panel" style={styles}>{typeof children === 'function' ? children(() => { setOpen(false); onOpenChange?.(false); }) : children}</div>
      </div>
    </FloatingFocusManager></FloatingPortal>}
  </>;
}

export function RateControl({ value, onChange, t }) {
  const position = ratePosition(value);
  return <div className="player-rate-control">
    <strong>{t("playbackSpeed")}</strong>
    <div className="player-rate-value"><span>{value}×</span><button type="button" onClick={() => onChange("1")}>{t("resetRate")}</button></div>
    <input type="range" aria-label={t("playbackSpeed")} aria-valuetext={`${value}×`} min="0" max="24" step="1" value={position} onChange={event => {
      const next = Number(event.target.value);
      onChange(String(positionRate(next)));
    }} onKeyDown={event => {
      const next = event.key === "Home" ? .25 : event.key === "End" ? 4 : ["ArrowLeft", "ArrowDown"].includes(event.key) ? Math.max(.25, Number(value) - .25) : ["ArrowRight", "ArrowUp"].includes(event.key) ? Math.min(4, Number(value) + .25) : null;
      if (next !== null) { event.preventDefault(); onChange(String(next)); }
    }} style={{ "--range-progress": `${position / 24 * 100}%` }} />
    <div className="player-rate-marks"><span>0.25×</span><span>1×</span><span>4×</span></div>
  </div>;
}
