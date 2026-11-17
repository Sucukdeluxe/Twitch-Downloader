const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { _electron } = require('playwright');
const e = require('./e2e-test-environment');
const environment = e.createE2eEnvironment('mcp-files', { streamlink_quality: 'source' });
const report = { checks: [] };
let app;
async function launch() {
    app = await _electron.launch(e.getElectronLaunchOptions(environment));
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof window.api?.getConfig === 'function');
    await e.verifyE2eIsolation(app, win, environment);
    await e.installOfflineFixtures(app);
    return win;
}
(async () => {
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    let win = await launch();
    await app.evaluate(({ clipboard }) => { clipboard.writeText = value => { global.__mcpTestClipboard = value; }; });
    const state = await win.evaluate(port => window.api.setMcpSettings({ enabled: true, port }), port);
    assert.equal(state.running, true);
    await win.evaluate(() => window.api.copyMcpValue('token'));
    const token = await app.evaluate(() => global.__mcpTestClipboard);
    assert.ok(token);
    const call = async (name, args = {}) => {
        const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, 'MCP-Protocol-Version': '2025-06-18' },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
        });
        const raw = await response.text();
        const data = raw.split(/\r?\n/).find(line => line.startsWith('data:'));
        const value = JSON.parse(data ? data.slice(5) : raw);
        assert.equal(value.error, undefined, JSON.stringify(value.error));
        return value.result;
    };
    const source = path.join(environment.downloadsDir, 'original.mp4');
    const destination = path.join(environment.downloadsDir, '16.11.2026', 'Game.mp4');
    fs.writeFileSync(source, 'fictional video bytes');
    fs.writeFileSync(source.replace('.mp4', '.chat.json'), '{}');
    const files = [{ source, destination }];
    const preview = await call('organize_recordings', { files, dry_run: true });
    assert.equal(preview.structuredContent.files[0].status, 'planned');
    assert.equal(fs.existsSync(path.dirname(destination)), false);
    const moved = await call('organize_recordings', { files });
    assert.equal(moved.isError, undefined, JSON.stringify(moved));
    assert.equal(fs.readFileSync(destination, 'utf8'), 'fictional video bytes');
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(destination.replace('.mp4', '.chat.json')), true);
    const listing = await call('list_recordings', { search: 'Game' });
    assert.ok(JSON.stringify(listing.structuredContent).includes('Game.mp4'));
    report.checks.push('real MCP move, rename, sidecars, dry run and archive refresh');
    fs.writeFileSync(source, 'another video');
    assert.equal((await call('organize_recordings', { files })).isError, true);
    assert.equal(fs.readFileSync(source, 'utf8'), 'another video');
    assert.equal((await call('organize_recordings', { files: [{ source, destination: path.join(environment.mediaDir, 'outside.mp4') }] })).isError, true);
    report.checks.push('collision and root escape rejected without source loss');
    const folder = path.join(environment.downloadsDir, 'additional');
    assert.equal((await call('create_recording_folder', { path: folder })).structuredContent.created, true);
    const before = (await call('get_download_settings')).structuredContent.settings;
    const settings = { part_minutes: 45, download_mode: 'parts', parallel_downloads: 2 };
    await call('set_download_settings', { settings, dry_run: true });
    assert.deepEqual((await call('get_download_settings')).structuredContent.settings, before);
    const changed = await call('set_download_settings', { settings });
    assert.equal(changed.structuredContent.after.part_minutes, 45);
    assert.equal(changed.structuredContent.after.download_mode, 'parts');
    assert.equal((await call('set_download_settings', { settings: { default_quality: '720p60' } })).isError, true);
    report.checks.push('settings preview and save');
    await app.close(); app = null;
    const Database = require('better-sqlite3');
    for (const file of fs.readdirSync(path.join(environment.appDataDir, 'mcp-backups')).filter(name => name.endsWith('.db'))) {
        const backup = new Database(path.join(environment.appDataDir, 'mcp-backups', file), { readonly: true });
        assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
        backup.close();
    }
    win = await launch();
    const restored = await win.evaluate(() => window.api.getConfig());
    assert.equal(restored.part_minutes, 45);
    assert.equal(restored.parallel_downloads, 2);
    assert.equal(restored.download_mode, 'parts');
    assert.equal(restored.streamlink_quality, 'source');
    report.checks.push('valid metadata backups and settings persist across restart');
    report.success = true;
})().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
    if (app) await app.close();
    e.cleanupE2eEnvironment(environment);
    console.log(JSON.stringify(report));
});
