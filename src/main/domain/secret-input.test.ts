import { describe, expect, it } from 'vitest';
import { createSecretInputRevision, isSecretInputRevisionCurrent, resolveSecretInputUpdate } from './secret-input';

describe('resolveSecretInputUpdate', () => {
    it('keeps a configured secret when the masked value is unchanged', () => {
        expect(resolveSecretInputUpdate('••••••••', true)).toEqual({ action: 'unchanged' });
    });

    it('clears a configured secret when the field is emptied', () => {
        expect(resolveSecretInputUpdate('  ', true)).toEqual({ action: 'clear' });
    });

    it('sets a trimmed replacement without exposing the stored value', () => {
        expect(resolveSecretInputUpdate(' replacement ', true)).toEqual({ action: 'set', value: 'replacement' });
    });

    it('ignores an empty field when no secret is configured', () => {
        expect(resolveSecretInputUpdate('', false)).toEqual({ action: 'unchanged' });
    });

    it('does not apply a completed save mask after a newer secret input arrives', async () => {
        const revision = createSecretInputRevision();
        const requestRevision = revision.current();
        let resolveSave: (() => void) | undefined;
        let visibleValue: string;
        const save = new Promise<void>((resolve) => {
            resolveSave = resolve;
        }).then(() => {
            if (isSecretInputRevisionCurrent(revision, requestRevision)) visibleValue = '••••••••';
        });

        revision.advance();
        visibleValue = 'second-secret';
        resolveSave?.();
        await save;

        expect(visibleValue).toBe('second-secret');
    });
});
