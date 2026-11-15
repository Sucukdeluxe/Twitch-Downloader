const path = require('node:path');
const electron = require('electron');
global.__headlessShellCalls = [];
for (const method of ['showItemInFolder', 'openPath', 'openExternal']) {
    electron.shell[method] = (...args) => {
        global.__headlessShellCalls.push({ method, args });
        return method === 'showItemInFolder' ? undefined : Promise.resolve(method === 'openPath' ? '' : undefined);
    };
}


const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const OFFSCREEN = -32000;

electron.app.setName(pkg.build?.productName || pkg.name);
electron.app.getAppPath = () => root;
electron.app.getVersion = () => pkg.version;
electron.app.focus = () => {};
electron.Notification.isSupported = () => false;
electron.Notification.prototype.show = function () {};

function park(window) {
    if (window.isDestroyed()) return;
    const [width, height] = window.getSize();
    window.setBounds({ x: OFFSCREEN, y: OFFSCREEN, width, height });
}

electron.app.on('browser-window-created', (_event, window) => {
    const showInactive = window.showInactive.bind(window);
    window.show = () => { park(window); showInactive(); park(window); };
    window.showInactive = window.show;
    window.focus = () => {};
    window.moveTop = () => {};
    window.center = () => park(window);
    window.maximize = () => park(window);
    window.setFullScreen = () => {};
    window.flashFrame = () => {};
    window.setSkipTaskbar(true);
    window.webContents.setAudioMuted(true);
    window.webContents.setBackgroundThrottling(false);
    window.on('show', () => park(window));
    window.on('move', () => { const [x] = window.getPosition(); if (x !== OFFSCREEN) park(window); });
    park(window);
});

require('../dist/main.js');
