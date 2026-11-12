import { timeLabel } from './timeline.js';

export function parseExactTime(text, total) {
  const value = String(text).trim();
  const decimal = value.replace(',', '.').split('.');
  const segments = decimal[0].split(':');
  if (value.length > 40 || decimal.length > 2 || segments.length > 3
    || segments.some((part, index) => !/^\d+$/.test(part) || (index > 0 && part.length > 2))
    || (decimal.length === 2 && !/^\d{1,3}$/.test(decimal[1]))) return null;
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length > 1 && parts.at(-1) >= 60 || parts.length === 3 && parts[1] >= 60) return null;
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Number.isFinite(total) && Number.isFinite(seconds) && seconds >= 0 && seconds <= total ? seconds : null;
}

export function exactTimeLabel(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  return `${timeLabel(milliseconds / 1000)},${String(milliseconds % 1000).padStart(3, '0')}`;
}
