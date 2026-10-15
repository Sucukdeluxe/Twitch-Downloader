interface EditingWorkflowResponse {
    success: boolean;
    cancelled?: boolean;
    error?: string;
    name?: string;
    project?: CutterProject;
    source?: FileCapabilityReference;
    projects?: Array<{ id: string; name: string; sourceName: string; updatedAt: number }>;
    jobs?: EditingWorkflowJob[];
    paused?: boolean;
    compatibility?: import('./main/domain/merge-compatibility').MergeCompatibility;
}
interface EditingWorkflowJob {
    id: string; name: string; kind: 'cut' | 'merge'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number; attempts: number; error: string | null; outputName: string | null;
}
interface EditingWorkflowApi {
    listNamedCutterProjects(): Promise<EditingWorkflowResponse>;
    saveNamedCutterProject(token: string, project: unknown, name: string, saveAs: boolean): Promise<EditingWorkflowResponse>;
    openNamedCutterProject(id?: string): Promise<EditingWorkflowResponse>;
    listExportJobs(): Promise<EditingWorkflowResponse>;
    enqueueCutterExport(token: string, project: unknown): Promise<EditingWorkflowResponse>;
    inspectMergeExport(ids: string[]): Promise<EditingWorkflowResponse>;
    enqueueMergeExport(ids: string[], mode: 'copy' | 'encode', output?: { name: string; directory?: string }): Promise<EditingWorkflowResponse>;
    exportJobAction(action: 'start' | 'pause' | 'cancel' | 'retry' | 'remove' | 'reveal' | 'move-up' | 'move-down' | 'clear-completed', id?: string): Promise<EditingWorkflowResponse>;
    onExportJobsChanged(callback: (state: { jobs: EditingWorkflowJob[]; paused: boolean }) => void): () => void;
}
let editingWorkflowInitialized = false;
let editingWorkflowBusy = false;
let editingWorkflowJobs: EditingWorkflowJob[] = [];
let editingWorkflowPaused = true;
const editingWorkflowRows = new Map<string, HTMLElement>();

function editingText(de: string, en: string): string { return currentLanguage === 'de' ? de : en; }
function editingButton(text: string, action: () => void): HTMLButtonElement {
    return RendererElements.button(text, action);
}
function editingErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/source changed/i.test(message)) return editingText('Quelldatei wurde geändert. Neu öffnen.', 'Source changed. Open it again.');
    if (/source.*unavailable|project not found|ENOENT/i.test(message)) return editingText('Datei nicht gefunden. Pfad prüfen.', 'File not found. Check its location.');
    if (/export is running/i.test(message)) return editingText('Ein Export läuft bereits.', 'An export is already running.');
    if (/backup|restore|locked/i.test(message)) return editingText('Sicherung oder Wiederherstellung läuft.', 'Backup or restore is running.');
    if (/already exists|destination changed/i.test(message)) return editingText('Zieldatei geändert. Anderen Namen wählen.', 'Output changed. Choose another name.');
    if (/interrupted/i.test(message)) return editingText('Export unterbrochen. Erneut versuchen.', 'Export interrupted. Retry.');
    if (/incomplete|duration differs|format differs/i.test(message)) return editingText('Exportprüfung fehlgeschlagen.', 'Export verification failed.');
    if (/ENOSPC/i.test(message)) return editingText('Nicht genug Speicherplatz.', 'Not enough disk space.');
    if (/EPERM|EACCES/i.test(message)) return editingText('Kein Zugriff auf die Datei.', 'Cannot access the file.');
    return editingText('Aktion fehlgeschlagen.', 'Action failed.');
}
function editingApi(): EditingWorkflowApi { return window.api as typeof window.api & EditingWorkflowApi; }
async function editingOperation(operation: () => Promise<EditingWorkflowResponse>, after?: (result: EditingWorkflowResponse) => Promise<void> | void): Promise<void> {
    if (editingWorkflowBusy) return;
    const focused = document.activeElement as HTMLElement | null;
    const focusedJob = focused?.closest<HTMLElement>('.editing-job')?.dataset.jobId;
    const focusedAction = focused?.dataset.action;
    editingWorkflowBusy = true;
    const previousError = document.getElementById('editingWorkflowError'); if (previousError) previousError.hidden = true;
    refreshEditingWorkflowControls();
    try {
        const result = await operation();
        if (!result.success && !result.cancelled) throw new Error(result.error || 'Operation failed');
        if (result.success) await after?.(result);
    } catch (error) {
        showAppToast(editingErrorMessage(error), 'warn');
        const details = document.getElementById('editingWorkflowError');
        if (details) { details.hidden = false; const content = details.querySelector('pre'); if (content) content.textContent = error instanceof Error ? error.message : String(error); }
    } finally {
        editingWorkflowBusy = false;
        refreshEditingWorkflowControls();
        if (focusedJob && document.activeElement === document.body) {
            const controls = Array.from(editingWorkflowRows.get(focusedJob)?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
            const target = controls.find(button => button.dataset.action === focusedAction) || controls[0];
            target?.focus({ preventScroll: true });
        }
    }
}
async function openNamedEditingProject(id?: string): Promise<void> {
    if (isCutting || cutterCutDraft) return;
    if (cutterFile && !await confirmCutterReplacement({ ...cutterFile, token: '' })) return;
    if (cutterEditorState && !cutterRecoveryDecisionPending && !await persistCutterProject(false)) return;
    await editingOperation(() => editingApi().openNamedCutterProject(id), async result => {
        if (!result.source || !result.project) throw new Error('Project source unavailable');
        await loadCutterFromPath(result.source);
        if (cutterFile?.token !== result.source.token || !applyCutterProject(result.project)) throw new Error('Project could not be restored');
        cutterRecoveryDecisionPending = false;
        renderCutterProjectRecovery(null);
        const name = document.getElementById('editingProjectName') as HTMLInputElement | null;
        if (name) { name.value = result.name || ''; name.dataset.source = result.source.token; }
        refreshEditingWorkflowControls();
    });
}
async function saveNamedEditingProject(saveAs = false): Promise<void> {
    const project = getCutterProjectPayload();
    const name = (document.getElementById('editingProjectName') as HTMLInputElement | null)?.value.trim();
    if (!cutterFile || !project || cutterCutDraft || !name) return;
    await editingOperation(() => editingApi().saveNamedCutterProject(cutterFile!.token, project, name, saveAs), result => {
        const input = document.getElementById('editingProjectName') as HTMLInputElement | null;
        if (input && result.name) input.value = result.name;
        showAppToast(editingText('Projekt gespeichert.', 'Project saved.'), 'info');
    });
}
let editingRecentProjects: NonNullable<EditingWorkflowResponse['projects']> = [];
function renderRecentEditingProjects(): void {
    const dialog = document.getElementById('editingRecentProjects');
    const list = dialog?.querySelector<HTMLElement>('.editing-recent-list');
    if (!list) return;
    const query = (dialog!.querySelector<HTMLInputElement>('#editingProjectSearch')?.value || '').trim().toLocaleLowerCase(currentLanguage);
    const order = dialog!.querySelector<HTMLSelectElement>('#editingProjectSort')?.value || 'recent';
    const collator = new Intl.Collator(currentLanguage, { numeric: true, sensitivity: 'base' });
    const projects = editingRecentProjects.filter(project => [project.name, project.sourceName].some(value => value.toLocaleLowerCase(currentLanguage).includes(query)));
    projects.sort((a, b) => order === 'name' ? collator.compare(a.name, b.name) || b.updatedAt - a.updatedAt : (order === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt) || collator.compare(a.name, b.name));
    list.replaceChildren();
    for (const project of projects) {
        const button = editingButton(project.name, () => { (dialog as HTMLDialogElement).close(); void openNamedEditingProject(project.id); });
        button.dataset.projectId = project.id;
        const source = document.createElement('span'); source.textContent = project.sourceName;
        const date = document.createElement('time'); date.dateTime = new Date(project.updatedAt).toISOString(); date.textContent = new Intl.DateTimeFormat(currentLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(project.updatedAt);
        button.append(source, date); list.append(button);
    }
    if (!projects.length) list.textContent = editingRecentProjects.length ? editingText('Keine passenden Projekte.', 'No matching projects.') : editingText('Keine gespeicherten Projekte.', 'No saved projects.');
    const count = document.getElementById('editingProjectCount'); if (count) count.textContent = formatUiNumber(projects.length) + ' / ' + formatUiNumber(editingRecentProjects.length);
}
async function showRecentEditingProjects(): Promise<void> {
    await editingOperation(() => editingApi().listNamedCutterProjects(), result => {
        const dialog = document.getElementById('editingRecentProjects') as HTMLDialogElement;
        editingRecentProjects = result.projects || [];
        renderRecentEditingProjects();
        dialog.showModal();
        dialog.querySelector<HTMLInputElement>('#editingProjectSearch')?.focus();
    });
}
function renderEditingJobs(): void {
    const list = document.getElementById('editingJobList');
    if (!list) return;
    const present = new Set(editingWorkflowJobs.map(job => job.id));
    for (const [id, row] of editingWorkflowRows) if (!present.has(id)) { row.remove(); editingWorkflowRows.delete(id); }
    const waiting = editingWorkflowJobs.filter(job => job.status === 'queued');
    const waitingPositions = new Map(waiting.map((job, index) => [job.id, index]));
    const percentageFormat = new Intl.NumberFormat(currentLanguage, { style: 'percent', maximumFractionDigits: 1 });
    for (const [index, job] of editingWorkflowJobs.entries()) {
        let row = editingWorkflowRows.get(job.id);
        if (!row) {
            row = document.createElement('article'); row.className = 'editing-job'; row.dataset.jobId = job.id;
            const title = document.createElement('strong'); title.className = 'editing-job-title'; row.append(title);
            const state = document.createElement('span'); state.className = 'editing-job-state'; row.append(state);
            const progress = document.createElement('progress'); progress.max = 100; row.append(progress);
            const percentage = document.createElement('span'); percentage.className = 'editing-job-percentage'; row.append(percentage);
            const actions = document.createElement('div'); actions.className = 'editing-job-actions'; row.append(actions);
            const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = editingText('Details', 'Details'); details.append(summary, document.createElement('pre')); row.append(details);
            editingWorkflowRows.set(job.id, row); list.append(row);
        }
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
        row.querySelector('strong')!.textContent = job.name;
        const percentage = row.querySelector<HTMLElement>('.editing-job-percentage')!;
        percentage.hidden = job.status !== 'running';
        percentage.textContent = percentageFormat.format(job.progress / 100);
        row.querySelector('.editing-job-state')!.textContent = ({ queued: editingText('Bereit', 'Ready'), running: editingText('Exportiert', 'Exporting'), completed: editingText('Gespeichert', 'Saved'), failed: editingText('Fehlgeschlagen', 'Failed'), cancelled: editingText('Abgebrochen', 'Cancelled') })[job.status];
        const progress = row.querySelector('progress')!; progress.value = job.progress; progress.hidden = job.status !== 'running'; progress.setAttribute('aria-label', job.name);
        const details = row.querySelector('details')!; details.hidden = !job.error; details.querySelector('pre')!.textContent = job.error || '';
        details.querySelector('summary')!.textContent = job.error ? editingErrorMessage(job.error) : editingText('Details', 'Details');
        const actions = row.querySelector('.editing-job-actions')!;
        const desired = job.status === 'queued' ? ['move-up', 'move-down', 'cancel'] : job.status === 'running' ? ['cancel'] : job.status === 'failed' || job.status === 'cancelled' ? ['retry', 'remove'] : ['reveal', 'remove'];
        const actionKey = desired.join('|') + '|' + currentLanguage;
        if (actions.getAttribute('data-actions') !== actionKey) {
            actions.setAttribute('data-actions', actionKey); actions.replaceChildren();
            for (const action of desired) {
                const label = ({ cancel: editingText('Abbrechen', 'Cancel'), retry: editingText('Erneut versuchen', 'Retry'), remove: editingText('Entfernen', 'Remove'), reveal: editingText('Ordner', 'Folder'), 'move-up': editingText('Nach oben', 'Move up'), 'move-down': editingText('Nach unten', 'Move down') })[action as 'cancel' | 'retry' | 'remove' | 'reveal' | 'move-up' | 'move-down'];
                const button = editingButton(label, () => { void editingOperation(() => editingApi().exportJobAction(action as 'cancel' | 'retry' | 'remove' | 'reveal' | 'move-up' | 'move-down', job.id)); });
                button.dataset.action = action; actions.append(button);
            }
        }
        for (const button of Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))) {
            const position = waitingPositions.get(job.id) ?? -1;
            button.disabled = editingWorkflowBusy || button.dataset.action === 'move-up' && position <= 0 || button.dataset.action === 'move-down' && position >= waiting.length - 1;
        }
    }
    const clear = document.getElementById('editingJobsClear') as HTMLButtonElement | null;
    if (clear) clear.disabled = editingWorkflowBusy || !editingWorkflowJobs.some(job => job.status === 'completed');
    const empty = document.getElementById('editingJobsEmpty'); if (empty) empty.hidden = editingWorkflowJobs.length > 0;
    const start = document.getElementById('editingJobsStart') as HTMLButtonElement | null;
    if (start) { start.textContent = editingWorkflowPaused ? editingText('Starten', 'Start') : editingText('Anhalten', 'Pause'); start.disabled = editingWorkflowBusy || !editingWorkflowJobs.some(job => job.status === 'queued' || job.status === 'running'); }
    const count = document.getElementById('editingJobCount'); if (count) count.textContent = formatUiNumber(editingWorkflowJobs.length);
}
function initializeEditingWorkflows(): void {
    if (editingWorkflowInitialized) { refreshEditingWorkflowLanguage(); return; }
    if (typeof editingApi().listExportJobs !== 'function') return;
    const host = document.querySelector('#cutterTab .cutter-container');
    if (!host) return;
    editingWorkflowInitialized = true;
    const toolbar = document.createElement('div'); toolbar.className = 'editing-project-toolbar';
    const label = document.createElement('label'); label.textContent = editingText('Projekt', 'Project');
    const input = document.createElement('input'); input.type = 'text'; input.id = 'editingProjectName'; input.maxLength = 120; input.placeholder = editingText('Projektname', 'Project name'); input.addEventListener('input', refreshEditingWorkflowControls); label.append(input); toolbar.append(label);
    const commands: Array<[string, () => void]> = [
        [editingText('Öffnen', 'Open'), () => { void openNamedEditingProject(); }],
        [editingText('Zuletzt verwendet', 'Recent projects'), () => { void showRecentEditingProjects(); }],
        [editingText('Speichern', 'Save'), () => { void saveNamedEditingProject(); }],
        [editingText('Variante speichern', 'Save variant'), () => { void saveNamedEditingProject(true); }],
        [editingText('Export vormerken', 'Queue export'), () => { const project = getCutterProjectPayload(); if (cutterFile && project && !cutterCutDraft) void editingOperation(() => editingApi().enqueueCutterExport(cutterFile!.token, project)); }],
    ];
    for (const [index, command] of commands.entries()) {
        const existing = index === 0 ? document.getElementById('cutterOpenProjectBtn') : index === 2 ? document.getElementById('cutterSaveProjectBtn') : null;
        if (existing) { existing.dataset.editingOperation = String(index); continue; }
        const button = editingButton(command[0], command[1]); button.dataset.editingOperation = String(index); toolbar.append(button);
    }
    host.prepend(toolbar);
    const error = document.createElement('details'); error.id = 'editingWorkflowError'; error.hidden = true; const errorTitle = document.createElement('summary'); errorTitle.textContent = editingText('Fehlerdetails', 'Error details'); error.append(errorTitle, document.createElement('pre')); toolbar.after(error);
    const recent = document.createElement('dialog'); recent.id = 'editingRecentProjects'; recent.className = 'editing-recent-dialog';
    const heading = document.createElement('h2'); heading.textContent = editingText('Zuletzt verwendete Projekte', 'Recent projects'); recent.append(heading);
    const filters = document.createElement('div'); filters.className = 'editing-recent-filters';
    const searchLabel = document.createElement('label');
    const searchCaption = document.createElement('span'); searchCaption.id = 'editingProjectSearchLabel'; searchCaption.textContent = editingText('Suche', 'Search');
    const search = document.createElement('input'); search.id = 'editingProjectSearch'; search.type = 'search'; search.maxLength = 200; search.autocomplete = 'off'; search.addEventListener('input', renderRecentEditingProjects); searchLabel.append(searchCaption, search);
    const sortLabel = document.createElement('label');
    const sortCaption = document.createElement('span'); sortCaption.id = 'editingProjectSortLabel'; sortCaption.textContent = editingText('Sortierung', 'Sort order');
    const sort = document.createElement('select'); sort.id = 'editingProjectSort';
    for (const [value, caption] of [['recent', editingText('Zuletzt geändert', 'Recently changed')], ['oldest', editingText('Älteste zuerst', 'Oldest first')], ['name', editingText('Name', 'Name')]]) sort.add(new Option(caption, value));
    sort.addEventListener('change', renderRecentEditingProjects); sortLabel.append(sortCaption, sort);
    const projectCount = document.createElement('span'); projectCount.id = 'editingProjectCount'; projectCount.setAttribute('role', 'status');
    filters.append(searchLabel, sortLabel, projectCount); recent.append(filters);
    const recentList = document.createElement('div'); recentList.className = 'editing-recent-list'; recent.append(recentList, editingButton(editingText('Schließen', 'Close'), () => recent.close())); document.body.append(recent);
    const panel = document.createElement('section'); panel.className = 'editing-jobs-panel'; panel.id = 'editingJobsPanel';
    const header = document.createElement('div'); header.className = 'editing-jobs-header'; const title = document.createElement('h3'); title.textContent = editingText('Exportaufträge', 'Export queue'); const count = document.createElement('span'); count.id = 'editingJobCount'; header.append(title, count);
    const start = editingButton(editingText('Starten', 'Start'), () => { void editingOperation(() => editingApi().exportJobAction(editingWorkflowPaused ? 'start' : 'pause')); }); start.id = 'editingJobsStart'; header.append(start);
    const clear = editingButton(editingText('Gespeicherte entfernen', 'Remove saved'), () => { void editingOperation(() => editingApi().exportJobAction('clear-completed')); }); clear.id = 'editingJobsClear'; header.append(clear); panel.append(header);
    const empty = document.createElement('p'); empty.id = 'editingJobsEmpty'; empty.textContent = editingText('Keine Exportaufträge.', 'No export jobs.'); panel.append(empty);
    const list = document.createElement('div'); list.id = 'editingJobList'; list.className = 'editing-job-list'; panel.append(list); host.append(panel);
    const mergeToolbar = document.querySelector('#mergeTab .merge-actions');
    if (mergeToolbar) {
        const mergeButton = editingButton(editingText('Export vormerken', 'Queue export'), () => { void submitMergeTimeline(false); });
        mergeButton.id = 'editingMergeQueue';
        const actions = document.createElement('div'); actions.className = 'editing-merge-queue-actions';
        actions.append(mergeButton);
        const mergeNow = document.getElementById('btnMerge'); if (mergeNow) actions.append(mergeNow);
        mergeToolbar.append(actions);
    }
    const mergeMode = document.createElement('dialog'); mergeMode.id = 'editingMergeMode'; mergeMode.className = 'editing-recent-dialog';
    document.body.append(mergeMode);
    const movePanel = () => {
        const mergeTab = document.getElementById('mergeTab');
        const target = mergeTab?.classList.contains('active') ? document.getElementById('mergeJobsDialog') : host;
        if (target && panel.parentElement !== target) target.append(panel);
    };
    const observer = new MutationObserver(movePanel);
    for (const id of ['cutterTab', 'mergeTab']) { const tab = document.getElementById(id); if (tab) observer.observe(tab, { attributes: true, attributeFilter: ['class'] }); }
    movePanel();
    const controlObserver = new MutationObserver(refreshEditingWorkflowControls);
    for (const id of ['btnCut', 'cutterSaveProjectBtn', 'btnMerge']) { const control = document.getElementById(id); if (control) controlObserver.observe(control, { attributes: true, attributeFilter: ['disabled'] }); }
    refreshEditingWorkflowControls();
    editingApi().onExportJobsChanged(state => { editingWorkflowJobs = state.jobs; editingWorkflowPaused = state.paused; renderEditingJobs(); });
    void editingOperation(() => editingApi().listExportJobs(), result => { editingWorkflowJobs = result.jobs || []; editingWorkflowPaused = result.paused !== false; renderEditingJobs(); });
}

function refreshEditingWorkflowLanguage(): void {
    const toolbar = document.querySelector('.editing-project-toolbar');
    if (!toolbar) return;
    const label = toolbar.querySelector('label'); if (label?.firstChild) label.firstChild.nodeValue = editingText('Projekt', 'Project');
    const input = toolbar.querySelector('input'); if (input) input.placeholder = editingText('Projektname', 'Project name');
    const captions = [editingText('Öffnen', 'Open'), editingText('Zuletzt verwendet', 'Recent projects'), editingText('Speichern', 'Save'), editingText('Variante speichern', 'Save variant'), editingText('Export vormerken', 'Queue export')];
    toolbar.querySelectorAll('button').forEach(button => { button.textContent = captions[Number(button.dataset.editingOperation)]; });
    const update = (selector: string, text: string) => { const node = document.querySelector(selector); if (node) node.textContent = text; };
    update('#editingWorkflowError summary', editingText('Fehlerdetails', 'Error details'));
    update('#editingRecentProjects h2', editingText('Zuletzt verwendete Projekte', 'Recent projects'));
    update('#editingProjectSearchLabel', editingText('Suche', 'Search'));
    update('#editingProjectSortLabel', editingText('Sortierung', 'Sort order'));
    update('#editingProjectSort option[value=recent]', editingText('Zuletzt geändert', 'Recently changed'));
    update('#editingProjectSort option[value=oldest]', editingText('Älteste zuerst', 'Oldest first'));
    renderRecentEditingProjects();
    update('#editingRecentProjects > button', editingText('Schließen', 'Close'));
    update('.editing-jobs-header h3', editingText('Exportaufträge', 'Export queue'));
    update('#editingJobsClear', editingText('Gespeicherte entfernen', 'Remove saved'));
    update('#editingJobsEmpty', editingText('Keine Exportaufträge.', 'No export jobs.'));
    update('#editingMergeQueue', editingText('Export vormerken', 'Queue export'));
    update('#editingMergeMode h2', editingText('Zusammenfügen', 'Merge'));
    document.querySelectorAll('.editing-job details summary').forEach(node => { node.textContent = editingText('Details', 'Details'); });
    renderEditingJobs();
}

function refreshEditingWorkflowControls(): void {
    renderEditingJobs();
    const mergeQueue = document.getElementById('editingMergeQueue') as HTMLButtonElement | null;
    const mergeNow = document.getElementById('btnMerge') as HTMLButtonElement | null;
    const mergeDisabled = editingWorkflowBusy || !mergeNow || mergeNow.disabled;
    if (mergeQueue && mergeQueue.disabled !== mergeDisabled) mergeQueue.disabled = mergeDisabled;
    const input = document.getElementById('editingProjectName') as HTMLInputElement | null;
    if (input && cutterFile && input.dataset.source !== cutterFile.token) {
        input.dataset.source = cutterFile.token;
        input.value = cutterFile.name?.replace(/\.[^.]+$/, '') || '';
    }
    const usable = Boolean(cutterFile && getCutterProjectPayload() && !cutterCutDraft && !isCutting);
    document.querySelectorAll<HTMLButtonElement>('[data-editing-operation]').forEach(button => {
        const index = Number(button.dataset.editingOperation);
        const disabled = editingWorkflowBusy || (index >= 2 && !usable) || (index === 2 || index === 3) && !input?.value.trim() || index === 0 && isCutting;
        if (button.disabled !== disabled) button.disabled = disabled;
    });
}

async function showMergeExportOptions(startImmediately = true): Promise<void> {
    if (workspaceLoading || isMerging || mergeFilePickerInFlight || mergeFiles.length < 2 || mergeFiles.some(file => file.missing)) return;
    const ids = mergeFiles.map(file => file.id);
    const dialog = document.getElementById('editingMergeMode') as HTMLDialogElement;
    if (!dialog) return;
    dialog.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = editingText('Zusammenfügen', 'Merge');
    const state = document.createElement('p'); state.textContent = editingText('Videos werden geprüft …', 'Checking videos …');
    const cancel = editingButton(editingText('Abbrechen', 'Cancel'), () => dialog.close());
    dialog.append(heading, state, cancel); dialog.showModal();
    await editingOperation(() => editingApi().inspectMergeExport(ids), result => {
        if (!dialog.open || !result.compatibility) return;
        const report = result.compatibility;
        state.textContent = report.copyAllowed ? editingText('Originalqualität bleibt erhalten.', 'Original quality is preserved.') : editingText('Die Videoformate unterscheiden sich.', 'The video formats differ.');
        const list = document.createElement('div'); list.className = 'editing-merge-sources';
        for (const file of report.files) {
            const row = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('span');
            name.textContent = file.name;
            detail.textContent = file.width + ' × ' + file.height + ' · ' + Number(file.fps.toFixed(3)).toLocaleString(currentLanguage) + ' FPS · ' + file.codec.toUpperCase() + ' · ' + file.format.bitDepth + '-Bit ' + (file.format.hdr ? 'HDR' : 'SDR') + ' · ' + formatUiNumber(file.audioTracks) + editingText(' Tonspuren', ' audio tracks');
            row.append(name, detail); list.append(row);
        }
        dialog.insertBefore(list, cancel);
        const actions = document.createElement('div'); actions.className = 'editing-merge-actions';
        for (const mode of ['copy', 'encode'] as const) {
            const button = editingButton(mode === 'copy' ? editingText('Original beibehalten', 'Keep original') : editingText('Neu codieren', 'Re-encode'), () => {
                dialog.close();
                void editingOperation(() => editingApi().enqueueMergeExport(ids, mode), async () => {
                    if (startImmediately) {
                        const started = await editingApi().exportJobAction('start');
                        if (!started.success) throw new Error(started.error);
                    }
                });
            });
            button.disabled = mode === 'copy' ? !report.copyAllowed : !report.encodeAllowed;
            actions.append(button);
        }
        dialog.insertBefore(actions, cancel);
        if (!report.copyAllowed && report.encodeAllowed) {
            const hint = document.createElement('p'); hint.textContent = editingText('Neu codieren: H.264/AAC, Größe und Bildrate des ersten Videos.', 'Re-encode: H.264/AAC, first video dimensions and frame rate.'); dialog.insertBefore(hint, actions);
        }
        if (!report.copyAllowed && !report.encodeAllowed) state.textContent = editingText('Diese Formate lassen sich nicht ohne Informationsverlust zusammenfügen.', 'These formats cannot be merged without losing source information.');
    });
}
