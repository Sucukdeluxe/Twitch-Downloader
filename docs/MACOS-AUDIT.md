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
| Download a clip or VOD before using any other feature | Clip fails; ordinary VOD paths skip integrity checks because FFprobe is missing | Install both Streamlink and FFmpeg before first use, including the common VOD/live download path |
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

## Keychain isolation

An isolated `userData` directory does not create a separate macOS Keychain
identity. All shared E2E launch paths now select an authenticated AES-GCM test
provider before the application reads any secrets. Its random per-test key
exists only in the test parent and child processes, not in files. Both data
directories must resolve inside the marked temporary test root; invalid or
partial test configuration fails without falling back to the native Keychain.
Native encryption methods are guarded during these tests so an accidental
bypass throws instead of presenting a password dialog.

Real database writes, failed-save recovery, ciphertext authentication and
restart behavior remain exercised. Native-provider denial is tested through
the production adapter, separately from the test provider. The installed app
continues to use Electron safeStorage; no plaintext fallback or system-wide
Keychain permission change is introduced. System Reduce Motion is not changed.

The development command reuses the same Electron executable while rebuilding
JavaScript. Its current executable is linker/ad-hoc signed and unchanged across
code-only development builds. Preview app bundles are also ad-hoc signed, so
their identities can change between releases. A consistent Developer ID is
still required to make production Keychain identity stable across releases.

This does not establish absence of every possible defect. Developer ID signing,
notarization, a signed update installation and account-specific subscriber/live
workflows remain separate acceptance checks.

## Editor-load regression check

Loading a 58-second clip repeatedly rehashed the large FFmpeg binaries; profiling
measured 500–627 ms inside tool preparation alone. Mac FFmpeg verification now
reuses a successful hash/runtime check only while both executable identities
(resolved path, device, inode, size, mode, nanosecond mtime and ctime) match.
Missing execute permission, replacement and same-size edits with restored mtime
invalidate the cache. Unit tests and a real binary-corruption recovery test
cover those cases. Python still receives a runtime probe, because a launcher
identity cannot detect damage to imported modules. The existing strict local
waveform latency budget is unchanged.

The native CI run also exposed a test timing assumption in the volume animation
check: a snapshot 70 ms after sending hover could precede delivery of that event.
The test now observes real intermediate animation frames and the fully opened/
closed states. Geometry assertions and the animation itself are unchanged;
reduced-motion emulation remains local to the test page.
