# macOS port

Baseline: `Sucukdeluxe/Twitch-Downloader` at `5113089`, version **1.0.9**.
The complete upstream history is retained. `upstream` points to the Windows repository;
`origin` points to `Sucukdeluxe/Twitch-Downloader-macos`. No upstream merge has been made.

## Install the preview

Download the DMG from [Releases](https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases),
choose `arm64` for Apple Silicon (M1 and newer) or `x64` for Intel, and drag the app to Applications.
The preview is ad-hoc signed, without Apple Developer ID signing or notarization.
If macOS blocks its first launch, follow [Apple's instructions for a trusted app](https://support.apple.com/en-us/102445).
No system-wide security settings need to be disabled. Updates from version 1.0.10 onward use the authenticated Mac updater described in [MACOS-UPDATES.md](MACOS-UPDATES.md). Older previews need this bootstrap version installed once.
Switching between development and differently signed preview builds can also cause
a Keychain permission prompt; [Electron documents why a consistent signature is needed](https://www.electronjs.org/docs/latest/api/safe-storage).

## Build

macOS 12 or later, Apple Silicon or Intel. Node.js 24 and the Xcode Command Line Tools
are needed to build; end users need neither Node, Python, Homebrew nor FFmpeg.

```sh
npm ci
node node_modules/electron/install.js
npm run tools:mac -- arm64
npm run tools:mac -- x64
PATH="$PWD/.cache/macos-tools/stage-$(node -p process.arch)/ffmpeg:$PATH" npm run test:e2e:release
npm run test:mac
npm run dist:mac -- --arm64 --x64 -c.mac.identity=- --publish never
```

The last command creates ad-hoc-signed preview DMG and ZIP files in `release/`.
For Developer ID distribution, omit `-c.mac.identity=-` and provide the normal
electron-builder signing/notarization credentials through the environment/CI secrets.
Never put credentials into the repository.

`npm run dev` preserves the original hot reload workflow. It uses `.dev-program-data`
and `.dev-user-data`, isolated from the installed app. Tests use unique temporary directories.
The installed Mac app stores its database, configuration and managed tools under
`~/Library/Application Support/Twitch VOD Manager/`. Windows keeps its existing data path.

## Scope

All upstream screens, translations, queue, archive, statistics, trimming, merging,
splitting, Twitch access, chat replay and automatic recording logic remain shared.
Changes are restricted to OS paths, native menus, Apple hardware encoding,
portable tool packaging, process argument safety and macOS test/build support.
Window closing follows macOS behavior: the app and background downloads stay alive;
Command-Q runs the existing orderly shutdown and partial-file cleanup.

Two shared cutter corrections came from the Mac acceptance tests: previews normalize
nonzero Twitch fragment timestamps and use the resulting excerpt duration, and pointer
geometry has no CSS transitions even with reduced motion enabled. Source videos are
preserved; the timestamp normalization only affects the temporary preview.

FFmpeg/FFprobe remains at 8.1.2, as on Windows. The Mac bundle uses Streamlink 8.6.3
for current urllib3 compatibility and upstream security fixes; the Windows manifest is unchanged.
Every tool archive is bundled and SHA-256 verified before first use. Repair/reset works
offline. Python, dependencies, upstream archives and checksums are pinned in `scripts/`.
The Mac app only resolves tools inside its own managed directory, including before the
first install; it never probes a system Python or triggers the developer-tools installer.

## Validation and release boundary

`macos-ci.yml` runs on separate native Apple Silicon and Intel runners, including the
upstream release suite and real packaged-app tests.
The source and packaged-app jobs use separate fresh runners so their differently
signed executables do not compete for the same login Keychain item.
The macOS-specific test removes Homebrew from PATH, provisions the bundled tools offline, downloads a generated HLS
stream with Streamlink, probes it, trims video through the app's real IPC, repairs a
corrupted executable, resets/reinstalls tools, and closes/reopens the Mac window.
It also builds a fragmented MP4 with a two-minute timestamp offset and verifies the
three-second editor timeline, playback start and a real cut export.
The existing Windows CI remains enabled for regression coverage.
CPU-bound thumbnail/waveform checks keep the original local time budgets; hosted Mac
runners get a threefold budget on Apple Silicon and sixfold on virtualized Intel,
and frame-pacing checks get a twofold budget. Both still report measured times.
Pointer accuracy and frame synchronization assertions remain unchanged, with input
delivery, playback resumption and asynchronous focus restoration awaited explicitly.

A preview is not a declaration that every Twitch account-specific scenario is accepted.
Subscriber-only Twitch access and long-running live recording require an eligible
account/live stream. Developer ID signing and Apple notarization remain optional distribution improvements;
the free update path authenticates releases with a separately pinned Ed25519 key.
It uses this public repository, architecture-specific ZIPs and `mac-update.json`.
This is release authentication, not Apple notarization. See [MACOS-UPDATES.md](MACOS-UPDATES.md).

Before merging upstream: run Windows and both Mac jobs from the same commit, test the
authenticated update from an older installed version, and confirm authenticated Twitch workflows.
