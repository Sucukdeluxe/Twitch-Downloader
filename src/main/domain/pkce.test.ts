import { test, expect, describe } from 'vitest';
import * as crypto from 'crypto';
import { createPkcePair, generateState } from './pkce';

describe('createPkcePair', () => {
    test('returns S256 method', () => {
        expect(createPkcePair().codeChallengeMethod).toBe('S256');
    });

    test('verifier is 43+ chars base64url-safe', () => {
        const { codeVerifier } = createPkcePair();
        expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
        // RFC 7636 unreserved chars only: [A-Z a-z 0-9 - . _ ~]
        // base64url uses [A-Z a-z 0-9 - _], no = padding.
        expect(/^[A-Za-z0-9_-]+$/.test(codeVerifier)).toBe(true);
    });

    test('challenge matches sha256(verifier) base64url-encoded', () => {
        const pair = createPkcePair();
        const expected = crypto.createHash('sha256').update(pair.codeVerifier).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(pair.codeChallenge).toBe(expected);
    });

    test('two pairs differ (sufficient entropy)', () => {
        const a = createPkcePair();
        const b = createPkcePair();
        expect(a.codeVerifier).not.toBe(b.codeVerifier);
        expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });
});

describe('generateState', () => {
    test('returns >= 16 chars', () => {
        expect(generateState().length).toBeGreaterThanOrEqual(16);
    });

    test('base64url-safe charset', () => {
        expect(/^[A-Za-z0-9_-]+$/.test(generateState())).toBe(true);
    });

    test('two states differ', () => {
        expect(generateState()).not.toBe(generateState());
    });
});
