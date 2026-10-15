import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCutterWaveformAccumulator } from './cutter-waveform';
import { createAudioTimelineFilter } from './audio-processing';
import { cutterVideoFormat, type VideoSourceFormat } from './media-format';

export interface MergeMediaInfo {
    duration: number; width: number; height: number; fps: number; startTime: number;
    hasAudio: boolean; videoCodec: string; audioCodec: string | null; previewCompatible: boolean;
    audioStreams: Array<{ channels: number }>;
    sourceFormat?: VideoSourceFormat;
}
export interface MergeMediaSource { path: string; size: number; mtimeMs: number }
interface Entry { info: Promise<MergeMediaInfo | null>; preview?: Promise<string | null>; thumbnails?: Promise<string[]>; waveform?: Promise<number[][] | null> }
export class MergeMediaService {
    private entries = new Map<string, Entry>();
    private processes = new Set<ChildProcess>();
    private directories = new Set<string>();
    private pending: Array<() => void> = [];
    private active = 0;
    private disposed = false;
    constructor(private dependencies: { temp: string; ffmpeg(): Promise<string>; info(file: string): Promise<MergeMediaInfo | null>; record(command: string): void }) {}
    private key(source: MergeMediaSource): string { return JSON.stringify([source.path, source.size, source.mtimeMs]); }
    private entry(source: MergeMediaSource): Entry {
        const key = this.key(source);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { info: this.dependencies.info(source.path) };
            this.entries.set(key, entry);
            if (this.entries.size > 24) this.entries.delete(this.entries.keys().next().value!);
        }
        return entry;
    }
    describe(source: MergeMediaSource): Promise<MergeMediaInfo | null> { return this.entry(source).info; }
    private async limited<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active >= 2) await new Promise<void>(resolve => this.pending.push(resolve));
        if (this.disposed) throw new Error('Media service closed');
        this.active++;
        try { return await operation(); } finally { this.active--; this.pending.shift()?.(); }
    }
    private async directory(): Promise<string> {
        const directory = await fs.mkdtemp(path.join(this.dependencies.temp, 'tvm-merge-media-'));
        this.directories.add(directory);
        return directory;
    }
    private async run(args: string[], onData?: (data: string) => void): Promise<boolean> {
        if (this.disposed) return false;
        const executable = await this.dependencies.ffmpeg();
        if (this.disposed) return false;
        this.dependencies.record(executable);
        return new Promise(resolve => {
            const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { windowsHide: true });
            this.processes.add(child);
            child.stderr?.resume();
            if (onData) child.stdout?.on('data', (chunk: Buffer) => onData(chunk.toString()));
            else child.stdout?.resume();
            let done = false;
            const finish = (success: boolean) => {
                if (done) return;
                done = true; clearTimeout(timeout); this.processes.delete(child); resolve(success && !this.disposed);
            };
            const timeout = setTimeout(() => { child.kill(); finish(false); }, 180000);
            child.once('error', () => finish(false)); child.once('close', code => finish(code === 0));
        });
    }
    async preview(source: MergeMediaSource): Promise<string | null> {
        const entry = this.entry(source);
        const info = await entry.info;
        if (!info) return null;
        if (info.previewCompatible) return pathToFileURL(source.path).href;
        if (!entry.preview) entry.preview = this.limited(async () => {
            const directory = await this.directory(), output = path.join(directory, 'preview.mp4');
            const color = info.sourceFormat ? cutterVideoFormat(info.sourceFormat, false, 'sdr') : { filters: [], args: [] };
            const filter = [...color.filters, 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2'].join(',');
            const success = await this.run(['-threads', '2', '-i', source.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', ...color.args, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', output]);
            if (success) return pathToFileURL(output).href;
            await fs.rm(directory, { recursive: true, force: true }); this.directories.delete(directory);
            return null;
        }).catch(() => null);
        const result = await entry.preview;
        if (!result) entry.preview = undefined;
        return result;
    }
    async thumbnails(source: MergeMediaSource): Promise<string[]> {
        const entry = this.entry(source);
        if (!entry.thumbnails) entry.thumbnails = this.limited(async () => {
            const info = await entry.info;
            if (!info || info.duration <= 0) return [];
            const directory = await this.directory();
            try {
                const images: string[] = [];
                const color = info.sourceFormat?.hdr ? cutterVideoFormat(info.sourceFormat, false, 'sdr').filters : [];
                const filter = [...color, 'scale=192:108:force_original_aspect_ratio=increase,crop=192:108'].join(',');
                for (let index = 0; index < 8; index++) {
                    const output = path.join(directory, index + '.jpg');
                    const success = await this.run(['-threads', '1', '-ss', String((index + .5) / 8 * info.duration), '-i', source.path, '-frames:v', '1', '-an', '-vf', filter, '-q:v', '5', '-y', output]);
                    if (success) images.push('data:image/jpeg;base64,' + (await fs.readFile(output)).toString('base64'));
                }
                return images;
            } finally { await fs.rm(directory, { recursive: true, force: true }); this.directories.delete(directory); }
        }).catch(() => []);
        return entry.thumbnails;
    }
    async waveform(source: MergeMediaSource): Promise<number[][] | null> {
        const entry = this.entry(source);
        if (!entry.waveform) entry.waveform = this.limited(async () => {
            const info = await entry.info;
            if (!info || !info.hasAudio) return null;
            const channels = Math.min(2, Math.max(1, info.audioStreams[0]?.channels || 1));
            const accumulator = createCutterWaveformAccumulator(info.duration, channels);
            const success = await this.run(['-threads', '2', '-copyts', '-itsoffset', String(-info.startTime), '-i', source.path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', String(channels), '-filter_threads', '1', '-af', createAudioTimelineFilter(48000) + ',asetnsamples=n=' + accumulator.samplesPerBin + ':p=0,astats=metadata=1:reset=1:measure_perchannel=Peak_level:measure_overall=none,ametadata=mode=print:file=-', '-f', 'null', '-'], chunk => accumulator.push(chunk));
            accumulator.finish();
            return success && accumulator.completedBins ? accumulator.peaks.map(channel => Array.from(channel)) : null;
        }).catch(() => null);
        return entry.waveform;
    }
    async dispose(): Promise<void> {
        this.disposed = true;
        const exits = [...this.processes].map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill(); setTimeout(resolve, 2000); }));
        this.pending.splice(0).forEach(resolve => resolve());
        await Promise.all(exits);
        await Promise.all([...this.directories].map(directory => fs.rm(directory, { recursive: true, force: true }).catch(() => {})));
        this.directories.clear(); this.entries.clear();
    }
}
