let mergeWorkspaceView: ReturnType<Window['VodPlayer']['mountMerge']> | null = null;
let mergeOutputMode: 'copy' | 'encode' = 'copy';
let mergeOutputDirectory: { token: string; displayPath: string } | null = null;
let mergeInspection: import('./main/domain/merge-compatibility').MergeCompatibility | null = null;
let mergeInspectionKey = '';
let mergeInspectionBusy = false;
let mergeInspectionFailed = false;
let mergeUndo: MergeFileReference[][] = [];
let mergeRedo: MergeFileReference[][] = [];

function rememberMergeEdit(): void { mergeUndo.push([...mergeFiles]); mergeUndo = mergeUndo.slice(-30); mergeRedo = []; }
function changeMergeOrder(ids: string[]): void {
    if (isMerging || workspaceLoading || mergeFilePickerInFlight || ids.length !== mergeFiles.length || new Set(ids).size !== ids.length) return;
    if (ids.join('|') === mergeFiles.map(file => file.id).join('|')) return;
    const files = new Map(mergeFiles.map(file => [file.id, file]));
    if (ids.some(id => !files.has(id))) return;
    rememberMergeEdit(); mergeFiles = ids.map(id => files.get(id)!); persistMergeWorkspace(); renderMergeFiles();
}
function restoreMergeEdit(redo: boolean): void {
    if (isMerging || workspaceLoading || mergeFilePickerInFlight) return;
    const source = redo ? mergeRedo : mergeUndo, target = redo ? mergeUndo : mergeRedo;
    const files = source.pop(); if (!files) return;
    target.push([...mergeFiles]); mergeFiles = [...files]; persistMergeWorkspace(); renderMergeFiles();
}
function setMergeMode(mode: 'copy' | 'encode'): void { mergeOutputMode = mode; updateMergeOutput(); }
function updateMergeOutput(): void {
    byId('mergeModeCopy').setAttribute('aria-pressed', String(mergeOutputMode === 'copy'));
    byId('mergeModeEncode').setAttribute('aria-pressed', String(mergeOutputMode === 'encode'));
    const allowed = mergeOutputMode === 'copy' ? mergeInspection?.copyAllowed : mergeInspection?.encodeAllowed;
    byId<HTMLButtonElement>('btnMerge').disabled = workspaceLoading || isMerging || mergeFilePickerInFlight || editingWorkflowBusy || mergeInspectionBusy || !allowed || !byId<HTMLInputElement>('mergeFilename').value.trim() || mergeFiles.length < 2 || mergeFiles.some(file => file.missing);
    byId<HTMLButtonElement>('mergeModeCopy').disabled = !mergeInspection?.copyAllowed;
    byId<HTMLButtonElement>('mergeModeEncode').disabled = !mergeInspection?.encodeAllowed;
    refreshEditingWorkflowControls();
}
async function selectMergeFolder(): Promise<void> {
    if (workspaceLoading || isMerging || mergeFilePickerInFlight) return;
    const directory = await window.api.selectFolder();
    if (directory) { mergeOutputDirectory = directory; byId('mergeFolderValue').textContent = directory.displayPath; }
}
function openMergeJobs(): void { byId<HTMLDialogElement>('mergeJobsDialog').showModal(); }
function renderMergeWorkspace(): void {
    const language = currentLanguage === 'en' ? 'en' : 'de';
    const captions: Record<string, string> = language === 'de' ? { mergeOutputTitle:'Ausgabe', mergeFilenameLabel:'Dateiname', mergeFolderLabel:'Speicherort', mergeCopyLabel:'Original beibehalten', mergeCopyHint:'Schnell · kein Qualitätsverlust', mergeEncodeLabel:'Neu codieren', mergeEncodeHint:'H.264 / AAC · Format des ersten Videos', mergeJobsButton:'Exportaufträge' } : { mergeOutputTitle:'Output', mergeFilenameLabel:'File name', mergeFolderLabel:'Folder', mergeCopyLabel:'Keep original', mergeCopyHint:'Fast · no quality loss', mergeEncodeLabel:'Re-encode', mergeEncodeHint:'H.264 / AAC · first video format', mergeJobsButton:'Export queue' };
    for (const [id, caption] of Object.entries(captions)) byId(id).textContent = caption;
    if (!mergeOutputDirectory) byId('mergeFolderValue').textContent = language === 'de' ? 'Ordner der ersten Datei' : 'First file folder';
    if (!mergeWorkspaceView && window.VodPlayer?.mountMerge) {
        mergeWorkspaceView = window.VodPlayer.mountMerge(byId('mergePreviewRoot'), {
            add: () => { void addMergeFiles(); }, reorder: changeMergeOrder,
            remove: id => { const index = mergeFiles.findIndex(file => file.id === id); if (index >= 0) removeMergeFile(index); },
            undo: () => restoreMergeEdit(false), redo: () => restoreMergeEdit(true),
            selection: (file, info) => { byId('mergeSelectedInfo').textContent = file ? file.name + (info ? ' · ' + info.width + ' × ' + info.height + ' · ' + Number(info.fps.toFixed(2)).toLocaleString(currentLanguage) + ' FPS' : '') : ''; },
        });
        const observer = new MutationObserver(() => renderMergeWorkspace());
        observer.observe(byId('mergeTab'), { attributes: true, attributeFilter: ['class'] });
        const dialog = byId<HTMLDialogElement>('mergeJobsDialog');
        dialog.addEventListener('pointerdown', event => { dialog.dataset.outside = String(event.target === dialog); });
        dialog.addEventListener('click', event => { if (event.target === dialog && dialog.dataset.outside === 'true') dialog.close(); });
    }
    mergeWorkspaceView?.update({ files: mergeFiles.map(file => ({ ...file })), language, locked: workspaceLoading || isMerging || mergeFilePickerInFlight, active: byId('mergeTab').classList.contains('active'), history: { undo: !!mergeUndo.length, redo: !!mergeRedo.length }, timelineHost: byId('mergeTimelineRoot') });
    const key = JSON.stringify(mergeFiles.map(file => [file.id, !!file.missing]));
    if (mergeInspectionKey !== key) {
        mergeInspectionKey = key; mergeInspection = null; mergeInspectionFailed = false;
        mergeInspectionBusy = mergeFiles.length >= 2 && !mergeFiles.some(file => file.missing);
        if (mergeInspectionBusy) {
            void editingApi().inspectMergeExport(mergeFiles.map(file => file.id)).then(result => {
                if (mergeInspectionKey !== key) return;
                mergeInspection = result.compatibility || null;
                mergeInspectionFailed = !result.success || !mergeInspection;
                if (!mergeInspection?.copyAllowed && mergeInspection?.encodeAllowed) mergeOutputMode = 'encode';
            }).catch(() => { if (mergeInspectionKey === key) mergeInspectionFailed = true; }).finally(() => { if (mergeInspectionKey === key) { mergeInspectionBusy = false; renderMergeWorkspace(); } });
        }
    }
    byId('mergeInspection').textContent = mergeFiles.some(file => file.missing) ? editingText('Eine Quelldatei fehlt. Entfernen und neu hinzufügen.', 'A source file is missing. Remove and add it again.') : mergeInspectionBusy ? editingText('Videoformate werden geprüft …', 'Checking video formats …') : mergeInspectionFailed ? editingText('Videoformate konnten nicht geprüft werden. Dateien erneut hinzufügen.', 'Could not inspect the formats. Add the files again.') : mergeFiles.length < 2 ? editingText('Mindestens zwei Videos hinzufügen.', 'Add at least two videos.') : mergeInspection?.copyAllowed ? editingText('Originalqualität bleibt erhalten.', 'Original quality is preserved.') : mergeInspection?.encodeAllowed ? editingText('Unterschiedliche Formate. Neu codieren erforderlich.', 'Different formats. Re-encoding is required.') : editingText('Diese Formate werden nicht gemeinsam unterstützt.', 'These formats cannot be combined.');
    updateMergeOutput();
}
async function submitMergeTimeline(startImmediately: boolean): Promise<void> {
    updateMergeOutput(); if (byId<HTMLButtonElement>('btnMerge').disabled) return;
    const ids = mergeFiles.map(file => file.id), mode = mergeOutputMode;
    const name = byId<HTMLInputElement>('mergeFilename').value.trim();
    await editingOperation(() => editingApi().enqueueMergeExport(ids, mode, { name, directory: mergeOutputDirectory?.token }), async () => {
        if (startImmediately) { const result = await editingApi().exportJobAction('start'); if (!result.success) throw new Error(result.error); }
        openMergeJobs();
    });
    updateMergeOutput();
}
