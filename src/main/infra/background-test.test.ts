import { describe, expect, it, vi } from 'vitest';
import { isIsolatedBackgroundTest, presentApplicationWindow } from './background-test';

describe('background test presentation', () => {
    const makeWindow = () => ({ isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), showInactive: vi.fn(), focus: vi.fn() });
    it('never activates or restores an isolated background window', () => {
        const window = makeWindow();
        presentApplicationWindow(window, true, true);
        expect(window.showInactive).toHaveBeenCalledOnce();
        expect(window.show).not.toHaveBeenCalled();
        expect(window.restore).not.toHaveBeenCalled();
        expect(window.focus).not.toHaveBeenCalled();
    });
    it('preserves normal application activation', () => {
        const window = makeWindow();
        presentApplicationWindow(window, false, true);
        expect(window.restore).toHaveBeenCalledOnce();
        expect(window.show).toHaveBeenCalledOnce();
        expect(window.focus).toHaveBeenCalledOnce();
        expect(window.showInactive).not.toHaveBeenCalled();
    });
    it('does not enable background mode with an environment flag alone', () => {
        expect(isIsolatedBackgroundTest({ TVM_E2E_BACKGROUND: '1' }, '/Applications', 'darwin')).toBe(false);
        expect(isIsolatedBackgroundTest({ TVM_E2E_BACKGROUND: '1' }, '/Applications', 'win32')).toBe(false);
    });
});
