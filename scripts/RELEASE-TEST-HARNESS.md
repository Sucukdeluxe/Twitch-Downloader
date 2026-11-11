# Reconstructed Windows release harness

These public fixtures reconstruct the current Windows application's test contract.
They are not the missing original private tests. Browser fixtures verify renderer
behavior; they do not establish that native download, filesystem, encoding,
installer, credential storage, or update operations work. Those checks must run
against the production Electron backend on an actual Windows runner.

## Entry points

Import `./release-test-harness.cjs` from a CommonJS release script.

```js
const assert = require('node:assert/strict');
const { createEnvironment, launchBrowser, closeSession } = require('./release-test-harness.cjs');
const env = createEnvironment('queue-cards', { language: 'de', theme: 'light' });
let session;
try {
  session = await launchBrowser(env, {
    engine: 'chromium', // or 'webkit'
    fixture: {
      state: { config: { streamers: ['fixture_streamer'] }, queue: [] },
      overrides: { getClipInfo: async url => ({ title: url, broadcaster_name: 'fixture' }) },
    },
  });
  // Exercise actual DOM controls and assert the observed result.
  assert.deepEqual(session.errors, []);
} finally {
  await closeSession(session || env);
}
```

`parseOptions(argv = process.argv.slice(2))` accepts only `--webkit`,
`--expect-refined`, `--packaged`, `--two-omissions`, `--de`, `--light`, `--parts`,
and `--cancel`. It returns corresponding boolean camelCase properties and optional
positional `ffmpeg` / `ffprobe` paths. Unknown flags and extra positional arguments
throw. Each consuming test decides which flags affect its scenario.

`createEnvironment(name, config = {})` synchronously creates an owned temporary
root and returns `rootDir`, `programDataDir`, `appDataDir`, `userDataDir`,
`downloadsDir`, `mediaDir`, `roamingDir`, `localAppDataDir`, `tempDir`, `homeDir`,
`configFile`, `queueFile`, and `config`. Windows app data is always
`programDataDir/Twitch_Downloader`. Config starts offline with empty credentials,
no automatic recording, cleanup, notifications, queue resumption, or streamers.
Those safety fields override supplied config. Other config preferences are retained.
The production downloader path is always `downloadsDir`.

`launchBrowser(env, { engine = 'chromium', fixture = {} })` requires an existing
production build (`npm run build`) and installed Playwright browsers
(`npx playwright install chromium webkit`). It serves `dist/renderer` on an owned
127.0.0.1 server and executes the **built production preload** with a narrow IPC
transport shim. Source and built preload API names must agree. Renderer network
requests outside loopback HTTP are aborted; service workers are blocked. No
external live content is required.

## Browser fixture contract

The session exposes `page`, `browser`, `context`, `env`, mutable `state`, `calls`,
`errors`, `blockedRequests`, async `emit`, async `replaceIpc`, and async `cleanup`.
`cleanup()` is equivalent to `closeSession(session)`.

`fixture.state` supplies initial `queue`, `library`, `workspace`, `vods`, `live`,
`downloading`, and `sequence` values. `state.config` is merged over environment
defaults; all other supplied state fields replace their defaults. Defaults include
one synthetic VOD, an empty queue, empty library collections (`filters`, `groups`,
`markers`, `excerpts`), and empty clip/merge workspaces. Inputs and returned data
are cloned to prevent accidental reference sharing with the page.

`fixture.overrides` maps real preload **method names** to serializable response
values or async Node functions receiving the original method arguments. Functions
can close over `env` or custom test state. They run in the test process, not the
browser. `await session.replaceIpc(method, valueOrFunction)` adds or replaces one
override at runtime. Overrides own their state changes and events. For methods
such as `openFile`, an explicit method override bypasses the preload's chained
capability calls; it must not be presented as native capability verification.

Unknown override names throw. Credential-setting and login overrides are forbidden.
Unconfigured operations reject with `Unconfigured release fixture API`; there is
no generic success response. Browser defaults cover startup, empty archive and
history views, settings, workspace persistence, VOD libraries, queue add/remove/
reorder/retry, and downloaded VOD marking. Native tool status honestly reports
unavailable tools, and preflight repair requires an explicit override. Encoding,
downloads, dialogs returning actual selections, playback, update installation,
storage cleanup, and export operations need explicit scenario responses.

`session.calls` entries contain `{ method, channel, args, override? }`.
`session.errors` records page exceptions and rejected fixture handlers. Tests should
assert it is empty unless intentionally testing a rejected call, in which case
assert the exact expected error. `blockedRequests` contains aborted external URLs.

`await session.emit(event, payload)` accepts either the public subscription method
(for example `onQueueUpdated`, `onExportJobsChanged`, `onVodTimelineProgress`) or
its real IPC channel (`queue-updated`, `editing-jobs-changed`,
`vod-timeline-progress`). Payloads must match the production preload types.
Subscriptions and their unsubscribe functions execute the real preload code.
Queue events also replace `state.queue`; other event payloads do not implicitly
modify fixture state. Queue mutation defaults emit production queue events.

## Native Electron contract

`launchElectron(env, { packaged = false, fixture = {} })` rejects any platform
other than `win32`; browser success never substitutes for Windows execution.
Development mode runs the project's Electron binary with `.`. Packaged mode runs
`release/win-unpacked/Twitch Downloader.exe` without `.`. Installer checks may pass
`{ packaged: true, executablePath }`, but that existing absolute `.exe` must be
canonically inside `env.rootDir`.

The native session exposes `app` (Playwright `ElectronApplication`), `page`, `env`,
`calls`, `errors`, `emit`, `replaceIpc`, `refreshCalls`, and `cleanup`.
Call `await session.refreshCalls()` before inspecting native invocation history.
Use `app.evaluate(({ dialog }, selection) => { dialog.showOpenDialog = async () =>
selection; }, selection)` for a deterministic native file picker, then call the
real preload selection method so the production backend issues capabilities.

Production media, queue, persistence, database, and filesystem handlers stay real.
Native overrides accept serializable values only and are restricted to external
Twitch/playback/metadata and update-check/download APIs. Other replacements throw.
The child receives an allowlisted environment and isolated PROGRAMDATA, APPDATA,
LOCALAPPDATA, USERPROFILE, HOME, TEMP, TMP, and `--user-data-dir`. Proxy and socket
guards block external networking; native credential encryption/decryption and
external shell opens are forbidden. Updater checks and downloads are suppressed. The config
contains no secrets before launch. This is isolated test instrumentation, not a
security sandbox for running untrusted application code.

Native media tests need real `ffmpeg` and `ffprobe` on the inherited PATH. The
harness does not install managed tools or fabricate verification receipts. The
production tool resolver accepts working PATH binaries when no bundled copy
requires repair. Do not place arbitrary binaries in the managed tool directory:
unverified managed files trigger the production repair path. A positional tool
path passed to `createMediaFixture` applies to fixture generation only; a native
consumer using such paths must also make their directories available on PATH
before launching Electron. Check production preflight/tool status before encoding.

`assertIsolation(session)` verifies owned directories and the renderer's actual
config download path. Native sessions additionally check actual `app.getPath`
values for `userData`, `sessionData`, and `temp`, the `--user-data-dir` value,
PROGRAMDATA, LOCALAPPDATA, and empty secret status. Paths escaping through
traversal or symlinks fail.

On Windows, `app.getPath('appData')` remains the OS-known folder: changing APPDATA
does not redirect it. The harness reports that value only as read-only metadata.
The production code's sole use of it is legacy migration, disabled by the mandatory
`--user-data-dir` switch. A source contract test guards that condition. Production
config/database/tools use the isolated PROGRAMDATA directory; Chromium's actual
profile and session/cache paths must both resolve to the isolated userData folder.
The harness does not claim to isolate every OS-known folder, and does not inject
an unsupported preload into packaged Electron. Updater downloads remain disabled
so they cannot use the OS updater cache.

## Media, HTTP, and cleanup

`createMediaFixture(env, { name = 'fixture.mp4', duration = 3, width = 320,
height = 180, fps = 25, audio = true, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' })`
runs real tools, checks real streams and duration, and returns
`{ path, file, probe, duration }`. It refuses existing output and escaping names.
MP4, MKV, MOV, WebM, and TS names are supported. Required codecs must be present.

`createHttpFixture(env, routes)` listens only on 127.0.0.1 and returns
`{ url, server, calls, close }`. Route keys are `/path` or `GET /path`.
Values are strings, buffers, `{ status?, headers?, body }`, `{ status?, headers?,
file }`, or async `(request, calls) => value` handlers. Objects in `body` are JSON.
File responses must be inside the owned environment. Missing routes return 404;
route failures return 500. `calls` records method, path, original URL, and headers.
Implement range handling explicitly in the route when a media scenario needs it.

Always call `closeSession(session || env)` in `finally`. It closes owned resources
in reverse order and removes only the root with its matching ownership marker.
Cleanup refuses forged or altered ownership and retains files if resource closing
fails. It is idempotent. For native restart/installer scenarios, `await app.close()`
preserves the environment; launch again with the same env and call `closeSession`
only after the last phase.

Focused portable checks: `node --test scripts/release-test-harness.test.cjs` and
`npx eslint scripts/release-test-harness.cjs scripts/release-browser-fixtures.cjs
scripts/release-test-harness.test.cjs`. Browser scenario scripts additionally
require the built renderer and installed browser engines. Native scenario scripts
require Windows, real tool executables, and the appropriate built application.
