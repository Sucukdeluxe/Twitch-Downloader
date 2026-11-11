import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ManagedToolId = 'streamlink' | 'ffmpeg';

export interface ExternalToolManifest {
    id: ManagedToolId;
    version: string;
    sourceUrl: string;
    archiveName: string;
    sha256: string;
    executables: string[];
}

export interface ManagedToolStatus {
    id: ManagedToolId;
    version: string;
    sourceUrl: string;
    archiveName: string;
    state: 'missing' | 'installing' | 'verified' | 'unverified' | 'corrupt';
    verified: boolean;
}

export interface ManagedToolInstallResult {
    success: boolean;
    status: ManagedToolStatus;
    error?: 'download-failed' | 'archive-hash-mismatch' | 'extract-failed' | 'required-executable-missing' | 'promotion-failed' | 'recovery-journal-invalid' | 'recovery-restore-failed';
    detail?: string;
    diagnostics: string[];
}

interface ManagedToolRecord {
    id: ManagedToolId;
    version: string;
    sourceUrl: string;
    archiveName: string;
    sha256: string;
    executableHashes?: Record<string, string>;
}

interface InstallationJournal {
    installationDirectory: string;
    backupDirectory: string;
    stagingDirectory: string;
    phase: 'staged' | 'backup-created' | 'promoted';
}

interface InstallationInspection {
    state: ManagedToolStatus['state'];
    version: string;
    layoutUsable: boolean;
    strictValid: boolean;
}

interface RecoveryResult {
    success: boolean;
    error?: NonNullable<ManagedToolInstallResult['error']>;
    detail?: string;
}

export interface ManagedToolInstallerOptions {
    installationDirectory: string;
    temporaryDirectory: string;
    download(sourceUrl: string, archivePath: string): Promise<void>;
    extract(archivePath: string, destinationPath: string): Promise<void>;
    rename?(sourcePath: string, destinationPath: string): void;
    remove?(targetPath: string, options: { recursive?: boolean; force?: boolean }): void;
    diagnostic?(message: string, details: Record<string, string>): void;
}

const RECORD_FILE_NAME = '.tool-manifest.json';
const JOURNAL_SUFFIX = '.transaction.json';
const INVALID_JOURNAL = Symbol('invalid-journal');

function findFileRecursive(rootDir: string, fileName: string): string | null {
    const direct = path.join(rootDir, fileName);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(rootDir, entry.name);
            if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                return entryPath;
            }
            if (entry.isDirectory()) {
                const nested = findFileRecursive(entryPath, fileName);
                if (nested) return nested;
            }
        }
    } catch {
        return null;
    }
    return null;
}

function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        let digest: string | null = null;
        stream.on('data', (chunk) => {
            hash.update(chunk);
        });
        stream.once('error', reject);
        stream.once('end', () => {
            digest = hash.digest('hex');
        });
        stream.once('close', () => {
            if (digest !== null) resolve(digest);
        });
    });
}

function isRecord(value: unknown): value is ManagedToolRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.version === 'string'
        && typeof record.sourceUrl === 'string'
        && typeof record.archiveName === 'string'
        && typeof record.sha256 === 'string';
}

function isJournal(value: unknown, installationDirectory: string): value is InstallationJournal {
    if (!value || typeof value !== 'object') return false;
    const journal = value as Record<string, unknown>;
    if (typeof journal.installationDirectory !== 'string'
        || typeof journal.backupDirectory !== 'string'
        || typeof journal.stagingDirectory !== 'string'
        || (journal.phase !== 'staged' && journal.phase !== 'backup-created' && journal.phase !== 'promoted')) {
        return false;
    }
    const expectedDirectory = path.resolve(installationDirectory);
    return path.resolve(journal.installationDirectory) === expectedDirectory
        && isInstallationSibling(expectedDirectory, journal.backupDirectory, '.backup-')
        && isInstallationSibling(expectedDirectory, journal.stagingDirectory, '.stage-');
}

function isInstallationSibling(installationDirectory: string, candidate: string, suffix: string): boolean {
    const resolvedCandidate = path.resolve(candidate);
    return path.dirname(resolvedCandidate) === path.dirname(installationDirectory)
        && path.basename(resolvedCandidate).startsWith(`${path.basename(installationDirectory)}${suffix}`);
}

function matchesManifest(record: ManagedToolRecord, manifest: ExternalToolManifest): boolean {
    return record.id === manifest.id
        && record.version === manifest.version
        && record.sourceUrl === manifest.sourceUrl
        && record.archiveName === manifest.archiveName
        && record.sha256 === manifest.sha256;
}

function hasExecutableHashes(record: ManagedToolRecord, executables: string[]): record is ManagedToolRecord & { executableHashes: Record<string, string> } {
    if (!record.executableHashes || typeof record.executableHashes !== 'object') return false;
    return executables.every((executable) => typeof record.executableHashes?.[executable] === 'string'
        && /^[a-f0-9]{64}$/i.test(record.executableHashes[executable]));
}

export class ManagedToolInstaller {
    private readonly inFlight = new Map<ManagedToolId, Promise<ManagedToolInstallResult>>();

    constructor(private readonly options: ManagedToolInstallerOptions) {}

    async status(manifest: ExternalToolManifest, includeInstallState = true): Promise<ManagedToolStatus> {
        if (includeInstallState && this.inFlight.has(manifest.id)) {
            return this.createStatus(manifest, 'installing', false);
        }

        const recovery = await this.recover(manifest, []);
        if (!recovery.success) {
            return this.createStatus(manifest, 'corrupt', false);
        }
        return await this.statusFromInspection(manifest);
    }

    async install(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        const currentStatus = await this.status(manifest);
        if (currentStatus.verified) {
            return Promise.resolve({ success: true, status: currentStatus, diagnostics: [] });
        }
        return this.start(manifest);
    }

    repair(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        return this.start(manifest);
    }

    async reset(manifest: ExternalToolManifest): Promise<ManagedToolStatus> {
        if (this.inFlight.has(manifest.id)) {
            return await this.status(manifest);
        }
        const diagnostics: string[] = [];
        const journal = await this.readJournal();
        if (isJournal(journal, this.options.installationDirectory)) {
            this.cleanup(journal.backupDirectory, true, diagnostics);
            this.cleanup(journal.stagingDirectory, true, diagnostics);
        }
        this.cleanup(this.options.installationDirectory, true, diagnostics);
        this.cleanup(this.journalPath(), false, diagnostics);
        return await this.status(manifest);
    }

    private start(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        const existing = this.inFlight.get(manifest.id);
        if (existing) return existing;

        const operation = Promise.resolve()
            .then(() => this.installOnce(manifest))
            .catch(async (error: unknown) => await this.failure(manifest, 'download-failed', this.errorText(error), []))
            .finally(() => {
                if (this.inFlight.get(manifest.id) === operation) {
                    this.inFlight.delete(manifest.id);
                }
            });
        this.inFlight.set(manifest.id, operation);
        return operation;
    }

    private async installOnce(manifest: ExternalToolManifest): Promise<ManagedToolInstallResult> {
        const uniqueSuffix = crypto.randomUUID();
        const archivePath = path.join(this.options.temporaryDirectory, `${uniqueSuffix}-${manifest.archiveName}`);
        const stagingDirectory = `${this.options.installationDirectory}.stage-${uniqueSuffix}`;
        const diagnostics: string[] = [];

        try {
            const recovery = await this.recover(manifest, diagnostics);
            if (!recovery.success) {
                return await this.failure(manifest, recovery.error!, recovery.detail, diagnostics);
            }

            fs.mkdirSync(this.options.temporaryDirectory, { recursive: true });
            await this.options.download(manifest.sourceUrl, archivePath);
            if ((await sha256File(archivePath)).toLowerCase() !== manifest.sha256.toLowerCase()) {
                return await this.failure(manifest, 'archive-hash-mismatch', undefined, diagnostics);
            }

            try {
                await this.options.extract(archivePath, stagingDirectory);
            } catch (error) {
                return await this.failure(manifest, 'extract-failed', this.errorText(error), diagnostics);
            }

            const executablePaths = this.executablePaths(stagingDirectory, manifest.executables);
            if (!executablePaths) {
                return await this.failure(manifest, 'required-executable-missing', undefined, diagnostics);
            }

            const executableHashes = Object.fromEntries(await Promise.all(executablePaths.map(async ([name, executablePath]) => [name, await sha256File(executablePath)] as const)));
            const record: ManagedToolRecord = {
                id: manifest.id,
                version: manifest.version,
                sourceUrl: manifest.sourceUrl,
                archiveName: manifest.archiveName,
                sha256: manifest.sha256,
                executableHashes
            };
            fs.writeFileSync(path.join(stagingDirectory, RECORD_FILE_NAME), JSON.stringify(record));

            const promotion = await this.promote(manifest, stagingDirectory, diagnostics);
            if (!promotion.success) {
                return await this.failure(manifest, promotion.error!, promotion.detail, diagnostics);
            }

            return { success: true, status: await this.statusFromInspection(manifest), diagnostics };
        } catch (error) {
            return await this.failure(manifest, 'download-failed', this.errorText(error), diagnostics);
        } finally {
            this.cleanup(archivePath, false, diagnostics);
            this.cleanup(stagingDirectory, true, diagnostics);
        }
    }

    private async promote(manifest: ExternalToolManifest, stagingDirectory: string, diagnostics: string[]): Promise<RecoveryResult> {
        const backupDirectory = `${this.options.installationDirectory}.backup-${crypto.randomUUID()}`;
        const journal: InstallationJournal = {
            installationDirectory: this.options.installationDirectory,
            backupDirectory,
            stagingDirectory,
            phase: 'staged'
        };

        try {
            this.writeJournal(journal, diagnostics);
            if (fs.existsSync(this.options.installationDirectory)) {
                this.rename(this.options.installationDirectory, backupDirectory);
                journal.phase = 'backup-created';
                this.writeJournal(journal, diagnostics);
            }
            this.rename(stagingDirectory, this.options.installationDirectory);
            journal.phase = 'promoted';
            this.writeJournal(journal, diagnostics);
            this.cleanup(backupDirectory, true, diagnostics);
            this.cleanup(this.journalPath(), false, diagnostics);
            return { success: true };
        } catch (error) {
            const recovery = await this.recover(manifest, diagnostics);
            return recovery.success
                ? { success: false, error: 'promotion-failed', detail: this.errorText(error) }
                : recovery;
        }
    }

    private async recover(manifest: ExternalToolManifest, diagnostics: string[]): Promise<RecoveryResult> {
        const journal = await this.readJournal();
        if (journal === undefined) {
            return { success: true };
        }
        if (!isJournal(journal, this.options.installationDirectory)) {
            return { success: false, error: 'recovery-journal-invalid', detail: 'Ungültiges Installationsjournal.' };
        }
        return await this.recoverJournal(manifest, journal, diagnostics);
    }

    private async recoverJournal(manifest: ExternalToolManifest, journal: InstallationJournal, diagnostics: string[]): Promise<RecoveryResult> {
        const active = await this.inspectInstallation(this.options.installationDirectory, manifest);
        if (active.strictValid || (journal.phase === 'staged' && active.layoutUsable)) {
            this.cleanup(journal.backupDirectory, true, diagnostics);
            this.cleanup(journal.stagingDirectory, true, diagnostics);
            this.cleanup(this.journalPath(), false, diagnostics);
            return { success: true };
        }

        const backup = await this.inspectInstallation(journal.backupDirectory, manifest);
        if (backup.layoutUsable) {
            let displacedDirectory: string | undefined;
            try {
                if (fs.existsSync(this.options.installationDirectory)) {
                    displacedDirectory = `${this.options.installationDirectory}.recovery-${crypto.randomUUID()}`;
                    this.rename(this.options.installationDirectory, displacedDirectory);
                }
                this.rename(journal.backupDirectory, this.options.installationDirectory);
            } catch (error) {
                return { success: false, error: 'recovery-restore-failed', detail: this.errorText(error) };
            }

            this.cleanup(journal.stagingDirectory, true, diagnostics);
            if (displacedDirectory) {
                this.cleanup(displacedDirectory, true, diagnostics);
            }
            this.cleanup(this.journalPath(), false, diagnostics);
            return { success: true };
        }

        const staging = await this.inspectInstallation(journal.stagingDirectory, manifest);
        if (journal.phase !== 'staged' || !staging.strictValid || fs.existsSync(this.options.installationDirectory)) {
            return { success: false, error: 'recovery-restore-failed', detail: 'Kein nutzbares Tool-Backup für die Wiederherstellung vorhanden.' };
        }

        try {
            this.rename(journal.stagingDirectory, this.options.installationDirectory);
        } catch (error) {
            return { success: false, error: 'recovery-restore-failed', detail: this.errorText(error) };
        }

        this.cleanup(this.journalPath(), false, diagnostics);
        return { success: true };
    }

    private async statusFromInspection(manifest: ExternalToolManifest): Promise<ManagedToolStatus> {
        const inspection = await this.inspectInstallation(this.options.installationDirectory, manifest);
        return this.createStatus(manifest, inspection.state, inspection.strictValid, inspection.version);
    }

    private async inspectInstallation(directory: string, manifest: ExternalToolManifest): Promise<InstallationInspection> {
        if (!fs.existsSync(directory)) {
            return { state: 'missing', version: manifest.version, layoutUsable: false, strictValid: false };
        }

        const executablePaths = this.executablePaths(directory, manifest.executables);
        if (!executablePaths) {
            return { state: 'corrupt', version: manifest.version, layoutUsable: false, strictValid: false };
        }

        const record = await this.readRecord(directory);
        if (!record || !isRecord(record)) {
            return { state: 'unverified', version: manifest.version, layoutUsable: true, strictValid: false };
        }
        if (!matchesManifest(record, manifest)) {
            return { state: 'unverified', version: record.version, layoutUsable: true, strictValid: false };
        }
        if (!hasExecutableHashes(record, manifest.executables)) {
            return { state: 'unverified', version: record.version, layoutUsable: true, strictValid: false };
        }

        try {
            const hashesMatch = (await Promise.all(executablePaths.map(async ([name, executablePath]) => (await sha256File(executablePath)).toLowerCase() === record.executableHashes[name].toLowerCase()))).every(Boolean);
            return hashesMatch
                ? { state: 'verified', version: record.version, layoutUsable: true, strictValid: true }
                : { state: 'corrupt', version: record.version, layoutUsable: true, strictValid: false };
        } catch {
            return { state: 'corrupt', version: record.version, layoutUsable: true, strictValid: false };
        }
    }

    private executablePaths(directory: string, executables: string[]): Array<[string, string]> | null {
        const paths = executables.map((name) => [name, findFileRecursive(directory, name)] as const);
        if (paths.some(([, executablePath]) => !executablePath)) {
            return null;
        }
        return paths as Array<[string, string]>;
    }

    private async readRecord(directory: string): Promise<unknown> {
        try {
            return JSON.parse(await fs.promises.readFile(path.join(directory, RECORD_FILE_NAME), 'utf8'));
        } catch {
            return null;
        }
    }

    private async readJournal(): Promise<unknown | typeof INVALID_JOURNAL | undefined> {
        try {
            if (!fs.existsSync(this.journalPath())) {
                return undefined;
            }
            return JSON.parse(await fs.promises.readFile(this.journalPath(), 'utf8'));
        } catch {
            return INVALID_JOURNAL;
        }
    }

    private writeJournal(journal: InstallationJournal, diagnostics: string[]): void {
        const journalPath = this.journalPath();
        const temporaryPath = `${journalPath}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryPath, JSON.stringify(journal));
            this.rename(temporaryPath, journalPath);
        } finally {
            this.cleanup(temporaryPath, false, diagnostics);
        }
    }

    private journalPath(): string {
        return `${this.options.installationDirectory}${JOURNAL_SUFFIX}`;
    }

    private rename(sourcePath: string, destinationPath: string): void {
        (this.options.rename ?? fs.renameSync)(sourcePath, destinationPath);
    }

    private cleanup(targetPath: string, recursive: boolean, diagnostics: string[]): void {
        try {
            (this.options.remove ?? fs.rmSync)(targetPath, { recursive, force: true });
        } catch (error) {
            const errorText = this.errorText(error);
            diagnostics.push(errorText);
            this.options.diagnostic?.('managed-tool-cleanup-failed', { path: targetPath, error: errorText });
        }
    }

    private createStatus(manifest: ExternalToolManifest, state: ManagedToolStatus['state'], verified: boolean, version = manifest.version): ManagedToolStatus {
        return {
            id: manifest.id,
            version,
            sourceUrl: manifest.sourceUrl,
            archiveName: manifest.archiveName,
            state,
            verified
        };
    }

    private async failure(manifest: ExternalToolManifest, error: NonNullable<ManagedToolInstallResult['error']>, detail: string | undefined, diagnostics: string[]): Promise<ManagedToolInstallResult> {
        return {
            success: false,
            error,
            detail,
            status: await this.statusFromInspection(manifest),
            diagnostics
        };
    }

    private errorText(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

export function createManagedToolInstaller(options: ManagedToolInstallerOptions): ManagedToolInstaller {
    return new ManagedToolInstaller(options);
}
