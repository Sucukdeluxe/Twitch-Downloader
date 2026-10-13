import { watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJsonDocument, writeJsonDocument, createSerialExecutor } from './durable-json-store';
import { scanArchiveInventory, classify, fileDate, type ArchiveInventory, type ArchiveInventoryFile } from './archive-inventory';

interface IndexState { inventory: ArchiveInventory | null; watcher: FSWatcher | null; dirty: Set<string>; full: boolean; verified: number; active: Promise<ArchiveInventory> | null; loading: Promise<void> | null; activeFull: boolean }
export function createIndexedArchiveReader(indexFile: string, reconcileMs = 60000, onUpdated?: (root: string) => void) {
    const states = new Map<string, IndexState>();
    const persist = createSerialExecutor();
    let closing = false, lastWrite: Promise<void> = Promise.resolve();
    function contained(root: string, filename: string): boolean { const relative = path.relative(root, filename); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); }
    async function cached(root: string): Promise<ArchiveInventory | null> {
        try {
            const raw = await readJsonDocument(indexFile, 64 * 1024 * 1024) as { version?: number; inventory?: ArchiveInventory } | undefined;
            const value = raw?.inventory;
            if (raw?.version !== 1 || !value || value.root !== root || !Array.isArray(value.files) || value.files.length > 500000) return null;
            const files: ArchiveInventoryFile[] = [];
            for (const entry of value.files) {
                if (typeof entry.relativePath !== 'string' || path.isAbsolute(entry.relativePath) || typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0 || typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs)) return null;
                const fullPath = path.resolve(root, entry.relativePath); if (!contained(root, fullPath) || entry.relativePath.split(path.sep).some(part => part.startsWith('.'))) return null;
                files.push({ fullPath, relativePath:entry.relativePath, fileName:path.basename(fullPath), ...classify(entry.relativePath), size:entry.size, mtimeMs:entry.mtimeMs, date:fileDate(path.basename(fullPath),entry.mtimeMs) });
            }
            return { root, rootExists:value.rootExists !== false, scannedAt:String(value.scannedAt || ''), files };
        } catch { return null; }
    }
    function track(root: string, state: IndexState): void {
        if (state.watcher || closing || states.get(root) !== state) return;
        try {
            state.watcher = watch(root, { recursive:true, persistent:false }, (_event, name) => {
                if (!name) { state.full = true; return; }
                const filename = path.resolve(root, String(name));
                if (!contained(root,filename)) { state.full=true; return; }
                if (path.relative(root,filename).split(path.sep).some(part=>part.startsWith('.'))) return;
                state.dirty.add(filename); if (state.dirty.size > 2000) { state.full=true; state.dirty.clear(); }
            });
            state.watcher.on('error',()=>{state.watcher?.close();state.watcher=null;state.full=true;});
        } catch { state.full=true; }
    }
    async function delta(root: string, inventory: ArchiveInventory, paths: string[]): Promise<ArchiveInventory> {
        const minimal = paths.filter(filename=>!paths.some(other=>other!==filename && filename.startsWith(other+path.sep)));
        const files = inventory.files.filter(entry=>!minimal.some(filename=>entry.fullPath===filename||entry.fullPath.startsWith(filename+path.sep)));
        for (const filename of minimal) {
            let stat; try { stat=await fs.lstat(filename); } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') continue; throw error; }
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                const branch=await scanArchiveInventory(filename);
                for (const entry of branch.files) { const relativePath=path.relative(root,entry.fullPath); files.push({...entry,relativePath,...classify(relativePath)}); }
            } else if (stat.isFile()) {
                const relativePath=path.relative(root,filename);
                files.push({ fullPath:filename,relativePath,fileName:path.basename(filename),...classify(relativePath),size:stat.size,mtimeMs:stat.mtimeMs,date:fileDate(path.basename(filename),stat.mtimeMs) });
            }
        }
        return {root,rootExists:true,scannedAt:new Date().toISOString(),files};
    }
    async function update(root: string, state: IndexState, refresh: boolean): Promise<ArchiveInventory> {
        track(root,state);
        const paths=[...state.dirty];state.dirty.clear();
        const full=refresh || state.full || !state.inventory || Date.now()-state.verified>=reconcileMs;
        state.activeFull=full;
        state.full=false;
        let inventory: ArchiveInventory;
        try { inventory=full ? await scanArchiveInventory(root) : paths.length ? await delta(root,state.inventory!,paths) : state.inventory!; }
        catch { state.full=true; inventory=await scanArchiveInventory(root); }
        if (full) state.verified=Date.now();
        if (inventory!==state.inventory) {
            state.inventory=inventory;
            lastWrite=persist(()=>writeJsonDocument(indexFile,{version:1,inventory})).catch(()=>{});
        }
        if (!inventory.rootExists) { state.watcher?.close();state.watcher=null; }
        return inventory;
    }
    function startUpdate(root: string, state: IndexState, refresh: boolean): Promise<ArchiveInventory> {
        const previous = state.inventory;
        const promise = update(root, state, refresh).finally(() => {
            if (state.active === promise) state.active = null;
        });
        state.active = promise;
        void promise.then(inventory => {
            if (!closing && previous && (inventory.rootExists || previous.rootExists)) onUpdated?.(root);
        }).catch(() => { state.full = true; });
        return promise;
    }
    const read = async (directory: string, refresh = false): Promise<ArchiveInventory> => {
        const root = directory ? path.resolve(directory) : '';
        if (!root) return scanArchiveInventory(root);
        if (closing) return states.get(root)?.inventory ?? { root, rootExists: false, scannedAt: new Date().toISOString(), files: [] };
        let state = states.get(root);
        if (!state) {
            if (states.size >= 4) {
                const key = states.keys().next().value!;
                states.get(key)?.watcher?.close();
                states.delete(key);
            }
            state = { inventory: null, watcher: null, dirty: new Set(), full: true, verified: 0, active: null, loading: null, activeFull: false };
            states.set(root, state);
            const current = state;
            state.loading = cached(root).then(inventory => { current.inventory = inventory; });
        }
        await state.loading;
        if (closing) return state.inventory ?? { root, rootExists: false, scannedAt: new Date().toISOString(), files: [] };
        if (refresh) {
            if (state.active) {
                const activeWasFull = state.activeFull;
                await state.active;
                if (activeWasFull && !state.dirty.size && !state.full) return state.inventory!;
            }
            return startUpdate(root, state, true);
        }
        if (!state.inventory) return state.active || startUpdate(root, state, true);
        if (!state.active && (state.full || state.dirty.size || Date.now() - state.verified >= reconcileMs)) startUpdate(root, state, false);
        return state.inventory;
    };
    read.isRefreshing = (directory: string): boolean => Boolean(states.get(directory ? path.resolve(directory) : '')?.active);
    read.invalidate = (directory?: string): void => { for (const [root,state] of states) if (!directory || path.resolve(directory)===root) state.full=true; };
    read.dispose = async (): Promise<void> => { closing=true;for(const state of states.values())state.watcher?.close();await Promise.allSettled([...states.values()].map(async state=>{await state.loading;await state.active;}));await lastWrite;states.clear(); };
    return read;
}
