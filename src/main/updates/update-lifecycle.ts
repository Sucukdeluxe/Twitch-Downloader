export type UpdateLifecycleSnapshot =
    | { phase: 'idle' }
    | { phase: 'checking' }
    | { phase: 'available'; version: string }
    | { phase: 'downloading'; version: string }
    | { phase: 'ready'; version: string };

export type UpdateLifecycleStartResult =
    | { started: true }
    | { started: false; reason: 'in-progress' | 'downloading' | 'ready-to-install' | 'not-available' | 'stale-version' };

export class UpdateLifecycle {
    private state: UpdateLifecycleSnapshot = { phase: 'idle' };
    private checkFallback: UpdateLifecycleSnapshot | null = null;

    get snapshot(): UpdateLifecycleSnapshot {
        return { ...this.state };
    }

    beginCheck(): UpdateLifecycleStartResult {
        if (this.state.phase === 'checking') return { started: false, reason: 'in-progress' };
        if (this.state.phase === 'downloading') return { started: false, reason: 'downloading' };
        if (this.state.phase === 'ready') return { started: false, reason: 'ready-to-install' };
        this.checkFallback = this.state.phase === 'available' ? this.state : { phase: 'idle' };
        this.state = { phase: 'checking' };
        return { started: true };
    }

    completeCheckAvailable(version: string): boolean {
        if (this.state.phase !== 'checking' || !version) return false;
        this.state = { phase: 'available', version };
        this.checkFallback = null;
        return true;
    }

    completeCheckNotAvailable(): boolean {
        if (this.state.phase !== 'checking') return false;
        this.state = { phase: 'idle' };
        this.checkFallback = null;
        return true;
    }

    failCheck(): boolean {
        if (this.state.phase !== 'checking') return false;
        this.state = this.checkFallback ?? { phase: 'idle' };
        this.checkFallback = null;
        return true;
    }

    beginDownload(version: string): UpdateLifecycleStartResult {
        if (this.state.phase === 'downloading') return { started: false, reason: 'in-progress' };
        if (this.state.phase === 'ready') return { started: false, reason: 'ready-to-install' };
        if (this.state.phase !== 'available') return { started: false, reason: 'not-available' };
        if (!version || this.state.version !== version) return { started: false, reason: 'stale-version' };
        this.state = { phase: 'downloading', version };
        return { started: true };
    }

    completeDownload(version: string): boolean {
        if (this.state.phase !== 'downloading' || this.state.version !== version) return false;
        this.state = { phase: 'ready', version };
        return true;
    }

    restoreDownload(version: string): boolean {
        if (!version || (this.state.phase !== 'idle' && this.state.phase !== 'checking')) return false;
        if (this.checkFallback?.phase === 'available' && this.checkFallback.version !== version) return false;
        this.state = { phase: 'ready', version };
        this.checkFallback = null;
        return true;
    }

    failDownload(version?: string): boolean {
        if (this.state.phase !== 'downloading') return false;
        if (version && this.state.version !== version) return false;
        this.state = { phase: 'available', version: this.state.version };
        return true;
    }
}
