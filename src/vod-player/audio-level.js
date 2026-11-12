export function samplePeakDecibels(samples) {
  let peak = 0;
  for (const sample of samples) if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
  return peak > 0 ? Math.max(-60, Math.min(6, 20 * Math.log10(peak))) : -60;
}
