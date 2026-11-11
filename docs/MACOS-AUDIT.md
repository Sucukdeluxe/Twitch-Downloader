# macOS fault and recovery audit

Original audit baseline: `7ce2ae2` / `v1.0.9-macos-preview.1`.
The 1.1.20 integration uses the actual upstream `v1.1.20` tag (`9a814180`),
not upstream's older default branch. The findings below are retained as
regression coverage for the current Mac app.

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
| Repeatedly load a clip in the cutter | Rehashing unchanged FFmpeg files exceeds the existing waveform latency budget | Reuse verification only while executable identity is unchanged |
| Diagnose a runnable replacement before first use | The initial cache optimization accepted a runtime-only probe as integrity verification | Keep diagnostic results out of the Mac integrity cache; assert exact bundle restoration |

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
notarization and account-specific subscriber/live workflows remain separate
acceptance checks. Update authentication and installation have their own tests,
described in [MACOS-UPDATES.md](MACOS-UPDATES.md).

## 1.1.20 integration coverage

- Preserve the Mac bundle identity, application-data directory and pinned update
  key while importing the new workspace, player, export queue and history.
- Reattach active clip progress and cancellation to a reopened Mac window; send
  merge completion to the current window rather than its destroyed predecessor.
- Flush settings, deferred clip metadata and pending workspace saves before
  closing. A failed final save vetoes update installation.
- Accept portable cutter projects across platforms and handle unavailable
  hardware encoders in queued exports. Retain native Mac editing shortcuts.
- Restore a verified cached update to the ready state after restart. Reject a
  staged app whose minimum macOS version is newer than the current system.
- Keep the runtime dependency security fixes when merging the upstream lockfile.

The local 1.1.20 suite passes 526 unit tests; the Windows-only executable test is
skipped on Mac and is run by Windows CI. Real-media source and packaged tests
exercise tool repair, separate audio/video streams, first-use downloads,
window recovery, cancellation, merging and SQLite persistence. Workspace and
cutter UI suites exercise the new interface rather than the retired UI.
CI must pass for the final commit on both native Mac architectures and Windows
before merging; local Apple Silicon results alone are not an Intel claim.

Local automated windows run without a Dock entry or foreground activation only
inside the strictly validated isolated test environment. The normal application's
identity, window behavior and Keychain provider are unchanged. The upgrade from
the original 1.0.10 application runs on CI because that older code can activate
its window. The local updater test explicitly reports its synthetic older-version
fixture instead of claiming it is the original release.

Clip cancellation tests wait independently for the main-process session to end
and for the renderer to receive the terminal `stopped` event. A session IPC reply
can arrive before the corresponding progress-event callback; both outcomes must
still occur within the test deadline.

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

A runtime-only diagnostic must not populate the Mac integrity cache. A further
fault test replaces FFmpeg with a harmless executable that passes `--version`,
runs diagnostics without repair, then checks that first use restores the exact
bundled binary. This reproduced an integrity bypass introduced by the fast path;
only successful bundle verification may now populate that cache on macOS.

The native CI run also exposed a test timing assumption in the volume animation
check: a snapshot 70 ms after sending hover could precede delivery of that event.
The test now observes real intermediate animation frames and the fully opened/
closed states. Geometry assertions and the animation itself are unchanged;
reduced-motion emulation remains local to the test page.
Update-popover checks likewise wait for the visible, expanded state after focus
or hover rather than taking a snapshot after a fixed 80 ms delay. Keyboard
focus, disabled-action semantics and popover visibility are still asserted.
The animated VOD preview similarly waits for removal of the previous overlay
and observes the actual first and second visible frames. Fixed sleeps could
sample the old frame on Intel CI before the next timer callback ran; a preview
that never advances still fails the bounded frame-transition check.

The long-video scrub test now expresses its allowed gap in pointer-input steps,
not an absolute media duration that changes with timeline width and zoom. The
Intel runner presented 22 frames for 24 one-pixel moves, with a largest gap of
0.84 seconds (two input steps); the old 0.75-second limit rejected this despite
the existing 12-frame minimum allowing coalescing. The check still requires at
least 12 frames, now permits at most two input steps plus one video frame, and
additionally requires monotonic presentation and the exact first/final targets.
It waits for those rendered targets with a bounded timeout. Pointer speed and
the application's existing latest-target coalescing are unchanged.

Playback pacing is measured between successive animation callbacks. The former
first sample also included the asynchronous `video.play()` startup, which could
incorrectly attribute startup latency to steady playback. Startup is reported
separately; pacing thresholds remain unchanged. Scrub diagnostics retain both
delivered pointer events and video-frame callback metadata to distinguish input
coalescing, missed observations and delayed presentation on hosted runners.

Window recovery tests wait for both Playwright's page-close event and the native
BrowserWindow `closed` event before activation. They also reuse a window already
reopened by macOS. This avoids treating the ordering of Cocoa and test-protocol
events as an application failure; the save-failure assertion still requires the
window to remain open until saving succeeds.
