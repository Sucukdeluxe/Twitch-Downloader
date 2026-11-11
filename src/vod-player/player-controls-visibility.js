export function playerControlsPinned(controls, menuOpen, scrubbing) {
  return Boolean(menuOpen || scrubbing || controls?.matches(":hover") || controls?.querySelector(":focus-visible"));
}
