# macOS port

Since **1.1.23**, Windows, Apple Silicon and Intel are built from the same commit in
[`Sucukdeluxe/Twitch-Downloader`](https://github.com/Sucukdeluxe/Twitch-Downloader).
Both histories are retained. The Mac repository remains the compatibility release
feed for installed apps; development and pull requests use the canonical repository.
See [UNIFIED-RELEASE.md](UNIFIED-RELEASE.md) for publishing and recovery.

## Install the preview

Download the DMG from [Releases](https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases),
choose `arm64` for Apple Silicon (M1 and newer) or `x64` for Intel, and drag the app to Applications.
The preview is ad-hoc signed, without Apple Developer ID signing or notarization.
If macOS blocks its first launch, follow [Apple's instructions for a trusted app](https://support.apple.com/en-us/102445).
No system-wide security settings need to be disabled. Updates from version 1.0.10 onward use the authenticated Mac updater described in [MACOS-UPDATES.md](MACOS-UPDATES.md). Older previews need this bootstrap version installed once.
Switching between development and differently signed preview builds can also cause
a Keychain permission prompt; [Electron documents why a consistent signature is needed](https://www.electronjs.org/docs/latest/api/safe-storage).

## Build

macOS 13 or later, Apple Silicon or Intel. Node.js 24 and the Xcode Command Line Tools
are needed to build; end users need neither Node, Python, Homebrew nor FFmpeg.

```sh
npm ci
node node_modules/electron/install.js
npm run tools:mac -- arm64
npm run tools:mac -- x64
npm run test:unit
npm run rebuild:electron
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
`~/Library/Application Support/Twitch VOD Manager/`. Windows uses the 1.1.20 `Twitch_Downloader` data path with the upstream legacy-directory migration.

## Scope

All upstream screens, translations, queue, archive, statistics, trimming, merging,
splitting, Twitch access, chat replay and automatic recording logic remain shared.
This includes the 1.1.20 VOD player, quality selection, range exclusions, persistent
editing workspaces, export queue, live-VOD snapshots and lifetime download history.
Platform-specific adapters cover OS paths, native menus, Apple hardware encoding,
portable tool packaging and macOS support. Trim fixes and the compact player layout
are shared with Windows. Selected VOD ranges are encoded precisely in H.264/AAC;
complete VOD downloads retain the stream-copy path.
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

`macos-ci.yml` runs on native Apple Silicon and Intel runners. The unified release
workflow also verifies the full Windows release harness and WebKit checks, packages
all three targets, validates artifact hashes and tests upgrades from Mac 1.0.10.
A failed required check prevents publication. The maintained Mac source suite is
`npm run test:e2e:release`; `npm run release:verify` runs the full Windows release
gate on Windows. Required tests must be present and cannot report skipped success.

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

All releases must pass Windows and both Mac jobs from the same commit and the
authenticated upgrade checks described in [UNIFIED-RELEASE.md](UNIFIED-RELEASE.md).
