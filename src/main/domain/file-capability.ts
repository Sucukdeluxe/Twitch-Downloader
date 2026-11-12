import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export type FileCapabilityPurpose =
    | 'cutter-input'
    | 'cutter-output'
    | 'merge-input'
    | 'merge-output'
    | 'chat-input'
    | 'config-import'
    | 'config-export'
    | 'runtime-export'
    | 'queue-output'
    | 'selected-folder'
    | 'open-file'
    | 'show-in-folder';

export type FileCapabilityKind = 'input-file' | 'output-file' | 'directory';

export const CUTTER_SESSION_CAPABILITY_TTL_MS = 8 * 60 * 60 * 1000;

export interface FileCapabilityReference {
    token: string;
    name: string;
}

interface FileIdentity {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
}

interface FileCapabilityGrant {
    ownerId: number;
    purpose: FileCapabilityPurpose;
    path: string;
    kind: FileCapabilityKind;
    extensions: Set<string>;
    expiresAt: number;
    identity: FileIdentity | null;
}

interface IssueFileCapabilityOptions {
    ownerId: number;
    purpose: FileCapabilityPurpose;
    path: string;
    kind: FileCapabilityKind;
    extensions?: string[];
    ttlMs?: number;
}

interface FileCapabilityStoreOptions {
    now?: () => number;
    defaultTtlMs?: number;
}

function normalizeExtension(extension: string): string {
    const normalized = extension.trim().toLowerCase();
    return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function comparablePath(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLocaleLowerCase('en-US') : filePath;
}

function canonicalInputPath(filePath: string, kind: FileCapabilityKind): string {
    if (typeof filePath !== 'string' || !filePath || !isAbsolute(filePath)) throw new Error('File path must be absolute');
    if (!existsSync(filePath)) throw new Error(kind === 'directory' ? 'Directory does not exist' : 'Input file does not exist');
    const canonical = realpathSync.native(resolve(filePath));
    const stats = statSync(canonical);
    if (kind === 'directory' && !stats.isDirectory()) throw new Error('Capability path is not a directory');
    if (kind === 'input-file' && !stats.isFile()) throw new Error('Capability path is not a file');
    return canonical;
}

function canonicalOutputPath(filePath: string): string {
    if (typeof filePath !== 'string' || !filePath || !isAbsolute(filePath)) throw new Error('File path must be absolute');
    const resolved = resolve(filePath);
    const parent = dirname(resolved);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('Output directory does not exist');
    if (existsSync(resolved) && !statSync(resolved).isFile()) throw new Error('Output target is not a file');
    return join(realpathSync.native(parent), basename(resolved));
}

function validateExtension(filePath: string, extensions: Set<string>): void {
    const lowerPath = filePath.toLowerCase();
    if (extensions.size > 0 && !Array.from(extensions).some((extension) => lowerPath.endsWith(extension))) throw new Error('File extension is not allowed');
}

function getIdentity(filePath: string): FileIdentity {
    const stats = statSync(filePath);
    return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
    if (left.dev !== right.dev || left.size !== right.size || left.mtimeMs !== right.mtimeMs) return false;
    return left.ino === 0 || right.ino === 0 || left.ino === right.ino;
}

export function isTrustedFileIpcSender(expectedOwnerId: number, expectedUrl: string, actualOwnerId: number, actualUrl: string): boolean {
    if (actualOwnerId !== expectedOwnerId || typeof actualUrl !== 'string') return false;
    return actualUrl.split(/[?#]/, 1)[0] === expectedUrl;
}

export class FileCapabilityStore {
    private readonly grants = new Map<string, FileCapabilityGrant>();
    private readonly now: () => number;
    private readonly defaultTtlMs: number;

    constructor(options: FileCapabilityStoreOptions = {}) {
        this.now = options.now ?? Date.now;
        this.defaultTtlMs = options.defaultTtlMs ?? 15 * 60 * 1000;
    }

    issue(options: IssueFileCapabilityOptions): FileCapabilityReference {
        const extensions = new Set((options.extensions ?? []).map(normalizeExtension));
        const canonical = options.kind === 'output-file'
            ? canonicalOutputPath(options.path)
            : canonicalInputPath(options.path, options.kind);
        validateExtension(canonical, extensions);
        const ttlMs = options.ttlMs ?? this.defaultTtlMs;
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('File capability lifetime is invalid');
        const token = randomBytes(32).toString('base64url');
        this.grants.set(token, {
            ownerId: options.ownerId,
            purpose: options.purpose,
            path: canonical,
            kind: options.kind,
            extensions,
            expiresAt: this.now() + ttlMs,
            identity: options.kind === 'input-file' ? getIdentity(canonical) : null,
        });
        return { token, name: basename(canonical) };
    }

    resolve(token: string, ownerId: number, purpose: FileCapabilityPurpose): string {
        return this.resolveGrant(token, ownerId, purpose, false);
    }

    consume(token: string, ownerId: number, purpose: FileCapabilityPurpose, protectedPaths: string[] = []): string {
        const resolved = this.resolveGrant(token, ownerId, purpose, false);
        for (const protectedPath of protectedPaths) {
            const canonicalProtected = existsSync(protectedPath)
                ? realpathSync.native(resolve(protectedPath))
                : canonicalOutputPath(protectedPath);
            const samePath = comparablePath(resolved) === comparablePath(canonicalProtected);
            const sameFile = existsSync(resolved)
                && existsSync(canonicalProtected)
                && identitiesMatch(getIdentity(resolved), getIdentity(canonicalProtected));
            if (samePath || sameFile) throw new Error('Output path conflicts with a protected input');
        }
        this.grants.delete(token);
        return resolved;
    }

    revoke(token: string): void {
        this.grants.delete(token);
    }

    private resolveGrant(token: string, ownerId: number, purpose: FileCapabilityPurpose, consume: boolean): string {
        if (typeof token !== 'string' || !token) throw new Error('Invalid file capability');
        const grant = this.grants.get(token);
        if (!grant) throw new Error('Invalid file capability');
        if (grant.ownerId !== ownerId) throw new Error('Invalid file capability owner');
        if (grant.purpose !== purpose) throw new Error('Invalid file capability purpose');
        if (this.now() >= grant.expiresAt) {
            this.grants.delete(token);
            throw new Error('Expired file capability');
        }
        const currentPath = grant.kind === 'output-file'
            ? canonicalOutputPath(grant.path)
            : canonicalInputPath(grant.path, grant.kind);
        validateExtension(currentPath, grant.extensions);
        if (comparablePath(currentPath) !== comparablePath(grant.path)) throw new Error('File capability path changed');
        if (grant.identity && !identitiesMatch(grant.identity, getIdentity(currentPath))) throw new Error('File capability path changed');
        if (consume) this.grants.delete(token);
        return currentPath;
    }
}

export async function publishCapabilityOutput(outputPath: string, produce: (partialPath: string) => Promise<boolean>): Promise<boolean> {
    const canonicalOutput = canonicalOutputPath(outputPath);
    const extension = extname(canonicalOutput);
    const stem = basename(canonicalOutput, extension);
    const partialPath = join(dirname(canonicalOutput), `.${stem}.${process.pid}.${randomBytes(8).toString('hex')}.partial${extension}`);
    const backupPath = `${canonicalOutput}.${process.pid}.${randomBytes(8).toString('hex')}.backup`;
    let backupCreated = false;
    try {
        const produced = await produce(partialPath);
        if (!produced || !existsSync(partialPath) || !statSync(partialPath).isFile()) return false;
        if (existsSync(canonicalOutput)) {
            renameSync(canonicalOutput, backupPath);
            backupCreated = true;
        }
        try {
            renameSync(partialPath, canonicalOutput);
        } catch (error) {
            if (backupCreated && !existsSync(canonicalOutput)) renameSync(backupPath, canonicalOutput);
            throw error;
        }
        if (backupCreated) rmSync(backupPath, { force: true });
        return true;
    } finally {
        rmSync(partialPath, { force: true });
        if (backupCreated && existsSync(backupPath) && !existsSync(canonicalOutput)) renameSync(backupPath, canonicalOutput);
    }
}
