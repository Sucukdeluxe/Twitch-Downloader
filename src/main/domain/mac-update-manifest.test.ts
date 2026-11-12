import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareMacVersions, isStableMacVersion, MAC_UPDATE_MAX_BYTES, validateMacArchiveEntries, verifyMacUpdateManifest, type MacUpdateManifest } from './mac-update-manifest';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function fixture(): MacUpdateManifest {
    return {
        schema: 1, version: '1.2.3', publishedAt: '2026-11-11T10:00:00.000Z', releaseNotes: 'Verified update',
        artifacts: Object.fromEntries(['arm64', 'x64'].map((arch) => [arch, {
            url: `https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-${arch}.zip`,
            size: 100, sha256: 'a'.repeat(64),
        }])) as MacUpdateManifest['artifacts'],
    };
}

function envelope(value: unknown): string {
    const payload = Buffer.from(JSON.stringify(value));
    return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') });
}

describe('authenticated macOS update manifests', () => {
    it('authenticates exact payload bytes and retains both architecture artifacts', () => {
        expect(verifyMacUpdateManifest(envelope(fixture()), publicKey)).toEqual(fixture());
    });

    it('rejects a correctly shaped document signed by another key', () => {
        const differentKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
        expect(() => verifyMacUpdateManifest(envelope(fixture()), differentKey)).toThrow(/signature/i);
    });

    it('rejects payload or signature tampering before accepting release fields', () => {
        const original = JSON.parse(envelope(fixture()));
        const changed = { ...fixture(), releaseNotes: 'Changed after signing' };
        expect(() => verifyMacUpdateManifest(JSON.stringify({ ...original, payload: Buffer.from(JSON.stringify(changed)).toString('base64') }), publicKey)).toThrow(/signature/i);
        const signature = Buffer.from(original.signature, 'base64');
        signature[0] ^= 1;
        expect(() => verifyMacUpdateManifest(JSON.stringify({ ...original, signature: signature.toString('base64') }), publicKey)).toThrow(/signature/i);
    });

    it.each(['payload', 'signature'])('rejects noncanonical base64 in %s', (field) => {
        const original = JSON.parse(envelope(fixture()));
        original[field] += '\n';
        expect(() => verifyMacUpdateManifest(JSON.stringify(original), publicKey)).toThrow(/encoding/i);
    });

    it('bounds untrusted document and decoded payload sizes', () => {
        expect(() => verifyMacUpdateManifest(' '.repeat(256 * 1024 + 1), publicKey)).toThrow(/large/i);
        expect(() => verifyMacUpdateManifest(envelope('x'.repeat(128 * 1024)), publicKey)).toThrow(/encoding/i);
    });

    it.each([
        ['schema', (manifest: any) => { manifest.schema = 2; }],
        ['prerelease', (manifest: any) => { manifest.version = '1.2.3-beta.1'; }],
        ['leading zero', (manifest: any) => { manifest.version = '01.2.3'; }],
        ['date', (manifest: any) => { manifest.publishedAt = 'not a date'; }],
        ['notes type', (manifest: any) => { manifest.releaseNotes = {}; }],
        ['notes size', (manifest: any) => { manifest.releaseNotes = 'x'.repeat(64 * 1024 + 1); }],
        ['missing architecture', (manifest: any) => { delete manifest.artifacts.x64; }],
        ['artifact type', (manifest: any) => { manifest.artifacts.arm64 = []; }],
        ['zero size', (manifest: any) => { manifest.artifacts.arm64.size = 0; }],
        ['fractional size', (manifest: any) => { manifest.artifacts.arm64.size = 1.5; }],
        ['excessive size', (manifest: any) => { manifest.artifacts.arm64.size = MAC_UPDATE_MAX_BYTES + 1; }],
        ['checksum', (manifest: any) => { manifest.artifacts.arm64.sha256 = 'g'.repeat(64); }],
    ])('rejects authenticated but invalid %s', (_name, mutate) => {
        const manifest = fixture();
        mutate(manifest);
        expect(() => verifyMacUpdateManifest(envelope(manifest), publicKey)).toThrow();
    });

    it.each([
        'http://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-arm64.zip',
        'https://github.com/attacker/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-arm64.zip',
        'https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/latest/download/Twitch-VOD-Manager-1.2.3-mac-arm64.zip',
        'https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-x64.zip',
        'https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-arm64.zip?redirect=1',
    ])('pins signed artifact address %s', (url) => {
        const manifest = fixture();
        manifest.artifacts.arm64.url = url;
        expect(() => verifyMacUpdateManifest(envelope(manifest), publicKey)).toThrow(/address/i);
    });
});

describe('stable macOS versions', () => {
    it.each(['', 'v1.2.3', '1.2', '1.2.3.4', '1.2.3-beta', '1.2.3+build', '-1.2.3', '1.02.3', '1.2.3\n', '100000000.0.0'])('rejects ambiguous version %j', (version) => {
        expect(isStableMacVersion(version)).toBe(false);
    });
    it('compares numeric components and rejects invalid baselines', () => {
        expect(compareMacVersions('1.10.0', '1.9.9')).toBe(1);
        expect(compareMacVersions('1.2.3', '1.2.3')).toBe(0);
        expect(compareMacVersions('1.2.3', '2.0.0')).toBe(-1);
        expect(() => compareMacVersions('1.2.3', '1.2.3-beta')).toThrow();
    });
});

describe('macOS archive entry boundaries', () => {
    it('allows application contents and macOS resource metadata', () => {
        expect(() => validateMacArchiveEntries('Twitch VOD Manager.app/\nTwitch VOD Manager.app/Contents/Info.plist\n__MACOSX/._Twitch VOD Manager.app\n')).not.toThrow();
    });
    it.each(['', '/tmp/escape', '../escape', 'Twitch VOD Manager.app/Contents/../../escape', 'Twitch VOD Manager.app/Contents\\escape', 'Twitch VOD Manager.app/Contents/\u0000escape', 'Other.app/Contents/Info.plist', '__MACOSX/../escape'])('rejects unsafe archive entry %j', (entry) => {
        expect(() => validateMacArchiveEntries(entry)).toThrow();
    });
    it('rejects an excessive archive entry count', () => {
        expect(() => validateMacArchiveEntries('Twitch VOD Manager.app/Contents/file\n'.repeat(100001))).toThrow();
    });
});
