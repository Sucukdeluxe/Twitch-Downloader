export function streamTimestamp(parts, started, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  let cursor = 0;
  let wall = Number.isFinite(started) && started > 0 ? started : null;
  if (!parts?.length) return wall === null ? null : wall + seconds * 1000;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (Number.isFinite(part.started) && part.started > 0) wall = part.started;
    const duration = Number.isFinite(part.duration) && part.duration > 0 ? part.duration : 0;
    if (seconds < cursor + duration || (index === parts.length - 1 && seconds === cursor + duration)) {
      return wall === null ? null : wall + (seconds - cursor) * 1000;
    }
    cursor += duration;
    if (wall !== null) wall += duration * 1000;
  }
  return null;
}

export function createStreamClock(locale = "de", timeZone) {
  const formatter = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  });
  return (started, seconds) => {
    if (!Number.isFinite(started) || started <= 0 || !Number.isFinite(seconds) || seconds < 0) return null;
    const date = new Date(Math.floor((started + seconds * 1000) / 1000) * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    return { dateTime: date.toISOString(), label: formatter.format(date) };
  };
}
