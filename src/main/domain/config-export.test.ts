import { describe, expect, it } from 'vitest';
import { createExportableConfig } from './config-export';

describe('createExportableConfig', () => {
    it('recursively removes every secret-bearing field and value', () => {
        const exported = createExportableConfig({
            language: 'de',
            client_secret: 'client-secret-value',
            discord_webhook_url: 'https://discord.com/api/webhooks/value',
            access_token: 'access-token-value',
            nested: {
                refresh_token: 'refresh-token-value',
                password: 'password-value',
                cookie: 'cookie-value',
            },
        }, new Date('2026-08-11T20:00:00.000Z'));
        const serialized = JSON.stringify(exported);

        expect(exported).toMatchObject({ language: 'de', __exportVersion: 2, __exportedAt: '2026-08-11T20:00:00.000Z' });
        for (const forbidden of ['client_secret', 'discord_webhook_url', 'access_token', 'refresh_token', 'password', 'cookie', 'client-secret-value', '/webhooks/value']) {
            expect(serialized).not.toContain(forbidden);
        }
    });
});
