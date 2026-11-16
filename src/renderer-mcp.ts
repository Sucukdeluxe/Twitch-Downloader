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
        clientNote: 'Claude Code und Claude Desktop senden den Schlüssel als Bearer-Token. Für ChatGPT und claude.ai die Adresse mit Schlüssel eintragen und „Keine Authentifizierung“ wählen; beide benötigen eine öffentliche HTTPS-Adresse.',
        regenerate: 'Neuen Zugriffsschlüssel erzeugen',
        regenerateConfirm: 'Neuen Zugriffsschlüssel erzeugen? Bereits eingerichtete KI-Clients verlieren den Zugriff, bis der neue Schlüssel eingetragen ist.',
        regenerated: 'Neuer Zugriffsschlüssel erzeugt.',
        copied: 'In die Zwischenablage kopiert.',
        copyFailed: 'Kopieren nicht möglich. MCP-Server zuerst aktivieren.',
        invalidPort: 'Port zwischen 1024 und 65535 eintragen.',
        invalidUrl: 'Adresse mit http:// oder https:// eintragen.',
        saveFailed: 'Die Einstellung wurde nicht gespeichert.',
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
        clientNote: 'Claude Code and Claude Desktop send the key as a bearer token. For ChatGPT and claude.ai enter the address with key and choose "No authentication"; both need a public HTTPS address.',
        regenerate: 'Create new access key',
        regenerateConfirm: 'Create a new access key? AI clients that are already set up lose access until the new key is entered.',
        regenerated: 'New access key created.',
        copied: 'Copied to the clipboard.',
        copyFailed: 'Nothing to copy. Enable the MCP server first.',
        invalidPort: 'Enter a port between 1024 and 65535.',
        invalidUrl: 'Enter an address starting with http:// or https://.',
        saveFailed: 'The setting was not saved.',
    },
};

let mcpState: McpState | null = null;
let mcpNotice = '';
let mcpRefreshTimer: number | null = null;

function mcpText(): typeof MCP_TEXT.de {
    return currentLanguage === 'en' ? MCP_TEXT.en : MCP_TEXT.de;
}

function mcpCopyTarget(): 'public' | 'local' {
    return mcpState?.publicUrl ? 'public' : 'local';
}

function renderMcpSettings(): void {
    const text = mcpText();
    const labels: Record<string, string> = {
        mcpServerTitle: text.serverTitle, mcpServerHint: text.serverHint, mcpEnabledLabel: text.enabled, mcpNetworkLabel: text.network,
        mcpPortLabel: text.port, mcpPublicUrlLabel: text.publicUrl, mcpConnectTitle: text.connectTitle, mcpConnectHint: text.connectHint,
        mcpCopyClaudeCode: text.copyClaudeCode, mcpCopyJson: text.copyJson, mcpCopySecretUrl: text.copySecretUrl, mcpCopyUrl: text.copyUrl,
        mcpCopyToken: text.copyToken, mcpClientNote: text.clientNote, mcpRegenerateToken: text.regenerate, mcpNetworkNote: text.networkNote,
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
    const activity = byId<HTMLElement>('mcpActivityLine');
    activity.hidden = !state.running;
    activity.textContent = state.lastActivityAt
        ? text.activity.replace('{count}', new Intl.NumberFormat(getIntlLocale()).format(state.requests))
            .replace('{tool}', state.lastTool || 'MCP')
            .replace('{time}', new Intl.DateTimeFormat(getIntlLocale(), { timeStyle: 'medium' }).format(new Date(state.lastActivityAt)))
        : text.activityNone;
    const copyBase = state.publicUrl || state.localUrl.replace(/\/mcp$/, '');
    byId<HTMLElement>('mcpCopyTarget').textContent = text.copyTarget.replace('{url}', copyBase + '/mcp');
    for (const id of ['mcpCopyClaudeCode', 'mcpCopyJson', 'mcpCopySecretUrl', 'mcpCopyToken', 'mcpRegenerateToken']) {
        byId<HTMLButtonElement>(id).disabled = !state.tokenConfigured;
    }
    byId<HTMLElement>('mcpNotice').textContent = mcpNotice;
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
        mcpNotice = '';
    } catch {
        mcpNotice = mcpText().saveFailed;
    }
    renderMcpSettings();
}

async function copyMcpValue(kind: McpCopyKind): Promise<void> {
    const copied = await window.api.copyMcpValue(kind, mcpCopyTarget()).catch(() => false);
    setMcpNotice(copied ? mcpText().copied : mcpText().copyFailed);
}

async function regenerateMcpToken(): Promise<void> {
    if (!confirm(mcpText().regenerateConfirm)) return;
    try {
        const state = await window.api.regenerateMcpToken();
        if (state) mcpState = state;
        mcpNotice = mcpText().regenerated;
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
