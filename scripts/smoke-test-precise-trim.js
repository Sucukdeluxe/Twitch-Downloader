// Real renderer -> queue -> FFmpeg -> MP4 on macOS and Windows.
// The temporal oracle is independent of production trimming and survives lossy encoding.
// After building: node scripts/smoke-test-precise-trim.js [absolute-ffmpeg absolute-ffprobe]
// macOS always uses bundled managed tools, even when host arguments are supplied.
// Oracle-only (no build/UI): node scripts/smoke-test-precise-trim.js --oracle-self-test [ffmpeg ffprobe]
// Actual HLS decoder, no visible windows: --headless-source-audio [ffmpeg ffprobe]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { createE2eEnvironment, getElectronLaunchOptions, verifyE2eIsolation, cleanupE2eEnvironment } = require('./e2e-test-environment');
const execute = promisify(execFile);

const WIDTH = 160, HEIGHT = 96, SAMPLE_RATE = 48000;
const mediaCommand = (command, args, binary = false, cwd) => execute(command, args, {
  timeout: 120000, windowsHide: true, maxBuffer: 96 * 1024 * 1024,
  ...(binary ? { encoding: 'buffer' } : {}),
  ...(cwd ? { cwd } : {}),
});
const rateNumber = rate => String(rate).split('/').map(Number).reduce((a, b) => a / b);

// Numeric IDs are encoded twice, with inverse polarity, in large flat blocks.
// They can be read after H.264 encoding without relying on source pixel hashes.
async function createTemporalFixture(directory, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe',
  fps = '25', duration = 18, name = 'temporal', segmentType = 'mpegts' } = {}) {
  directory = path.resolve(directory);
  assert.equal(path.basename(name), name);
  assert(['mpegts', 'fmp4'].includes(segmentType));
  const rate = rateNumber(fps), count = Math.ceil(duration * rate);
  assert(count > 0 && count < 4096);
  const rawVideo = path.join(directory, `${name}.gray`), rawAudio = path.join(directory, `${name}.f32`);
  const source = path.join(directory, `${name}.mp4`);
  const stem = name.replace(/[^a-z0-9_-]/gi, '-');
  // FFmpeg's HLS reader treats backslashes as URL separators inconsistently.
  const playlist = path.join(directory, `${stem}.m3u8`).replaceAll('\\', '/');
  const video = Buffer.alloc(count * WIDTH * HEIGHT, 96);
  for (let frame = 0; frame < count; frame++) {
    for (let bit = 0; bit < 12; bit++) {
      for (let y = 8; y < 88; y++) {
        const high = Boolean(frame & (1 << bit)) !== (y >= 48);
        video.fill(high ? 235 : 16, frame * WIDTH * HEIGHT + y * WIDTH + 8 + bit * 12,
          frame * WIDTH * HEIGHT + y * WIDTH + 20 + bit * 12);
      }
    }
  }
  const audio = Buffer.alloc(Math.ceil(duration * SAMPLE_RATE) * 4);
  let seed = 0x12345678, noise = 0;
  for (let sample = 0; sample < audio.length / 4; sample++) {
    const t = sample / SAMPLE_RATE;
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    noise = .97 * noise + .03 * ((seed >>> 0) / 0x80000000 - 1);
    // Deterministic band-limited noise disambiguates phase aliases in the chirps.
    audio.writeFloatLE(.12 * Math.sin(2 * Math.PI * (317 * t + 37 * t * t))
      + .10 * Math.sin(2 * Math.PI * (733 * t + 53 * t * t)) + 2.5 * noise, sample * 4);
  }
  fs.writeFileSync(rawVideo, video, { flag: 'wx' });
  fs.writeFileSync(rawAudio, audio, { flag: 'wx' });
  try {
    await mediaCommand(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'gray',
      '-video_size', `${WIDTH}x${HEIGHT}`, '-framerate', String(fps), '-i', rawVideo,
      '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawAudio,
      '-frames:v', String(count), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-g', String(Math.ceil(rate * 10)), '-keyint_min', String(Math.ceil(rate * 10)),
      '-sc_threshold', '0', '-bf', '3', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-n', source]);
    // Generate every HLS artifact relative to one owned directory. In
    // particular, fMP4 init/segment path inference must not see a Windows drive.
    await mediaCommand(ffmpeg, ['-v', 'error', '-i', path.basename(source), '-c', 'copy', '-hls_time', '2',
      '-hls_list_size', '0', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', `${stem}-%04d.${segmentType === 'fmp4' ? 'm4s' : 'ts'}`,
      ...(segmentType === 'fmp4' ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `${stem}-init.mp4`] : []),
      '-n', path.basename(playlist)], false, directory);
    const text = fs.readFileSync(playlist, 'utf8');
    const references = [...text.matchAll(/#EXT-X-MAP:.*?URI="([^"]+)"/g)].map(match => match[1]);
    references.push(...text.split(/\r?\n/).filter(line => line && !line.startsWith('#')));
    assert(references.length > 0, 'HLS fixture must reference media files');
    for (const reference of references) {
      assert.equal(path.posix.basename(reference), reference, 'Fixture HLS URLs must be relative filenames');
      assert.equal(path.win32.basename(reference), reference, 'Fixture HLS URLs must not contain Windows paths');
      assert(!reference.includes(':') && !reference.includes('\\'), 'Fixture HLS URL must not contain drive or backslash syntax');
      assert(fs.statSync(path.join(directory, reference)).isFile(), `Missing generated HLS media: ${reference}`);
    }
  } finally {
    fs.unlinkSync(rawVideo); fs.unlinkSync(rawAudio);
  }
  const metadata = JSON.parse((await mediaCommand(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_streams', '-show_frames', '-show_entries', 'stream=codec_type,has_b_frames:frame=key_frame,best_effort_timestamp_time',
    '-of', 'json', source])).stdout);
  assert(metadata.streams.find(stream => stream.codec_type === 'video').has_b_frames > 0, 'Fixture must contain B-frames');
  assert(metadata.frames.filter(frame => frame.key_frame === 1).slice(1)
    .every(frame => Number(frame.best_effort_timestamp_time) >= 9.9), 'Fixture must retain its long first GOP');
  const fixture = { path: source, playlist, fps: rate, duration, count, segmentType };
  await assertTemporalFrames(source, fixture, [{ start: 0, end: duration }], { ffmpeg });
  return fixture;
}

async function readIds(file, ffmpeg) {
  const data = (await mediaCommand(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0',
    '-vf', `scale=${WIDTH}:${HEIGHT}`, '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], true)).stdout;
  assert(data.length > 0 && data.length % (WIDTH * HEIGHT) === 0, 'Incomplete decoded frames');
  const ids = [];
  for (let offset = 0; offset < data.length; offset += WIDTH * HEIGHT) {
    let id = 0;
    for (let bit = 0; bit < 12; bit++) {
      const top = data[offset + 24 * WIDTH + 14 + bit * 12];
      const bottom = data[offset + 72 * WIDTH + 14 + bit * 12];
      assert(Math.abs(top - bottom) > 120, `Unreadable frame ID at output frame ${ids.length}`);
      if (top > bottom) id |= 1 << bit;
    }
    ids.push(id);
  }
  return ids;
}

function selectedFrames(fixture, { start, end }) {
  const frames = fixture.presentationFrames || Array.from({ length: fixture.count }, (_, id) => ({ id, pts: id / fixture.fps }));
  return frames.filter(frame => frame.pts >= start - 0.000001 && frame.pts < end - 0.000001);
}

async function assertTemporalFrames(output, fixture, ranges, { ffmpeg = 'ffmpeg' } = {}) {
  const expected = ranges.flatMap(range => selectedFrames(fixture, range).map(frame => frame.id));
  const actual = await readIds(output, ffmpeg);
  assert.equal(actual.length, expected.length,
    `Exact frame count (end exclusive; no preroll): actual IDs ${actual[0]}..${actual.at(-1)}, expected ${expected[0]}..${expected.at(-1)}`);
  for (let i = 0; i < expected.length; i++) assert.equal(actual[i], expected[i], `Source frame ID at output frame ${i}`);
  return { frames: actual.length, first: actual[0], last: actual.at(-1) };
}

async function audioSamples(file, ffmpeg) {
  const data = (await mediaCommand(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0',
    '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 'f32le', '-'], true)).stdout;
  return Float32Array.from({ length: data.length / 4 }, (_, i) => data.readFloatLE(i * 4));
}

function correlateAudio(actual, actualStart, expected, expectedStart) {
  let best = { score: -1, lag: 0 };
  for (let lag = -2400; lag <= 2400; lag++) {
    if (expectedStart + lag < 0 || expectedStart + lag + 2400 >= expected.length) continue;
    let dot = 0, xx = 0, yy = 0;
    for (let i = 0; i < 2400; i += 4) {
      const x = actual[actualStart + i], y = expected[expectedStart + i + lag];
      dot += x * y; xx += x * x; yy += y * y;
    }
    const score = dot / Math.sqrt(xx * yy);
    if (score > best.score) best = { score, lag };
  }
  return best;
}

async function assertPreciseRange(output, fixture, ranges, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  const frames = await assertTemporalFrames(output, fixture, ranges, { ffmpeg });
  const metadata = JSON.parse((await mediaCommand(ffprobe, ['-v', 'error', '-show_streams', '-show_format',
    '-show_frames', '-show_entries', 'stream=codec_type,start_time,duration:format=duration:frame=media_type,best_effort_timestamp_time,nb_samples', '-of', 'json', output])).stdout);
  assert.deepEqual(metadata.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  const duration = ranges.reduce((total, range) => total + range.end - range.start, 0);
  const muxTolerance = Math.max(1 / fixture.fps, 1024 / SAMPLE_RATE) + .001;
  assert(Math.abs(Number(metadata.format.duration) - duration) <= muxTolerance,
    `MP4 duration ${metadata.format.duration} differs from selected ${duration}`);
  for (const type of ['video', 'audio']) {
    const decoded = metadata.frames.filter(frame => frame.media_type === type);
    assert(decoded.length, `Missing ${type} frames`);
    const times = decoded.map(frame => Number(frame.best_effort_timestamp_time));
    assert(times.every(Number.isFinite), `Missing ${type} PTS`);
    const referenceStart = type === 'video' ? selectedFrames(fixture, ranges[0])[0].pts : 0;
    const initialGap = Math.max(0, referenceStart - ranges[0].start);
    assert(times[0] >= -.000001 && times[0] <= Math.max(initialGap, type === 'video' ? 1 / fixture.fps : 1024 / SAMPLE_RATE) + .001,
      `${type} starts at ${times[0]} instead of zero`);
    for (let i = 1; i < times.length; i++) assert(times[i] > times[i - 1], `Nonmonotonic ${type} PTS`);
    const lastEnd = times.at(-1) + (type === 'video' ? 1 / fixture.fps : decoded.at(-1).nb_samples / SAMPLE_RATE);
    assert(Math.abs(lastEnd - duration) <= muxTolerance, `${type} end ${lastEnd} differs from selected ${duration}`);
  }
  const [sourceAudio, outputAudio] = await Promise.all([audioSamples(fixture.audioReference?.path || fixture.path, ffmpeg), audioSamples(output, ffmpeg)]);
  const outputAudioStart = Number(metadata.streams.find(stream => stream.codec_type === 'audio').start_time);
  let offset = 0;
  for (const range of ranges) {
    const length = range.end - range.start;
    // Correlate markers near BOTH edges and in the middle, including each join.
    for (const at of [.08, length / 2, length - .18]) {
      const actualStart = Math.round((offset + at - outputAudioStart) * SAMPLE_RATE);
      assert(actualStart >= 0 && actualStart + 2400 < outputAudio.length, 'Audio marker must lie in output audio');
      const expectedStart = Math.round((range.start + at - (fixture.audioReference?.start || 0)) * SAMPLE_RATE);
      assert(expectedStart >= 0 && expectedStart + 2400 < sourceAudio.length, 'Audio marker must lie in original source audio');
      const best = correlateAudio(outputAudio, actualStart, sourceAudio, expectedStart);
      assert(best.score > .94, `Wrong audio content at ${offset + at}s (correlation ${best.score})`);
      assert(Math.abs(best.lag) <= 96, `Audio marker drift at ${offset + at}s: ${best.lag / SAMPLE_RATE}s`);
    }
    offset += length;
  }
  await mediaCommand(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
  return { ...frames, duration: Number(metadata.format.duration), audioMarkers: ranges.length * 3 };
}

// Observe the actual production HLS.js -> MediaSource boundary. These bytes and
// timestamp offsets are what the browser receives, independently of FFmpeg's
// input seek calculations. Do not derive expected times using production helpers.
async function observePlayerMedia(win) {
  await win.evaluate(() => {
    window.__trimPlayerBuffers = [];
    window.__trimPlayerSourceUrls = new Map();
    const sources = new WeakMap();
    let nextSource = 0;
    const sourceId = source => {
      if (!sources.has(source)) sources.set(source, ++nextSource);
      return sources.get(source);
    };
    const createUrl = URL.createObjectURL;
    URL.createObjectURL = function (source) {
      const url = createUrl.call(this, source);
      if (source instanceof MediaSource) window.__trimPlayerSourceUrls.set(url, sourceId(source));
      return url;
    };
    const add = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const buffer = add.call(this, mime);
      const record = { mime, sourceId: sourceId(this), chunks: [] };
      window.__trimPlayerBuffers.push(record);
      const append = buffer.appendBuffer;
      buffer.appendBuffer = function (bytes) {
        const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        record.chunks.push({ offset: buffer.timestampOffset, bytes: Array.from(view) });
        return append.call(this, bytes);
      };
      return buffer;
    };
  });
}

async function capturePlayerReference(win, fixture, { ffmpeg, ffprobe }) {
  // The player has active and standby slots. Bind one element/source generation;
  // neither DOM order nor the first captured SourceBuffer identifies playback.
  await win.waitForFunction(() => document.querySelector('#clipPlayer video.active')?.readyState >= 2);
  const video = await win.$('#clipPlayer video.active');
  const sourceUrl = await video.evaluate(element => { element.pause(); return element.currentSrc; });
  try {
    await waitFor(async () => video.evaluate((element, { duration, sourceUrl }) => {
      if (!element.isConnected || !element.classList.contains('active') || element.currentSrc !== sourceUrl) {
        throw new Error('Player source changed while capturing its reference');
      }
      const buffered = element.buffered;
      if (!buffered.length || element.readyState < 2) return false;
      const end = buffered.end(buffered.length - 1);
      if (end >= duration - .1) return true;
      // A paused playhead can remain before the first B-frame PTS, or HLS may
      // have reached its forward-buffer limit. Move only INSIDE data already
      // received, in order, so HLS loads the next fragment without skipping or
      // refetching one. Do not alter production HLS buffering configuration.
      const target = Math.max(buffered.start(buffered.length - 1), end - .25);
      if (!element.seeking && target > element.currentTime + .1) element.currentTime = target;
      return false;
    }, { duration: fixture.duration, sourceUrl }), 30000);
  } catch (error) {
    console.error('Player reference buffer diagnostics:', await win.evaluate(() => ({
      videos: [...document.querySelectorAll('#clipPlayer video')].map(element => ({
        className: element.className, src: element.currentSrc, time: element.currentTime,
        duration: element.duration, ready: element.readyState, paused: element.paused,
        seeking: element.seeking, network: element.networkState, error: element.error?.message,
        buffered: Array.from({ length: element.buffered.length }, (_, index) => [element.buffered.start(index), element.buffered.end(index)]),
      })),
      buffers: window.__trimPlayerBuffers.map(record => ({ sourceId: record.sourceId, mime: record.mime, chunks: record.chunks.length })),
    })));
    throw error;
  }
  const records = await win.evaluate(sourceUrl => {
    const sourceId = window.__trimPlayerSourceUrls.get(sourceUrl);
    if (!sourceId) throw new Error('Active player MediaSource was not observed');
    return window.__trimPlayerBuffers.filter(record => record.sourceId === sourceId);
  }, sourceUrl);
  const results = {};
  for (const type of ['video', 'audio']) {
    const record = records.find(row => row.mime.startsWith(type + '/'))
      || (type === 'audio' ? records.find(row => row.mime.includes('mp4a.')) : null);
    assert(record?.chunks.length > 1, `Production HLS player did not append ${type} media`);
    // Initialization segments may arrive before the final timestamp offset.
    const mediaChunks = record.chunks.filter(chunk => Buffer.from(chunk.bytes).includes(Buffer.from('moof')));
    assert(mediaChunks.length, `Missing player ${type} fragments`);
    const offsets = [...new Set(mediaChunks.map(chunk => chunk.offset))];
    assert.equal(offsets.length, 1, 'Fixture must have one continuous MSE timestamp origin');
    const file = fixture.path + `.player-${type}.mp4`;
    fs.writeFileSync(file, Buffer.concat(record.chunks.map(chunk => Buffer.from(chunk.bytes))));
    const meta = JSON.parse((await mediaCommand(ffprobe, ['-v', 'error', '-select_streams', type === 'video' ? 'v:0' : 'a:0', '-show_streams', '-show_frames',
      '-show_entries', 'stream=codec_type,start_time:frame=best_effort_timestamp_time', '-of', 'json', file])).stdout);
    assert.equal(meta.streams.length, 1);
    assert.equal(meta.streams[0].codec_type, type);
    results[type] = { file, meta, offset: offsets[0] };
  }
  const ids = await readIds(results.video.file, ffmpeg);
  assert.equal(ids.length, results.video.meta.frames.length);
  const presentationFrames = ids.map((id, index) => ({ id,
    pts: Number(results.video.meta.frames[index].best_effort_timestamp_time) + results.video.offset }));
  assert.equal(presentationFrames.length, fixture.count, 'Actual player must receive every fixture frame');
  for (let i = 0; i < presentationFrames.length; i++) {
    assert.equal(presentationFrames[i].id, i, 'Player reference must retain source frame sequence');
    if (i) assert(presentationFrames[i].pts > presentationFrames[i - 1].pts);
  }
  // Confirm captured bytes agree with images displayed by the actual app. A
  // paused time between frames displays the previous frame; cuts use [start,end).
  for (const time of [4.513, 10.513]) {
    const observed = await video.evaluate(async (video, time) => {
      video.pause();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Player reference seek timed out')), 10000);
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.currentTime = time;
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 96;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 160, 96);
      const data = context.getImageData(0, 0, 160, 96).data;
      let id = 0;
      for (let bit = 0; bit < 12; bit++) {
        const top = data[(24 * 160 + 14 + bit * 12) * 4];
        const bottom = data[(72 * 160 + 14 + bit * 12) * 4];
        if (Math.abs(top - bottom) <= 120) throw new Error('Unreadable displayed player frame');
        if (top > bottom) id |= 1 << bit;
      }
      return { id, time: video.currentTime };
    }, time);
    const expected = presentationFrames.filter(frame => frame.pts <= observed.time + .000001).at(-1);
    assert.equal(observed.id, expected.id, `Displayed HLS frame at ${observed.time}s`);
  }
  const sourceReference = await mapOriginalSourceAudio(fixture, presentationFrames, { ffmpeg, ffprobe });
  // HLS.js can smooth AAC differently after a seek. Its decoded audio is useful
  // diagnostic evidence, but MUST NOT define the exported source A/V timeline.
  const browserAudioStart = Number(results.audio.meta.frames[0].best_effort_timestamp_time) + results.audio.offset;
  const at = Math.min(5, fixture.duration / 2);
  const [browserAudio, rawAudio] = await Promise.all([audioSamples(results.audio.file, ffmpeg), audioSamples(fixture.playlist, ffmpeg)]);
  const phase = correlateAudio(browserAudio, Math.round((at - browserAudioStart) * SAMPLE_RATE),
    rawAudio, Math.round((at - sourceReference.audioReference.start) * SAMPLE_RATE));
  return { ...sourceReference, browserAudioPhase: { seconds: phase.lag / SAMPLE_RATE, correlation: phase.score } };
}

async function mapOriginalSourceAudio(fixture, presentationFrames, { ffmpeg, ffprobe }) {
  const raw = JSON.parse((await mediaCommand(ffprobe, ['-v', 'error', '-show_frames',
    '-show_entries', 'frame=media_type,best_effort_timestamp_time', '-of', 'json', fixture.playlist])).stdout);
  const video = raw.frames.filter(frame => frame.media_type === 'video');
  const audio = raw.frames.filter(frame => frame.media_type === 'audio');
  const ids = await readIds(fixture.playlist, ffmpeg);
  assert.equal(ids.length, video.length);
  assert.equal(ids.length, presentationFrames.length);
  assert(audio.length, 'Original HLS must contain decoded audio');
  const shifts = presentationFrames.map((frame, index) => {
    assert.equal(frame.id, ids[index], 'Match source and browser pictures before mapping audio');
    return frame.pts - Number(video[index].best_effort_timestamp_time);
  });
  const shift = shifts[0];
  assert(Number.isFinite(shift) && shifts.every(value => Math.abs(value - shift) <= .0001),
    'The actual browser/source video mapping must be a consistent shift for this continuous fixture');
  // PCM sample zero belongs to the FIRST DECODED AUDIO FRAME, not the format or
  // stream start. This preserves TS mux offsets and AAC priming independently
  // of how the production downloader calculates its seek origin.
  const start = Number(audio[0].best_effort_timestamp_time) + shift;
  assert(Number.isFinite(start));
  return { ...fixture, presentationFrames, sourcePresentationShift: shift,
    audioReference: { path: fixture.playlist, start } };
}

async function waitFor(predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Trim workflow did not finish in time');
}

// A fast, headless check that the oracle accepts lossy correct trims and rejects
// shifted frames, inclusive end boundaries, and audio shifted by one AAC packet.
async function selfTest({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'precise-trim-oracle-'));
  const checks = [];
  let negativeChecks = 0;
  try {
    for (const fps of ['25', '60000/1001']) {
      const fixture = await createTemporalFixture(directory, { ffmpeg, ffprobe, fps,
        name: fps === '25' ? 'PAL' : 'NTSC', duration: 12 });
      for (const [start, end] of [[0, 1.013], [4.513, 8.527]]) {
        const output = path.join(directory, `correct-${fixture.fps}-${start}.mp4`);
        const encode = (target, audioOffset = 0) => mediaCommand(ffmpeg, ['-v', 'error', '-i', fixture.path,
          '-vf', `trim=start=${start}:end=${end},setpts=PTS-STARTPTS`,
          '-af', `atrim=start=${start + audioOffset}:end=${end + audioOffset},asetpts=PTS-STARTPTS`,
          '-fps_mode', 'passthrough', '-c:v', 'libx264', '-crf', '23', '-c:a', 'aac', '-n', target]);
        await encode(output);
        checks.push(await assertPreciseRange(output, fixture, [{ start, end }], { ffmpeg, ffprobe }));
        await assert.rejects(assertTemporalFrames(output, fixture,
          [{ start: start + 1 / fixture.fps, end: end + 1 / fixture.fps }], { ffmpeg }), /Source frame ID/);
        await assert.rejects(assertTemporalFrames(output, fixture,
          [{ start, end: end + 1 / fixture.fps }], { ffmpeg }), /Exact frame count/);
        negativeChecks += 2;
        for (const shift of [-1024 / SAMPLE_RATE, -.004667, .004667, 1024 / SAMPLE_RATE].filter(shift => start + shift >= 0)) {
          const shiftedAudio = path.join(directory, `wrong-audio-${fixture.fps}-${start}-${shift}.mp4`);
          await encode(shiftedAudio, shift);
          await assert.rejects(assertPreciseRange(shiftedAudio, fixture, [{ start, end }], { ffmpeg, ffprobe }), /Audio marker drift/);
          negativeChecks++;
        }
      }
    }
    console.log(JSON.stringify({ oracle: 'passed', positiveRanges: checks, negativeChecks }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// Validate real HLS.js video mapping and source A/V timing with a genuinely
// headless browser. This deliberately does not launch Electron or a native app.
async function headlessSourceAudio({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  const { chromium } = require('playwright');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'precise-headless-source-'));
  let browser, server;
  const checks = [], observations = [];
  try {
    const modulePath = path.join(directory, 'production-trim.cjs');
    require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/main/domain/vod-precise-trim.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: modulePath, logLevel: 'silent' });
    // Fixed repository entry point compiled into this test's owned directory.
    // eslint-disable-next-line security/detect-non-literal-require
    const production = require(modulePath);
    server = http.createServer((request, response) => {
      const file = path.join(directory, path.basename(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': fs.statSync(file).size,
        'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
      fs.createReadStream(file).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    for (const [fps, segmentType, duration] of [['25', 'mpegts', 28], ['60000/1001', 'mpegts', 28], ['60000/1001', 'fmp4', 28], ['25', 'mpegts', 68]]) {
      const page = await browser.newPage();
      try {
        let fixture = await createTemporalFixture(directory, { ffmpeg, ffprobe, fps, segmentType,
          name: `headless-${fps.replace('/', '-')}-${segmentType}-${duration}`, duration });
        await page.setContent('<div id="clipPlayer"><video class="standby" muted playsinline></video><video class="active" muted playsinline width="160" height="96"></video></div>');
        await observePlayerMedia(page);
        await page.addScriptTag({ path: require.resolve('hls.js/dist/hls.js') });
        await page.evaluate(async url => {
          const config = { maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30 };
          // Observe an incomplete previous source first. Its buffers must never
          // become the active reference merely because they were created first.
          const previous = new window.Hls(config);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Standby fixture did not buffer')), 10000);
            previous.once(window.Hls.Events.FRAG_BUFFERED, () => {
              previous.stopLoad(); clearTimeout(timer); resolve();
            });
            previous.loadSource(url); previous.attachMedia(document.querySelector('video.standby'));
          });
          previous.destroy();
          const video = document.querySelector('video.active');
          const hls = new window.Hls(config);
          window.__headlessHls = hls;
          hls.on(window.Hls.Events.FRAG_BUFFERED, () => { window.__lastHeadlessAppend = performance.now(); });
          hls.loadSource(url); hls.attachMedia(video);
          // Deliberately remain paused at zero, including before the first PTS.
        }, `http://127.0.0.1:${server.address().port}/${path.basename(fixture.playlist)}`);
        if (duration > 60) {
          await page.waitForFunction(() => {
            const video = document.querySelector('video.active');
            return video.buffered.length && video.buffered.end(0) >= 20
              && window.__headlessHls.streamController.state === 'IDLE'
              && performance.now() - window.__lastHeadlessAppend > 500;
          });
          const end = await page.evaluate(() => document.querySelector('video.active').buffered.end(0));
          assert(end < duration - .1, 'Long paused fixture must demonstrate the passive full-buffer wait cannot finish');
        }
        fixture = await capturePlayerReference(page, fixture, { ffmpeg, ffprobe });
        observations.push({ fps: fixture.fps, segmentType, duration, frames: fixture.presentationFrames.length, sourcePresentationShift: fixture.sourcePresentationShift,
          sourceAudioStart: fixture.audioReference.start, browserAudioPhase: fixture.browserAudioPhase });
        // Expected video IDs/times come from the browser; expected PCM timing
        // comes from independently decoded original HLS, never this helper.
        const timeline = await production.readVodPlaylistTimeline(ffprobe, fixture.playlist);
        for (const [start, end] of (duration > 60 ? [[61.513, 64.527]] : [[0, 1.013], [4.513, 8.527], [21.513, 24.527]])) {
          const output = path.join(directory, `output-${fps.replace('/', '-')}-${segmentType}-${start}.mp4`);
          await mediaCommand(ffmpeg, production.buildPreciseVodTrimArgs({ input: fixture.playlist, output,
            start, duration: end - start, seekOffset: timeline.seekOffset, seekAfterInput: true }));
          const evidence = await assertPreciseRange(output, fixture, [{ start, end }], { ffmpeg, ffprobe });
          checks.push({ fps: fixture.fps, segmentType, start, end, ...evidence });
        }
      } finally { await page.close(); }
    }
    console.log(JSON.stringify({ headlessSourceAudio: 'passed', nativeAppLaunched: false,
      originalSourceAudio: true, observations, ranges: checks }));
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function run({ macOnly = false, ffmpeg: hostFFmpeg, ffprobe: hostFFprobe } = {}) {
  if (macOnly) assert.equal(process.platform, 'darwin');
  assert(['darwin', 'win32'].includes(process.platform), 'Native macOS or Windows is required');
  const { _electron: electron } = require('playwright');
  const environment = createE2eEnvironment('precise-trim-download', { language: 'en', performance_mode: 'balanced' });
  let app, server;
  const pageErrors = [];
  try {
    const launch = getElectronLaunchOptions(environment);
    launch.args = launch.args.map(arg => arg.startsWith('--host-resolver-rules=') ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1' : arg);
    if (process.platform === 'darwin') launch.env.PATH = '/usr/bin:/bin';
    else if (hostFFmpeg || hostFFprobe) {
      for (const file of [hostFFmpeg, hostFFprobe]) assert(file && path.isAbsolute(file) && fs.statSync(file).isFile(), 'Pass absolute ffmpeg and ffprobe paths');
      // Provision only the isolated child process; never change the real app or host PATH.
      launch.env.PATH = [...new Set([path.dirname(hostFFmpeg), path.dirname(hostFFprobe)]), launch.env.PATH].join(path.delimiter);
    }
    // Only the fixture server bypasses the offline proxy for child FFmpeg.
    launch.env.NO_PROXY = launch.env.no_proxy = '127.0.0.1';
    if (process.env.PACKAGED_APP_PATH) {
      launch.executablePath = path.resolve(process.env.PACKAGED_APP_PATH);
      launch.args = launch.args.filter(arg => arg !== '.');
    }
    app = await electron.launch(launch);
    const win = await app.firstWindow();
    win.on('pageerror', error => pageErrors.push(error.message));
    win.on('console', message => { if (message.type() === 'error') console.error('Player console:', message.text()); });
    win.on('requestfailed', request => console.error('Player request failed:', request.url(), request.failure()?.errorText));
    await verifyE2eIsolation(app, win, environment);
    const preflight = await win.evaluate(() => window.api.runPreflight(true));
    for (const tool of ['ffmpeg', 'ffprobe', 'streamlink']) assert(preflight.checks[tool], `${tool} must work in the isolated profile`);
    const selectedTools = await app.evaluate(async ({ app: nativeApp }) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      const tools = appRequire('./dist/tools.js');
      return { ffmpeg: await tools.getFFmpegPath(), ffprobe: await tools.getFFprobePath() };
    });
    // The fixture generator runs in this Node process, outside the child's PATH.
    const ffmpeg = process.platform === 'win32' && hostFFmpeg ? hostFFmpeg : selectedTools.ffmpeg;
    const ffprobe = process.platform === 'win32' && hostFFprobe ? hostFFprobe : selectedTools.ffprobe;
    if (process.platform === 'darwin') {
      for (const tool of [ffmpeg, ffprobe]) assert(tool.startsWith(environment.appDataDir + path.sep), 'Mac must use managed tools without Homebrew');
    }
    let fixture = await createTemporalFixture(environment.mediaDir, { ffmpeg, ffprobe, name: 'Source with spaces ä', fps: '25', duration: 28 });
    server = http.createServer((request, response) => {
      const file = path.join(environment.mediaDir, path.basename(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)));
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': fs.statSync(file).size,
        'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : /\.(mp4|m4s)$/.test(file) ? 'video/mp4' : 'video/mp2t' });
      fs.createReadStream(file).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const playlistUrl = fixture => `http://127.0.0.1:${server.address().port}/${encodeURIComponent(path.basename(fixture.playlist))}`;
    await observePlayerMedia(win);
    await app.evaluate(({ app: nativeApp, ipcMain }, fixture) => {
      const appRequire = process.getBuiltinModule('module').createRequire(`${nativeApp.getAppPath()}/package.json`);
      nativeApp.setPath('temp', fixture.root);
      const mediaUrl = 'https://fixture.ttvnw.net/index.m3u8';
      // Ordinary Twitch renditions used to bypass FFmpeg seeking and use
      // Streamlink's segment-rounded offsets instead.
      appRequire('./dist/main/domain/vod-quality.js').resolveVodQualitySource = async () => null;
      appRequire('./dist/main/domain/vod-quality.js').resolveVodPlaybackSource = async () => mediaUrl;
      const snapshots = appRequire('./dist/main/domain/vod-live-snapshot.js');
      const fixtureFs = appRequire('node:fs'), fixturePath = appRequire('node:path');
      globalThis.__precisePlaylist = fixture.playlist;
      globalThis.__precisePlaylistFile = fixture.file;
      snapshots.fetchHlsMediaPlaylist = async () => snapshots.parseHlsMediaPlaylist(
        fixtureFs.readFileSync(globalThis.__precisePlaylistFile, 'utf8'), mediaUrl);
      const childProcess = appRequire('node:child_process'), spawn = childProcess.spawn;
      childProcess.spawn = (command, args, options) => {
        const mapped = args.map(arg => arg === mediaUrl ? globalThis.__precisePlaylist : arg);
        // Only external transport is redirected. The real production playlist
        // parser, bounded snapshot, copy spool and final encoder remain active.
        for (const arg of mapped) {
          if (typeof arg !== 'string' || !arg.endsWith('.m3u8') || !fixturePath.resolve(arg).startsWith(fixture.root + fixturePath.sep) || !fixtureFs.existsSync(arg)) continue;
          const content = fixtureFs.readFileSync(arg, 'utf8');
          fixtureFs.writeFileSync(arg, content.replaceAll('https://fixture.ttvnw.net/', new URL('.', globalThis.__precisePlaylist).href));
        }
        const protocols = mapped.indexOf('-protocol_whitelist');
        if (protocols >= 0) mapped[protocols + 1] += ',http';
        return spawn(command, mapped, options);
      };
      const handle = (name, callback) => { ipcMain.removeHandler(name); ipcMain.handle(name, callback); };
      handle('open-vod-playback', (_event, request) => ({ id: request.id, sourceUrl: globalThis.__precisePlaylist, quality: 'source' }));
      handle('close-vod-playback', () => {});
      handle('get-vod-timeline', () => null);
      let qualityAttempts = 0;
      handle('get-vod-qualities', () => ++qualityAttempts === 1 ? null : [{ id: 'source', label: 'Source · 360p · 25 fps · H.264' }]);
    }, { playlist: playlistUrl(fixture), file: fixture.playlist, root: environment.rootDir });
    await win.waitForFunction(() => typeof window.openClipDialog === 'function');
    await win.evaluate(() => window.openClipDialog('https://www.twitch.tv/videos/2222222', 'Trim workflow fixture', '2026-11-11T12:00:00Z', 'fixture', '28s'));
    await win.waitForFunction(() => document.querySelector('#clipPlayer video.active')?.readyState >= 2).catch(async error => {
      console.error('Player load diagnostics:', await win.evaluate(() => ({
        text: document.querySelector('#clipPlayer')?.textContent,
        videos: [...document.querySelectorAll('#clipPlayer video')].map(video => ({ src: video.currentSrc, ready: video.readyState, error: video.error?.message, dataset: { ...video.dataset } })),
        buffers: window.__trimPlayerBuffers?.map(row => ({ mime: row.mime, chunks: row.chunks.length })),
      })));
      throw error;
    });
    await win.evaluate(() => document.querySelector('#clipPlayer video.active').pause());
    fixture = await capturePlayerReference(win, fixture, { ffmpeg, ffprobe });
    assert.equal(await win.locator('#clipDetailsToggle').getAttribute('aria-expanded'), 'false');
    for (const [seconds, text, button] of [[4, '00:00:04', '#clipMarkStart button'], [10, '00:00:10', '#clipMarkEnd button']]) {
      await win.getByRole('button', { name: 'Exact playback time', exact: true }).click();
      await win.locator('.player-exact-time input').fill(text);
      await win.locator('.player-exact-time input').press('Enter');
      await win.waitForFunction(time => Math.abs(document.querySelector('#clipPlayer video.active').currentTime - time) < .1, seconds);
      await win.locator(button).click();
    }
    await win.locator('.vod-selection .vod-range-handle.is-start').press('ArrowRight');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:05');
    await win.locator('#clipStartEarlier').click();
    assert.equal(await win.locator('#clipDurationTime').textContent(), '00:00:06');
    await win.locator('#clipEndTime').fill('00:00:03');
    assert(await win.locator('#clipDialogConfirmBtn').isDisabled(), 'Reversed ranges must not be queued');
    await win.locator('#clipEndTime').fill('00:00:10');
    await win.locator('#clipDetailsToggle').click();
    await win.locator('#clipFilenameOptions summary').click();
    await win.locator('#clipStartPart').fill('7');
    await win.locator('input[name="filenameFormat"][value="template"]').check();
    await win.locator('#clipFilenameTemplate').fill('Trim Ä Test-{part}.mp4');
    await win.locator('#clipDetailsToggle').click({ timeout: 5000 });
    await win.locator('#clipDialogConfirmBtn').click();
    const quality = win.locator('.vod-quality-dialog');
    await quality.getByRole('button', { name: 'Retry', exact: true }).click();
    await quality.locator('input[value="source"]').check();
    await quality.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await win.evaluate(() => window.api.getQueue())).length, 0, 'Cancel must not add a job');
    assert.equal(await win.locator('#clipStartTime').inputValue(), '00:00:04');
    await win.locator('#clipDialogConfirmBtn').click();
    await quality.locator('input[value="source"]').check();
    await quality.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await waitFor(async () => (await win.evaluate(() => window.api.getQueue())).length === 1);
    const queued = (await win.evaluate(() => window.api.getQueue()))[0];
    assert.equal(queued.customClip.startSec, 4);
    assert.equal(queued.customClip.durationSec, 6);
    assert.equal(queued.customClip.startPart, 7);
    assert.equal(queued.customClip.filenameTemplate, 'Trim Ä Test-{part}.mp4');
    assert.equal(queued.quality, 'source');
    assert.equal(queued.status, 'pending');
    await win.locator('#btnStart').click();
    let completed;
    await waitFor(async () => {
      completed = (await win.evaluate(() => window.api.getQueue()))[0];
      assert.notEqual(completed.status, 'error', completed.last_error);
      return completed.status === 'completed';
    });
    assert.equal(completed.outputFiles.length, 1);
    const output = completed.outputFiles[0];
    assert.equal(path.basename(output), 'Trim Ä Test-7.mp4');
    assert(output.startsWith(environment.downloadsDir + path.sep));
    const checks = [await assertPreciseRange(output, fixture, [{ start: 4, end: 10 }], { ffmpeg, ffprobe })];
    console.log(JSON.stringify({ precisePlayerRange: { fps: fixture.fps, start: 4, end: 10, ...checks[0] } }));
    const outputs = [output];
    // Fractional boundaries deliberately lie between frames, including the first GOP.
    // Repeat through the real queue at NTSC rate with B-frames and a ten-second GOP.
    for (const [rate, segmentType] of [['25', 'mpegts'], ['60000/1001', 'mpegts'], ['60000/1001', 'fmp4']]) {
      let next = rate === '25' ? fixture : await createTemporalFixture(environment.mediaDir,
        { ffmpeg, ffprobe, name: `NTSC long GOP ${segmentType}`, fps: rate, duration: 28, segmentType });
      await app.evaluate((_electron, fixture) => { globalThis.__precisePlaylist = fixture.playlist; globalThis.__precisePlaylistFile = fixture.file; }, { playlist: playlistUrl(next), file: next.playlist });
      for (const [start, end] of [[0, 1.013], [4.513, 8.527], [21.513, 24.527]]) {
        const id = String(3333330 + outputs.length);
        await win.evaluate(() => { window.__trimPlayerBuffers = []; });
        await win.evaluate(({ id }) => window.openClipDialog(`https://www.twitch.tv/videos/${id}`,
          `Precise ${id}`, '2026-11-11T12:00:00Z', 'fixture', '28s'), { id });
        await win.waitForFunction(() => document.querySelector('#clipPlayer video.active')?.readyState >= 2);
        await win.evaluate(() => document.querySelector('#clipPlayer video.active').pause());
        next = await capturePlayerReference(win, next, { ffmpeg, ffprobe });
        // These fractional bounds go through the same manual time entries and
        // Add to queue dialog as a user, not a direct synthetic queue insertion.
        const clock = seconds => `00:00:${seconds.toFixed(3).padStart(6, '0')}`;
        await win.locator('#clipStartTime').fill(clock(start));
        await win.locator('#clipEndTime').fill(clock(end));
        if (await win.locator('#clipDetailsToggle').getAttribute('aria-expanded') === 'false') await win.locator('#clipDetailsToggle').click();
        if (await win.locator('#clipFilenameOptions').getAttribute('open') === null) await win.locator('#clipFilenameOptions summary').click();
        await win.locator('input[name="filenameFormat"][value="template"]').check();
        await win.locator('#clipFilenameTemplate').fill(`Precise-${id}.mp4`);
        await win.locator('#clipDialogConfirmBtn').click();
        await quality.locator('input[value="source"]').check();
        await quality.getByRole('button', { name: 'Add to queue', exact: true }).click();
        const pending = (await win.evaluate(() => window.api.getQueue())).find(row => row.url.endsWith(id));
        assert(pending, 'Manual trim did not add its queue entry');
        assert.equal(pending.customClip.startSec, start);
        assert(Math.abs(pending.customClip.durationSec - (end - start)) < .000001);
        await win.locator('#btnStart').click();
        let item;
        await waitFor(async () => {
          item = (await win.evaluate(() => window.api.getQueue())).find(row => row.url.endsWith(id));
          assert(item, 'Queued trim disappeared');
          assert.notEqual(item.status, 'error', item.last_error);
          return item.status === 'completed';
        });
        assert.equal(item.outputFiles.length, 1);
        outputs.push(item.outputFiles[0]);
        checks.push(await assertPreciseRange(item.outputFiles[0], next, [{ start, end }], { ffmpeg, ffprobe }));
        console.log(JSON.stringify({ precisePlayerRange: { fps: next.fps, segmentType: next.segmentType, start, end, ...checks.at(-1) } }));
      }
    }
    await win.reload();
    await win.waitForFunction(() => Boolean(window.api));
    const restored = await win.evaluate(() => window.api.getQueue());
    assert.equal(restored.length, outputs.length);
    assert.equal(restored[0].status, 'completed');
    assert.deepEqual(restored.flatMap(item => item.outputFiles).sort(), [...outputs].sort());
    assert(restored.every(item => item.status === 'completed'));
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ success: true, markers: true, invalidRange: true, filenameAndCollapse: true,
      qualityRetryAndCancel: true, queue: true, download: true, audioVideoDecode: true,
      actualHlsPlayerReference: true, originalSourceAudio: true, preciseRanges: checks, persistedCompletion: true }));
  } catch (error) {
    const debugLog = path.join(environment.appDataDir, 'debug.log');
    if (fs.existsSync(debugLog)) console.error('Isolated trim diagnostics:', fs.readFileSync(debugLog, 'utf8').slice(-6000));
    throw error;
  } finally {
    if (app) await app.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    cleanupE2eEnvironment(environment);
  }
}
module.exports = { run, createTemporalFixture, assertPreciseRange, assertTemporalFrames, headlessSourceAudio };
if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = argv[0]?.startsWith('--') ? argv.shift() : null;
  const [ffmpeg, ffprobe] = argv;
  if (argv.length > 2 || argv.some(arg => arg.startsWith('--')) || ![null, '--oracle-self-test', '--headless-source-audio'].includes(mode)) {
    throw new Error('Usage: smoke-test-precise-trim.js [--oracle-self-test | --headless-source-audio] [ffmpeg ffprobe]');
  }
  const command = mode === '--oracle-self-test' ? selfTest : mode === '--headless-source-audio' ? headlessSourceAudio : run;
  command({ ffmpeg, ffprobe }).catch(error => { console.error(error); process.exitCode = 1; });
}
