import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface DevelopmentStyleUpdate {
    revision: number;
    styles: Array<{ name: string; css: string }>;
    status: 'ready' | 'reload' | 'restart' | 'error';
}

export function createDevelopmentLiveUpdates(
    root: string,
    publish: (update: DevelopmentStyleUpdate) => void,
    reportError: (error: unknown) => void,
    rebuild = async () => {
        await promisify(execFile)(process.execPath, [join(root, 'scripts/build.mjs'), '--development-refresh'], {
            cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        });
    },
) {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    let stopped = false;
    let refreshing = false;
    let refreshAgain = false;
    let pendingBuild: 'reload' | 'restart' | undefined;
    let snapshot: DevelopmentStyleUpdate = { revision: 0, styles: [], status: 'ready' };

    async function refresh(): Promise<void> {
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        const currentRevision = ++revision;
        const buildKind = pendingBuild;
        try {
            if (buildKind) await rebuild();
            const { build, transform } = await import('esbuild');
            const names = ['styles', 'styles-workflows', 'styles-overlays', 'workspace', 'workspace-refinements', 'editing-workflows', 'workspace-insights'];
            const styles = await Promise.all(names.map(async name => {
                const source = await readFile(join(root, 'src', name + '.css'), 'utf8');
                const result = await transform(source, { loader: 'css', sourcefile: name + '.css', logLevel: 'silent' });
                if (result.warnings.length) throw new Error('Invalid development stylesheet: ' + name);
                return { name, css: result.code };
            }));
            const player = await build({
                absWorkingDir: root,
                entryPoints: ['src/vod-player/workspace.jsx'],
                bundle: true,
                outfile: 'dist/renderer-vod-player.js',
                format: 'iife',
                platform: 'browser',
                target: 'chrome120',
                minify: true,
                legalComments: 'eof',
                define: { 'process.env.NODE_ENV': '"production"' },
                write: false,
                logLevel: 'silent',
            });
            if (player.warnings.length) throw new Error('Invalid development player stylesheet');
            const playerCss = player.outputFiles.find(file => file.path.endsWith('.css'));
            if (!playerCss) throw new Error('Development player stylesheet missing');
            styles.push({ name: 'renderer-vod-player', css: playerCss.text });
            if (stopped || currentRevision !== revision) return;
            snapshot = { revision: currentRevision, styles, status: buildKind || 'ready' };
            pendingBuild = undefined;
            publish(snapshot);
        } catch (error) {
            if (stopped || currentRevision !== revision) return;
            snapshot = { ...snapshot, revision: currentRevision, status: 'error' };
            reportError(error);
            publish(snapshot);
        } finally {
            refreshing = false;
            if (refreshAgain && !stopped) { refreshAgain = false; void refresh(); }
        }
    }

    function schedule(file: string): void {
        if (stopped || /\.(?:test|spec)\./.test(file) || !/\.(?:css|html|[cm]?[jt]sx?)$/.test(file)) return;
        const normalized = file.replaceAll('\\', '/');
        if (!file.endsWith('.css')) {
            const rendererOnly = /^(?:renderer[^/]*\.tsx?|index\.html|preload\.ts|vod-player\/)/.test(normalized);
            if (!rendererOnly) pendingBuild = 'restart';
            else pendingBuild ??= 'reload';
        }
        ++revision;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; void refresh(); }, 200);
    }

    try {
        watcher = watch(join(root, 'src'), { recursive: true }, (_event, file) => {
            if (file) schedule(file.toString());
        });
        watcher.on('error', error => {
            reportError(error);
            snapshot = { ...snapshot, revision: ++revision, status: 'error' };
            publish(snapshot);
        });
        void refresh();
    } catch (error) {
        reportError(error);
        snapshot = { ...snapshot, revision: ++revision, status: 'error' };
        publish(snapshot);
    }

    return {
        current: () => snapshot,
        stop: () => {
            stopped = true;
            ++revision;
            if (timer) clearTimeout(timer);
            watcher?.close();
        },
    };
}
