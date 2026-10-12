import React, { cloneElement, useEffect, useRef, useState } from 'react';
import { arrow, autoUpdate, flip, FloatingArrow, FloatingPortal, hide, offset, safePolygon, shift, size, useDismiss, useFloating, useFocus, useHover, useInteractions, useMergeRefs, useRole, useTransitionStyles } from '@floating-ui/react';
import './tooltip.css';

export function Tooltip({ children, content }) {
  const arrowRef = useRef(null);
  const [open, setOpen] = useState(false);
  const floating = useFloating({
    open, onOpenChange: setOpen, placement: 'top', strategy: 'fixed', whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8, crossAxis: true }), size({
      padding: 8,
      apply({ availableHeight, elements }) {
        const height = Math.max(0, Math.min(320, availableHeight)) + 'px';
        elements.floating.style.maxHeight = height;
        elements.floating.style.setProperty('--tooltip-max-height', height);
      },
    }), arrow({ element: arrowRef, padding: 12 }), hide()],
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(floating.context, { delay: { open: 180, close: 100 }, handleClose: safePolygon() }),
    useFocus(floating.context),
    useDismiss(floating.context, { referencePress: true, bubbles: false }),
    useRole(floating.context, { role: 'tooltip' }),
  ]);
  const { isMounted, styles } = useTransitionStyles(floating.context, {
    duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : { open: 180, close: 140 },
    initial: ({ side }) => ({ opacity: 0, transform: 'translateY(' + (side === 'top' ? '6' : '-6') + 'px) scale(0.94)' }),
    open: { opacity: 1, transform: 'translateY(0) scale(1)' },
  });
  const ref = useMergeRefs([floating.refs.setReference, children.props.ref]);
  useEffect(() => {
    const element = floating.elements.floating;
    const dismiss = () => setOpen(false);
    element?.addEventListener('vod-tooltip-dismiss', dismiss);
    return () => element?.removeEventListener('vod-tooltip-dismiss', dismiss);
  }, [floating.elements.floating]);
  const reference = floating.elements.domReference;
  const portalRoot = reference?.closest('dialog[open]') || (document.fullscreenElement?.contains(reference) ? document.fullscreenElement : document.body);
  return <>
    {cloneElement(children, getReferenceProps({ ...children.props, ref }))}
    {isMounted && <FloatingPortal root={portalRoot}>
      <div ref={floating.refs.setFloating} className="vod-tooltip-position" data-open={open} {...getFloatingProps({ onClick: event => event.stopPropagation(), onPointerDown: event => event.stopPropagation() })} style={{ ...floating.floatingStyles, visibility: !floating.isPositioned || floating.middlewareData.hide?.referenceHidden ? 'hidden' : undefined }}>
        <div className="vod-tooltip-bubble" style={{ ...styles, transformOrigin: (floating.middlewareData.arrow?.x !== undefined ? floating.middlewareData.arrow.x + 7 + 'px' : '50%') + ' ' + (floating.placement.startsWith('top') ? 'bottom' : 'top') }}>
          <div className="vod-tooltip-content">{content}</div>
          <FloatingArrow ref={arrowRef} context={floating.context} className="vod-tooltip-arrow" width={14} height={7}/>
        </div>
      </div>
    </FloatingPortal>}
  </>;
}
