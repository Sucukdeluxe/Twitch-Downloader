import { createPublicKey, verify } from 'node:crypto';

export const MAC_UPDATE_FEED = 'https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/latest/download/mac-update.json';
export const MAC_UPDATE_BUNDLE_ID = 'io.github.sucukdeluxe.twitch-vod-manager';
export const MAC_UPDATE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export type MacUpdateArch = 'arm64' | 'x64';
export interface MacUpdateArtifact { url: string; size: number; sha256: string }
export interface MacUpdateManifest {
    schema: 1;
    version: string;
    publishedAt: string;
    releaseNotes: string;
    artifacts: Record<MacUpdateArch, MacUpdateArtifact>;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update document');
    return value as Record<string, unknown>;
}

function base64(value: unknown, maxBytes: number): Buffer {
    if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error('Invalid update signature encoding');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || decoded.length > maxBytes) throw new Error('Invalid update signature encoding');
    return decoded;
}

export function isStableMacVersion(value: unknown): value is string {
    return typeof value === 'string' && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value);
}

export function compareMacVersions(a: string, b: string): number {
    if (!isStableMacVersion(a) || !isStableMacVersion(b)) throw new Error('Invalid stable update version');
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
}

/** Authenticate the original bytes before parsing or using any release fields. */
export function verifyMacUpdateManifest(input: Buffer | string, publicKey: string): MacUpdateManifest {
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('Update document is too large');
    const envelope = object(JSON.parse(input.toString()));
    const payload = base64(envelope.payload, 128 * 1024);
    const signature = base64(envelope.signature, 64);
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payload, key, signature)) {
        throw new Error('Update signature is invalid. Nothing was installed.');
    }
    const manifest = object(JSON.parse(payload.toString('utf8')));
    if (manifest.schema !== 1 || !isStableMacVersion(manifest.version)) throw new Error('Unsupported stable update version');
    if (typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error('Invalid release date');
    if (typeof manifest.releaseNotes !== 'string' || manifest.releaseNotes.length > 64 * 1024) throw new Error('Invalid release notes');
    const artifacts = object(manifest.artifacts);
    for (const arch of ['arm64', 'x64'] as const) {
        const artifact = object(artifacts[arch]);
        const expected = `https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v${manifest.version}/Twitch-VOD-Manager-${manifest.version}-mac-${arch}.zip`;
        if (artifact.url !== expected) throw new Error(`Invalid ${arch} update address`);
        if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) < 1 || (artifact.size as number) > MAC_UPDATE_MAX_BYTES) throw new Error('Invalid update size');
        if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('Invalid update checksum');
    }
    return manifest as unknown as MacUpdateManifest;
}

/** ZIP entry paths are checked before ditto can write anything. */
export function validateMacArchiveEntries(listing: string): void {
    const entries = listing.split('\n').filter(Boolean);
    if (entries.length < 1 || entries.length > 100000) throw new Error('Invalid update archive');
    for (const entry of entries) {
        if (entry.includes('\\') || [...entry].some((character) => character.charCodeAt(0) < 32) || entry.startsWith('/') || entry.split('/').includes('..')) throw new Error('Unsafe update archive path');
        if (entry !== 'Twitch VOD Manager.app/' && !entry.startsWith('Twitch VOD Manager.app/') && !entry.startsWith('__MACOSX/')) throw new Error('Unexpected update archive contents');
    }
}
