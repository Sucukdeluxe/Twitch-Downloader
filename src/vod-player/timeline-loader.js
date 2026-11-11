export function watchVodTimeline(api, request, onUpdate) {
  let closed = false, pending = false, timer, snapshot = null;
  function publish(value, state) {
    if (value) {
      const previous = snapshot?.vodId === value.vodId && snapshot?.started === value.started ? snapshot : null;
      snapshot = { ...value,
        chapters: value.chapters?.length ? value.chapters : previous?.chapters || [],
        titleHistory: value.titleHistory?.length ? value.titleHistory : previous?.titleHistory || [],
        viewerHistory: value.viewerHistory?.length ? value.viewerHistory : previous?.viewerHistory || [],
        viewerGaps: value.viewerHistory?.length ? value.viewerGaps : previous?.viewerGaps || [],
      };
    }
    onUpdate(snapshot, state);
  }
  const unsubscribe = api.onVodTimelineProgress?.(update => {
    if (!closed && pending && update.id === request.id) publish(update.timeline, 'partial');
  });
  async function load(refresh) {
    pending = true;
    let delay = 15000;
    try {
      const result = await api.getVodTimeline({ ...request, refresh });
      if (closed) return;
      publish(result, result ? 'ready' : 'error');
      if (result) delay = result.refreshAfterMs ?? (result.chapters?.length ? 0 : 15000);
    } catch {
      if (!closed) publish(null, 'error');
    } finally {
      pending = false;
      if (!closed && delay > 0) timer = setTimeout(() => { void load(true); }, delay);
    }
  }
  onUpdate(null, 'loading');
  void load(request.refresh === true);
  return () => { closed = true; clearTimeout(timer); unsubscribe?.(); };
}
