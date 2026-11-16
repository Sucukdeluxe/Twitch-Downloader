'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ffmpeg = process.argv[2] || process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.argv[3] || process.env.FFPROBE_PATH || 'ffprobe';
const { composeLossless } = require('../dist/main/mcp/lossless-compose.js');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

function fixture(directory, name, seconds, size, frequency, dropFrames = false) {
    const file = path.join(directory, name);
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
        '-t', String(seconds), ...(dropFrames ? ['-vf', "select='not(eq(mod(n,10),5))'", '-fps_mode', 'vfr'] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-shortest', file]);
    return file;
}

function probe(file) {
    return JSON.parse(run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
}

function decodedFrameHashes(file, count) {
    return run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-frames:v', String(count), '-fps_mode', 'passthrough', '-f', 'framemd5', '-'])
        .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
}

function compose(segments, outputPath, signal = new AbortController().signal) {
    const progress = [];
    return composeLossless({ segments, outputPath, ffmpegPath: ffmpeg, ffprobePath: ffprobe, signal, onProgress: value => progress.push(value), checkSpace: () => undefined }).then(result => ({ ...result, progress }));
}

function leftovers(directory) {
    return fs.readdirSync(directory).filter(name => name.startsWith('.mcp-compose-'));
}

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-downloader-mcp-compose-'));
    try {
        const a = fixture(directory, 'a.mp4', 12, '640x360', 440);
        const b = fixture(directory, 'b.mp4', 8, '640x360', 660);
        const other = fixture(directory, 'other.mp4', 4, '320x180', 440);
        const sourceVideo = probe(a).streams.find(stream => stream.codec_type === 'video');

        const joined = path.join(directory, 'joined.mp4');
        const result = await compose([{ path: a }, { path: b, start: 2, end: 6 }, { path: a, start: 5, end: 9 }], joined);
        const output = probe(joined);
        const outputVideo = output.streams.find(stream => stream.codec_type === 'video');
        assert.equal(result.outputPath, joined);
        assert.ok(Math.abs(Number(output.format.duration) - 20) < 2.5, `joined duration ${output.format.duration}`);
        assert.equal(outputVideo.codec_name, sourceVideo.codec_name);
        assert.equal(outputVideo.width, 640);
        assert.equal(output.streams.filter(stream => stream.codec_type === 'audio').length, 1);
        const sourceFrames = decodedFrameHashes(a, 300);
        assert.equal(sourceFrames.length, 300);
        assert.deepEqual(decodedFrameHashes(joined, 300), sourceFrames, 'the first source must decode to identical pictures');
        assert.equal(outputVideo.profile, sourceVideo.profile);
        assert.equal(outputVideo.pix_fmt, sourceVideo.pix_fmt);
        assert.ok(Math.abs(Number(outputVideo.bit_rate) - Number(sourceVideo.bit_rate)) / Number(sourceVideo.bit_rate) < 0.25, 'bitrate stays in the range of the sources');
        assert.equal(result.progress.at(-1), 100);
        assert.ok(result.progress.every((value, index, all) => index === 0 || value >= all[index - 1]), 'progress never decreases');
        run(ffmpeg, ['-v', 'error', '-xerror', '-i', joined, '-f', 'null', '-']);
        assert.deepEqual(leftovers(directory), []);

        const dropped = fixture(directory, 'dropped.mp4', 8, '640x360', 880, true);
        const droppedVideo = probe(dropped).streams.find(stream => stream.codec_type === 'video');
        const rate = value => { const [n, d = 1] = value.split('/').map(Number); return n / d; };
        assert.equal(droppedVideo.r_frame_rate, sourceVideo.r_frame_rate);
        assert.ok(Math.abs(rate(droppedVideo.avg_frame_rate) - rate(sourceVideo.avg_frame_rate)) > 1);
        const variableJoined = path.join(directory, 'variable-joined.mp4');
        await compose([{ path: a }, { path: dropped }], variableJoined);
        const variableProbe = probe(variableJoined);
        assert.ok(Math.abs(Number(variableProbe.format.duration) - 20) < 0.1);
        assert.deepEqual(decodedFrameHashes(variableJoined, 1000), [...decodedFrameHashes(a, 1000), ...decodedFrameHashes(dropped, 1000)], 'all source frames remain in order despite average FPS differences');
        run(ffmpeg, ['-v', 'error', '-xerror', '-i', variableJoined, '-f', 'null', '-']);

        const before = fs.statSync(joined);
        await assert.rejects(compose([{ path: a }, { path: b }], joined), /already exists/);
        assert.equal(fs.statSync(joined).size, before.size);
        assert.equal(fs.statSync(joined).mtimeMs, before.mtimeMs);

        await assert.rejects(compose([{ path: a }, { path: other }], path.join(directory, 'mixed.mp4')), /formats differ \(video width, video height/);
        await assert.rejects(compose([{ path: a }], path.join(directory, 'single.mp4')), /needs no processing/);
        await assert.rejects(compose([{ path: a }, { path: path.join(directory, 'missing.mp4') }], path.join(directory, 'missing-out.mp4')), /Source file not found/);
        await assert.rejects(compose([{ path: a }, { path: b }], a), /already exists/);

        const controller = new AbortController();
        const cancelled = compose([{ path: a, start: 1, end: 11 }, { path: b }], path.join(directory, 'cancelled.mp4'), controller.signal);
        controller.abort();
        await assert.rejects(cancelled);
        assert.equal(fs.existsSync(path.join(directory, 'cancelled.mp4')), false);
        assert.deepEqual(leftovers(directory), []);
        assert.deepEqual(fs.readdirSync(directory).sort(), ['a.mp4', 'b.mp4', 'dropped.mp4', 'joined.mp4', 'other.mp4', 'variable-joined.mp4']);
        console.log(`PASS MCP lossless compose: ${Number(output.format.duration).toFixed(2)} s joined from 3 segments without re-encoding; differing average FPS joined with every frame preserved; overwrite, format mismatch and cancellation rejected`);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
