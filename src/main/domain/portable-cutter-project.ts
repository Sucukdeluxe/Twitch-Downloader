import { normalizeAudioProcessing } from './audio-processing';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CutterProject, CutterProjectSource } from './cutter-project';
import { createSerialExecutor, readJsonDocument, writeJsonDocument } from './durable-json-store';

export type PortableCutterEdit = CutterProject & { allAudioStreams?: boolean; colorMode?: 'source' | 'sdr' };
export interface PortableCutterProject {
    format: 'twitch-vod-manager/cutter-project';
    version: 1;
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    source: { name: string; relativePath: string; originalPath?: string; size: number; sha256: string };
    edit: Omit<PortableCutterEdit, 'source'>;
}
export interface RecentCutterProject {
    id: string;
    name: string;
    filePath: string;
    sourceName: string;
    updatedAt: number;
    openedAt: number;
}
export interface OpenedCutterProject {
    document: PortableCutterProject;
    project: PortableCutterEdit | null;
    sourceStatus: 'ready' | 'missing' | 'changed';
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid project document');
    return value as Record<string, unknown>;
}
function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
function text(value: unknown, max = 4096): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}
export function validatePortableCutterEdit(value: unknown): PortableCutterEdit {
    const edit = record(value);
    const source = record(edit.source);
    if (!text(source.path) || !path.isAbsolute(source.path) || !finite(source.size) || !Number.isSafeInteger(source.size) || source.size < 0
        || !finite(source.mtimeMs) || source.mtimeMs < 0 || !finite(edit.duration) || edit.duration <= 0
        || !finite(edit.fps) || edit.fps <= 0 || edit.fps > 1000 || !finite(edit.trimStart) || !finite(edit.trimEnd)
        || edit.trimStart < 0 || edit.trimEnd <= edit.trimStart || edit.trimEnd > edit.duration
        || !Array.isArray(edit.cuts) || edit.cuts.length > 64
        || !['quality', 'balanced', 'fast', 'archive'].includes(String(edit.profile))
        || !['software', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].includes(String(edit.encoder))
        || !Number.isInteger(edit.audioStreamIndex) || (edit.audioStreamIndex as number) < 0
        || (edit.allAudioStreams !== undefined && typeof edit.allAudioStreams !== 'boolean')
        || (edit.colorMode !== undefined && edit.colorMode !== 'source' && edit.colorMode !== 'sdr')) throw new Error('Invalid cutter edit');
    const ids = new Set<string>();
    const cuts = edit.cuts.map((value) => {
        const cut = record(value);
        if (!text(cut.id, 128) || ids.has(cut.id) || !finite(cut.start) || !finite(cut.end)
            || cut.start < (edit.trimStart as number) || cut.end > (edit.trimEnd as number) || cut.end <= cut.start) throw new Error('Invalid cutter exclusion');
        ids.add(cut.id);
        return { id: cut.id, start: cut.start, end: cut.end };
    }).sort((a, b) => a.start - b.start);
    for (let index = 1; index < cuts.length; index++) {
        if (cuts[index].start < cuts[index - 1].end) throw new Error('Overlapping cutter exclusions');
    }
    if (cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) >= edit.trimEnd - edit.trimStart) throw new Error('Cutter edit has no playable frames');
    return {
        source: { path: source.path, size: source.size, mtimeMs: source.mtimeMs }, duration: edit.duration,
        fps: edit.fps, trimStart: edit.trimStart, trimEnd: edit.trimEnd, cuts,
        profile: edit.profile as PortableCutterEdit['profile'], encoder: edit.encoder as PortableCutterEdit['encoder'],
        audioStreamIndex: edit.audioStreamIndex as number, allAudioStreams: edit.allAudioStreams as boolean | undefined,
        colorMode: edit.colorMode as PortableCutterEdit['colorMode'],
        ...(edit.audioProcessing === undefined ? {} : { audioProcessing: normalizeAudioProcessing(edit.audioProcessing, edit.trimEnd - edit.trimStart - cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0)) }),
    };
}

function portableSettings(project: PortableCutterEdit): Omit<PortableCutterEdit, 'source'> {
    return { duration: project.duration, fps: project.fps, trimStart: project.trimStart, trimEnd: project.trimEnd,
        cuts: project.cuts, profile: project.profile, encoder: project.encoder, audioStreamIndex: project.audioStreamIndex,
        allAudioStreams: project.allAudioStreams, colorMode: project.colorMode,
        ...(project.audioProcessing ? { audioProcessing: { ...project.audioProcessing } } : {}) };
}

export function parsePortableCutterProject(value: unknown): PortableCutterProject {
    const document = record(value);
    const source = record(document.source);
    if (document.format !== 'twitch-vod-manager/cutter-project' || document.version !== 1
        || !text(document.id, 128) || !text(document.name, 120) || !document.name.trim()
        || !finite(document.createdAt) || document.createdAt < 0 || !finite(document.updatedAt) || document.updatedAt < document.createdAt
        || !text(source.name, 255) || path.basename(source.name) !== source.name || !text(source.relativePath)
        || path.isAbsolute(source.relativePath) || /^[a-z]:/i.test(source.relativePath)
        || (source.originalPath !== undefined && (!text(source.originalPath) || !path.isAbsolute(source.originalPath)))
        || !finite(source.size) || source.size < 0 || !Number.isSafeInteger(source.size)
        || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Invalid portable cutter project');
    const edit = portableSettings(validatePortableCutterEdit({ ...record(document.edit), source: { path: path.resolve(source.name), size: source.size, mtimeMs: 0 } }));
    return {
        format: 'twitch-vod-manager/cutter-project', version: 1, id: document.id, name: document.name.trim(),
        createdAt: document.createdAt, updatedAt: document.updatedAt,
        source: { name: source.name, relativePath: source.relativePath, ...(source.originalPath ? { originalPath: String(source.originalPath) } : {}), size: source.size, sha256: source.sha256 }, edit,
    };
}

export async function fingerprintCutterSource(filePath: string): Promise<CutterProjectSource & { sha256: string }> {
    const before = await fs.stat(filePath);
    if (!before.isFile()) throw new Error('Project source is not a file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    const after = await fs.stat(filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Project source changed while reading');
    return { path: path.resolve(filePath), size: after.size, mtimeMs: after.mtimeMs, sha256: hash.digest('hex') };
}

export function portableSourceReference(projectPath: string, sourcePath: string): { relativePath: string; originalPath: string } {
    const relative = path.relative(path.dirname(path.resolve(projectPath)), path.resolve(sourcePath));
    return { relativePath: (path.isAbsolute(relative) ? path.basename(sourcePath) : relative).split(path.sep).join('/'), originalPath: path.resolve(sourcePath) };
}

export async function savePortableCutterProject(filePath: string, name: string, edit: PortableCutterEdit, previous?: PortableCutterProject): Promise<PortableCutterProject> {
    const validated = validatePortableCutterEdit(edit);
    if (path.resolve(filePath).toLowerCase() === path.resolve(validated.source.path).toLowerCase()) throw new Error('Project cannot overwrite its source');
    const source = await fingerprintCutterSource(validated.source.path);
    if (source.size !== validated.source.size || source.mtimeMs !== validated.source.mtimeMs) throw new Error('Project source changed');
    const now = Date.now();
    const settings = portableSettings(validated);
    const old = previous ? parsePortableCutterProject(previous) : undefined;
    const document = parsePortableCutterProject({
        format: 'twitch-vod-manager/cutter-project', version: 1, id: old?.id ?? randomUUID(), name,
        createdAt: old?.createdAt ?? now, updatedAt: Math.max(now, old?.createdAt ?? now),
        source: { name: path.basename(source.path), ...portableSourceReference(filePath, source.path), size: source.size, sha256: source.sha256 }, edit: settings,
    });
    await writeJsonDocument(filePath, document);
    return document;
}

export async function openPortableCutterProject(filePath: string, replacementSource?: string): Promise<OpenedCutterProject> {
    const document = parsePortableCutterProject(await readJsonDocument(filePath, 1024 * 1024));
    const candidates = replacementSource ? [path.resolve(replacementSource)] : [...new Set([
        path.resolve(path.dirname(filePath), document.source.relativePath), path.resolve(path.dirname(filePath), document.source.name), ...(document.source.originalPath ? [document.source.originalPath] : []),
    ])];
    let sourceStatus: OpenedCutterProject['sourceStatus'] = 'missing';
    for (const candidate of candidates) {
        try {
            const stat = await fs.stat(candidate);
            sourceStatus = 'changed';
            if (!stat.isFile() || stat.size !== document.source.size) continue;
            const source = await fingerprintCutterSource(candidate);
            if (source.sha256 !== document.source.sha256) continue;
            return { document, project: { ...document.edit, source: { path: source.path, size: source.size, mtimeMs: source.mtimeMs } }, sourceStatus: 'ready' };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    return { document, project: null, sourceStatus };
}

export async function relinkPortableCutterProject(filePath: string, replacementSource: string): Promise<OpenedCutterProject> {
    const opened = await openPortableCutterProject(filePath, replacementSource);
    if (!opened.project) throw new Error('Replacement source does not match the saved project');
    const document = await savePortableCutterProject(filePath, opened.document.name, opened.project, opened.document);
    return { ...opened, document };
}

export function parseRecentCutterProjects(raw: unknown): RecentCutterProject[] {
    if (raw === undefined) return [];
    const document = record(raw);
    if (document.version !== 1 || !Array.isArray(document.projects) || document.projects.length > 50) throw new Error('Invalid recent projects');
    return document.projects.map((value) => {
        const entry = record(value);
        if (!text(entry.id, 128) || !text(entry.name, 120) || !text(entry.filePath) || !path.isAbsolute(entry.filePath)
            || !text(entry.sourceName, 255) || !finite(entry.updatedAt) || !finite(entry.openedAt)) throw new Error('Invalid recent project');
        return { id: entry.id, name: entry.name, filePath: entry.filePath, sourceName: entry.sourceName, updatedAt: entry.updatedAt, openedAt: entry.openedAt };
    });
}

export function createRecentCutterProjectsStore(filePath: string) {
    const serial = createSerialExecutor();
    const pathKey = (value: string): string => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const read = async (): Promise<RecentCutterProject[]> => {
        return parseRecentCutterProjects(await readJsonDocument(filePath));
    };
    return {
        list: () => serial(read),
        flush: () => serial(async () => undefined),
        remember: (projectFilePath: string, project: PortableCutterProject) => serial(async () => {
            const validated = parsePortableCutterProject(project);
            const resolved = path.resolve(projectFilePath);
            const entries = (await read()).filter((entry) => pathKey(entry.filePath) !== pathKey(resolved));
            entries.unshift({ id: validated.id, name: validated.name, filePath: resolved, sourceName: validated.source.name, updatedAt: validated.updatedAt, openedAt: Date.now() });
            await writeJsonDocument(filePath, { version: 1, projects: entries.slice(0, 50) });
        }),
        remove: (projectFilePath: string) => serial(async () => {
            const resolved = pathKey(projectFilePath);
            await writeJsonDocument(filePath, { version: 1, projects: (await read()).filter((entry) => pathKey(entry.filePath) !== resolved) });
        }),
    };
}
