const MCP_TEXT = {
    de: {
        serverTitle: 'MCP-Server',
        serverHint: 'Zugang für KI-Assistenten wie Claude oder ChatGPT. Sie lesen VOD-Daten, füllen die Warteschlange und schneiden Dateien ohne Neukodierung.',
        enabled: 'MCP-Server aktivieren',
        network: 'Zugriff aus dem Netzwerk erlauben',
        port: 'Port',
        publicUrl: 'Öffentliche Adresse (optional)',
        statusOff: 'Nicht aktiv.',
        statusLocal: 'Aktiv, nur auf diesem PC erreichbar: {url}',
        statusNetwork: 'Aktiv im Netzwerk:\n{url}',
        errorPort: 'Port {port} ist belegt. Anderen Port eintragen.',
        errorAccess: 'Port {port} darf nicht geöffnet werden. Anderen Port eintragen.',
        errorFailed: 'Der Server wurde nicht gestartet. Details stehen im Debug-Log.',
        unavailable: 'Der Windows-Schlüsselspeicher ist nicht verfügbar. Der Zugriffsschlüssel kann nicht gespeichert werden.',
        networkNote: 'Die Verbindung ist unverschlüsselt (HTTP). Für Zugriffe über das Internet einen HTTPS-Reverse-Proxy oder Tunnel vorschalten und dessen Adresse als öffentliche Adresse eintragen.',
        activity: '{count} Anfragen seit Programmstart. Letzte Aktion: {tool}, {time}.',
        activityNone: 'Noch keine Anfragen seit Programmstart.',
        connectTitle: 'Verbindung einrichten',
        connectHint: 'Adresse und Zugriffsschlüssel in den KI-Client übertragen.',
        copyClaudeCode: 'Befehl für Claude Code kopieren',
        copyJson: 'JSON-Konfiguration kopieren',
        copySecretUrl: 'Adresse mit Schlüssel kopieren',
        copyUrl: 'Adresse kopieren',
        copyToken: 'Zugriffsschlüssel kopieren',
        copyTarget: 'Die Kopierschaltflächen verwenden die Adresse {url}.',
        copyAddress: 'Adresse für die Kopierschaltflächen',
        addressPublic: '{url} (öffentliche Adresse)',
        addressNetwork: '{url} (Netzwerk)',
        addressLocal: '{url} (nur dieser PC)',
        firewallNote: 'Andere Rechner erreichen den Server nur, wenn Port {port} (TCP) in der Windows-Firewall und bei gemieteten Servern zusätzlich in der Firewall des Anbieters freigegeben ist.',
        clientNote: 'Claude Code und Claude Desktop senden den Schlüssel als Bearer-Token. Für ChatGPT und claude.ai die Adresse mit Schlüssel eintragen und „Keine Authentifizierung“ wählen; beide benötigen eine öffentliche HTTPS-Adresse.',
        regenerate: 'Neuen Zugriffsschlüssel erzeugen',
        regenerateConfirm: 'Neuen Zugriffsschlüssel erzeugen? Bereits eingerichtete KI-Clients verlieren den Zugriff, bis der neue Schlüssel eingetragen ist.',
        regenerated: 'Neuer Zugriffsschlüssel erzeugt.',
        copied: 'In die Zwischenablage kopiert.',
        copyFailed: 'Kopieren nicht möglich. MCP-Server zuerst aktivieren.',
        invalidPort: 'Port zwischen 1024 und 65535 eintragen.',
        invalidUrl: 'Adresse mit http:// oder https:// eintragen.',
        saveFailed: 'Die Einstellung wurde nicht gespeichert.',
        activityTitle: 'Aktivität',
        activityHint: 'Letzte Aufrufe der KI und Dateiaufträge.',
        callsTitle: 'Letzte Aufrufe',
        callsEmpty: 'Noch keine Aufrufe seit Programmstart.',
        jobsTitle: 'Dateiaufträge',
        jobsEmpty: 'Keine Dateiaufträge.',
        jobQueued: 'Wartet',
        jobRunning: 'Läuft, {progress} %',
        jobCompleted: 'Fertig',
        jobFailed: 'Fehlgeschlagen: {error}',
        jobCancelled: 'Abgebrochen',
    },
    en: {
        serverTitle: 'MCP server',
        serverHint: 'Access for AI assistants such as Claude or ChatGPT. They read VOD data, fill the queue and cut files without re-encoding.',
        enabled: 'Enable MCP server',
        network: 'Allow access from the network',
        port: 'Port',
        publicUrl: 'Public address (optional)',
        statusOff: 'Not active.',
        statusLocal: 'Active, reachable on this PC only: {url}',
        statusNetwork: 'Active on the network:\n{url}',
        errorPort: 'Port {port} is in use. Enter another port.',
        errorAccess: 'Port {port} cannot be opened. Enter another port.',
        errorFailed: 'The server was not started. See the debug log for details.',
        unavailable: 'The Windows credential store is unavailable. The access key cannot be saved.',
        networkNote: 'The connection is unencrypted (HTTP). For access over the internet, put an HTTPS reverse proxy or tunnel in front and enter its address as the public address.',
        activity: '{count} requests since the app started. Last action: {tool}, {time}.',
        activityNone: 'No requests since the app started.',
        connectTitle: 'Set up the connection',
        connectHint: 'Transfer the address and access key to the AI client.',
        copyClaudeCode: 'Copy command for Claude Code',
        copyJson: 'Copy JSON configuration',
        copySecretUrl: 'Copy address with key',
        copyUrl: 'Copy address',
        copyToken: 'Copy access key',
        copyTarget: 'The copy buttons use the address {url}.',
        copyAddress: 'Address used by the copy buttons',
        addressPublic: '{url} (public address)',
        addressNetwork: '{url} (network)',
        addressLocal: '{url} (this PC only)',
        firewallNote: 'Other computers reach the server only if port {port} (TCP) is open in the Windows Firewall and, on rented servers, also in the firewall of the provider.',
        clientNote: 'Claude Code and Claude Desktop send the key as a bearer token. For ChatGPT and claude.ai enter the address with key and choose "No authentication"; both need a public HTTPS address.',
        regenerate: 'Create new access key',
        regenerateConfirm: 'Create a new access key? AI clients that are already set up lose access until the new key is entered.',
        regenerated: 'New access key created.',
        copied: 'Copied to the clipboard.',
        copyFailed: 'Nothing to copy. Enable the MCP server first.',
        invalidPort: 'Enter a port between 1024 and 65535.',
        invalidUrl: 'Enter an address starting with http:// or https://.',
        saveFailed: 'The setting was not saved.',
        activityTitle: 'Activity',
        activityHint: 'Recent calls by the AI and file jobs.',
        callsTitle: 'Recent calls',
        callsEmpty: 'No calls since the app started.',
        jobsTitle: 'File jobs',
        jobsEmpty: 'No file jobs.',
        jobQueued: 'Waiting',
        jobRunning: 'Running, {progress} %',
        jobCompleted: 'Finished',
        jobFailed: 'Failed: {error}',
        jobCancelled: 'Cancelled',
    },
};

let mcpState: McpState | null = null;
let mcpNotice = '';
let mcpRefreshTimer: number | null = null;
let mcpCopyChoice = '';

function mcpText(): typeof MCP_TEXT.de {
    return currentLanguage === 'en' ? MCP_TEXT.en : MCP_TEXT.de;
}

function mcpCopyAddress(): string {
    const offered = mcpState?.copyAddresses ?? [];
    return offered.includes(mcpCopyChoice) ? mcpCopyChoice : offered[0] ?? '';
}

function renderMcpSettings(): void {
    const text = mcpText();
    const labels: Record<string, string> = {
        mcpServerTitle: text.serverTitle, mcpServerHint: text.serverHint, mcpEnabledLabel: text.enabled, mcpNetworkLabel: text.network,
        mcpPortLabel: text.port, mcpPublicUrlLabel: text.publicUrl, mcpConnectTitle: text.connectTitle, mcpConnectHint: text.connectHint,
        mcpCopyClaudeCode: text.copyClaudeCode, mcpCopyJson: text.copyJson, mcpCopySecretUrl: text.copySecretUrl, mcpCopyUrl: text.copyUrl,
        mcpCopyToken: text.copyToken, mcpClientNote: text.clientNote, mcpRegenerateToken: text.regenerate, mcpNetworkNote: text.networkNote,
        mcpCopyAddressLabel: text.copyAddress, mcpActivityTitle: text.activityTitle, mcpActivityHint: text.activityHint, mcpCallsTitle: text.callsTitle, mcpJobsTitle: text.jobsTitle,
    };
    for (const [id, value] of Object.entries(labels)) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }
    const state = mcpState;
    const enabledToggle = byId<HTMLInputElement>('mcpEnabledToggle'), networkToggle = byId<HTMLInputElement>('mcpNetworkToggle');
    const portInput = byId<HTMLInputElement>('mcpPort'), urlInput = byId<HTMLInputElement>('mcpPublicUrl');
    if (!state || !enabledToggle) return;
    enabledToggle.checked = state.enabled;
    enabledToggle.disabled = !state.available;
    networkToggle.checked = state.networkAccess;
    if (document.activeElement !== portInput) portInput.value = String(state.port);
    if (document.activeElement !== urlInput) urlInput.value = state.publicUrl;
    const status = byId<HTMLElement>('mcpStatusLine');
    const port = String(state.port);
    status.dataset.state = !state.available || state.error ? 'error' : state.running ? 'active' : 'idle';
    status.textContent = !state.available ? text.unavailable
        : state.error === 'port-in-use' ? text.errorPort.replace('{port}', port)
            : state.error === 'no-access' ? text.errorAccess.replace('{port}', port)
                : state.error ? text.errorFailed
                    : !state.running ? text.statusOff
                        : state.networkAccess ? text.statusNetwork.replace('{url}', [...state.networkUrls, state.localUrl].join('\n'))
                            : text.statusLocal.replace('{url}', state.localUrl);
    byId<HTMLElement>('mcpNetworkNote').hidden = !state.networkAccess;
    const firewallNote = byId<HTMLElement>('mcpFirewallNote');
    firewallNote.hidden = !state.networkAccess;
    firewallNote.textContent = text.firewallNote.replace('{port}', port);
    const activity = byId<HTMLElement>('mcpActivityLine');
    activity.hidden = !state.running;
    activity.textContent = state.lastActivityAt
        ? text.activity.replace('{count}', new Intl.NumberFormat(getIntlLocale()).format(state.requests))
            .replace('{tool}', state.lastTool || 'MCP')
            .replace('{time}', new Intl.DateTimeFormat(getIntlLocale(), { timeStyle: 'medium' }).format(new Date(state.lastActivityAt)))
        : text.activityNone;
    const offered = state.copyAddresses, chosen = mcpCopyAddress();
    const addressSelect = byId<HTMLSelectElement>('mcpCopyAddress');
    const optionKey = [currentLanguage, ...offered].join('\n');
    if (addressSelect.dataset.options !== optionKey) {
        addressSelect.replaceChildren(...offered.map((address) => {
            const label = address === state.localUrl ? text.addressLocal : state.networkUrls.includes(address) ? text.addressNetwork : text.addressPublic;
            return new Option(label.replace('{url}', address), address);
        }));
        addressSelect.dataset.options = optionKey;
    }
    addressSelect.value = chosen;
    byId<HTMLElement>('mcpCopyAddressGroup').hidden = offered.length < 2;
    const copyTarget = byId<HTMLElement>('mcpCopyTarget');
    copyTarget.hidden = offered.length > 1;
    copyTarget.textContent = text.copyTarget.replace('{url}', chosen);
    for (const id of ['mcpCopyClaudeCode', 'mcpCopyJson', 'mcpCopySecretUrl', 'mcpCopyToken', 'mcpRegenerateToken']) {
        byId<HTMLButtonElement>(id).disabled = !state.tokenConfigured;
    }
    byId<HTMLElement>('mcpNotice').textContent = mcpNotice;
    const time = new Intl.DateTimeFormat(getIntlLocale(), { timeStyle: 'medium' });
    renderMcpList('mcpRecentCalls', state.recentCalls.map(call => ({ lead: time.format(new Date(call.at)), text: call.tool, state: '' })), text.callsEmpty);
    renderMcpList('mcpFileJobs', state.fileJobs.map(job => ({
        lead: job.status === 'queued' ? text.jobQueued : job.status === 'running' ? text.jobRunning.replace('{progress}', String(job.progress))
            : job.status === 'completed' ? text.jobCompleted : job.status === 'cancelled' ? text.jobCancelled : text.jobFailed.replace('{error}', mcpJobError(job.error)),
        text: job.name,
        state: job.status,
    })), text.jobsEmpty, true);
}

const MCP_JOB_ERRORS_DE: Array<[RegExp, string]> = [
    [/^The job was not continued because its files are no longer inside the download folder\.$/, 'Der Auftrag wurde nicht fortgesetzt, weil seine Dateien nicht mehr im Download-Ordner liegen.'],
    [/^Output file already exists: (.+)$/, 'Die Ausgabedatei existiert bereits: $1'],
    [/^Source file not found: (.+)$/, 'Quelldatei nicht gefunden: $1'],
    [/^Source file is not readable as video: (.+)$/, 'Quelldatei ist nicht als Video lesbar: $1'],
    [/^The sources cannot be joined without re-encoding because their formats differ \((.+)\)\.$/, 'Die Quellen lassen sich nicht ohne Neukodierung zusammenfügen, weil ihre Formate abweichen ($1).'],
    [/^The output is (.+) s long, expected (.+) s\.$/, 'Die Ausgabe ist $1 s lang, erwartet waren $2 s.'],
];

function mcpJobError(error: string | null): string {
    if (!error) return '–';
    if (mcpText() !== MCP_TEXT.de) return error;
    for (const [pattern, german] of MCP_JOB_ERRORS_DE) if (pattern.test(error)) return error.replace(pattern, german);
    return error;
}

function renderMcpList(id: string, rows: Array<{ lead: string; text: string; state: string }>, emptyText: string, leadLast = false): void {
    const list = document.getElementById(id);
    if (!list) return;
    const items = rows.length ? rows.map((row) => {
        const item = document.createElement('li');
        const lead = document.createElement('span'), main = document.createElement('span');
        lead.textContent = leadLast ? row.text : row.lead;
        main.textContent = leadLast ? row.lead : row.text;
        if (row.state) item.dataset.state = row.state;
        if (leadLast) item.classList.add('mcp-list-job');
        item.append(lead, main);
        return item;
    }) : [Object.assign(document.createElement('li'), { className: 'mcp-list-empty', textContent: emptyText })];
    list.replaceChildren(...items);
}

async function reloadConfigAfterExternalChange(): Promise<void> {
    try {
        config = { ...config, ...(await window.api.getConfig()) };
        renderStreamers();
    } catch {
        return;
    }
}

function setMcpNotice(message: string): void {
    mcpNotice = message;
    renderMcpSettings();
}

async function refreshMcpState(): Promise<void> {
    try {
        const state = await window.api.getMcpState();
        if (state) mcpState = state;
    } catch {
        return;
    }
    renderMcpSettings();
}

async function saveMcpSettings(settings: McpSettingsInput): Promise<void> {
    try {
        const state = await window.api.setMcpSettings(settings);
        if (state) mcpState = state;
        mcpNotice = state?.rejected === 'public-url' ? mcpText().invalidUrl : '';
    } catch {
        mcpNotice = mcpText().saveFailed;
    }
    renderMcpSettings();
}

async function copyMcpValue(kind: McpCopyKind): Promise<void> {
    const copied = await window.api.copyMcpValue(kind, mcpCopyAddress()).catch(() => false);
    setMcpNotice(copied ? mcpText().copied : mcpText().copyFailed);
}

async function regenerateMcpToken(): Promise<void> {
    if (!confirm(mcpText().regenerateConfirm)) return;
    try {
        const state = await window.api.regenerateMcpToken();
        if (state) mcpState = state;
        mcpNotice = state && state.rejected !== 'token' ? mcpText().regenerated : mcpText().saveFailed;
    } catch {
        mcpNotice = mcpText().saveFailed;
    }
    renderMcpSettings();
}

function initMcpSettings(): void {
    const enabledToggle = document.getElementById('mcpEnabledToggle') as HTMLInputElement | null;
    if (!enabledToggle) return;
    const networkToggle = byId<HTMLInputElement>('mcpNetworkToggle'), portInput = byId<HTMLInputElement>('mcpPort'), urlInput = byId<HTMLInputElement>('mcpPublicUrl');
    enabledToggle.addEventListener('change', () => { void saveMcpSettings({ enabled: enabledToggle.checked }); });
    networkToggle.addEventListener('change', () => { void saveMcpSettings({ networkAccess: networkToggle.checked }); });
    portInput.addEventListener('change', () => {
        const port = Number(portInput.value);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            portInput.value = String(mcpState?.port ?? '');
            setMcpNotice(mcpText().invalidPort);
            return;
        }
        void saveMcpSettings({ port });
    });
    urlInput.addEventListener('change', () => {
        const value = urlInput.value.trim();
        if (value && !/^https?:\/\/[^\s/]+/i.test(value)) {
            urlInput.value = mcpState?.publicUrl ?? '';
            setMcpNotice(mcpText().invalidUrl);
            return;
        }
        void saveMcpSettings({ publicUrl: value });
    });
    const addressSelect = byId<HTMLSelectElement>('mcpCopyAddress');
    addressSelect.addEventListener('change', () => {
        mcpCopyChoice = addressSelect.value;
        renderMcpSettings();
    });
    window.api.onConfigChanged(() => { void reloadConfigAfterExternalChange(); });
    window.api.onMcpStateChanged((state) => {
        mcpState = state;
        renderMcpSettings();
    });
    if (mcpRefreshTimer === null) {
        mcpRefreshTimer = window.setInterval(() => {
            if (canRunSettingsAutoRefresh('mcpStatusLine')) void refreshMcpState();
        }, 5000);
    }
    void refreshMcpState();
}
