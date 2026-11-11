import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../infra/fs-atomic';
import type { CutterExportEncoder, CutterExportProfile } from './cutter-export';

export interface CutterProjectSource {
    path: string;
    size: number;
    mtimeMs: number;
}

export interface CutterProject {
    source: CutterProjectSource;
    duration: number;
    fps: number;
    trimStart: number;
    trimEnd: number;
    cuts: Array<{ id: string; start: number; end: number }>;
    profile: CutterExportProfile;
    encoder: CutterExportEncoder;
    audioStreamIndex: number;
}

interface CutterProjectDocument {
    version: 1;
    projects: CutterProject[];
}

function cloneProject(project: CutterProject): CutterProject {
    return {
        ...project,
        source: { ...project.source },
        cuts: project.cuts.map((cut) => ({ ...cut })),
    };
}

function sourceKey(source: CutterProjectSource): string {
    return `${source.path}\u0000${source.size}\u0000${source.mtimeMs}`;
}

function isProjectSource(value: unknown): value is CutterProjectSource {
    if (!value || typeof value !== 'object') return false;
    const source = value as Record<string, unknown>;
    return typeof source.path === 'string'
        && source.path.length > 0
        && typeof source.size === 'number'
        && Number.isFinite(source.size)
        && source.size >= 0
        && typeof source.mtimeMs === 'number'
        && Number.isFinite(source.mtimeMs)
        && source.mtimeMs >= 0;
}

function isProject(value: unknown): value is CutterProject {
    if (!value || typeof value !== 'object') return false;
    const project = value as Record<string, unknown>;
    return isProjectSource(project.source)
        && typeof project.duration === 'number'
        && Number.isFinite(project.duration)
        && project.duration > 0
        && typeof project.fps === 'number'
        && Number.isFinite(project.fps)
        && project.fps > 0
        && typeof project.trimStart === 'number'
        && Number.isFinite(project.trimStart)
        && typeof project.trimEnd === 'number'
        && Number.isFinite(project.trimEnd)
        && Array.isArray(project.cuts)
        && project.cuts.every((cut) => cut && typeof cut === 'object'
            && typeof (cut as Record<string, unknown>).id === 'string'
            && typeof (cut as Record<string, unknown>).start === 'number'
            && Number.isFinite((cut as Record<string, unknown>).start)
            && typeof (cut as Record<string, unknown>).end === 'number'
            && Number.isFinite((cut as Record<string, unknown>).end))
        && (project.profile === 'quality' || project.profile === 'balanced' || project.profile === 'fast' || project.profile === 'archive')
        && (project.encoder === 'software' || project.encoder === 'h264_nvenc' || project.encoder === 'h264_qsv' || project.encoder === 'h264_amf' || project.encoder === 'h264_videotoolbox')
        && typeof project.audioStreamIndex === 'number'
        && Number.isInteger(project.audioStreamIndex)
        && project.audioStreamIndex >= 0;
}

function readDocument(filePath: string): CutterProjectDocument {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return { version: 1, projects: [] };
        return { version: 1, projects: parsed.projects.filter(isProject).map(cloneProject) };
    } catch {
        return { version: 1, projects: [] };
    }
}

export interface CutterProjectAutosaveStore {
    find(source: CutterProjectSource): CutterProject | null;
    save(project: CutterProject): void;
    discard(source: CutterProjectSource): boolean;
}

export function createCutterProjectAutosaveStore(filePath: string): CutterProjectAutosaveStore {
    const write = (document: CutterProjectDocument): void => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileAtomicSync(filePath, JSON.stringify(document));
    };

    return {
        find(source) {
            const project = readDocument(filePath).projects.find((entry) => sourceKey(entry.source) === sourceKey(source));
            return project ? cloneProject(project) : null;
        },
        save(project) {
            if (!isProject(project)) throw new Error('Invalid cutter project');
            const document = readDocument(filePath);
            const key = sourceKey(project.source);
            const projects = document.projects.filter((entry) => sourceKey(entry.source) !== key);
            projects.push(cloneProject(project));
            write({ version: 1, projects });
        },
        discard(source) {
            const document = readDocument(filePath);
            const key = sourceKey(source);
            const projects = document.projects.filter((entry) => sourceKey(entry.source) !== key);
            if (projects.length === document.projects.length) return false;
            write({ version: 1, projects });
            return true;
        },
    };
}
