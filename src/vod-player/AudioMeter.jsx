import React, { useEffect, useRef, useState } from 'react';
import { samplePeakDecibels } from './audio-level';

export function AudioMeter({ video, active, playing, language }) {
  const root = useRef(null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!active || !playing || typeof video.captureStream !== 'function' || !window.AudioContext) { setAvailable(false); return; }
    let context, stream, source, splitter, sink, frame, stopped = false, cancelWaiting = () => {};
    async function start() {
      try {
        await new Promise(resolve => {
          let callback;
          const finish = () => { clearTimeout(timer); if (callback !== undefined) video.cancelVideoFrameCallback(callback); resolve(); };
          const timer = setTimeout(finish, 500);
          cancelWaiting = finish;
          if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(finish);
        });
        if (stopped) return;
        stream = video.captureStream();
        if (!stream.getAudioTracks().length) {
          const ready = await new Promise(resolve => {
            const finish = value => { clearTimeout(timer); stream.removeEventListener('addtrack', changed); resolve(value); };
            const changed = () => { if (stream.getAudioTracks().length) finish(true); };
            const timer = setTimeout(() => finish(false), 3000);
            cancelWaiting = () => finish(false);
            stream.addEventListener('addtrack', changed); changed();
          });
          if (!ready || stopped) return;
        }
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
        splitter = context.createChannelSplitter(2);
        const analysers = [context.createAnalyser(), context.createAnalyser()];
        source.connect(splitter);
        sink = context.createGain(); sink.gain.value = 0; sink.connect(context.destination);
        analysers.forEach((analyser, index) => { analyser.fftSize = 2048; splitter.connect(analyser, index); analyser.connect(sink); });
        await context.resume();
        if (stopped) return;
        setAvailable(true);
        const samples = analysers.map(() => new Float32Array(2048)); let last = 0;
        const tick = now => {
          if (stopped) return;
          if (now - last >= 50 && root.current) {
            last = now;
            analysers.forEach((analyser, index) => {
              analyser.getFloatTimeDomainData(samples[index]);
              const db = samplePeakDecibels(samples[index]);
              const row = root.current.children[index];
              row.querySelector('i').style.width = ((db + 60) / 66 * 100) + '%';
              row.querySelector('i').classList.toggle('is-peak', db >= -1.5);
              row.querySelector('output').textContent = db <= -60 ? '−∞' : db.toFixed(1);
            });
          }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      } catch { setAvailable(false); }
    }
    void start();
    return () => { stopped = true; cancelWaiting(); cancelAnimationFrame(frame); source?.disconnect(); splitter?.disconnect(); sink?.disconnect(); stream?.getTracks().forEach(track => track.stop()); void context?.close().catch(() => {}); };
  }, [video, active, playing]);
  return <div className="audio-preview-meter" ref={root} hidden={!available} title={language === 'de' ? 'Vorschau · dBFS' : 'Preview · dBFS'} aria-label={language === 'de' ? 'Audiopegel der Vorschau' : 'Preview audio level'}>{['L', 'R'].map(channel => <div key={channel}><span>{channel}</span><b><i/></b><output>−∞</output></div>)}</div>;
}
