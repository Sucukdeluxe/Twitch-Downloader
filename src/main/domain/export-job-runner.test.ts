import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExportJobRunner } from './export-job-runner';
import type { ExportJobRequest } from './export-job-queue';

const commands = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async () => {
    const { promisify } = await import('node:util');
    Object.defineProperty(commands.execFile, promisify.custom, {
        value: (...args: unknown[]) => new Promise((resolve, reject) => {
            commands.execFile(...args, (error: Error | null, stdout: string, stderr: string) => {
                if (error) reject(error); else resolve({ stdout, stderr });
            });
        }),
    });
    return commands;
});

let directory: string;
let request: ExportJobRequest;
let controller: AbortController;
let failSoftware: boolean;
let cancelHardware: boolean;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-export-mac-'));
    const sourcePath = path.join(directory, 'source.mp4');
    fs.writeFileSync(sourcePath, 'unchanged source');
    const stat = fs.statSync(sourcePath);
    request = {
        kind: 'cut', outputPath: path.join(directory, 'export.mp4'),
        project: {
            source: { path: sourcePath, size: stat.size, mtimeMs: stat.mtimeMs },
            duration: 10, fps: 30, trimStart: 0, trimEnd: 10, cuts: [],
            profile: 'balanced', encoder: 'h264_videotoolbox', audioStreamIndex: 0,
        },
    };
    controller = new AbortController();
    failSoftware = false;
    cancelHardware = false;
    commands.execFile.mockImplementation((_command, _args, _options, callback) => {
        callback(null, JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 180, pix_fmt: 'yuv420p', avg_frame_rate: '30/1' }],
            format: { duration: '10', start_time: '0' },
        }), '');
    });
    commands.spawn.mockImplementation((_command: string, args: string[]) => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
        });
        const encoder = args[args.indexOf('-c:v') + 1];
        queueMicrotask(() => {
            const failed = encoder === 'h264_videotoolbox' || failSoftware;
            fs.writeFileSync(args[args.length - 1], Buffer.alloc(failed ? 128 : 512, 7));
            if (encoder === 'h264_videotoolbox' && cancelHardware) controller.abort();
            if (failed) child.stderr.end('encoder unavailable');
            else child.stdout.end('out_time_us=10000000\n');
            child.emit('close', failed ? 1 : 0);
        });
        return child;
    });
});

afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function runner() {
    return createExportJobRunner({
        resolveTools: async () => ({ ffmpeg: 'mock-ffmpeg', ffprobe: 'mock-ffprobe' }),
        availableHardwareEncoders: async () => ['h264_videotoolbox'],
    });
}

function attemptedEncoders(): string[] {
    return commands.spawn.mock.calls.map(([, args]: [string, string[]]) => args[args.indexOf('-c:v') + 1]);
}

describe('queued VideoToolbox exports', () => {
    it('retries a failed hardware export in software, verifies it, and publishes the result', async () => {
        const onProgress = vi.fn();
        const result = await runner()(request, { signal: controller.signal, onProgress });

        expect(attemptedEncoders()).toEqual(['h264_videotoolbox', 'libx264']);
        expect(commands.execFile).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenCalledWith(100);
        expect(result.outputFiles).toEqual([request.outputPath]);
        expect(fs.statSync(request.outputPath).size).toBe(512);
        expect(fs.readdirSync(directory).sort()).toEqual(['export.mp4', 'source.mp4']);
        expect(fs.readFileSync(path.join(directory, 'source.mp4'), 'utf8')).toBe('unchanged source');
    });

    it('does not retry or publish an export after cancellation', async () => {
        cancelHardware = true;
        await expect(runner()(request, { signal: controller.signal, onProgress: vi.fn() })).rejects.toThrow('Export cancelled');
        expect(attemptedEncoders()).toEqual(['h264_videotoolbox']);
        expect(fs.readdirSync(directory)).toEqual(['source.mp4']);
    });

    it('removes partial output when the software retry also fails', async () => {
        failSoftware = true;
        await expect(runner()(request, { signal: controller.signal, onProgress: vi.fn() })).rejects.toThrow('encoder unavailable');
        expect(attemptedEncoders()).toEqual(['h264_videotoolbox', 'libx264']);
        expect(fs.readdirSync(directory)).toEqual(['source.mp4']);
    });
});
