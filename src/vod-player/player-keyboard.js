export function playerKeyAction(event) {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.nativeEvent?.isComposing) return null;
  const target = event.target, root = event.currentTarget;
  if (!root?.contains(target) || target.closest?.('[contenteditable]:not([contenteditable="false"]), .player-panel-position')) return null;
  const dialog = target.closest?.('[role="dialog"]');
  if (dialog && !dialog.contains(root)) return null;
  const key = event.key.toLowerCase();
  const toggle = key === ' ' || key === 'k';
  if (target.closest?.('input, textarea, select, button, a, summary, [role="button"], [role="textbox"], [role="combobox"], [role="menuitem"]')) {
    if (!target.matches?.('input[type="range"]') || !toggle) return null;
  }
  const action = toggle ? 'toggle' : ({arrowright:'forward',arrowleft:'back',arrowup:'louder',arrowdown:'quieter',m:'mute',f:'fullscreen',home:'start',end:'end'})[key];
  if (!action) return null;
  return event.repeat && ['toggle','mute','fullscreen'].includes(action) ? 'consume' : action;
}
