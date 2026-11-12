import { createIsolatedTestSecureStorage } from './test-secure-storage';

/** Only an explicitly requested, fully isolated Mac test may hide its app UI. */
export function isIsolatedBackgroundTest(env: NodeJS.ProcessEnv, userDataDirectory: string, platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'darwin' && env.TVM_E2E_BACKGROUND === '1'
        && createIsolatedTestSecureStorage(env, userDataDirectory) !== null;
}

interface PresentableWindow {
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    showInactive(): void;
    focus(): void;
}

export function presentApplicationWindow(window: PresentableWindow, background: boolean, focus = false): void {
    if (background) {
        window.showInactive();
        return;
    }
    if (focus && window.isMinimized()) window.restore();
    window.show();
    if (focus) window.focus();
}
