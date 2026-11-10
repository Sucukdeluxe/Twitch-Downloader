const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const {
  createE2eEnvironment,
  getElectronLaunchOptions,
  verifyE2eIsolation,
  installOfflineFixtures,
  cleanupE2eEnvironment
} = require('./e2e-test-environment');

const TARGETS = [
  { width: 2048, height: 1094 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 }
];

const TABS = ['vods', 'clips', 'cutter', 'merge', 'stats', 'archive', 'settings'];

async function run() {
  const environment = createE2eEnvironment('workspace-ui', {
    language: 'en',
    theme: 'twitch'
  });
  const artifactDir = path.join(process.cwd(), 'artifacts', 'ui-overhaul', 'workspace-ui');
  fs.mkdirSync(artifactDir, { recursive: true });

  const failures = [];
  const runtimeIssues = [];
  const checks = {};
  let app;

  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  try {
    app = await electron.launch(getElectronLaunchOptions(environment));

    const win = await app.firstWindow();
    const isolation = await verifyE2eIsolation(app, win, environment);
    const offlineFixtures = await installOfflineFixtures(app);
    checks.dataIsolation = {
      expectedUserData: environment.userDataDir,
      actualUserData: isolation.userData,
      expectedDownloadPath: environment.downloadsDir,
      actualDownloadPath: isolation.downloadPath
    };
    checks.offlineFixtures = offlineFixtures;
    check(isolation.userDataIsolated, 'Electron userData is not isolated from the regular application profile');
    check(isolation.downloadPathIsolated, 'Workspace content is not isolated from the regular download folder');
    check(offlineFixtures.network === 'blocked' && offlineFixtures.twitch === 'fixture' && offlineFixtures.updater === 'fixture', 'Workspace UI test is not protected by offline fixtures');
    win.on('pageerror', (error) => runtimeIssues.push(`pageerror: ${String(error)}`));
    win.on('console', (message) => {
      if (message.type() === 'error') runtimeIssues.push(`console.error: ${message.text()}`);
    });

    await win.waitForFunction(() => typeof window.showTab === 'function');

    const shell = await win.evaluate(() => ({
      topbar: Boolean(document.querySelector('.app-topbar')),
      topNavigation: Boolean(document.querySelector('.top-nav')),
      workspace: Boolean(document.querySelector('.workspace-shell')),
      contextSidebar: Boolean(document.querySelector('.context-sidebar')),
      workspaceMain: Boolean(document.querySelector('.workspace-main')),
      toolbar: Boolean(document.querySelector('.workspace-toolbar')),
      updateButton: Boolean(document.getElementById('workspaceUpdateButton')),
      updateVisible: (() => {
        const banner = document.getElementById('updateBanner');
        const button = document.getElementById('workspaceUpdateButton');
        const rect = button?.getBoundingClientRect();
        return Boolean(banner && !banner.hidden && rect && rect.width > 0 && rect.height > 0);
      })(),
      systemStatusAction: Boolean(document.getElementById('systemStatusButton')),
      accountAction: Boolean(document.getElementById('openSettingsButton')),
      vodToolbarOrder: [...document.querySelectorAll('[data-toolbar-for="vods"] > button')].map((button) => button.id || button.className),
      vodScrollbarGutter: getComputedStyle(document.getElementById('vodsTab')).scrollbarGutter,
      backgroundRefreshStarted: streamerBackgroundRefreshTimer !== null,
      topNavigationItems: document.querySelectorAll('.top-nav button[data-tab]').length,
      nonButtonNavigationItems: document.querySelectorAll('.top-nav [data-tab]:not(button)').length
    }));
    checks.shell = shell;

    check(shell.topbar, 'The persistent application topbar is missing');
    check(shell.topNavigation, 'The primary icon navigation is missing');
    check(shell.workspace, 'The workspace shell is missing');
    check(shell.contextSidebar, 'The contextual sidebar is missing');
    check(shell.workspaceMain, 'The workspace main region is missing');
    check(shell.toolbar, 'The workspace toolbar is missing');
    check(shell.updateButton, 'The update action markup is missing');
    check(!shell.updateVisible, 'The update action is visible before an update is available');
    check(!shell.systemStatusAction && !shell.accountAction, 'Unused topbar actions are still visible');
    check(shell.vodToolbarOrder[0] === 'toolbarRefreshVodsBtn', `VOD refresh is not left of Add Streamer: ${shell.vodToolbarOrder.join(', ')}`);
    check(shell.vodScrollbarGutter.includes('stable'), `VOD workspace does not reserve stable scrollbar geometry: ${shell.vodScrollbarGutter}`);
    check(shell.backgroundRefreshStarted, 'Five-minute streamer background refresh was not started');
    check(shell.topNavigationItems === 7, `Expected 7 native primary navigation buttons, found ${shell.topNavigationItems}`);
    check(shell.nonButtonNavigationItems === 0, `Expected only native primary navigation buttons, found ${shell.nonButtonNavigationItems} non-buttons`);

    const mergeAddToolbarActions = await win.evaluate(() => {
      const capture = () => {
        const button = document.querySelector('[data-toolbar-for="merge"] button[onclick="addMergeFiles()"]');
        const label = button?.querySelector('span')?.textContent?.trim() || '';
        const accessibleLabel = button?.getAttribute('aria-label')?.trim() || label;
        return {
          label,
          accessibleLabel,
          plusCount: (button?.querySelectorAll('svg').length || 0) + ((button?.textContent?.match(/\+/g) || []).length)
        };
      };

      window.changeLanguage('en');
      const english = capture();
      window.changeLanguage('de');
      const german = capture();
      window.changeLanguage('en');
      return { english, german };
    });
    checks.mergeAddToolbarActions = mergeAddToolbarActions;
    check(mergeAddToolbarActions.english.plusCount === 1, `English Add videos toolbar action exposes ${mergeAddToolbarActions.english.plusCount} plus signs`);
    check(mergeAddToolbarActions.german.plusCount === 1, `German Videos hinzufügen toolbar action exposes ${mergeAddToolbarActions.german.plusCount} plus signs`);
    check(mergeAddToolbarActions.english.label === 'Add videos' && mergeAddToolbarActions.english.accessibleLabel === 'Add videos', `English Add videos toolbar label is "${mergeAddToolbarActions.english.accessibleLabel}"`);
    check(mergeAddToolbarActions.german.label === 'Videos hinzufügen' && mergeAddToolbarActions.german.accessibleLabel === 'Videos hinzufügen', `German Videos hinzufügen toolbar label is "${mergeAddToolbarActions.german.accessibleLabel}"`);

    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceStreamerCacheCalls = { ids: 0, vods: 0, profiles: 0 };
      ipcMain.removeHandler('get-user-id');
      ipcMain.handle('get-user-id', (_, login) => {
        globalThis.__workspaceStreamerCacheCalls.ids += 1;
        return `id-${login}`;
      });
      ipcMain.removeHandler('get-vods');
      ipcMain.handle('get-vods', (_, userId, forceRefresh) => {
        globalThis.__workspaceStreamerCacheCalls.vods += 1;
        const login = String(userId).replace(/^id-/, '');
        const base = [{ id: `${login}-old`, title: `${login} old`, created_at: '2026-08-09T12:00:00Z', duration: '1h', thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: `https://example.invalid/${login}-old`, view_count: 100 }];
        return forceRefresh ? [{ id: `${login}-new`, title: `${login} new`, created_at: '2026-08-10T12:00:00Z', duration: '2h', thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: `https://example.invalid/${login}-new`, view_count: 200 }, ...base] : base;
      });
      ipcMain.removeHandler('get-streamer-profile');
      ipcMain.handle('get-streamer-profile', (_, login) => {
        globalThis.__workspaceStreamerCacheCalls.profiles += 1;
        return { login, displayName: login, avatarUrl: '', bannerUrl: '', description: '', broadcasterType: '', followerCount: 100, vodCount: 1, lastStreamAt: '2026-08-09T12:00:00Z', isLive: false, currentTitle: null, currentGame: null, currentStreamPreviewUrl: '', currentStreamViewers: null, twitchUrl: `https://twitch.tv/${login}`, fetchedAt: Date.now() };
      });
    });
    const streamerCacheBehavior = await win.evaluate(async () => {
      streamerVodCache.clear();
      streamerProfileCache.clear();
      isConnected = true;
      config.streamers = ['cache_alpha', 'cache_beta'];
      await window.preloadConfiguredStreamerData(config.streamers);
      const selection = selectStreamer('cache_beta');
      const skeletonDuringCachedSelection = document.querySelectorAll('#vodGrid .vod-card-skeleton').length;
      await selection;
      const profileWidthBefore = document.getElementById('streamerProfileHeader')?.getBoundingClientRect().width || 0;
      await selectStreamer('cache_alpha');
      const profileWidthAfter = document.getElementById('streamerProfileHeader')?.getBoundingClientRect().width || 0;
      await selectStreamer('cache_beta');
      await window.refreshConfiguredStreamersInBackground();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        cachedVodStreamers: streamerVodCache.size,
        cachedProfiles: streamerProfileCache.size,
        skeletonDuringCachedSelection,
        profileWidthDelta: Math.abs(profileWidthBefore - profileWidthAfter),
        cardsAfterRefresh: document.querySelectorAll('#vodGrid .vod-card').length,
        activeAnimations: document.querySelectorAll('#vodGrid .vod-card')[0]?.getAnimations().length || 0
      };
    });
    const streamerCacheCalls = await app.evaluate(() => ({ ...globalThis.__workspaceStreamerCacheCalls }));
    checks.streamerCache = { ...streamerCacheBehavior, calls: streamerCacheCalls };
    check(streamerCacheBehavior.cachedVodStreamers === 2 && streamerCacheBehavior.cachedProfiles === 2, `Configured streamers were not fully preloaded: ${streamerCacheBehavior.cachedVodStreamers}/${streamerCacheBehavior.cachedProfiles}`);
    check(streamerCacheBehavior.skeletonDuringCachedSelection === 0, `Cached streamer selection still shows ${streamerCacheBehavior.skeletonDuringCachedSelection} skeleton cards`);
    check(streamerCacheBehavior.profileWidthDelta <= 1, `Streamer profile width changes by ${streamerCacheBehavior.profileWidthDelta}px between cached accounts`);
    check(streamerCacheBehavior.cardsAfterRefresh === 2, `Silent refresh did not add the new VOD: ${streamerCacheBehavior.cardsAfterRefresh}`);
    check(streamerCacheBehavior.activeAnimations > 0, 'Silent refresh does not animate the new VOD or grid reflow');
    check(streamerCacheCalls.ids === 4 && streamerCacheCalls.vods === 4, `Cached account switching triggered unexpected VOD requests: ${JSON.stringify(streamerCacheCalls)}`);

    const cutterDropFixturePath = path.join(environment.mediaDir, 'electron-43-cutter-drop.mp4');
    fs.writeFileSync(cutterDropFixturePath, 'electron-43-cutter-drop-fixture', 'utf8');
    await app.evaluate(({ ipcMain }, expectedPath) => {
      globalThis.__workspaceCutterDropPaths = { mediaCapability: '', expectedPath };
      ipcMain.removeHandler('prepare-video-editor-media');
      ipcMain.handle('prepare-video-editor-media', (_, capability) => {
        globalThis.__workspaceCutterDropPaths.mediaCapability = capability;
        return {
          sourceUrl: encodeURI(`file:///${expectedPath.replace(/\\/g, '/')}`),
          info: { duration: 120, width: 1920, height: 1080, fps: 60, hasAudio: false, rotation: 0, audioStreams: [] },
          thumbnails: ['data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='],
          waveform: null
        };
      });
    }, cutterDropFixturePath);
    await win.evaluate(() => {
      window.showTab('cutter');
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'workspaceCutterDropInput';
      document.body.appendChild(input);
    });
    await win.locator('#workspaceCutterDropInput').setInputFiles(cutterDropFixturePath);
    const cutterFileObject = await win.evaluate(() => {
      const input = document.getElementById('workspaceCutterDropInput');
      const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
      if (!file) return { name: '', legacyPathType: 'missing', apiType: typeof window.api.selectDroppedVideo };
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.getElementById('cutterTab')?.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      return {
        name: file.name,
        legacyPathType: typeof file.path,
        apiType: typeof window.api.selectDroppedVideo
      };
    });
    await win.waitForTimeout(250);
    const cutterDropPaths = await app.evaluate(() => ({ ...globalThis.__workspaceCutterDropPaths }));
    const cutterDropUi = await win.evaluate(() => ({
      filePath: document.getElementById('cutterFilePath')?.value || '',
      infoVisible: document.getElementById('cutterInfo')?.classList.contains('shown') || false,
      cutEnabled: document.getElementById('btnCut')?.disabled === false
    }));
    checks.cutterDrop = {
      electronVersion: await app.evaluate(() => process.versions.electron),
      expectedPath: cutterDropFixturePath,
      fileObject: cutterFileObject,
      ipc: cutterDropPaths,
      ui: cutterDropUi
    };
    check(cutterFileObject.legacyPathType === 'undefined', `Electron File.path is unexpectedly ${cutterFileObject.legacyPathType}`);
    check(cutterFileObject.apiType === 'function', `Cutter capability API is ${cutterFileObject.apiType}`);
    check(cutterDropUi.filePath === path.basename(cutterDropFixturePath), `Cutter drop displayed "${cutterDropUi.filePath}" instead of the safe file name`);
    check(typeof cutterDropPaths.mediaCapability === 'string' && cutterDropPaths.mediaCapability.length >= 32 && cutterDropPaths.mediaCapability !== cutterDropFixturePath, `Cutter drop did not send an opaque capability to media preparation: ${JSON.stringify(cutterDropPaths)}`);
    check(cutterDropUi.infoVisible && cutterDropUi.cutEnabled, 'Cutter drop did not populate the cutter controls');

    const queueEmptyActions = await win.evaluate(() => ({
      count: document.getElementById('queueCount')?.textContent?.trim() || '',
      startDisabled: document.getElementById('btnStart')?.disabled === true,
      retryDisabled: document.getElementById('btnRetryFailed')?.disabled === true,
      clearDisabled: document.getElementById('btnClear')?.disabled === true
    }));
    checks.queueEmptyActions = queueEmptyActions;
    check(queueEmptyActions.count === '0', `Expected an empty isolated queue, found count ${queueEmptyActions.count}`);
    check(queueEmptyActions.startDisabled, 'Start queue action is enabled while the queue is empty');
    check(queueEmptyActions.retryDisabled, 'Retry queue action is enabled while the queue is empty');
    check(queueEmptyActions.clearDisabled, 'Clear queue action is enabled while the queue is empty');

    await win.evaluate(() => {
      const storagePrototype = Object.getPrototypeOf(localStorage);
      const originalSetItem = storagePrototype.setItem;
      window.__workspaceTabActivations = [];
      storagePrototype.setItem = function setItem(key, value) {
        if (key === 'twitch-vod-manager:active-tab') {
          window.__workspaceTabActivations.push(value);
        }
        return originalSetItem.call(this, key, value);
      };
    });

    const keyboardActivations = {};
    for (const tab of TABS) {
      keyboardActivations[tab] = {};
      for (const key of ['Enter', 'Space']) {
        const button = win.locator(`.top-nav button[data-tab="${tab}"]`);
        await win.evaluate(() => { window.__workspaceTabActivations = []; });
        await button.focus();
        await button.press(key);
        await win.waitForTimeout(30);
        const activations = await win.evaluate(() => [...window.__workspaceTabActivations]);
        keyboardActivations[tab][key] = activations;
        check(activations.length === 1, `${tab} ${key} activation persisted ${activations.length} tab changes instead of exactly one`);
        check(activations[0] === tab, `${tab} ${key} activation persisted the wrong tab: ${activations.join(', ')}`);
      }
    }
    checks.keyboardActivations = keyboardActivations;

    const updateContract = await win.evaluate(() => ({
      action: typeof window.handleWorkspaceUpdateAction,
      available: typeof window.setUpdateBannerAvailableUi,
      downloading: typeof window.setDownloadPendingUi,
      ready: typeof window.setDownloadReadyUi,
      idle: typeof window.hideUpdateBanner
    }));
    checks.updateContract = updateContract;
    check(Object.values(updateContract).every((value) => value === 'function'), 'The workspace updater state contract is incomplete');

    if (Object.values(updateContract).every((value) => value === 'function')) {
      const updaterStates = await win.evaluate(() => {
        const capture = () => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          label: document.getElementById('workspaceUpdateLabel')?.textContent?.trim() || '',
          description: document.getElementById('updateText')?.textContent?.trim() || '',
          checkLabel: document.getElementById('checkUpdateBtn')?.textContent?.trim() || '',
          disabled: document.getElementById('workspaceUpdateButton')?.disabled || false,
          ariaDisabled: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-disabled') || '',
          visible: (() => {
            const banner = document.getElementById('updateBanner');
            const button = document.getElementById('workspaceUpdateButton');
            const rect = button?.getBoundingClientRect();
            return Boolean(banner && !banner.hidden && rect && rect.width > 0 && rect.height > 0);
          })()
        });

        window.setUpdateBannerAvailableUi({ version: '9.9.9' });
        const available = capture();
        window.setDownloadPendingUi();
        const downloading = capture();
        window.setDownloadReadyUi({ version: '9.9.9' });
        const ready = capture();
        window.hideUpdateBanner();
        const idle = capture();
        return { available, downloading, ready, idle };
      });

      checks.updaterStates = updaterStates;
      check(updaterStates.available.state === 'available', 'Available update state is not reflected in the topbar');
      check(updaterStates.available.visible, 'Available update action is not visible');
      check(updaterStates.available.description.includes('9.9.9'), 'Available update version is not announced');
      check(updaterStates.downloading.state === 'downloading', 'Download state is not reflected in the topbar');
      check(updaterStates.downloading.visible, 'Downloading update action is not visible');
      check(!updaterStates.downloading.disabled, 'Downloading update status is not keyboard focusable');
      check(updaterStates.downloading.ariaDisabled === 'true', 'Downloading update action does not expose aria-disabled=true');
      check(updaterStates.ready.state === 'ready', 'Ready-to-install state is not reflected in the topbar');
      check(updaterStates.ready.visible, 'Ready update action is not visible');
      check(updaterStates.ready.description.includes('9.9.9'), 'Ready update version is not announced');
      check(updaterStates.idle.state === 'idle', 'Idle update state is not restored in the topbar');
      check(!updaterStates.idle.visible, 'Idle update action remains visible');
      check(!updaterStates.idle.description.includes('9.9.9'), 'Idle update state keeps stale release information');
      check(updaterStates.idle.description === updaterStates.idle.checkLabel, 'Idle update tooltip does not describe the available action');

      const updateModalButtons = await win.evaluate(() => {
        const previousLanguage = config.language;
        window.changeLanguage('de');
        updateReady = false;
        openUpdateModal({ version: '9.9.9' });
        const buttons = [...document.querySelectorAll('#updateModal .update-modal-actions button')];
        const result = {
          labels: buttons.map((button) => button.textContent?.trim() || ''),
          heights: buttons.map((button) => button.getBoundingClientRect().height),
          overflow: buttons.map((button) => button.scrollHeight - button.clientHeight),
          skipLineHeight: Number.parseFloat(getComputedStyle(document.getElementById('updateModalSkipBtn')).lineHeight)
        };
        dismissUpdateModal();
        window.changeLanguage(previousLanguage);
        return result;
      });
      checks.updateModalButtons = updateModalButtons;
      check(updateModalButtons.labels.includes('Diese Version überspringen'), `German skip-version label is missing: ${updateModalButtons.labels.join(', ')}`);
      check(updateModalButtons.heights.every((height) => height >= 42) && Math.max(...updateModalButtons.heights) - Math.min(...updateModalButtons.heights) <= 1, `Update modal buttons do not share a safe height: ${updateModalButtons.heights.join(', ')}`);
      check(updateModalButtons.overflow.every((overflow) => overflow <= 0), `Update modal button text overflows by ${updateModalButtons.overflow.join(', ')}px`);
      check(updateModalButtons.skipLineHeight >= 14, `Update skip-version line height is too small: ${updateModalButtons.skipLineHeight}`);

      await win.emulateMedia({ reducedMotion: 'reduce' });
      await win.evaluate(() => {
        updateReady = false;
        openUpdateModal({
          version: '9.9.9',
          releaseNotes: '- Stable Windows shell registration\n- Smoother update details'
        });
      });
      // Sample CSS transitions at a fixed animation time. Cross-process clicks
      // and wall-clock sleeps can miss the entire 260ms transition on CI.
      const changelogMotion = await win.evaluate(async () => {
        const panel = document.getElementById('updateChangelogPanel');
        const toggle = document.getElementById('updateChangelogToggle');
        const capture = () => ({
          hidden: panel.hidden,
          expanded: panel.classList.contains('is-expanded'),
          ariaHidden: panel.getAttribute('aria-hidden') || '',
          ariaExpanded: toggle.getAttribute('aria-expanded') || '',
          height: panel.getBoundingClientRect().height,
          transitionDuration: getComputedStyle(panel).transitionDuration
        });
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const sampleToggle = async () => {
          toggle.click();
          const transitions = panel.getAnimations();
          for (const transition of transitions) {
            transition.pause();
            transition.currentTime = 20;
          }
          await frame();
          const intermediate = capture();
          for (const transition of transitions) transition.finish();
          await frame();
          return { intermediate, settled: capture() };
        };
        const collapsed = capture();
        const opening = await sampleToggle();
        const closing = await sampleToggle();
        return { collapsed, opening: opening.intermediate, expanded: opening.settled, closing: closing.intermediate, closed: closing.settled };
      });
      const { collapsed: changelogCollapsed, opening: changelogOpening, expanded: changelogExpanded, closing: changelogClosing, closed: changelogClosed } = changelogMotion;
      await win.evaluate(async () => {
        dismissUpdateModal();
        // Let the dialog restore focus before focusing the next control.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await win.emulateMedia({ reducedMotion: 'no-preference' });
      checks.updateChangelogMotion = {
        collapsed: changelogCollapsed,
        opening: changelogOpening,
        expanded: changelogExpanded,
        closing: changelogClosing,
        closed: changelogClosed
      };
      check(!changelogCollapsed.hidden && !changelogCollapsed.expanded && changelogCollapsed.ariaHidden === 'true' && changelogCollapsed.ariaExpanded === 'false', `Collapsed changelog does not remain animatable: ${JSON.stringify(changelogCollapsed)}`);
      check(changelogOpening.expanded && changelogOpening.height > changelogCollapsed.height && changelogOpening.height < changelogExpanded.height, `Changelog does not visibly expand through an intermediate frame: ${JSON.stringify({ changelogCollapsed, changelogOpening, changelogExpanded })}`);
      check(changelogExpanded.expanded && changelogExpanded.ariaHidden === 'false' && changelogExpanded.ariaExpanded === 'true' && changelogExpanded.height > 0, `Expanded changelog state is incorrect: ${JSON.stringify(changelogExpanded)}`);
      check(changelogClosing.height > changelogClosed.height && changelogClosing.height < changelogExpanded.height, `Changelog does not visibly collapse through an intermediate frame: ${JSON.stringify({ changelogExpanded, changelogClosing, changelogClosed })}`);
      check(!changelogClosed.expanded && changelogClosed.ariaHidden === 'true' && changelogClosed.ariaExpanded === 'false' && changelogClosed.height === 0, `Collapsed changelog state is incorrect: ${JSON.stringify(changelogClosed)}`);
      check(!/^0\.01ms(?:, 0\.01ms)*$/.test(changelogOpening.transitionDuration), `Changelog animation is disabled by reduced-motion fallback: ${changelogOpening.transitionDuration}`);

      await win.evaluate(() => window.setDownloadPendingUi());
      await win.locator('#workspaceUpdateButton').focus();
      await win.waitForTimeout(80);
      const downloadingKeyboardState = await win.evaluate(() => {
        const button = document.getElementById('workspaceUpdateButton');
        const popover = document.querySelector('.workspace-update-popover');
        const style = popover ? getComputedStyle(popover) : null;
        return {
          focused: document.activeElement === button,
          disabled: button?.disabled || false,
          ariaDisabled: button?.getAttribute('aria-disabled') || '',
          ariaExpanded: button?.getAttribute('aria-expanded') || '',
          visible: Boolean(style && style.visibility === 'visible' && Number(style.opacity) > 0),
          state: document.getElementById('updateBanner')?.dataset.updateState || ''
        };
      });
      await win.keyboard.press('Enter');
      const downloadingStateAfterEnter = await win.evaluate(() => document.getElementById('updateBanner')?.dataset.updateState || '');
      checks.downloadingKeyboardState = { ...downloadingKeyboardState, stateAfterEnter: downloadingStateAfterEnter };
      check(downloadingKeyboardState.focused && !downloadingKeyboardState.disabled, 'Downloading update status cannot receive keyboard focus');
      check(downloadingKeyboardState.ariaDisabled === 'true', 'Downloading update trigger does not communicate its unavailable action');
      check(downloadingKeyboardState.visible && downloadingKeyboardState.ariaExpanded === 'true', 'Downloading progress is hidden from keyboard focus');
      check(downloadingKeyboardState.state === 'downloading' && downloadingStateAfterEnter === 'downloading', 'Keyboard activation changes the downloading state');
      await win.evaluate(() => window.hideUpdateBanner());

      await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
      await win.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
      await win.locator('#workspaceUpdateButton').hover();
      await win.waitForTimeout(80);
      const popoverActions = await win.evaluate(() => {
        const popover = document.querySelector('.workspace-update-popover');
        const later = document.getElementById('workspaceUpdateLater');
        const dismiss = document.getElementById('workspaceUpdateDismiss');
        const style = popover ? getComputedStyle(popover) : null;
        return {
          visible: Boolean(style && style.visibility === 'visible' && Number(style.opacity) > 0),
          laterExists: later instanceof HTMLButtonElement,
          laterText: later?.textContent?.trim() || '',
          dismissExists: dismiss instanceof HTMLButtonElement,
          dismissLabel: dismiss?.textContent?.trim() || dismiss?.getAttribute('aria-label')?.trim() || dismiss?.getAttribute('title')?.trim() || '',
          expanded: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-expanded') || ''
        };
      });
      checks.popoverActions = popoverActions;
      check(popoverActions.visible, 'Available update popover is not visible on hover');
      check(popoverActions.laterExists, 'Available update popover has no Later action');
      check(/^later$/i.test(popoverActions.laterText), `Available update Later action is labelled "${popoverActions.laterText}"`);
      check(popoverActions.dismissExists, 'Available update popover has no Close action');
      check(/^close$/i.test(popoverActions.dismissLabel), `Available update Close action is labelled "${popoverActions.dismissLabel}"`);
      check(popoverActions.expanded === 'true', 'Available update trigger does not expose aria-expanded=true while the popover is visible');

      const updatePopoverTransit = [];
      const updateButtonBox = await win.locator('#workspaceUpdateButton').boundingBox();
      const updatePopoverBox = await win.locator('#workspaceUpdatePopover').boundingBox();
      if (updateButtonBox && updatePopoverBox) {
        const transitXs = [
          updateButtonBox.x + 10,
          updateButtonBox.x + updateButtonBox.width / 2,
          updateButtonBox.x + updateButtonBox.width - 10
        ];
        const transitY = (updateButtonBox.y + updateButtonBox.height + updatePopoverBox.y) / 2;

        for (const transitX of transitXs) {
          await win.mouse.move(transitX, transitY);
          await win.waitForTimeout(300);
          const gapState = await win.evaluate(({ transitX, transitY }) => {
            const button = document.getElementById('workspaceUpdateButton');
            const popover = document.getElementById('workspaceUpdatePopover');
            const style = popover ? getComputedStyle(popover) : null;
            return {
              expanded: button?.getAttribute('aria-expanded') || '',
              visibility: style?.visibility || '',
              pointerEvents: style?.pointerEvents || '',
              target: document.elementFromPoint(transitX, transitY)?.id || ''
            };
          }, { transitX, transitY });
          await win.locator('#workspaceUpdateButton').hover();
          await win.waitForTimeout(160);
          const panelState = await win.evaluate(() => {
            const button = document.getElementById('workspaceUpdateButton');
            const popover = document.getElementById('workspaceUpdatePopover');
            const style = popover ? getComputedStyle(popover) : null;
            return {
              expanded: button?.getAttribute('aria-expanded') || '',
              visibility: style?.visibility || '',
              pointerEvents: style?.pointerEvents || ''
            };
          });
          updatePopoverTransit.push({ gapState, panelState });
        }
      }
      checks.updatePopoverTransit = updatePopoverTransit;
      check(updatePopoverTransit.length === 3, 'Available update popover geometry cannot be measured for hover transit');
      check(updatePopoverTransit.every(({ gapState, panelState }) => (
        gapState.expanded === 'true'
        && gapState.visibility === 'visible'
        && gapState.pointerEvents === 'auto'
        && panelState.expanded === 'true'
        && panelState.visibility === 'visible'
        && panelState.pointerEvents === 'auto'
      )), `Available update popover closes while moving into it: ${JSON.stringify(updatePopoverTransit)}`);

      if (popoverActions.laterExists) {
        await win.locator('#workspaceUpdateLater').click();
        await win.waitForTimeout(160);
        const laterState = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          visibility: getComputedStyle(document.querySelector('.workspace-update-popover')).visibility,
          pointerEvents: getComputedStyle(document.querySelector('.workspace-update-popover')).pointerEvents,
          opacity: getComputedStyle(document.querySelector('.workspace-update-popover')).opacity,
          ariaExpanded: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-expanded') || ''
        }));
        checks.updateLaterState = laterState;
        check(laterState.state === 'available', 'Later action discards the available update state');
        check(!laterState.shown, 'Later action does not hide the current update announcement');
        check(laterState.visibility === 'hidden' && laterState.pointerEvents === 'none' && Number(laterState.opacity) === 0, 'Later action leaves the update popover visibly interactive');
        check(laterState.ariaExpanded === 'false', 'Later action leaves aria-expanded=true on a hidden popover');

        await win.evaluate(() => window.setDownloadReadyUi({ version: '9.9.9' }));
        const readyAfterPostpone = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          dismissed: document.getElementById('updateBanner')?.classList.contains('popover-dismissed') || false
        }));
        await win.evaluate(() => {
          window.changeLanguage('de');
          window.changeLanguage('en');
        });
        const readyAfterLanguageRefresh = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          dismissed: document.getElementById('updateBanner')?.classList.contains('popover-dismissed') || false
        }));
        checks.readyAfterPostpone = { immediate: readyAfterPostpone, afterLanguageRefresh: readyAfterLanguageRefresh };
        check(readyAfterPostpone.state === 'ready' && readyAfterPostpone.shown && !readyAfterPostpone.dismissed, 'Ready update remains postponed after download completion');
        check(readyAfterLanguageRefresh.state === 'ready' && readyAfterLanguageRefresh.shown && !readyAfterLanguageRefresh.dismissed, 'Language refresh hides or postpones a ready update');
      }

      await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
      if (popoverActions.dismissExists) {
        await win.locator('#workspaceUpdateButton').hover();
        await win.locator('#workspaceUpdateDismiss').click();
        await win.waitForTimeout(160);
        const dismissState = await win.evaluate(() => ({
          state: document.getElementById('updateBanner')?.dataset.updateState || '',
          shown: document.getElementById('updateBanner')?.classList.contains('show') || false,
          visibility: getComputedStyle(document.querySelector('.workspace-update-popover')).visibility,
          pointerEvents: getComputedStyle(document.querySelector('.workspace-update-popover')).pointerEvents,
          opacity: getComputedStyle(document.querySelector('.workspace-update-popover')).opacity,
          ariaExpanded: document.getElementById('workspaceUpdateButton')?.getAttribute('aria-expanded') || ''
        }));
        checks.updateDismissState = dismissState;
        check(dismissState.state === 'idle', 'Close action does not dismiss the available update state');
        check(!dismissState.shown, 'Close action leaves the update announcement visible');
        check(dismissState.visibility === 'hidden' && dismissState.pointerEvents === 'none' && Number(dismissState.opacity) === 0, 'Close action leaves the update popover visibly interactive');
        check(dismissState.ariaExpanded === 'false', 'Close action leaves aria-expanded=true on a hidden popover');
      }
      await win.evaluate(() => window.hideUpdateBanner());
    }

    await win.evaluate(() => window.showTab('clips'));
    const clipContextLinks = win.locator('[data-context-for="clips"] .context-link');
    if (await clipContextLinks.count() >= 2) {
      await clipContextLinks.nth(1).click();
      await win.waitForTimeout(30);
      const contextNavigation = await win.evaluate(() => {
        const panel = document.querySelector('[data-context-for="clips"]');
        const links = [...(panel?.querySelectorAll('.context-link') || [])];
        return {
          activeCount: links.filter((link) => link.classList.contains('active')).length,
          currentCount: links.filter((link) => link.getAttribute('aria-current') === 'page').length,
          secondActive: links[1]?.classList.contains('active') || false,
          secondCurrent: links[1]?.getAttribute('aria-current') === 'page'
        };
      });
      checks.contextNavigation = contextNavigation;
      check(contextNavigation.activeCount === 1, `Context navigation exposes ${contextNavigation.activeCount} active items after a click`);
      check(contextNavigation.currentCount === 1, `Context navigation exposes ${contextNavigation.currentCount} aria-current items after a click`);
      check(contextNavigation.secondActive && contextNavigation.secondCurrent, 'Clicked context navigation item is not active and current');
    } else {
      check(false, 'Clip context navigation does not expose at least two items');
    }

    await win.evaluate(() => window.showTab('settings'));
    const settingsSearchExists = await win.locator('#settingsSearchInput').count() === 1;
    check(settingsSearchExists, 'Settings search input is missing');
    if (settingsSearchExists) {
      const settingsPanes = await win.evaluate(async () => {
        const expected = [
          ['design', 'designTitle'],
          ['api', 'apiTitle'],
          ['downloads', 'downloadSettingsTitle'],
          ['automation', 'autoVodCardTitle'],
          ['notifications', 'discordCardTitle'],
          ['storage', 'storageCardTitle'],
          ['maintenance', 'backupCardTitle'],
          ['updates', 'updateTitle'],
          ['system', 'preflightTitle'],
          ['debug', 'debugLogTitle'],
          ['metrics', 'runtimeMetricsTitle']
        ];
        const visibleCards = () => [...document.querySelectorAll('#settingsTab .settings-card')].filter((card) => {
          const style = getComputedStyle(card);
          return !card.hidden && style.display !== 'none' && style.visibility !== 'hidden';
        });
        const states = [];
        for (const [pane, headingId] of expected) {
          const button = document.querySelector(`[data-context-for="settings"] [data-settings-pane="${pane}"]`);
          if (button) button.click();
          await new Promise((resolve) => window.setTimeout(resolve, 30));
          const visible = visibleCards();
          states.push({
            pane,
            buttonExists: Boolean(button),
            activePane: document.getElementById('settingsTab')?.dataset.settingsPane || '',
            visibleCount: visible.length,
            visibleHeading: visible[0]?.querySelector('h3')?.id || '',
            expectedHeading: headingId,
            activeButtons: document.querySelectorAll('[data-context-for="settings"] .context-link.active').length
          });
        }
        const apiButton = document.querySelector('[data-context-for="settings"] [data-settings-pane="api"]');
        if (apiButton) apiButton.click();
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        return {
          states,
          apiVisibleHeadings: visibleCards().map((card) => card.querySelector('h3')?.id || '')
        };
      });
      checks.settingsPanes = settingsPanes;
      check(settingsPanes.states.length === 11 && settingsPanes.states.every((state) => state.buttonExists), 'Settings navigation does not expose all eleven real panes');
      check(settingsPanes.states.every((state) => state.activePane === state.pane), 'Settings pane state does not follow the selected navigation item');
      check(settingsPanes.states.every((state) => state.visibleCount === 1 && state.visibleHeading === state.expectedHeading), 'A Settings selection shows unrelated or missing cards');
      check(settingsPanes.states.every((state) => state.activeButtons === 1), 'Settings navigation exposes more than one active item');
      check(settingsPanes.apiVisibleHeadings.join(',') === 'apiTitle', `Twitch API pane leaks unrelated cards: ${settingsPanes.apiVisibleHeadings.join(',')}`);
      await win.locator('#settingsSearchInput').fill('download');
      await win.waitForTimeout(80);
      const searchTarget = await win.evaluate(() => ({
        pane: document.getElementById('settingsTab')?.dataset.settingsPane || '',
        visibleHeadings: [...document.querySelectorAll('#settingsTab .settings-card')].filter((card) => {
          const style = getComputedStyle(card);
          return !card.hidden && style.display !== 'none' && style.visibility !== 'hidden';
        }).map((card) => card.querySelector('h3')?.id || '')
      }));
      await win.locator('#settingsSearchInput').fill('');
      checks.settingsSearch = searchTarget;
      check(searchTarget.pane === 'downloads' && searchTarget.visibleHeadings.join(',') === 'downloadSettingsTitle', `Settings search does not navigate to Downloads: ${searchTarget.pane} / ${searchTarget.visibleHeadings.join(',')}`);
    }

    await win.setViewportSize(TARGETS[0]);
    await win.evaluate(() => {
      window.showTab('settings');
      window.setSettingsPane('downloads');
      window.changeLanguage('de');
      updateStatus(UI_TEXT.status.noLogin, false, 'public');
      document.getElementById('smartSchedulerToggle').checked = true;
    });
    await win.waitForTimeout(80);
    const downloadSettingsWide = await win.evaluate(() => {
      const tab = document.getElementById('settingsTab');
      const card = tab?.querySelector('.settings-card[data-settings-pane="downloads"]');
      const layout = card?.querySelector('.download-settings-layout');
      const checkbox = card?.querySelector('.toggle-row input[type="checkbox"]');
      const label = checkbox?.closest('.toggle-row')?.querySelector('span');
      const dot = document.getElementById('statusDot');
      const text = document.getElementById('statusText');
      return {
        cardWidth: card?.getBoundingClientRect().width || 0,
        tabWidth: tab?.getBoundingClientRect().width || 0,
        columns: layout ? getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        sections: card?.querySelectorAll('.download-settings-section').length || 0,
        checkboxWidth: checkbox ? checkbox.getBoundingClientRect().width : 0,
        checkboxBackground: checkbox ? getComputedStyle(checkbox).backgroundImage : '',
        labelFontSize: label ? Number.parseFloat(getComputedStyle(label).fontSize) : 0,
        statusText: text?.textContent?.trim() || '',
        statusTitle: text?.getAttribute('title') || '',
        statusPublic: dot?.classList.contains('public') || false
      };
    });
    checks.downloadSettingsWide = downloadSettingsWide;
    check(downloadSettingsWide.cardWidth >= downloadSettingsWide.tabWidth * 0.8, `Download Settings wastes the wide workspace: ${downloadSettingsWide.cardWidth}/${downloadSettingsWide.tabWidth}`);
    check(downloadSettingsWide.columns === 2 && downloadSettingsWide.sections === 5, `Download Settings is not arranged as five semantic groups in two columns: ${downloadSettingsWide.columns}/${downloadSettingsWide.sections}`);
    check(downloadSettingsWide.checkboxWidth >= 18 && downloadSettingsWide.checkboxBackground !== 'none', `Checked Download Settings toggle has no clear checkmark: ${downloadSettingsWide.checkboxWidth}/${downloadSettingsWide.checkboxBackground}`);
    check(downloadSettingsWide.labelFontSize >= 13, `Download Settings toggle labels remain too small: ${downloadSettingsWide.labelFontSize}px`);
    check(downloadSettingsWide.statusText === 'Public-Modus · öffentliche VODs verfügbar', `Public status copy is unclear: ${downloadSettingsWide.statusText}`);
    check(downloadSettingsWide.statusPublic && downloadSettingsWide.statusTitle.includes('Twitch-API'), `Public status lacks orange state or explanatory API tooltip: ${downloadSettingsWide.statusPublic}/${downloadSettingsWide.statusTitle}`);

    await win.setViewportSize({ width: 1000, height: 760 });
    await win.waitForTimeout(80);
    const downloadSettingsNarrow = await win.evaluate(() => {
      const tab = document.getElementById('settingsTab');
      const layout = tab?.querySelector('.download-settings-layout');
      return {
        columns: layout ? getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tabOverflow: tab ? tab.scrollWidth - tab.clientWidth : 0
      };
    });
    checks.downloadSettingsNarrow = downloadSettingsNarrow;
    check(downloadSettingsNarrow.columns === 1, `Narrow Download Settings does not collapse to one column: ${downloadSettingsNarrow.columns}`);
    check(downloadSettingsNarrow.documentOverflow <= 1 && downloadSettingsNarrow.tabOverflow <= 1, `Narrow Download Settings causes horizontal overflow: ${JSON.stringify(downloadSettingsNarrow)}`);
    await win.setViewportSize(TARGETS[0]);

    const dynamicQueue = await win.evaluate(() => {
      showTab('vods');
      const vodContextPanel = document.querySelector('[data-context-for="vods"]');
      if (vodContextPanel) vodContextPanel.dataset.vodsLayout = 'split';
      queue = [
        { id: 'pending-fixture', title: 'Pending fixture', url: 'https://example.invalid/pending', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'pending', progress: 0 },
        { id: 'starting-fixture', title: 'Starting fixture', url: 'https://example.invalid/starting', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'downloading', progress: 0, progressStatus: UI_TEXT.queue.started },
        { id: 'downloading-fixture', title: 'Downloading fixture', url: 'https://example.invalid/downloading', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'downloading', progress: 42, currentPart: 1, totalParts: 1, speed: '55.8 MB/s' },
        { id: 'paused-fixture', title: 'Paused fixture', url: 'https://example.invalid/paused', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'paused', progress: 42 },
        { id: 'completed-fixture', title: 'Completed fixture', url: 'https://example.invalid/completed', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'completed', progress: 100 },
        { id: 'error-fixture', title: 'Error fixture', url: 'https://example.invalid/error', date: '2026-08-10T12:00:00Z', streamer: 'fixture', duration_str: '1h', status: 'error', progress: 0, last_error: 'Fixture failure' }
      ];
      renderQueue();
      const starting = document.querySelector('#queueList [data-id="starting-fixture"]');
      const pending = document.querySelector('#queueList [data-id="pending-fixture"]');
      const downloading = document.querySelector('#queueList [data-id="downloading-fixture"]');
      const startingBar = starting?.querySelector('.queue-progress-bar');
      const downloadingBar = downloading?.querySelector('.queue-progress-bar');
      const paused = document.querySelector('#queueList [data-id="paused-fixture"]');
      const alignedRows = [pending, starting, paused];
      const leftEdges = (selector) => alignedRows.map((row) => row?.querySelector(selector)?.getBoundingClientRect().left || 0);
      const progressWrap = downloading?.querySelector('.queue-progress-wrap');
      const progressInfo = downloading?.querySelector('.queue-progress-info');
      const statusLabel = downloading?.querySelector('.queue-status-label');
      const remove = downloading?.querySelector('.remove');
      const statusRect = statusLabel?.getBoundingClientRect();
      const removeRect = remove?.getBoundingClientRect();
      const statusLeftEdges = leftEdges('.status');
      const titleLeftEdges = leftEdges('.title');
      const dateLeftEdges = leftEdges('.queue-date');
      const successProbe = document.createElement('span');
      successProbe.style.color = 'var(--success)';
      document.body.appendChild(successProbe);
      const successColor = getComputedStyle(successProbe).color;
      successProbe.remove();
      const progressIsGreen = Boolean(downloadingBar && getComputedStyle(downloadingBar).backgroundImage.includes(successColor));
      const pendingTitleLeftBeforeSelection = pending?.querySelector('.title')?.getBoundingClientRect().left || 0;
      pending?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 }));
      const mergeSelectAction = document.querySelector('[data-queue-action="merge-select"]');
      const mergeSelectActionVisible = Boolean(mergeSelectAction && getComputedStyle(mergeSelectAction).display !== 'none');
      mergeSelectAction?.click();
      const selectedPending = document.querySelector('#queueList [data-id="pending-fixture"]');
      const selectionOrder = selectedPending?.querySelector('.queue-selection-order');
      const pendingTitleLeftAfterSelection = selectedPending?.querySelector('.title')?.getBoundingClientRect().left || 0;
      const resumedItem = queue.find((item) => item.id === 'paused-fixture');
      if (resumedItem) resumedItem.status = 'downloading';
      updateQueueItemProgress({ id: 'paused-fixture', progress: -1, speed: '', eta: '', status: UI_TEXT.queue.started });
      return {
        rows: document.querySelectorAll('#queueList .queue-item').length,
        pending: document.querySelectorAll('#queueList .status.pending').length,
        downloading: document.querySelectorAll('#queueList .status.downloading').length,
        completed: document.querySelectorAll('#queueList .status.completed').length,
        error: document.querySelectorAll('#queueList .status.error').length,
        determinateProgress: document.querySelector('#queueList [data-id="downloading-fixture"] .queue-progress-wrap')?.getAttribute('aria-valuenow') || '',
        startingProgress: starting?.querySelector('.queue-progress-wrap')?.getAttribute('aria-valuenow') || '',
        startingBarWidth: startingBar?.getBoundingClientRect().width || 0,
        startingIndeterminate: startingBar?.classList.contains('indeterminate') === true,
        startingStatusCount: [...starting?.querySelectorAll('.queue-meta, .queue-progress-text, .queue-progress-info') || []].filter((element) => element.textContent?.includes(UI_TEXT.queue.started)).length,
        startingStatusText: starting?.querySelector('.queue-progress-status')?.textContent || '',
        expectedStartingStatusText: UI_TEXT.queue.started,
        startingAnimated: starting?.querySelector('.queue-progress-status')?.classList.contains('is-starting') === true,
        resumedProgress: paused?.querySelector('.queue-progress-wrap')?.getAttribute('aria-valuenow') || '',
        resumedBarWidth: paused?.querySelector('.queue-progress-bar')?.style.width || '',
        statusLeftEdges,
        titleLeftEdges,
        dateLeftEdges,
        dateText: starting?.querySelector('.queue-date')?.textContent || '',
        progressInfoText: progressInfo?.textContent || '',
        progressInfoBelowBar: Boolean(progressWrap && progressInfo && progressInfo.getBoundingClientRect().top >= progressWrap.getBoundingClientRect().bottom),
        progressIsGreen,
        statusRemoveCenterDelta: statusRect && removeRect ? Math.abs((statusRect.top + statusRect.bottom) / 2 - (removeRect.top + removeRect.bottom) / 2) : null,
        reservedSelectionControls: document.querySelectorAll('#queueList .queue-selector, #queueList .queue-selector-placeholder').length,
        mergeSelectActionVisible,
        selectionOrderText: selectionOrder?.textContent?.trim() || '',
        selectionOrderPosition: selectionOrder ? getComputedStyle(selectionOrder).position : '',
        selectedTitleShift: Math.abs(pendingTitleLeftAfterSelection - pendingTitleLeftBeforeSelection),
        retryEnabled: document.getElementById('btnRetryFailed')?.disabled === false
      };
    });
    checks.dynamicQueue = dynamicQueue;
    check(dynamicQueue.rows === 6, `Dynamic queue fixture rendered ${dynamicQueue.rows} of 6 rows`);
    check(dynamicQueue.pending === 1 && dynamicQueue.downloading === 2 && dynamicQueue.completed === 1 && dynamicQueue.error === 1, 'Dynamic queue fixture does not expose all representative states');
    check(dynamicQueue.determinateProgress === '42', `Dynamic queue progress is ${dynamicQueue.determinateProgress} instead of 42`);
    check(dynamicQueue.startingProgress === '0' && dynamicQueue.startingBarWidth === 0 && !dynamicQueue.startingIndeterminate, `Starting queue item fakes progress: value=${dynamicQueue.startingProgress}, width=${dynamicQueue.startingBarWidth}, indeterminate=${dynamicQueue.startingIndeterminate}`);
    check(dynamicQueue.startingStatusCount === 1, `Starting queue status is rendered ${dynamicQueue.startingStatusCount} times instead of once`);
    check(dynamicQueue.startingStatusText === dynamicQueue.expectedStartingStatusText && dynamicQueue.startingAnimated, `Queue start state is not visibly active: ${dynamicQueue.startingStatusText}`);
    check(dynamicQueue.resumedProgress === '42' && dynamicQueue.resumedBarWidth === '42%', `Resuming queue item loses its paused progress: value=${dynamicQueue.resumedProgress}, width=${dynamicQueue.resumedBarWidth}`);
    check(dynamicQueue.statusLeftEdges.every((value) => value > 0) && dynamicQueue.titleLeftEdges.every((value) => value > 0) && dynamicQueue.dateLeftEdges.every((value) => value > 0), 'Queue alignment fixture was measured while hidden');
    check(Math.max(...dynamicQueue.statusLeftEdges) - Math.min(...dynamicQueue.statusLeftEdges) <= 1, `Queue status columns are offset: ${dynamicQueue.statusLeftEdges.join(', ')}`);
    check(Math.max(...dynamicQueue.titleLeftEdges) - Math.min(...dynamicQueue.titleLeftEdges) <= 1, `Queue title columns are offset: ${dynamicQueue.titleLeftEdges.join(', ')}`);
    check(Math.max(...dynamicQueue.dateLeftEdges) - Math.min(...dynamicQueue.dateLeftEdges) <= 1, `Queue date columns are offset: ${dynamicQueue.dateLeftEdges.join(', ')}`);
    check(dynamicQueue.dateText === '10.08.2026', `Queue VOD date is missing or incorrectly formatted: ${dynamicQueue.dateText}`);
    check(dynamicQueue.progressInfoText.includes('42.0%') && dynamicQueue.progressInfoText.includes('55.8 MB/s') && dynamicQueue.progressInfoText.includes('1/1'), `Queue progress details are incomplete: ${dynamicQueue.progressInfoText}`);
    check(dynamicQueue.progressInfoBelowBar, 'Queue progress details are not positioned below the progress bar');
    check(dynamicQueue.progressIsGreen, 'Running queue progress is not green');
    check(dynamicQueue.statusRemoveCenterDelta !== null && dynamicQueue.statusRemoveCenterDelta <= 1, `Queue status and remove action are not vertically aligned: ${dynamicQueue.statusRemoveCenterDelta}`);
    check(dynamicQueue.reservedSelectionControls === 0, `Queue still reserves ${dynamicQueue.reservedSelectionControls} in-flow selection controls`);
    check(dynamicQueue.mergeSelectActionVisible, 'Pending Queue item has no merge selection action in its context menu');
    check(dynamicQueue.selectionOrderText === '1' && dynamicQueue.selectionOrderPosition === 'absolute', `Merge selection order is not a floating badge: ${dynamicQueue.selectionOrderText}/${dynamicQueue.selectionOrderPosition}`);
    check(dynamicQueue.selectedTitleShift <= 1, `Selecting a merge item shifts its title by ${dynamicQueue.selectedTitleShift}px`);
    check(dynamicQueue.retryEnabled, 'Dynamic queue error state does not enable Retry');

    await win.evaluate(() => {
      queue = [];
      renderQueue();
      renderVODs([{
        id: 'locale-fixture',
        title: 'Locale fixture',
        created_at: '2026-08-07T12:00:00Z',
        duration: '1h2m3s',
        thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        url: 'https://example.invalid/vod',
        view_count: 1234
      }], 'fixture');
    });

    await win.evaluate(() => window.changeLanguage('en'));
    await win.keyboard.press('Control+K');
    await win.waitForSelector('#commandPaletteModal.show');
    const englishPalette = await win.evaluate(() => ({
      labels: [...document.querySelectorAll('#commandPaletteList .cp-item-label')].map((item) => item.textContent?.trim() || ''),
      hints: [...document.querySelectorAll('#commandPaletteList .cp-item-hint')].map((item) => item.textContent?.trim() || '')
    }));
    await win.keyboard.press('Escape');
    await win.evaluate(() => window.showTab('archive'));
    const englishChrome = await win.evaluate(() => ({
      navSettings: document.getElementById('navSettingsText')?.textContent?.trim() || '',
      contextHeading: document.querySelector('[data-context-for="archive"] [data-context-heading]')?.textContent?.trim() || '',
      archiveResults: document.getElementById('archiveResultsNavText')?.textContent?.trim() || '',
      selectFolder: document.getElementById('selectFolderBtn')?.textContent?.trim() || '',
      later: document.getElementById('workspaceUpdateLater')?.textContent?.trim() || '',
      dismiss: document.getElementById('workspaceUpdateDismiss')?.textContent?.trim() || document.getElementById('workspaceUpdateDismiss')?.getAttribute('aria-label')?.trim() || '',
      mainNavigation: document.querySelector('.top-nav')?.getAttribute('aria-label') || '',
      workspaceContext: document.querySelector('.context-sidebar')?.getAttribute('aria-label') || '',
      vodWorkspace: document.querySelector('[data-context-for="vods"] .context-switcher')?.getAttribute('aria-label') || '',
      clipSections: document.querySelector('[data-context-for="clips"] .context-list')?.getAttribute('aria-label') || '',
      cutterSections: document.querySelector('[data-context-for="cutter"] .context-list')?.getAttribute('aria-label') || '',
      mergeSections: document.querySelector('[data-context-for="merge"] .context-list')?.getAttribute('aria-label') || '',
      statisticsSections: document.querySelector('[data-context-for="stats"] .context-list')?.getAttribute('aria-label') || '',
      archiveSections: document.querySelector('[data-context-for="archive"] .context-list')?.getAttribute('aria-label') || '',
      settingsSections: document.querySelector('[data-context-for="settings"] .context-list')?.getAttribute('aria-label') || '',
      cutVideo: document.querySelector('button[onclick="startCutting()"]')?.getAttribute('aria-label') || '',
      mergeVideos: document.querySelector('button[onclick="startMerging()"]')?.getAttribute('aria-label') || '',
      streamerWorkspaceSwitch: document.querySelector('.context-switcher button:first-child')?.textContent?.trim() || '',
      queueWorkspaceSwitch: document.querySelector('.context-switcher button:nth-child(2)')?.textContent?.trim() || '',
      commandTitle: document.getElementById('commandPaletteTitle')?.textContent?.trim() || '',
      commandPalette: document.getElementById('commandPaletteInput')?.getAttribute('aria-label') || '',
      commandResults: document.getElementById('commandPaletteList')?.getAttribute('aria-label') || ''
    }));
    await win.evaluate(() => window.showTab('vods'));
    const englishDate = await win.locator('.vod-card .vod-meta span').first().textContent();
    const expectedEnglishDate = '07.08.2026';

    await win.evaluate(() => window.changeLanguage('de'));
    await win.keyboard.press('Control+K');
    await win.waitForSelector('#commandPaletteModal.show');
    const germanPalette = await win.evaluate(() => ({
      labels: [...document.querySelectorAll('#commandPaletteList .cp-item-label')].map((item) => item.textContent?.trim() || ''),
      hints: [...document.querySelectorAll('#commandPaletteList .cp-item-hint')].map((item) => item.textContent?.trim() || '')
    }));
    await win.keyboard.press('Escape');
    await win.evaluate(() => window.showTab('archive'));
    const germanChrome = await win.evaluate(() => ({
      navSettings: document.getElementById('navSettingsText')?.textContent?.trim() || '',
      contextHeading: document.querySelector('[data-context-for="archive"] [data-context-heading]')?.textContent?.trim() || '',
      archiveResults: document.getElementById('archiveResultsNavText')?.textContent?.trim() || '',
      selectFolder: document.getElementById('selectFolderBtn')?.textContent?.trim() || '',
      later: document.getElementById('workspaceUpdateLater')?.textContent?.trim() || '',
      dismiss: document.getElementById('workspaceUpdateDismiss')?.textContent?.trim() || document.getElementById('workspaceUpdateDismiss')?.getAttribute('aria-label')?.trim() || '',
      mainNavigation: document.querySelector('.top-nav')?.getAttribute('aria-label') || '',
      workspaceContext: document.querySelector('.context-sidebar')?.getAttribute('aria-label') || '',
      vodWorkspace: document.querySelector('[data-context-for="vods"] .context-switcher')?.getAttribute('aria-label') || '',
      clipSections: document.querySelector('[data-context-for="clips"] .context-list')?.getAttribute('aria-label') || '',
      cutterSections: document.querySelector('[data-context-for="cutter"] .context-list')?.getAttribute('aria-label') || '',
      mergeSections: document.querySelector('[data-context-for="merge"] .context-list')?.getAttribute('aria-label') || '',
      statisticsSections: document.querySelector('[data-context-for="stats"] .context-list')?.getAttribute('aria-label') || '',
      archiveSections: document.querySelector('[data-context-for="archive"] .context-list')?.getAttribute('aria-label') || '',
      settingsSections: document.querySelector('[data-context-for="settings"] .context-list')?.getAttribute('aria-label') || '',
      cutVideo: document.querySelector('button[onclick="startCutting()"]')?.getAttribute('aria-label') || '',
      mergeVideos: document.querySelector('button[onclick="startMerging()"]')?.getAttribute('aria-label') || '',
      streamerWorkspaceSwitch: document.querySelector('.context-switcher button:first-child')?.textContent?.trim() || '',
      queueWorkspaceSwitch: document.querySelector('.context-switcher button:nth-child(2)')?.textContent?.trim() || '',
      commandTitle: document.getElementById('commandPaletteTitle')?.textContent?.trim() || '',
      commandPalette: document.getElementById('commandPaletteInput')?.getAttribute('aria-label') || '',
      commandResults: document.getElementById('commandPaletteList')?.getAttribute('aria-label') || ''
    }));
    await win.evaluate(() => window.showTab('vods'));
    const germanDate = await win.locator('.vod-card .vod-meta span').first().textContent();
    const expectedGermanDate = '07.08.2026';
    checks.locale = { englishChrome, germanChrome, englishPalette, germanPalette, englishDate, expectedEnglishDate, germanDate, expectedGermanDate };
    const profileGrammarAndAlignment = await win.evaluate(() => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      renderStreamerProfileCard({
        login: 'alignment_fixture',
        displayName: 'Alignment Fixture',
        avatarUrl: '',
        bannerUrl: '',
        description: '',
        broadcasterType: '',
        followerCount: 1_300_000,
        vodCount: 45,
        lastStreamAt: oneDayAgo,
        isLive: false,
        currentTitle: null,
        currentGame: null,
        currentStreamPreviewUrl: '',
        currentStreamViewers: null,
        twitchUrl: 'https://twitch.tv/alignment_fixture',
        fetchedAt: Date.now()
      });
      const centerDeltas = [...document.querySelectorAll('.streamer-profile-stat')].map((stat) => {
        const iconRect = stat.querySelector('svg')?.getBoundingClientRect();
        const strongRect = stat.querySelector('strong')?.getBoundingClientRect();
        return iconRect && strongRect ? Math.abs((iconRect.top + iconRect.height / 2) - (strongRect.top + strongRect.height / 2)) : Number.MAX_SAFE_INTEGER;
      });
      return {
        oneDay: formatLastStreamAgo(oneDayAgo),
        twoDays: formatLastStreamAgo(twoDaysAgo),
        centerDeltas,
        lineHeights: [...document.querySelectorAll('.streamer-profile-stat')].map((stat) => getComputedStyle(stat).lineHeight)
      };
    });
    checks.profileGrammarAndAlignment = profileGrammarAndAlignment;
    check(profileGrammarAndAlignment.oneDay === 'vor 1 Tag', `German one-day profile copy is wrong: ${profileGrammarAndAlignment.oneDay}`);
    check(profileGrammarAndAlignment.twoDays === 'vor 2 Tagen', `German multi-day profile copy is wrong: ${profileGrammarAndAlignment.twoDays}`);
    check(profileGrammarAndAlignment.centerDeltas.length === 3 && profileGrammarAndAlignment.centerDeltas.every((delta) => delta <= 1), `Profile metadata icons and values are vertically misaligned: ${JSON.stringify(profileGrammarAndAlignment)}`);
    check(new Set(profileGrammarAndAlignment.lineHeights).size === 1 && profileGrammarAndAlignment.lineHeights[0] === '18px', `Profile metadata does not share one 18px line height: ${JSON.stringify(profileGrammarAndAlignment.lineHeights)}`);

    await win.setViewportSize({ width: 1600, height: 900 });
    const captureTopNavigationLayout = async (language) => {
      await win.evaluate((nextLanguage) => window.changeLanguage(nextLanguage), language);
      await win.waitForTimeout(40);
      return win.evaluate(() => [...document.querySelectorAll('.top-nav button[data-tab]')].map((button) => {
        const label = button.querySelector('.top-nav-label');
        const rect = button.getBoundingClientRect();
        return {
          tab: button.dataset.tab || '',
          text: label?.textContent?.trim() || '',
          left: rect.left,
          width: rect.width,
          truncated: Boolean(label && label.scrollWidth > label.clientWidth + 1)
        };
      }));
    };
    const englishTopNavigation = await captureTopNavigationLayout('en');
    const germanTopNavigation = await captureTopNavigationLayout('de');
    checks.topNavigationLocaleLayout = { english: englishTopNavigation, german: germanTopNavigation };
    check(germanTopNavigation.find((item) => item.tab === 'merge')?.text === 'Videos zusammenfügen', `German merge navigation says "${germanTopNavigation.find((item) => item.tab === 'merge')?.text}"`);
    check(germanTopNavigation.every((item) => !item.truncated), `German top navigation truncates: ${germanTopNavigation.filter((item) => item.truncated).map((item) => item.text).join(', ')}`);
    check(englishTopNavigation.every((item, index) => Math.abs(item.left - germanTopNavigation[index].left) <= 1 && Math.abs(item.width - germanTopNavigation[index].width) <= 1), 'Top navigation geometry shifts when switching language');

    const germanTextAudit = await win.evaluate(() => {
      const flatten = (value) => Object.values(value).flatMap((entry) => typeof entry === 'string' ? [entry] : entry && typeof entry === 'object' ? flatten(entry) : []);
      const localeText = flatten(UI_TEXT_DE).join('\n').toLocaleLowerCase('de-DE');
      const domText = [
        document.body.textContent || '',
        ...[...document.querySelectorAll('[title], [placeholder], [aria-label]')].flatMap((element) => [element.getAttribute('title') || '', element.getAttribute('placeholder') || '', element.getAttribute('aria-label') || ''])
      ].join('\n').toLocaleLowerCase('de-DE');
      const forbidden = ['verfugbar', 'uberspringen', 'fur ', 'hinzufugen', 'hinzufuegen', 'schliessen', 'auswahlen', 'auswaehlen', 'auflosung', 'zusammenfugen', 'wahle ', 'uebersicht', 'groesse', 'groessen', 'aelteste', 'qualitaet', 'waehrend', 'loeschen', 'nuetzlich', 'geprueft', 'geraet', 'zurueck', 'ausfuehren', 'wuerde', 'aelter', 'eintraege', 'oeffnen', 'ungueltig', 'kuerzere', 'gleichmaessig', 'einfuegereihenfolge', 'noetig', 'behaelt', 'faellt', 'laeuft', 'gekuerzt', 'ausserhalb', 'fliessen', 'grosser', 'aktivitaet', 'gruene', 'laengste', 'kuerzeste', 'zugehoerige'];
      return {
        localeMatches: forbidden.filter((token) => localeText.includes(token)),
        domMatches: forbidden.filter((token) => domText.includes(token))
      };
    });
    checks.germanTextAudit = germanTextAudit;
    check(germanTextAudit.localeMatches.length === 0, `German locale still contains replacement spellings: ${germanTextAudit.localeMatches.join(', ')}`);
    check(germanTextAudit.domMatches.length === 0, `German DOM still contains replacement spellings: ${germanTextAudit.domMatches.join(', ')}`);

    const selectionPolicy = await win.evaluate(() => {
      const input = document.getElementById('settingsSearchInput');
      const label = document.getElementById('navVodsText');
      const button = document.querySelector('.top-nav button[data-tab="vods"]');
      return {
        body: getComputedStyle(document.body).userSelect,
        label: label ? getComputedStyle(label).userSelect : '',
        button: button ? getComputedStyle(button).userSelect : '',
        input: input ? getComputedStyle(input).userSelect : ''
      };
    });
    checks.selectionPolicy = selectionPolicy;
    check(selectionPolicy.body === 'none' && selectionPolicy.label === 'none' && selectionPolicy.button === 'none', `Static UI remains selectable: ${JSON.stringify(selectionPolicy)}`);
    check(selectionPolicy.input === 'text', `Editable text input is not selectable: ${JSON.stringify(selectionPolicy)}`);

    check(englishChrome.navSettings === 'Settings', `English top navigation says "${englishChrome.navSettings}"`);
    check(englishChrome.contextHeading === 'Archive', `English context heading says "${englishChrome.contextHeading}"`);
    check(englishChrome.archiveResults === 'Results', `English archive context action says "${englishChrome.archiveResults}"`);
    check(/^later$/i.test(englishChrome.later), `English update Later action says "${englishChrome.later}"`);
    check(/^close$/i.test(englishChrome.dismiss), `English update Close action says "${englishChrome.dismiss}"`);
    check(englishChrome.mainNavigation === 'Main navigation', `English main navigation aria-label says "${englishChrome.mainNavigation}"`);
    check(englishChrome.workspaceContext === 'Workspace context', `English workspace context aria-label says "${englishChrome.workspaceContext}"`);
    check(englishChrome.vodWorkspace === 'VOD workspace', `English VOD workspace aria-label says "${englishChrome.vodWorkspace}"`);
    check(englishChrome.clipSections === 'Clip sections', `English clip sections aria-label says "${englishChrome.clipSections}"`);
    check(englishChrome.cutterSections === 'Video cutter sections', `English cutter sections aria-label says "${englishChrome.cutterSections}"`);
    check(englishChrome.mergeSections === 'Video merge sections', `English merge sections aria-label says "${englishChrome.mergeSections}"`);
    check(englishChrome.statisticsSections === 'Statistics sections', `English statistics sections aria-label says "${englishChrome.statisticsSections}"`);
    check(englishChrome.archiveSections === 'Archive sections', `English archive sections aria-label says "${englishChrome.archiveSections}"`);
    check(englishChrome.settingsSections === 'Settings sections', `English settings sections aria-label says "${englishChrome.settingsSections}"`);
    check(englishChrome.cutVideo === 'Cut video', `English cut action aria-label says "${englishChrome.cutVideo}"`);
    check(englishChrome.mergeVideos === 'Merge videos', `English merge action aria-label says "${englishChrome.mergeVideos}"`);
    check(englishChrome.streamerWorkspaceSwitch === 'Streamer', `English streamer workspace switch says "${englishChrome.streamerWorkspaceSwitch}"`);
    check(englishChrome.queueWorkspaceSwitch === 'Queue', `English queue workspace switch says "${englishChrome.queueWorkspaceSwitch}"`);
    check(JSON.stringify(englishPalette.labels) === JSON.stringify(['VODs', 'Clips', 'Video cutter', 'Merge videos', 'Statistics', 'Archive', 'Settings']), `English command palette labels are [${englishPalette.labels.join(', ')}]`);
    check(englishPalette.hints.length === 7 && englishPalette.hints.every((hint) => hint === 'Open'), `English command palette hints are [${englishPalette.hints.join(', ')}]`);
    check(englishChrome.commandTitle === 'Command palette', `English command palette title says "${englishChrome.commandTitle}"`);
    check(englishChrome.commandPalette === 'Command palette', `English command palette aria-label says "${englishChrome.commandPalette}"`);
    check(englishChrome.commandResults === 'Command results', `English command results aria-label says "${englishChrome.commandResults}"`);
    check(germanChrome.navSettings === 'Einstellungen', `German top navigation says "${germanChrome.navSettings}"`);
    check(germanChrome.contextHeading === 'Archiv', `German context heading says "${germanChrome.contextHeading}"`);
    check(/^Ergebnisse$/i.test(germanChrome.archiveResults), `German archive context action says "${germanChrome.archiveResults}"`);
    check(/^(Später|Spaeter)$/i.test(germanChrome.later), `German update Later action says "${germanChrome.later}"`);
    check(/^(Schließen|Schliessen)$/i.test(germanChrome.dismiss), `German update Close action says "${germanChrome.dismiss}"`);
    check(Boolean(englishChrome.selectFolder) && Boolean(germanChrome.selectFolder) && englishChrome.selectFolder !== germanChrome.selectFolder, 'Folder chooser action does not switch between English and German');
    check(germanChrome.mainNavigation === 'Hauptnavigation', `German main navigation aria-label says "${germanChrome.mainNavigation}"`);
    check(germanChrome.workspaceContext === 'Arbeitsbereichskontext', `German workspace context aria-label says "${germanChrome.workspaceContext}"`);
    check(germanChrome.vodWorkspace === 'VOD-Arbeitsbereich', `German VOD workspace aria-label says "${germanChrome.vodWorkspace}"`);
    check(germanChrome.clipSections === 'Clip-Bereiche', `German clip sections aria-label says "${germanChrome.clipSections}"`);
    check(germanChrome.cutterSections === 'Videoschnitt-Bereiche', `German cutter sections aria-label says "${germanChrome.cutterSections}"`);
    check(germanChrome.mergeSections === 'Zusammenfügen-Bereiche', `German merge sections aria-label says "${germanChrome.mergeSections}"`);
    check(germanChrome.statisticsSections === 'Statistik-Bereiche', `German statistics sections aria-label says "${germanChrome.statisticsSections}"`);
    check(germanChrome.archiveSections === 'Archiv-Bereiche', `German archive sections aria-label says "${germanChrome.archiveSections}"`);
    check(germanChrome.settingsSections === 'Einstellungsbereiche', `German settings sections aria-label says "${germanChrome.settingsSections}"`);
    check(germanChrome.cutVideo === 'Video schneiden', `German cut action aria-label says "${germanChrome.cutVideo}"`);
    check(germanChrome.mergeVideos === 'Videos zusammenfügen', `German merge action aria-label says "${germanChrome.mergeVideos}"`);
    check(germanChrome.streamerWorkspaceSwitch === 'Streamer', `German streamer workspace switch says "${germanChrome.streamerWorkspaceSwitch}"`);
    check(germanChrome.queueWorkspaceSwitch === 'Warteschlange', `German queue workspace switch says "${germanChrome.queueWorkspaceSwitch}"`);
    check(JSON.stringify(germanPalette.labels) === JSON.stringify(['VODs', 'Clips', 'Videoschnitt', 'Videos zusammenfügen', 'Statistiken', 'Archiv', 'Einstellungen']), `German command palette labels are [${germanPalette.labels.join(', ')}]`);
    check(germanPalette.hints.length === 7 && germanPalette.hints.every((hint) => hint === 'Öffnen'), `German command palette hints are [${germanPalette.hints.join(', ')}]`);
    check(germanChrome.commandTitle === 'Befehlspalette', `German command palette title says "${germanChrome.commandTitle}"`);
    check(germanChrome.commandPalette === 'Befehlspalette', `German command palette aria-label says "${germanChrome.commandPalette}"`);
    check(germanChrome.commandResults === 'Befehlsergebnisse', `German command results aria-label says "${germanChrome.commandResults}"`);
    check(englishDate === expectedEnglishDate, `English VOD date is "${englishDate}" instead of "${expectedEnglishDate}"`);
    check(germanDate === expectedGermanDate, `German VOD date is "${germanDate}" instead of "${expectedGermanDate}"`);

    await win.waitForFunction(() => !document.getElementById('btnStatsRefresh')?.disabled && !document.getElementById('btnArchiveSearch')?.disabled);
    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceLocalizedErrorCalls = { stats: 0, archive: 0 };
      ipcMain.removeHandler('get-archive-stats');
      ipcMain.handle('get-archive-stats', () => {
        globalThis.__workspaceLocalizedErrorCalls.stats += 1;
        throw new Error('localized stats fixture');
      });
      ipcMain.removeHandler('search-archive');
      ipcMain.handle('search-archive', () => {
        globalThis.__workspaceLocalizedErrorCalls.archive += 1;
        throw new Error('localized archive fixture');
      });
    });
    const captureLocalizedErrors = async (language, statsPrefix, archivePrefix, expectedStatsCalls, expectedArchiveCalls) => {
      await win.evaluate((nextLanguage) => {
        window.changeLanguage(nextLanguage);
        window.showTab('stats');
      }, language);
      await win.waitForFunction((prefix) => document.getElementById('statsSummaryGrid')?.textContent?.trim().startsWith(prefix), statsPrefix);
      await win.waitForFunction(() => !document.getElementById('btnStatsRefresh')?.disabled);
      const statsCalls = await app.evaluate(() => globalThis.__workspaceLocalizedErrorCalls.stats);
      check(statsCalls === expectedStatsCalls, `${language} statistics error path made ${statsCalls} IPC calls instead of ${expectedStatsCalls}`);
      const stats = await win.locator('#statsSummaryGrid').textContent();
      await win.evaluate(() => window.showTab('archive'));
      await win.waitForFunction((prefix) => document.getElementById('archiveSearchSummary')?.textContent?.trim().startsWith(prefix), archivePrefix);
      await win.waitForFunction(() => !document.getElementById('btnArchiveSearch')?.disabled);
      const archiveCalls = await app.evaluate(() => globalThis.__workspaceLocalizedErrorCalls.archive);
      check(archiveCalls === expectedArchiveCalls, `${language} archive error path made ${archiveCalls} IPC calls instead of ${expectedArchiveCalls}`);
      const archive = await win.locator('#archiveSearchSummary').textContent();
      return { stats: stats?.trim() || '', archive: archive?.trim() || '' };
    };
    const localizedErrors = {
      english: await captureLocalizedErrors('en', 'Error:', 'Error:', 1, 1),
      german: await captureLocalizedErrors('de', 'Fehler:', 'Fehler:', 2, 2)
    };
    checks.localizedErrors = localizedErrors;
    check(localizedErrors.english.stats.startsWith('Error:'), `English statistics error says "${localizedErrors.english.stats}"`);
    check(localizedErrors.english.archive.startsWith('Error:'), `English archive error says "${localizedErrors.english.archive}"`);
    check(localizedErrors.german.stats.startsWith('Fehler:'), `German statistics error says "${localizedErrors.german.stats}"`);
    check(localizedErrors.german.archive.startsWith('Fehler:'), `German archive error says "${localizedErrors.german.archive}"`);

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('get-archive-stats');
      ipcMain.handle('get-archive-stats', () => ({
        totalFiles: 0,
        totalBytes: 0,
        liveCount: 0,
        liveBytes: 0,
        vodCount: 0,
        vodBytes: 0,
        chatCount: 0,
        chatBytes: 0,
        eventsCount: 0,
        streamerCount: 0,
        avgRecordingSizeBytes: 0,
        topStreamers: [],
        dailyActivity: [],
        sizeBuckets: [],
        scannedAt: '2026-08-10T12:00:00Z',
        downloadPath: '',
        rootExists: true
      }));
      ipcMain.removeHandler('search-archive');
      ipcMain.handle('search-archive', () => ({
        rootExists: true,
        totalScanned: 0,
        matchCount: 0,
        truncated: false,
        hits: []
      }));
    });

    await win.evaluate(() => window.changeLanguage('en'));
    await win.setViewportSize(TARGETS[0]);
    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(160);
    await win.screenshot({
      path: path.join(artifactDir, `workspace-vods-fixture-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.evaluate(() => {
      vodRenderTaskId += 1;
      lastLoadedVods = [];
      lastLoadedStreamer = null;
      setVodGridEmptyState(document.getElementById('vodGrid'), UI_TEXT.vods.noneTitle, UI_TEXT.vods.noneText);
      updateVodFilterCount(0, 0);
    });
    await win.evaluate(() => window.showTab('settings'));

    const captureTheme = async () => win.evaluate(() => {
      const parse = (value) => {
        const parts = value.match(/[\d.]+/g)?.map(Number) || [];
        return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
      };
      const linear = (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (color) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
      const contrast = (foreground, background) => {
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const effectiveBackground = (element) => {
        let current = element;
        while (current) {
          const value = getComputedStyle(current).backgroundColor;
          if (parse(value).a > 0) return value;
          current = current.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      const pair = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const foreground = getComputedStyle(element).color;
        const background = effectiveBackground(element);
        return { foreground, background, contrast: contrast(parse(foreground), parse(background)) };
      };
      return {
        bodyClass: document.body.className,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        title: pair('#pageTitle'),
        contextHeading: pair('[data-context-for="settings"] [data-context-heading]'),
        settingsSearch: pair('#settingsSearchInput'),
        toolbarAction: pair('#toolbarCheckUpdateBtn')
      };
    });

    await win.evaluate(() => window.setSettingsPane('design'));
    await win.emulateMedia({ colorScheme: 'dark' });
    await win.locator('#workspaceThemePicker [data-theme="twitch"]').click();
    await win.waitForTimeout(160);
    const darkTheme = await captureTheme();
    await win.locator('#workspaceThemePicker [data-theme="light"]').click();
    await win.waitForTimeout(160);
    const lightTheme = await captureTheme();
    await win.emulateMedia({ colorScheme: 'light' });
    await win.locator('#workspaceThemePicker [data-theme="system"]').click();
    await win.waitForTimeout(160);
    const systemLightTheme = await captureTheme();
    checks.themes = { darkTheme, lightTheme, systemLightTheme };

    for (const [name, theme] of Object.entries({ dark: darkTheme, light: lightTheme, systemLight: systemLightTheme })) {
      check(Boolean(theme.title && theme.contextHeading && theme.settingsSearch && theme.toolbarAction), `${name} theme is missing a representative computed-style target`);
      for (const [pairName, pair] of Object.entries({ title: theme.title, contextHeading: theme.contextHeading, settingsSearch: theme.settingsSearch, toolbarAction: theme.toolbarAction })) {
        if (pair) check(pair.contrast >= 4.5, `${name} ${pairName} contrast is ${pair.contrast.toFixed(2)}:1`);
      }
    }
    check(darkTheme.bodyClass === 'theme-twitch', `Dark theme body class is ${darkTheme.bodyClass}`);
    check(lightTheme.bodyClass === 'theme-light', `Light theme body class is ${lightTheme.bodyClass}`);
    check(systemLightTheme.bodyClass === 'theme-system', `System theme body class is ${systemLightTheme.bodyClass}`);
    check(darkTheme.bodyBackground !== lightTheme.bodyBackground, 'Explicit Dark and Light themes compute the same body background');
    check(systemLightTheme.bodyBackground === lightTheme.bodyBackground, `System-Light background ${systemLightTheme.bodyBackground} does not match Light ${lightTheme.bodyBackground}`);
    check(systemLightTheme.bodyColor === lightTheme.bodyColor, `System-Light text ${systemLightTheme.bodyColor} does not match Light ${lightTheme.bodyColor}`);

    await win.screenshot({
      path: path.join(artifactDir, `workspace-settings-system-light-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.locator('#workspaceThemePicker [data-theme="light"]').click();
    await win.waitForTimeout(160);
    await win.screenshot({
      path: path.join(artifactDir, `workspace-settings-light-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.emulateMedia({ colorScheme: 'dark' });
    await win.locator('#workspaceThemePicker [data-theme="twitch"]').click();
    const finalScreenshotTheme = await win.evaluate(() => ({
      bodyClass: document.body.className,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      vodFixtureCards: document.querySelectorAll('#vodGrid .vod-card').length
    }));
    checks.finalScreenshotTheme = finalScreenshotTheme;
    check(finalScreenshotTheme.bodyClass === 'theme-twitch', `Canonical screenshots use ${finalScreenshotTheme.bodyClass} instead of Dark`);
    check(finalScreenshotTheme.bodyBackground === darkTheme.bodyBackground, `Canonical screenshot background ${finalScreenshotTheme.bodyBackground} does not match Dark ${darkTheme.bodyBackground}`);
    check(finalScreenshotTheme.vodFixtureCards === 0, `Canonical screenshots retain ${finalScreenshotTheme.vodFixtureCards} VOD fixture cards`);

    await win.evaluate(() => window.setUpdateBannerAvailableUi({ version: '9.9.9' }));
    await win.locator('#workspaceUpdateButton').hover();
    await win.waitForFunction(() => {
      const popover = document.getElementById('workspaceUpdatePopover');
      const style = popover ? getComputedStyle(popover) : null;
      return Boolean(style && style.visibility === 'visible' && Number(style.opacity) > 0);
    });
    const updateScreenshotState = await win.evaluate(() => ({
      bodyClass: document.body.className,
      state: document.getElementById('updateBanner')?.dataset.updateState || '',
      laterVisible: document.getElementById('workspaceUpdateLater')?.hidden === false,
      dismissVisible: document.getElementById('workspaceUpdateDismiss')?.hidden === false
    }));
    checks.updateScreenshotState = updateScreenshotState;
    check(updateScreenshotState.bodyClass === 'theme-twitch', `Update screenshot uses ${updateScreenshotState.bodyClass} instead of Dark`);
    check(updateScreenshotState.state === 'available', `Update screenshot uses ${updateScreenshotState.state} instead of available state`);
    check(updateScreenshotState.laterVisible && updateScreenshotState.dismissVisible, 'Update screenshot does not expose both Later and Close');
    await win.waitForTimeout(160);
    await win.screenshot({
      path: path.join(artifactDir, `workspace-update-${TARGETS[0].width}x${TARGETS[0].height}.png`),
      fullPage: true
    });
    await win.mouse.move(Math.floor(TARGETS[0].width / 2), Math.floor(TARGETS[0].height / 2));
    await win.evaluate(() => window.hideUpdateBanner());

    const responsiveQueueFixtures = [
      { id: 'responsive-pending', title: 'Responsive pending fixture with a deliberately long title that must remain contained inside the queue row', url: 'https://example.invalid/responsive-pending', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'pending', progress: 0 },
      { id: 'responsive-downloading', title: 'Responsive downloading fixture with a deliberately long title that must not widen the workspace', url: 'https://example.invalid/responsive-downloading', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'downloading', progress: 67 },
      { id: 'responsive-completed', title: 'Responsive completed fixture with a deliberately long title for overflow coverage', url: 'https://example.invalid/responsive-completed', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'completed', progress: 100 },
      { id: 'responsive-error', title: 'Responsive error fixture with a deliberately long title and representative failure state', url: 'https://example.invalid/responsive-error', date: '2026-08-10T12:00:00Z', streamer: 'fixture_streamer', duration_str: '12h34m56s', status: 'error', progress: 0, last_error: 'Offline responsive fixture failure' }
    ];
    await app.evaluate(({ ipcMain }, queueFixtures) => {
      globalThis.__workspaceResponsiveQueueSyncCalls = 0;
      ipcMain.removeHandler('get-queue');
      ipcMain.handle('get-queue', () => {
        globalThis.__workspaceResponsiveQueueSyncCalls += 1;
        return queueFixtures.map((item) => ({ ...item }));
      });
    }, responsiveQueueFixtures);
    await win.evaluate((queueFixtures) => {
      const vodFixtures = [
        { id: 'responsive-vod-one', title: 'Responsive VOD fixture with a deliberately long title that must stay inside its card at every supported width', created_at: '2026-08-10T12:00:00Z', duration: '12h34m56s', thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: 'https://example.invalid/responsive-vod-one', view_count: 987654 },
        { id: 'responsive-vod-two', title: 'Short title', created_at: '2026-08-09T12:00:00Z', duration: '9h8m7s', thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', url: 'https://example.invalid/responsive-vod-two', view_count: 123456 }
      ];
      window.__restoreResponsiveFixtures = () => {
        queue = queueFixtures.map((item) => ({ ...item }));
        renderQueue();
        renderVODs(vodFixtures.map((item) => ({ ...item })), 'fixture_streamer');
      };
      window.__restoreResponsiveFixtures();
    }, responsiveQueueFixtures);
    await win.evaluate(() => syncQueueAndDownloadState());
    const responsiveQueueSyncCalls = await app.evaluate(() => globalThis.__workspaceResponsiveQueueSyncCalls);
    const responsiveFixtures = await win.evaluate(() => {
      return {
        queueRows: document.querySelectorAll('#queueList .queue-item').length,
        vodCards: document.querySelectorAll('#vodGrid .vod-card').length
      };
    });
    checks.responsiveFixtures = { ...responsiveFixtures, syncCalls: responsiveQueueSyncCalls };
    check(responsiveQueueSyncCalls >= 1, 'Responsive queue fixtures were not observed through the queue sync IPC path');
    check(responsiveFixtures.queueRows === 4, `Responsive fixture rendered ${responsiveFixtures.queueRows} queue rows instead of 4`);
    check(responsiveFixtures.vodCards === 2, `Responsive fixture rendered ${responsiveFixtures.vodCards} VOD cards instead of 2`);
    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(60);
    const vodCardLayout = await win.evaluate(() => {
      const cards = [...document.querySelectorAll('#vodGrid .vod-card')];
      const longTitle = cards[0]?.querySelector('.vod-title');
      const metaRows = cards.map((card) => [...card.querySelectorAll('.vod-meta > span')].map((span) => span.getBoundingClientRect().top));
      const metadata = cards[0]?.querySelector('.vod-meta');
      const durationBadge = cards[0]?.querySelector('.vod-duration-badge');
      const filterRow = document.querySelector('.vod-filter-row');
      const sort = document.getElementById('vodSortSelect');
      const hide = document.getElementById('vodHideDownloadedLabel');
      const rowRect = filterRow?.getBoundingClientRect();
      const sortRect = sort?.getBoundingClientRect();
      const hideRect = hide?.getBoundingClientRect();
      return {
        cardHeights: cards.map((card) => card.getBoundingClientRect().height),
        titleHeight: longTitle?.getBoundingClientRect().height || 0,
        titleLineHeight: longTitle ? Number.parseFloat(getComputedStyle(longTitle).lineHeight) : 0,
        titleIsEllipsized: Boolean(longTitle && longTitle.scrollWidth > longTitle.clientWidth),
        titleTooltip: longTitle?.getAttribute('title') || '',
        metaRows,
        metadataHasDuration: Boolean(cards[0]?.querySelector('.vod-duration')),
        metadataIcons: cards[0]?.querySelectorAll('.vod-meta svg').length || 0,
        metadataFontSize: metadata ? Number.parseFloat(getComputedStyle(metadata.querySelector('span')).fontSize) : 0,
        durationBadgeBorder: durationBadge ? getComputedStyle(durationBadge).borderTopWidth : '',
        durationBadgeLineHeight: durationBadge ? getComputedStyle(durationBadge).lineHeight : '',
        durationBadgeHeight: durationBadge ? durationBadge.getBoundingClientRect().height : 0,
        sortAtRight: Boolean(rowRect && sortRect && Math.abs(rowRect.right - sortRect.right) <= 1),
        hideBeforeSort: Boolean(hideRect && sortRect && hideRect.right < sortRect.left)
      };
    });
    checks.vodCardLayout = vodCardLayout;
    check(Math.max(...vodCardLayout.cardHeights) - Math.min(...vodCardLayout.cardHeights) <= 1, `VOD cards do not share one height: ${vodCardLayout.cardHeights.join(', ')}`);
    check(Math.abs(vodCardLayout.titleHeight - vodCardLayout.titleLineHeight) <= 1, `Long VOD title uses more than one line: ${vodCardLayout.titleHeight}/${vodCardLayout.titleLineHeight}`);
    check(vodCardLayout.titleIsEllipsized, 'Long VOD title is not visibly shortened with an ellipsis');
    check(vodCardLayout.titleTooltip.startsWith('Responsive VOD fixture'), 'Ellipsized VOD title does not retain the complete hover tooltip');
    check(vodCardLayout.metaRows.every((row) => row.length === 2 && Math.max(...row) - Math.min(...row) <= 1), `VOD metadata is not reduced to aligned date and views: ${JSON.stringify(vodCardLayout.metaRows)}`);
    check(!vodCardLayout.metadataHasDuration, 'VOD duration is still duplicated in the metadata row');
    check(vodCardLayout.metadataIcons === 2 && vodCardLayout.metadataFontSize >= 12, `VOD metadata is not visually identifiable: ${vodCardLayout.metadataIcons}/${vodCardLayout.metadataFontSize}px`);
    check(vodCardLayout.durationBadgeBorder !== '0px', `VOD duration overlay has no contrast border: ${vodCardLayout.durationBadgeBorder}`);
    check(vodCardLayout.durationBadgeLineHeight !== '0px', `VOD duration overlay inherits zero line height: ${vodCardLayout.durationBadgeLineHeight}`);
    check(vodCardLayout.durationBadgeHeight >= 22, `VOD duration overlay is too narrow vertically: ${vodCardLayout.durationBadgeHeight}px`);
    check(vodCardLayout.sortAtRight, 'VOD sort control is not aligned to the far right');
    check(vodCardLayout.hideBeforeSort, 'Hide-downloaded control is not placed before the sort control');

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('get-streamer-display-names');
      ipcMain.handle('get-streamer-display-names', (_, logins) => Object.fromEntries(
        logins.map((login) => [String(login).toLowerCase(), String(login).toLowerCase() === 'xrohat' ? 'xRohat' : String(login)])
      ));
    });

    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(480);
    const streamerSidebarLayout = await win.evaluate(async () => {
      config.streamers = ['xrohat'];
      config.streamer_display_names = {};
      currentStreamer = 'xrohat';
      window.setPageTitle('xrohat');
      await window.hydrateStreamerDisplayNames();
      liveStatusByLogin.set('xrohat', true);
      renderStreamers();
      const item = document.querySelector('#streamerList .streamer-item');
      const remove = item?.querySelector('.remove');
      const counter = document.getElementById('streamerSectionCounter');
      item?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 160,
        clientY: 180
      }));
      const menu = document.querySelector('.streamer-context-menu');
      const itemRect = item?.getBoundingClientRect();
      const removeRect = remove?.getBoundingClientRect();
      return {
        displayName: item?.querySelector('.streamer-name')?.textContent,
        title: document.title,
        hasInlineActions: Boolean(item?.querySelector('.streamer-actions')),
        nameBeforeRemove: Boolean(item && removeRect && item.querySelector('.streamer-name')?.getBoundingClientRect().right <= removeRect.left + 4),
        removeAtRightEdge: Boolean(itemRect && removeRect && Math.abs(itemRect.right - removeRect.right) <= 10),
        counterRemoveCenterDelta: counter && removeRect ? Math.abs((counter.getBoundingClientRect().left + counter.getBoundingClientRect().right) / 2 - (removeRect.left + removeRect.right) / 2) : null,
        removeOpacity: remove ? Number(getComputedStyle(remove).opacity) : 0,
        contextMenuVisible: Boolean(menu && getComputedStyle(menu).display !== 'none'),
        contextMenuActions: [...menu?.querySelectorAll('[data-streamer-action]') || []].map((element) => element.getAttribute('data-streamer-action')),
        counterAtTitleEdge: counter?.parentElement?.id === 'streamerSectionTitle',
        counterHasBorder: getComputedStyle(counter).borderStyle !== 'none',
        counterTextWithLiveStreamer: counter?.textContent?.trim(),
        counterContainsLiveSuffix: Boolean(counter?.querySelector('.streamer-section-counter-live'))
      };
    });
    checks.streamerSidebarLayout = streamerSidebarLayout;
    check(streamerSidebarLayout.displayName === 'xRohat', 'Streamer sidebar does not preserve Twitch display casing');
    check(streamerSidebarLayout.title.startsWith('xRohat - '), 'Window title does not use the Twitch display casing');
    check(!streamerSidebarLayout.hasInlineActions, 'Streamer row still renders inline automation actions');
    check(streamerSidebarLayout.nameBeforeRemove, 'Streamer name does not leave room for the remove action');
    check(streamerSidebarLayout.removeAtRightEdge, 'Streamer remove action is not aligned to the right edge of every row');
    check(streamerSidebarLayout.counterRemoveCenterDelta !== null && streamerSidebarLayout.counterRemoveCenterDelta <= 1, `Streamer counter and remove actions are not on the same x-axis: ${streamerSidebarLayout.counterRemoveCenterDelta}`);
    check(streamerSidebarLayout.removeOpacity >= 0.7, 'Streamer remove action is not visibly available');
    check(streamerSidebarLayout.contextMenuVisible, 'Streamer context menu does not open on right click');
    check(streamerSidebarLayout.contextMenuActions.join(',') === 'auto,vod,record', 'Streamer context menu does not expose AUTO, VOD and REC actions');
    check(streamerSidebarLayout.counterAtTitleEdge && streamerSidebarLayout.counterHasBorder, 'Streamer counter is not rendered as a title-edge badge');
    check(streamerSidebarLayout.counterTextWithLiveStreamer === '1' && !streamerSidebarLayout.counterContainsLiveSuffix, `Streamer counter mixes total and live state: ${streamerSidebarLayout.counterTextWithLiveStreamer}`);
    await win.screenshot({
      path: path.join(artifactDir, 'workspace-streamer-context-menu.png'),
      fullPage: true
    });
    await win.keyboard.press('Escape');

    const streamerSelectionMotion = await win.evaluate(async () => {
      const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      config.streamers = ['xrohat', 'fibii', 'montanablack88'];
      currentStreamer = 'xrohat';
      renderStreamers();
      await pause(420);
      const list = document.getElementById('streamerList');
      const readY = () => new DOMMatrixReadOnly(getComputedStyle(list, '::before').transform).m42;
      const start = readY();
      currentStreamer = 'montanablack88';
      renderStreamers();
      await pause(150);
      const middle = readY();
      const activeBackgroundAtMiddle = getComputedStyle(document.querySelector('#streamerList .streamer-item.active')).backgroundColor;
      await pause(360);
      const target = readY();
      currentStreamer = 'xrohat';
      renderStreamers();
      await pause(150);
      const upwardMiddle = readY();
      await pause(360);
      const upwardTarget = readY();
      return { start, middle, target, upwardMiddle, upwardTarget, activeBackgroundAtMiddle };
    });
    checks.streamerSelectionMotion = streamerSelectionMotion;
    check(streamerSelectionMotion.middle > streamerSelectionMotion.start + 1 && streamerSelectionMotion.middle < streamerSelectionMotion.target - 1, `Streamer selection has no intermediate position: ${JSON.stringify(streamerSelectionMotion)}`);
    check(streamerSelectionMotion.target > streamerSelectionMotion.start + 40, `Streamer selection does not travel down the list: ${JSON.stringify(streamerSelectionMotion)}`);
    check(streamerSelectionMotion.upwardMiddle < streamerSelectionMotion.target - 1 && streamerSelectionMotion.upwardMiddle > streamerSelectionMotion.upwardTarget + 1, `Streamer selection has no upward intermediate position: ${JSON.stringify(streamerSelectionMotion)}`);
    check(Math.abs(streamerSelectionMotion.upwardTarget - streamerSelectionMotion.start) <= 1, `Streamer selection does not return to its first position: ${JSON.stringify(streamerSelectionMotion)}`);
    check(streamerSelectionMotion.activeBackgroundAtMiddle === 'rgba(0, 0, 0, 0)', `Target streamer paints a second background during motion: ${streamerSelectionMotion.activeBackgroundAtMiddle}`);
    await win.evaluate(() => {
      currentStreamer = 'montanablack88';
      renderStreamers();
    });
    await win.waitForTimeout(150);
    await win.screenshot({ path: path.join(artifactDir, 'workspace-streamer-slide-mid.png'), fullPage: true });
    const emptyStreamerIndicatorOpacity = await win.evaluate(async () => {
      config.streamers = [];
      currentStreamer = null;
      renderStreamers();
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      return getComputedStyle(document.getElementById('streamerList'), '::before').opacity;
    });
    check(emptyStreamerIndicatorOpacity === '0', `Streamer selection remains visible behind the empty state: ${emptyStreamerIndicatorOpacity}`);

    const previewFrames = [0, 1, 2, 3].map((index) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="rgb(${index * 40},20,40)"/></svg>`).toString('base64')}`);
    await app.evaluate(({ ipcMain }, frames) => {
      ipcMain.removeHandler('get-vod-storyboard');
      ipcMain.handle('get-vod-storyboard', () => ({
        vodId: 'hover-hd-fixture',
        spriteDataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        frameDataUrls: frames,
        frameWidth: 1920,
        frameHeight: 1080,
        cols: 1,
        rows: 1,
        cellWidth: 1,
        cellHeight: 1,
        framesInSprite: 1
      }));
    }, previewFrames);
    await win.evaluate(() => {
      renderVODs([{
        id: 'hover-hd-fixture',
        title: 'Full HD hover fixture',
        created_at: '2026-08-10T12:00:00Z',
        duration: '1h',
        thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        url: 'https://example.invalid/hover-hd-fixture',
        view_count: 1
      }, {
        id: 'dock-width-fixture',
        title: 'Dock width fixture',
        created_at: '2026-08-09T12:00:00Z',
        duration: '2h',
        thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        url: 'https://example.invalid/dock-width-fixture',
        view_count: 2
      }], 'fixture_streamer');
    });
    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceOpenExternalCalls = [];
      ipcMain.removeHandler('open-external');
      ipcMain.handle('open-external', (_, url) => {
        globalThis.__workspaceOpenExternalCalls.push(url);
      });
    });
    const hoverCard = win.locator('.vod-card[data-vod-id="hover-hd-fixture"]');
    const gridTopBeforeSelection = await win.locator('#vodGrid').evaluate((grid) => grid.getBoundingClientRect().top);
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await hoverCard.locator('.vod-thumbnail').click();
    const clickSelection = await win.evaluate(() => {
      const card = document.querySelector('.vod-card[data-vod-id="hover-hd-fixture"]');
      const checkbox = card?.querySelector('.vod-select-checkbox');
      const tab = document.getElementById('vodsTab');
      const grid = document.getElementById('vodGrid');
      const dock = document.getElementById('vodBulkBar');
      const tabRect = tab?.getBoundingClientRect();
      const dockRect = dock?.getBoundingClientRect();
      return {
        cardSelected: card?.classList.contains('selected') || false,
        checkboxChecked: checkbox?.checked || false,
        selectedUrls: selectedVodUrls.size,
        thumbnailTitle: card?.querySelector('.vod-thumbnail')?.getAttribute('title') || '',
        selectionLabel: UI_TEXT.vods.selectAriaLabel,
        openLabel: UI_TEXT.vods.openOnTwitch,
        gridTop: grid?.getBoundingClientRect().top || 0,
        dockPosition: dock ? getComputedStyle(dock).position : '',
        dockCenterDelta: tabRect && dockRect ? Math.abs((dockRect.left + dockRect.width / 2) - (tabRect.left + tabRect.width / 2)) : Number.MAX_SAFE_INTEGER,
        dockAnimationCount: dock?.getAnimations().length || 0
      };
    });
    const openCallsAfterClick = await app.evaluate(() => [...globalThis.__workspaceOpenExternalCalls]);
    await hoverCard.click({ button: 'right' });
    await win.locator('.context-menu-item').first().click();
    const openCallsAfterContextMenu = await app.evaluate(() => [...globalThis.__workspaceOpenExternalCalls]);
    checks.vodCardClick = { clickSelection, openCallsAfterClick, openCallsAfterContextMenu };
    check(clickSelection.cardSelected && clickSelection.checkboxChecked && clickSelection.selectedUrls === 1, `VOD image click does not select its card: ${JSON.stringify(clickSelection)}`);
    check(clickSelection.thumbnailTitle === clickSelection.selectionLabel && clickSelection.thumbnailTitle !== clickSelection.openLabel, `VOD image still advertises a Twitch open action: ${JSON.stringify(clickSelection)}`);
    check(Math.abs(clickSelection.gridTop - gridTopBeforeSelection) <= 1, `VOD selection shifts the grid by ${clickSelection.gridTop - gridTopBeforeSelection}px`);
    check(clickSelection.dockPosition === 'fixed', `VOD bulk actions are not a floating dock: ${clickSelection.dockPosition}`);
    check(clickSelection.dockCenterDelta <= 2, `VOD bulk dock is not centered in the VOD workspace: ${clickSelection.dockCenterDelta}px`);
    check(clickSelection.dockAnimationCount > 0, 'VOD bulk dock appears without an entrance animation');
    await win.waitForTimeout(280);
    const dockWithOneSelection = await win.locator('#vodBulkBar').evaluate((dock) => {
      const rect = dock.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    });
    const secondDockCard = win.locator('.vod-card[data-vod-id="dock-width-fixture"]');
    await secondDockCard.locator('.vod-thumbnail').click();
    const dockWithTwoSelections = await win.locator('#vodBulkBar').evaluate((dock) => {
      const rect = dock.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    });
    checks.vodBulkDockGeometry = { one: dockWithOneSelection, two: dockWithTwoSelections };
    check(Math.abs(dockWithOneSelection.width - dockWithTwoSelections.width) <= 0.25, `VOD bulk dock width changes between one and two selections: ${dockWithOneSelection.width}/${dockWithTwoSelections.width}`);
    check(Math.abs(dockWithOneSelection.left - dockWithTwoSelections.left) <= 0.25, `VOD bulk dock shifts between one and two selections: ${dockWithOneSelection.left}/${dockWithTwoSelections.left}`);
    await secondDockCard.locator('.vod-thumbnail').click();
    await hoverCard.locator('.vod-thumbnail').click();
    await win.waitForTimeout(80);
    const dockDuringExit = await win.locator('#vodBulkBar').evaluate((dock) => {
      const style = getComputedStyle(dock);
      return {
        display: style.display,
        opacity: Number(style.opacity),
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        animationCount: dock.getAnimations().length,
        translateY: new DOMMatrix(style.transform).m42
      };
    });
    await win.waitForFunction(() => getComputedStyle(document.getElementById('vodBulkBar')).visibility === 'hidden', null, { timeout: 1000 });
    const dockAfterExit = await win.locator('#vodBulkBar').evaluate((dock) => {
      const style = getComputedStyle(dock);
      return {
        display: style.display,
        opacity: Number(style.opacity),
        visibility: style.visibility,
        pointerEvents: style.pointerEvents
      };
    });
    checks.vodBulkDockExit = { during: dockDuringExit, after: dockAfterExit };
    check(dockDuringExit.display === 'flex' && dockDuringExit.visibility === 'visible', `VOD bulk dock disappears before its exit motion: ${JSON.stringify(dockDuringExit)}`);
    check(dockDuringExit.opacity > 0 && dockDuringExit.opacity < 1, `VOD bulk dock has no visible exit opacity frame: ${JSON.stringify(dockDuringExit)}`);
    check(dockDuringExit.animationCount > 0, `VOD bulk dock exits without a running transition: ${JSON.stringify(dockDuringExit)}`);
    check(dockDuringExit.translateY > 1, `VOD bulk dock exit has no downward movement: ${JSON.stringify(dockDuringExit)}`);
    check(dockAfterExit.display === 'flex' && dockAfterExit.visibility === 'hidden' && dockAfterExit.pointerEvents === 'none' && dockAfterExit.opacity === 0, `VOD bulk dock does not finish in a non-interactive hidden state: ${JSON.stringify(dockAfterExit)}`);
    await hoverCard.locator('.vod-thumbnail').click();
    await win.waitForTimeout(280);
    check(openCallsAfterClick.length === 0, `VOD image click still opens Twitch: ${JSON.stringify(openCallsAfterClick)}`);
    check(openCallsAfterContextMenu.length === 1 && openCallsAfterContextMenu[0] === 'https://example.invalid/hover-hd-fixture', `VOD context menu does not exclusively open Twitch: ${JSON.stringify(openCallsAfterContextMenu)}`);
    await win.locator('#toolbarRefreshVodsBtn').hover();
    await win.waitForTimeout(40);
    await hoverCard.hover();
    await win.waitForTimeout(320);
    const hdHoverFirst = await win.evaluate(() => {
      const overlay = document.querySelector('.vod-card[data-vod-id="hover-hd-fixture"] .vod-storyboard-preview');
      const checkbox = document.querySelector('.vod-card[data-vod-id="hover-hd-fixture"] .vod-select-checkbox');
      const duration = document.querySelector('.vod-card[data-vod-id="hover-hd-fixture"] .vod-duration-badge');
      const checkboxStyle = checkbox ? getComputedStyle(checkbox) : null;
      const durationStyle = duration ? getComputedStyle(duration) : null;
      return overlay ? {
        backgroundImage: getComputedStyle(overlay).backgroundImage,
        backgroundSize: getComputedStyle(overlay).backgroundSize,
        checkboxOpacity: checkboxStyle?.opacity || '',
        checkboxBorderColor: checkboxStyle?.borderColor || '',
        checkboxBackgroundImage: checkboxStyle?.backgroundImage || '',
        checkboxZIndex: checkboxStyle?.zIndex || '',
        durationOpacity: durationStyle?.opacity || '',
        durationZIndex: durationStyle?.zIndex || ''
      } : null;
    });
    await win.waitForTimeout(650);
    const hdHoverSecond = await win.evaluate(() => {
      const overlay = document.querySelector('.vod-card[data-vod-id="hover-hd-fixture"] .vod-storyboard-preview');
      return overlay ? getComputedStyle(overlay).backgroundImage : null;
    });
    checks.hdVodHover = { first: hdHoverFirst, secondBackgroundImage: hdHoverSecond };
    check(hdHoverFirst?.backgroundImage.includes(previewFrames[0]), `VOD hover does not start with the first 1080p frame: ${hdHoverFirst?.backgroundImage}`);
    check(hdHoverFirst?.backgroundSize === 'cover', `VOD hover does not render the 1080p frame as a full-frame image: ${hdHoverFirst?.backgroundSize}`);
    check(hdHoverFirst?.checkboxOpacity === '1', `VOD selection disappears during preview: ${hdHoverFirst?.checkboxOpacity}`);
    check(hdHoverFirst?.checkboxBorderColor === 'rgb(34, 197, 94)', `Selected VOD checkbox is not green: ${hdHoverFirst?.checkboxBorderColor}`);
    check(hdHoverFirst?.checkboxBackgroundImage.includes('%2322c55e'), `Selected VOD checkmark is not green: ${hdHoverFirst?.checkboxBackgroundImage}`);
    check(Number(hdHoverFirst?.checkboxZIndex) > 2, `VOD selection is behind the preview overlay: ${hdHoverFirst?.checkboxZIndex}`);
    check(hdHoverFirst?.durationOpacity === '1', `VOD duration disappears during preview: ${hdHoverFirst?.durationOpacity}`);
    check(Number(hdHoverFirst?.durationZIndex) > 2, `VOD duration is behind the preview overlay: ${hdHoverFirst?.durationZIndex}`);
    check(hdHoverSecond?.includes(previewFrames[1]), `VOD hover does not cycle to the next 1080p frame: ${hdHoverSecond}`);
    await win.screenshot({
      path: path.join(artifactDir, 'workspace-vod-hover-hd.png'),
      fullPage: true
    });

    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(480);
    const sidebarLayoutPreference = await win.evaluate(() => {
      const panel = document.querySelector('[data-context-for="vods"]');
      const visible = (element) => Boolean(element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0);
      if (typeof window.applySidebarLayoutPreference !== 'function') {
        return { split: { mode: '', switcherVisible: true, streamersVisible: false, queueVisible: false, streamerGrow: '0', queueGrow: '0' }, tabs: { mode: '', switcherVisible: false, streamersVisible: false, queueVisible: false, settingExists: false } };
      }
      window.applySidebarLayoutPreference(true);
      const split = {
        mode: panel?.dataset.vodsLayout || '',
        switcherVisible: visible(panel?.querySelector('.context-switcher')),
        streamersVisible: visible(panel?.querySelector('.streamer-section')),
        queueVisible: visible(panel?.querySelector('.queue-section')),
        streamerGrow: getComputedStyle(panel?.querySelector('.streamer-section')).flexGrow,
        queueGrow: getComputedStyle(panel?.querySelector('.queue-section')).flexGrow
      };
      window.applySidebarLayoutPreference(false);
      window.setVodsWorkspace('queue');
      const tabs = {
        mode: panel?.dataset.vodsLayout || '',
        switcherVisible: visible(panel?.querySelector('.context-switcher')),
        streamersVisible: visible(panel?.querySelector('.streamer-section')),
        queueVisible: visible(panel?.querySelector('.queue-section')),
        settingExists: Boolean(document.getElementById('sidebarSplitViewToggle'))
      };
      return { split, tabs };
    });
    checks.sidebarLayoutPreference = sidebarLayoutPreference;
    check(sidebarLayoutPreference.split.mode === 'split' && !sidebarLayoutPreference.split.switcherVisible, `Split sidebar does not hide the Streamer/Queue switcher: ${JSON.stringify(sidebarLayoutPreference.split)}`);
    check(sidebarLayoutPreference.split.streamersVisible && sidebarLayoutPreference.split.queueVisible, 'Split sidebar does not show Streamer and Queue together');
    check(sidebarLayoutPreference.split.streamerGrow === '1' && sidebarLayoutPreference.split.queueGrow === '1', `Split sidebar does not divide available height: ${sidebarLayoutPreference.split.streamerGrow}/${sidebarLayoutPreference.split.queueGrow}`);
    check(sidebarLayoutPreference.tabs.mode === 'tabs' && sidebarLayoutPreference.tabs.switcherVisible, `Tabbed sidebar does not restore the Streamer/Queue switcher: ${JSON.stringify(sidebarLayoutPreference.tabs)}`);
    check(!sidebarLayoutPreference.tabs.streamersVisible && sidebarLayoutPreference.tabs.queueVisible, 'Tabbed sidebar queue selection does not remain exclusive');
    check(sidebarLayoutPreference.tabs.settingExists, 'Design Settings does not expose the sidebar layout preference');
    await win.evaluate(() => {
      if (typeof window.applySidebarLayoutPreference === 'function') window.applySidebarLayoutPreference(true);
    });

    const queueWorkspaceView = await win.evaluate(() => {
      if (typeof window.applySidebarLayoutPreference === 'function') window.applySidebarLayoutPreference(false);
      window.setVodsWorkspace('queue');
      const panel = document.querySelector('[data-context-for="vods"]');
      const streamers = document.getElementById('streamerList');
      const queueSection = document.querySelector('.context-sidebar .queue-section');
      const queueCount = document.getElementById('queueCount');
      const isVisible = (element) => {
        if (!element || element.hidden) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const queueCountStyle = queueCount ? getComputedStyle(queueCount) : null;
      return {
        view: panel?.dataset.vodsWorkspace || '',
        queueActive: document.getElementById('queueWorkspaceSwitch')?.getAttribute('aria-pressed') || '',
        streamerActive: document.getElementById('streamerWorkspaceSwitch')?.getAttribute('aria-pressed') || '',
        streamersVisible: isVisible(streamers),
        queueVisible: isVisible(queueSection),
        queueCanFillSidebar: queueSection ? getComputedStyle(queueSection).flexGrow === '1' : false,
        countBackground: queueCountStyle?.backgroundColor || '',
        countColor: queueCountStyle?.color || ''
      };
    });
    checks.queueWorkspaceView = queueWorkspaceView;
    check(queueWorkspaceView.view === 'queue', 'Queue switch does not set the queue workspace view');
    check(queueWorkspaceView.queueActive === 'true' && queueWorkspaceView.streamerActive === 'false', 'Queue switch does not update its pressed state');
    check(!queueWorkspaceView.streamersVisible && queueWorkspaceView.queueVisible, 'Queue switch leaves the streamer list in the queue workspace');
    check(queueWorkspaceView.queueCanFillSidebar, 'Queue workspace does not use the available sidebar height');
    check(queueWorkspaceView.countBackground === 'rgb(31, 122, 67)' && queueWorkspaceView.countColor === 'rgb(255, 255, 255)', 'Queue counter does not use the readable green treatment');
    await win.screenshot({
      path: path.join(artifactDir, 'workspace-queue-view.png'),
      fullPage: true
    });
    await win.evaluate(() => window.setVodsWorkspace('streamers'));

    await win.emulateMedia({ reducedMotion: 'reduce' });
    const contextSwitcherMotion = await win.evaluate(async () => {
      const switcher = document.querySelector('.context-switcher');
      const readX = () => new DOMMatrixReadOnly(getComputedStyle(switcher, '::before').transform).m41;
      const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      window.setVodsWorkspace('streamers');
      await pause(460);
      const start = readX();
      let transformRuns = 0;
      const listener = (event) => {
        if (event.pseudoElement === '::before' && event.propertyName === 'transform') transformRuns += 1;
      };
      switcher.addEventListener('transitionrun', listener);
      window.setVodsWorkspace('queue');
      await pause(150);
      const middle = readX();
      const targetBackgroundAtMiddle = getComputedStyle(document.getElementById('queueWorkspaceSwitch')).backgroundColor;
      await pause(420);
      const target = readX();
      window.setVodsWorkspace('streamers');
      await pause(150);
      const reverseMiddle = readX();
      await pause(420);
      const reverseTarget = readX();
      switcher.removeEventListener('transitionrun', listener);
      return {
        start,
        middle,
        target,
        reverseMiddle,
        reverseTarget,
        targetBackgroundAtMiddle,
        transformRuns,
        transition: getComputedStyle(switcher, '::before').transition
      };
    });
    checks.contextSwitcherMotion = contextSwitcherMotion;
    const contextMotionMinimum = Math.min(contextSwitcherMotion.start, contextSwitcherMotion.target);
    const contextMotionMaximum = Math.max(contextSwitcherMotion.start, contextSwitcherMotion.target);
    check(contextSwitcherMotion.transformRuns >= 1, 'Streamer/Queue marker does not start a transform transition');
    check(contextSwitcherMotion.middle > contextMotionMinimum + 1 && contextSwitcherMotion.middle < contextMotionMaximum - 1, 'Streamer/Queue marker has no visible intermediate position');
    check(Math.abs(contextSwitcherMotion.target - contextSwitcherMotion.start) > 1, 'Streamer/Queue marker does not travel between views');
    check(contextSwitcherMotion.reverseMiddle > contextMotionMinimum + 1 && contextSwitcherMotion.reverseMiddle < contextMotionMaximum - 1, 'Queue/Streamer marker has no visible reverse intermediate position');
    check(Math.abs(contextSwitcherMotion.reverseTarget - contextSwitcherMotion.start) < 1, 'Queue/Streamer marker does not return to the streamer view');
    check(contextSwitcherMotion.targetBackgroundAtMiddle === 'rgba(0, 0, 0, 0)', `Queue target paints a second background during motion: ${contextSwitcherMotion.targetBackgroundAtMiddle}`);
    await win.evaluate(() => window.setVodsWorkspace('streamers'));
    await win.waitForTimeout(460);
    await win.evaluate(() => window.setVodsWorkspace('queue'));
    await win.waitForTimeout(150);
    await win.screenshot({ path: path.join(artifactDir, 'workspace-context-switcher-slide-mid.png'), fullPage: true });
    await win.evaluate(() => window.setVodsWorkspace('streamers'));

    await win.evaluate(() => window.showTab('settings'));
    const languageSwitcherMotion = await win.evaluate(async () => {
      const picker = document.getElementById('languagePicker');
      const readX = () => new DOMMatrixReadOnly(getComputedStyle(picker, '::before').transform).m41;
      const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      window.changeLanguage('en');
      await pause(460);
      const start = readX();
      let transformRuns = 0;
      const listener = (event) => {
        if (event.pseudoElement === '::before' && event.propertyName === 'transform') transformRuns += 1;
      };
      picker.addEventListener('transitionrun', listener);
      window.changeLanguage('de');
      await pause(150);
      const middle = readX();
      const targetBackgroundAtMiddle = getComputedStyle(document.getElementById('langOptionDe')).backgroundColor;
      const englishLabelBlendAtMiddle = getComputedStyle(document.getElementById('languageEnText')).mixBlendMode;
      const germanLabelBlendAtMiddle = getComputedStyle(document.getElementById('languageDeText')).mixBlendMode;
      await pause(420);
      const target = readX();
      const germanLabelColorSelected = getComputedStyle(document.getElementById('languageDeText')).color;
      const englishLabelColorInactive = getComputedStyle(document.getElementById('languageEnText')).color;
      window.changeLanguage('en');
      await pause(150);
      const reverseMiddle = readX();
      await pause(420);
      const reverseTarget = readX();
      picker.removeEventListener('transitionrun', listener);
      return {
        firstOption: picker.querySelector('button:first-of-type')?.id || '',
        secondOption: picker.querySelector('button:nth-of-type(2)')?.id || '',
        firstLabel: picker.querySelector('button:first-of-type')?.textContent?.trim() || '',
        secondLabel: picker.querySelector('button:nth-of-type(2)')?.textContent?.trim() || '',
        start,
        middle,
        target,
        reverseMiddle,
        reverseTarget,
        targetBackgroundAtMiddle,
        englishLabelBlendAtMiddle,
        germanLabelBlendAtMiddle,
        germanLabelColorSelected,
        englishLabelColorInactive,
        transformRuns,
        transition: getComputedStyle(picker, '::before').transition
      };
    });
    checks.languageSwitcherMotion = languageSwitcherMotion;
    const languageMotionMinimum = Math.min(languageSwitcherMotion.start, languageSwitcherMotion.target);
    const languageMotionMaximum = Math.max(languageSwitcherMotion.start, languageSwitcherMotion.target);
    check(languageSwitcherMotion.firstOption === 'langOptionEn' && languageSwitcherMotion.secondOption === 'langOptionDe', 'Language options are not ordered English left and German right');
    check(languageSwitcherMotion.firstLabel === 'English' && languageSwitcherMotion.secondLabel === 'Deutsch', `Language options do not keep their self-names: ${languageSwitcherMotion.firstLabel} / ${languageSwitcherMotion.secondLabel}`);
    check(languageSwitcherMotion.transformRuns >= 1, 'Language marker does not start a transform transition');
    check(languageSwitcherMotion.middle > languageMotionMinimum + 1 && languageSwitcherMotion.middle < languageMotionMaximum - 1, 'Language marker has no visible intermediate position');
    check(Math.abs(languageSwitcherMotion.target - languageSwitcherMotion.start) > 1, 'Language marker does not travel between languages');
    check(languageSwitcherMotion.reverseMiddle > languageMotionMinimum + 1 && languageSwitcherMotion.reverseMiddle < languageMotionMaximum - 1, 'Language marker has no visible reverse intermediate position');
    check(Math.abs(languageSwitcherMotion.reverseTarget - languageSwitcherMotion.start) < 1, 'Language marker does not return to English');
    check(languageSwitcherMotion.targetBackgroundAtMiddle === 'rgba(0, 0, 0, 0)', `Language target paints a second background during motion: ${languageSwitcherMotion.targetBackgroundAtMiddle}`);
    check(languageSwitcherMotion.englishLabelBlendAtMiddle === 'normal' && languageSwitcherMotion.germanLabelBlendAtMiddle === 'normal', `Language labels still use color-distorting blend modes: ${languageSwitcherMotion.englishLabelBlendAtMiddle}/${languageSwitcherMotion.germanLabelBlendAtMiddle}`);
    check(languageSwitcherMotion.germanLabelColorSelected === 'rgb(23, 32, 51)' && languageSwitcherMotion.englishLabelColorInactive === 'rgb(173, 169, 169)', `Selected and inactive language labels do not use the requested contrast: ${languageSwitcherMotion.germanLabelColorSelected}/${languageSwitcherMotion.englishLabelColorInactive}`);
    await win.evaluate(() => window.changeLanguage('en'));
    await win.waitForTimeout(460);
    await win.evaluate(() => window.changeLanguage('de'));
    await win.waitForTimeout(150);
    await win.screenshot({ path: path.join(artifactDir, 'workspace-language-switcher-slide-mid.png'), fullPage: true });

    const settingsNavigationMotion = await win.evaluate(async () => {
      const list = document.querySelector('[data-context-for="settings"] .context-list');
      const buttons = [...list.querySelectorAll('.context-link')];
      const designButton = list.querySelector('[data-settings-pane="design"]') || buttons[0];
      const updatesButton = list.querySelector('[data-settings-pane="updates"]') || buttons[3];
      const readY = () => new DOMMatrixReadOnly(getComputedStyle(list, '::before').transform).m42;
      const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      designButton.click();
      await pause(460);
      const start = readY();
      let transformRuns = 0;
      const listener = (event) => {
        if (event.pseudoElement === '::before' && event.propertyName === 'transform') transformRuns += 1;
      };
      list.addEventListener('transitionrun', listener);
      updatesButton.click();
      await pause(150);
      const middle = readY();
      const targetBackgroundAtMiddle = getComputedStyle(updatesButton).backgroundColor;
      await pause(420);
      const target = readY();
      designButton.click();
      await pause(150);
      const reverseMiddle = readY();
      await pause(420);
      const reverseTarget = readY();
      list.removeEventListener('transitionrun', listener);
      return {
        start,
        middle,
        target,
        reverseMiddle,
        reverseTarget,
        targetBackgroundAtMiddle,
        transformRuns,
        transition: getComputedStyle(list, '::before').transition
      };
    });
    checks.settingsNavigationMotion = settingsNavigationMotion;
    const settingsMotionMinimum = Math.min(settingsNavigationMotion.start, settingsNavigationMotion.target);
    const settingsMotionMaximum = Math.max(settingsNavigationMotion.start, settingsNavigationMotion.target);
    check(settingsNavigationMotion.transformRuns >= 2, 'Settings marker does not start transitions in both directions');
    check(settingsNavigationMotion.middle > settingsMotionMinimum + 1 && settingsNavigationMotion.middle < settingsMotionMaximum - 1, 'Settings marker has no visible downward intermediate position');
    check(settingsNavigationMotion.reverseMiddle > settingsMotionMinimum + 1 && settingsNavigationMotion.reverseMiddle < settingsMotionMaximum - 1, 'Settings marker has no visible upward intermediate position');
    check(Math.abs(settingsNavigationMotion.reverseTarget - settingsNavigationMotion.start) < 1, 'Settings marker does not return to Design');
    check(settingsNavigationMotion.targetBackgroundAtMiddle === 'rgba(0, 0, 0, 0)', `Settings target paints a second background during motion: ${settingsNavigationMotion.targetBackgroundAtMiddle}`);
    await win.evaluate(() => {
      const updatesButton = document.querySelector('[data-context-for="settings"] [data-settings-pane="updates"]') || document.querySelectorAll('[data-context-for="settings"] .context-link')[3];
      updatesButton.click();
    });
    await win.waitForTimeout(150);
    await win.screenshot({ path: path.join(artifactDir, 'workspace-settings-navigation-slide-mid.png'), fullPage: true });
    await win.evaluate(() => {
      window.changeLanguage('en');
      window.showTab('vods');
    });

    await win.locator('.top-nav button[data-tab="settings"]').hover();
    const topNavMotion = await win.evaluate(async () => {
      const nav = document.querySelector('.top-nav');
      const readX = () => new DOMMatrixReadOnly(getComputedStyle(nav, '::before').transform).m41;
      const pause = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      window.showTab('vods');
      await pause(520);
      const start = readX();
      let transformRuns = 0;
      const listener = (event) => {
        if (event.pseudoElement === '::before' && event.propertyName === 'transform') transformRuns += 1;
      };
      nav.addEventListener('transitionrun', listener);
      window.showTab('settings');
      await pause(170);
      const middle = readX();
      const targetBackgroundAtMiddle = getComputedStyle(document.querySelector('.top-nav button[data-tab="settings"]')).backgroundColor;
      await pause(420);
      const target = readX();
      nav.removeEventListener('transitionrun', listener);
      return {
        start,
        middle,
        target,
        targetBackgroundAtMiddle,
        transformRuns,
        transition: getComputedStyle(nav, '::before').transition
      };
    });
    checks.topNavMotion = topNavMotion;
    const motionMinimum = Math.min(topNavMotion.start, topNavMotion.target);
    const motionMaximum = Math.max(topNavMotion.start, topNavMotion.target);
    check(topNavMotion.transformRuns >= 1, 'Top navigation marker does not start a transform transition');
    check(topNavMotion.middle > motionMinimum + 1 && topNavMotion.middle < motionMaximum - 1, 'Top navigation marker has no visible intermediate position');
    check(Math.abs(topNavMotion.target - topNavMotion.start) > 1, 'Top navigation marker does not travel between tabs');
    check(topNavMotion.targetBackgroundAtMiddle === 'rgba(0, 0, 0, 0)', `Target tab paints a second background during motion: ${topNavMotion.targetBackgroundAtMiddle}`);
    await win.evaluate(() => window.showTab('vods'));
    await win.waitForTimeout(520);
    await win.locator('.top-nav button[data-tab="settings"]').hover();
    await win.evaluate(() => window.showTab('settings'));
    await win.waitForTimeout(170);
    await win.screenshot({ path: path.join(artifactDir, 'workspace-top-nav-slide-mid.png'), fullPage: true });
    await win.emulateMedia({ reducedMotion: 'no-preference' });

    const responsiveTabs = {};
    for (const target of TARGETS) {
      await win.setViewportSize(target);
      await win.evaluate(() => window.__restoreResponsiveFixtures());
      await win.waitForTimeout(50);
      responsiveTabs[`${target.width}x${target.height}`] = {};
      for (const tab of TABS) {
        await win.evaluate((tabId) => window.showTab(tabId), tab);
        await win.waitForTimeout(160);
        const state = await win.evaluate((tabId) => {
          const isVisible = (element) => {
            if (!element || element.hidden) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          };
          const navItem = document.querySelector(`.top-nav button[data-tab="${tabId}"]`);
          const topNav = document.querySelector('.top-nav');
          const navRect = topNav?.getBoundingClientRect();
          const navItemRect = navItem?.getBoundingClientRect();
          const navStyle = topNav ? getComputedStyle(topNav) : null;
          const contextPanels = [...document.querySelectorAll('[data-context-for]')].filter(isVisible);
          const toolbars = [...document.querySelectorAll('[data-toolbar-for]')].filter(isVisible);
          const tabContents = [...document.querySelectorAll('.tab-content')].filter(isVisible);
          return {
            current: navItem?.getAttribute('aria-current') === 'page',
            navIndicatorX: Number.parseFloat(navStyle?.getPropertyValue('--top-nav-active-x') || ''),
            navIndicatorWidth: Number.parseFloat(navStyle?.getPropertyValue('--top-nav-active-width') || ''),
            navItemOffsetX: navRect && navItemRect ? navItemRect.left - navRect.left : Number.NaN,
            navItemWidth: navItemRect?.width || Number.NaN,
            contextPanels: contextPanels.map((panel) => panel.dataset.contextFor || ''),
            toolbars: toolbars.map((toolbar) => toolbar.dataset.toolbarFor || ''),
            tabContents: tabContents.map((content) => content.id || ''),
            viewportWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            workspaceScrollWidth: document.querySelector('.workspace-shell')?.scrollWidth || 0,
            workspaceClientWidth: document.querySelector('.workspace-shell')?.clientWidth || 0,
            queueRows: document.querySelectorAll('#queueList .queue-item').length,
            vodCards: document.querySelectorAll('#vodGrid .vod-card').length
          };
        }, tab);
        responsiveTabs[`${target.width}x${target.height}`][tab] = state;
        check(state.current, `${tab} is not current at ${target.width}x${target.height}`);
        check(Math.abs(state.navIndicatorX - state.navItemOffsetX) < 1, `${tab} navigation indicator is not aligned at ${target.width}x${target.height}`);
        check(Math.abs(state.navIndicatorWidth - state.navItemWidth) < 1, `${tab} navigation indicator width is not aligned at ${target.width}x${target.height}`);
        check(state.contextPanels.length === 1 && state.contextPanels[0] === tab, `${tab} exposes context panels [${state.contextPanels.join(', ')}] at ${target.width}x${target.height}`);
        check(state.toolbars.length === 1 && state.toolbars[0] === tab, `${tab} exposes toolbars [${state.toolbars.join(', ')}] at ${target.width}x${target.height}`);
        check(state.tabContents.length === 1 && state.tabContents[0] === `${tab}Tab`, `${tab} exposes tab contents [${state.tabContents.join(', ')}] at ${target.width}x${target.height}`);
        check(state.documentScrollWidth <= state.viewportWidth + 1, `${tab} document overflows horizontally at ${target.width}x${target.height}`);
        check(state.bodyScrollWidth <= state.viewportWidth + 1, `${tab} body overflows horizontally at ${target.width}x${target.height}`);
        check(state.workspaceScrollWidth <= state.workspaceClientWidth + 1, `${tab} workspace overflows horizontally at ${target.width}x${target.height}`);
        if (tab === 'vods') {
          check(state.queueRows === 4, `VOD workspace lost responsive queue fixtures at ${target.width}x${target.height}`);
          check(state.vodCards === 2, `VOD workspace lost responsive VOD fixtures at ${target.width}x${target.height}`);
        }

        if (target.width === TARGETS[0].width) {
          await win.screenshot({
            path: path.join(artifactDir, `workspace-${tab}-${target.width}x${target.height}.png`),
            fullPage: true
          });
        }
      }

      const geometry = await win.evaluate(() => {
        const topbar = document.querySelector('.app-topbar')?.getBoundingClientRect();
        const sidebar = document.querySelector('.context-sidebar')?.getBoundingClientRect();
        const toolbar = document.querySelector('.workspace-toolbar')?.getBoundingClientRect();
        const updateButton = document.getElementById('workspaceUpdateButton')?.getBoundingClientRect();
        return {
          topbarHeight: topbar?.height || 0,
          sidebarWidth: sidebar?.width || 0,
          toolbarHeight: toolbar?.height || 0,
          updateVisible: Boolean(updateButton && updateButton.width > 0 && updateButton.height > 0)
        };
      });
      responsiveTabs[`${target.width}x${target.height}`].geometry = geometry;
      check(geometry.topbarHeight >= 39 && geometry.topbarHeight <= 41, `Topbar height is ${geometry.topbarHeight}px at ${target.width}x${target.height}`);
      check(geometry.sidebarWidth >= 260 && geometry.sidebarWidth <= 272, `Context sidebar width is ${geometry.sidebarWidth}px at ${target.width}x${target.height}`);
      check(geometry.toolbarHeight >= 59 && geometry.toolbarHeight <= 61, `Workspace toolbar height is ${geometry.toolbarHeight}px at ${target.width}x${target.height}`);
      check(!geometry.updateVisible, `Update action is visible without an available update at ${target.width}x${target.height}`);
      await win.screenshot({
        path: path.join(artifactDir, `workspace-${target.width}x${target.height}.png`),
        fullPage: true
      });
    }
    checks.responsiveTabs = responsiveTabs;

    await app.evaluate(({ ipcMain }) => {
      globalThis.__workspaceClipIpcState = { calls: 0, resolve: null };
      globalThis.__workspaceStatsIpcState = { calls: 0, resolve: null };
      ipcMain.removeHandler('download-clip');
      ipcMain.handle('download-clip', () => {
        globalThis.__workspaceClipIpcState.calls += 1;
        return new Promise((resolve) => {
          globalThis.__workspaceClipIpcState.resolve = resolve;
        });
      });
      ipcMain.removeHandler('get-archive-stats');
      ipcMain.handle('get-archive-stats', () => {
        globalThis.__workspaceStatsIpcState.calls += 1;
        return new Promise((resolve) => {
          globalThis.__workspaceStatsIpcState.resolve = resolve;
        });
      });
    });

    await win.evaluate(() => {
      document.getElementById('clipUrl').value = 'https://clips.twitch.tv/ContractFixture';
      document.getElementById('btnClip').click();
      void window.downloadClip();
      document.getElementById('toolbarClipDownloadBtn').click();
    });
    await win.waitForFunction(() => document.getElementById('btnClip')?.disabled && document.getElementById('toolbarClipDownloadBtn')?.disabled);
    const clipPending = await win.evaluate(() => ({
      mainDisabled: document.getElementById('btnClip')?.disabled === true,
      toolbarDisabled: document.getElementById('toolbarClipDownloadBtn')?.disabled === true
    }));
    const clipIpcCalls = await app.evaluate(() => globalThis.__workspaceClipIpcState.calls);
    checks.clipConcurrency = { ...clipPending, ipcCalls: clipIpcCalls };
    check(clipIpcCalls === 1, `Parallel downloadClip activation produced ${clipIpcCalls} IPC calls instead of one`);
    check(clipPending.mainDisabled && clipPending.toolbarDisabled, 'Clip main and toolbar triggers are not both disabled while the IPC call is pending');
    await app.evaluate(() => globalThis.__workspaceClipIpcState.resolve({ success: true }));
    await win.waitForFunction(() => !document.getElementById('btnClip')?.disabled && !document.getElementById('toolbarClipDownloadBtn')?.disabled);

    await win.evaluate(() => {
      document.getElementById('btnStatsRefresh').click();
      void window.refreshArchiveStats();
      document.getElementById('toolbarStatsRefreshBtn').click();
    });
    await win.waitForFunction(() => document.getElementById('btnStatsRefresh')?.disabled && document.getElementById('toolbarStatsRefreshBtn')?.disabled);
    const statsPending = await win.evaluate(() => ({
      mainDisabled: document.getElementById('btnStatsRefresh')?.disabled === true,
      toolbarDisabled: document.getElementById('toolbarStatsRefreshBtn')?.disabled === true
    }));
    const statsIpcCalls = await app.evaluate(() => globalThis.__workspaceStatsIpcState.calls);
    checks.statsConcurrency = { ...statsPending, ipcCalls: statsIpcCalls };
    check(statsIpcCalls === 1, `Parallel refreshArchiveStats activation produced ${statsIpcCalls} IPC calls instead of one`);
    check(statsPending.mainDisabled && statsPending.toolbarDisabled, 'Statistics main and toolbar triggers are not both disabled while the IPC call is pending');
    await app.evaluate(() => globalThis.__workspaceStatsIpcState.resolve({
      totalFiles: 0,
      totalBytes: 0,
      liveCount: 0,
      liveBytes: 0,
      vodCount: 0,
      vodBytes: 0,
      chatCount: 0,
      chatBytes: 0,
      eventsCount: 0,
      streamerCount: 0,
      avgRecordingSizeBytes: 0,
      topStreamers: [],
      dailyActivity: [],
      sizeBuckets: [],
      scannedAt: new Date().toISOString(),
      downloadPath: '',
      rootExists: true
    }));
    await win.waitForFunction(() => !document.getElementById('btnStatsRefresh')?.disabled && !document.getElementById('toolbarStatsRefreshBtn')?.disabled);
  } finally {
    if (app) await app.close();
    cleanupE2eEnvironment(environment);
  }

  const result = { checks, failures, runtimeIssues };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = failures.length || runtimeIssues.length ? 1 : 0;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
