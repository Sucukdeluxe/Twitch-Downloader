# macOS fault and recovery audit

Baseline: `7ce2ae2` / `v1.0.9-macos-preview.1`.

The audit uses isolated app-data directories, actual Electron processes and the
bundled macOS executables. It never reuses the user's settings or downloads.
Twitch authentication and clip metadata are fixture responses; Streamlink reads
real local HLS playlists and FFmpeg/FFprobe process the resulting media.

## Reproduced defects

| Scenario | Baseline result | Correction / regression coverage |
| --- | --- | --- |
| Remove FFmpeg's executable permission | Automatic repair leaves it unusable | Probe the real executable and force verified bundle extraction on failure |
| Corrupt a private Python module while retaining launcher hashes | Tool status passes, automatic repair fails | Probe the complete runtime rather than trusting an old command cache |
| Download a clip before using any other feature | Streamlink missing | Install both Streamlink and the FFmpeg integrity checker before starting |
| HLS with separate audio and video | Video-only output when no host FFmpeg exists | Pass the absolute managed FFmpeg path to Streamlink; inspect both output streams |
| HLS containing invalid media bytes | Successful download despite FFprobe failure | Fail integrity validation and discard partial output |
| Native Cmd-Z / Edit → Undo in the cutter | No edit is undone, despite passing synthetic key tests | Route native menu actions to cutter history; preserve normal text-field undo |
| Save an Apple VideoToolbox project | `Invalid cutter project` | Accept the macOS encoder in project validation; round-trip every supported encoder |
| Close the window immediately after editing | Last edit not recoverable | Await pending autosave before closing or quitting; retain the window if saving fails |
| Reopen a Mac window with startup-resume enabled | Unexpected queue processing scheduled | Run startup auto-resume only on the first renderer load |
| Stored secret cannot be decrypted | Ordinary preferences, queue and database access disappear | Isolate secret read failures; keep stored ciphertext and ordinary data intact |
| Cancel a process with a child that ignores SIGTERM | Child remains and shutdown can hang | Own a separate Mac process group, escalate the whole group, await termination before cleanup |

## Verification commands

```sh
npm run lint
npm run security:check
npm run test:security
npm run test:lint-config
npm run test:ci-contract
npm run test:unit
npm run test:mac
PATH="$PWD/.cache/macos-tools/stage-arm64/ffmpeg:$PATH" npm run test:e2e:release
PACKAGED_APP_PATH="release/mac-arm64/Twitch VOD Manager.app/Contents/MacOS/Twitch VOD Manager" npm run test:mac
```

`test:mac` includes the recovery/fault suite. CI runs it against source Electron
and the actual application bundle, independently on Apple Silicon and Intel.
The process tests exercise descendants with inherited and private stdio, and
assert that an unrelated process is unaffected by cancellation.

Native Cmd-Z, Shift-Cmd-Z and the Edit menu additionally require a real macOS
keyboard/menu check: synthetic renderer key events do not exercise Cocoa's
menu accelerator routing.

This does not establish absence of every possible defect. Developer ID signing,
notarization, a signed update installation and account-specific subscriber/live
workflows remain separate acceptance checks.
