const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const e = require('./e2e-test-environment');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/vod-boundary-preview');
const environment = e.createE2eEnvironment('vod-boundary-preview');
let app, server;
const report = { checks: [] };
(async () => {
    fs.mkdirSync(output, { recursive: true });
    const video = path.join(environment.mediaDir, 'preview.mp4');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', video], { windowsHide: true });
    const bytes = fs.readFileSync(video);
    server = http.createServer((request, response) => {
        const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        response.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Access-Control-Allow-Origin': '*', ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {}) });
        response.end(bytes.subarray(start, end + 1));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    app = await _electron.launch(e.getElectronLaunchOptions(environment));
    const win = await app.firstWindow();
    win.setDefaultTimeout(10000);
    report.isolation = await e.verifyE2eIsolation(app, win, environment);
    await e.installOfflineFixtures(app);
    await app.evaluate(({ ipcMain }, sourceUrl) => {
        for (const channel of ['open-vod-playback', 'get-vod-timeline']) ipcMain.removeHandler(channel);
        ipcMain.handle('open-vod-playback', (_, request) => ({ id: request.id, sourceUrl, quality: 'source' }));
        ipcMain.handle('get-vod-timeline', () => ({ vodId: '1234567890', started: Date.parse('2026-01-01T00:00:00Z'), duration: 20, chapters: [], titleHistory: [], viewerHistory: [], viewerGaps: [], refreshAfterMs: 0, chaptersStatus: 'empty' }));
    }, 'http://127.0.0.1:' + server.address().port + '/preview.mp4');
    await win.waitForFunction(() => typeof workspaceLoading !== 'undefined' && !workspaceLoading);
    const errors = [];
    win.on('pageerror', error => errors.push(String(error)));
    for (const language of ['de', 'en']) {
        await win.evaluate(language => {
            applyRendererLanguage(language);
            openClipDialog('https://www.twitch.tv/videos/1234567890', 'Preview fixture', '2026-01-01T00:00:00Z', 'fixture', '20s');
        }, language);
        await win.waitForFunction(() => document.querySelector('#clipPlayer video.active')?.readyState >= 2);
        await win.evaluate(() => document.querySelector('#clipPlayer video.active').pause());
        async function dragBoundary(selector, boundary, delta, omitting = false) {
            await win.evaluate(() => { clipPlayer.applyExcerpt({ range: { start: 2, end: 18 }, omissions: [] }); });
            await win.waitForFunction(() => Math.abs(document.querySelector('#clipPlayer video.active').currentTime - 2) < .15);
            const expanded = selector.startsWith('.vod-selection');
            const collapsed = await win.locator('#clipModal').evaluate(element => element.classList.contains('is-range-collapsed'));
            if (expanded === collapsed) await win.locator('#clipDetailsToggle').click();
            if (omitting) await win.locator('.vod-omission-modes button').nth(1).click();
            const handle = win.locator(selector + ' .is-' + boundary).first();
            await handle.scrollIntoViewIfNeeded();
            const rect = await handle.boundingBox();
            const old = Number(await handle.getAttribute('aria-valuenow'));
            await win.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
            await win.mouse.down();
            await win.mouse.move(rect.x + rect.width / 2 + delta, rect.y + rect.height / 2, { steps: 5 });
            const target = Number(await handle.getAttribute('aria-valuenow'));
            assert.notEqual(target, old, 'Boundary moved');
            await win.waitForFunction(target => { const video = document.querySelector('#clipPlayer video.active'); return !video.seeking && Math.abs(video.currentTime - Math.min(target, video.duration - .05)) < .2; }, target);
            await win.mouse.up();
            const state = await win.evaluate(() => ({ snapshot: clipPlayer.snapshot(), time: document.querySelector('#clipPlayer video.active').currentTime, paused: document.querySelector('#clipPlayer video.active').paused }));
            assert.equal(state.snapshot.range[boundary], target);
            assert.equal(state.snapshot.range[boundary === 'start' ? 'end' : 'start'], boundary === 'start' ? 18 : 2);
            assert.equal(state.paused, true);
            report.checks.push({ language, selector, boundary, target, time: state.time });
        }
        for (const selector of ['.vod-selection .vod-range-markers', '#clipPlayer .vod-range-markers.is-excerpt']) {
            await dragBoundary(selector, 'start', 50);
            await dragBoundary(selector, 'end', -60);
        }
        await dragBoundary('#clipPlayer .vod-range-markers.is-excerpt', 'end', -60, true);
        await dragBoundary('#clipPlayer .vod-range-markers.is-excerpt', 'end', 120, true);
        await win.screenshot({ path: path.join(output, language + '.png') });
        await win.evaluate(() => closeClipDialog());
    }
    assert.deepEqual(errors, []);
    report.success = true;
})().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
    if (app) await app.close();
    if (server) await new Promise(resolve => server.close(resolve));
    e.cleanupE2eEnvironment(environment);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
});
