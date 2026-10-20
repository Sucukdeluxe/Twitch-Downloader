# Changelog

## 1.1.10 - 2026-10-20

This update adds channel-focused statistics, improves theme readability and makes stalled VOD transfers easier to diagnose.

- Show download history with video covers, channel names and profile images, with full-width statistics and channel filters.
- Keep statistics stable during channel changes and animate updated values while respecting reduced-motion settings.
- Improve text contrast in light, dark and system themes, including the update dialog, profile header and video timeline.
- Detect VOD transfers that stop receiving data, show a waiting status and retry timed-out attempts without treating intentional pauses or throttling as failures.
- Keep already completed VOD parts when an automatic retry is needed, avoiding duplicate downloads.
- Read transfer file sizes asynchronously and ignore late progress callbacks after a transfer ends.
- Update Electron to 44.9.1 and refresh affected runtime dependencies.

## 1.1.9 - 2026-10-17

This update makes large VOD lists load more smoothly while keeping all entries and actions available.

- Reduce layout stalls when initially displaying large VOD lists.
- Preserve the full list, selection, filters, sorting and card actions.
- Keep row heights and scrolling stable when resizing the window or changing the interface language.

## 1.1.8 - 2026-10-17

This update improves playback-history performance and language switching, and corrects several interface labels.

- Avoid rebuilding unchanged history cards while playback advances.
- Reduce layout work in hidden clip and archive panels during language changes.
- Preserve filters, card actions, animations and scroll positions.
- Rename the initial history label to Title in English and Titel in German.
- Translate remaining German interface labels for parts, categories and merging.

## 1.1.7 - 2026-10-17

This update refreshes the update dialog and VOD actions, and improves scheduled downloads.

- Add a compact update dialog with version colors, publication date and time, and expandable release notes.
- Keep update actions visible while long release notes scroll, and reset the notes to the top when collapsed.
- Show available updates through the navigation button without a hover popup.
- Refresh the Trim and Queue buttons and the external-link icon for opening Twitch.
- Keep the downloaded checkmark visible during VOD hover previews.
- Remove tooltips that only repeat visible labels.
- Prevent automatic queued jobs from starting after a download window ends; continue in the next permitted window.

## 1.1.6 - 2026-10-16

This update simplifies download limits and scheduled download windows.

- Replace the free-text schedule with individual start and end time fields.
- Add and remove time windows, with a next-day indicator for overnight schedules.
- Use a compact download limit field with a visible MiB/s unit and a clear unlimited state.
- Keep status and the Start now action together in a compact footer.
- Preserve saved limits and schedules when restarting the application.

## 1.1.5 - 2026-10-16

This update reorganizes settings and improves their layout and readability.

- Group download, automation, storage, backup and diagnostic options into consistent expandable sections.
- Move startup behavior and completion notifications to General, storage folders to Storage & backup, and recording recovery to Automation.
- Show the current settings category in the toolbar and keep General compact without an empty update column.
- Use consistent checkbox spacing and complete hover areas.
- Expand download sections by default and animate opening and closing, including rapid direction changes.
- Remove the misleading fixed Source quality display; choose quality when adding a VOD to the queue.
- Increase footer text size and contrast.

## 1.1.4 - 2026-10-16

This update fixes overly long frame-rate values in the video quality selector.

- Show frame rates with at most two decimal places for Source and all other video qualities.
- Keep the selected stream and its original frame rate unchanged.

## 1.1.3 - 2026-10-15

This update introduces a timeline workspace for combining videos and fixes timeline navigation and audio timing.

- Arrange linked video and audio clips on a timeline with previews, waveforms, undo and redo.
- Zoom around the mouse pointer and use a larger horizontal scrollbar without losing your chosen view during playback.
- Keep zoom controls consistent after adding or removing clips.
- Preserve audio start offsets when re-encoding merged videos.
- Browse source files in a centered dialog with previews and readable controls.
- Wait for valid video timing before starting the merge preview.

## 1.1.2 - 2026-10-15

This update adds a configurable seek interval and fixes the forward control at the end of VODs.

- Keep the video editor rewind control disabled on the first frame despite sub-frame decoder timestamps.
- Disable the VOD forward control at the final seekable position, including the media seek tolerance.

- Add a saved 10-, 30- or 60-second seek interval for VOD playback and the video editor, with matching button icons, labels and VOD keyboard controls.

## 1.1.1 - 2026-10-15

This update speeds up opening VODs for trimming and keeps development sessions separate during normal application updates.

- Disable ten-second seek buttons when the video is already at the start or end.
- Remove completed queue entries when the application starts while preserving pending, paused and failed work, downloaded files and download history.
- Restrict installer and uninstaller shutdown to the exact installed executable paths.
- Give development builds a distinct executable filename so older installers cannot close them by matching the normal application name.
- Show VOD categories as soon as they arrive and briefly reuse completed timelines when reopening the same VOD.
- Start direct VOD playback without repeating Streamlink preparation.
- Resolve regular VOD playback qualities directly and cancel obsolete source lookups when the player is closed.

## 1.1.0 - 2026-10-15

This update reorganizes VOD history into grouped sections, clarifies file verification activity and adds the application version to the window title.

- Restore measured viewer counts in VOD previews and the viewer-history curve above the timeline, including correct stream timing and explicit measurement gaps.
- Restyle the update button and action popover with neutral surfaces, clearer controls and no duplicate hover tooltip.
- Prevent tooltips from briefly shifting the workspace and status bar upward.
- Group categories and their title changes into bordered history sections, with smooth filter transitions and separate counters for categories and title changes.
- Keep category trimming and title seeking available in the new layout, with readable text and reduced-motion support.
- Prevent duplicate current-section labels from overlapping category duration and date.
- Match the approved history design with its original colors, borders, typography and spacing, including narrow sidebars.
- Highlight only the current category when a stream title continues across category changes, and locate the matching section.
- Seek by clicking the history card surface while keeping title and trim actions separate; use a normal arrow cursor in the cards.
- Dismiss VOD trimming and quality selection by clicking their backdrop; keep dialogs open when interacting or dragging inside them.
- Keep the progress indicator full-width during file verification and other finalization steps without measurable progress, including when reduced motion is enabled.
- Show the active section and application version in the window title, with a separate development label when applicable.

## 1.0.49 - 2026-10-15

This patch prevents direct VOD downloads from remaining stuck when the server stops responding.

- Stop a network read after 30 seconds without a response so the existing retry logic can recover or report a failure.
- Reject interrupted streams instead of treating an incomplete video as a successful download.
- Show a clear timeout message and classify it as a network error. Normal slow downloads, pause/resume and cancellation remain supported.

## 1.0.48 - 2026-10-14

This update redesigns video cutting and improves clip queues, saved downloads and audio synchronization.

### Video cutting

- Add a preview-focused workspace with a compact editing panel, frame-accurate trim controls and editable omitted ranges.
- Keep the preview size stable when switching between the full timeline, selected range and manual zoom. Clearly mark the active view and separate audio meters from the time display.
- Load timeline thumbnails faster for long videos and show the audio waveform progressively with visible progress.
- Preserve audio timing in waveforms, direct exports and queued exports, including delayed tracks, internal silence, multiple audio streams and omitted ranges.
- Fix short-range omissions, validation after keyboard adjustments and Tab navigation.

### Twitch clips

- Separate pasted clip links from the download queue. Adding clips to the queue clears the input list without removing queued or completed downloads.
- Shorten displayed clip links, restore Undo/Redo and clarify download states with consistent action icons and tooltips.
- Choose a destination folder for queued clips and browse saved clips from the configured folders.
- Show progress for the current download batch, reset progress when the list is empty, and keep the list stationary when switching tabs.
- Improve duplicate messages, completion actions, folder changes and oversized link-paste handling.

## 1.0.47 - 2026-10-14

This update renames the application to Twitch Downloader, reworks the Clips workspace into a two-column split layout with clip thumbnails, and updates the top navigation bar.

### Application rename and migration

- Rename the application, Windows shortcuts, installer (`Twitch-Downloader-Setup-1.0.47.exe`) and repository references to Twitch Downloader.
- Format the window title as `Twitch Downloader - <Section>` (for example `Twitch Downloader - VODs` or `Twitch Downloader - Clips`), with ` | Entwicklerversion` appended in development builds.
- Migrate existing settings, databases, tools and encrypted credentials automatically from the previous application folders on startup, and replace previous installations cleanly during installer upgrades.

### Clips workspace

- Rework the Clips tab into a full-width two-column split layout with link entry and batch controls on the left and the download list on the right.
- Show a 16:9 clip thumbnail next to each row number in the download list, using public Twitch clip metadata or a local video preview with a neutral fallback icon.
- Hide the batch progress bar track while no download is active and display active or completed batch progress in green.

### Navigation and VOD toolbar

- Arrange the seven top-navigation sections as equal-width tiles with the icon centered above the label and prevent descender or right-edge text clipping.
- Remove the unused Views button from the VOD filter bar.

## 1.0.46 - 2026-10-13

This update lets you choose the output filename and destination for each queued download before it starts.

### Queue output

- Choose a filename and target folder for an individual queued VOD or clip through the download details or context menu.
- Persist the selected output path with the queue item so it survives application restarts and does not change the global download settings.
- Add predictable `_PartNN` suffixes when the selected output is split into multiple files.
- Apply the selected destination consistently to VODs, clips, edited excerpts, omission downloads and live recordings.

## 1.0.45 - 2026-10-13

This update makes sure VODs load reliably after adding a streamer.

### Streamers and VODs

- Load the VOD list immediately after adding a streamer. A temporary Twitch error during the first request no longer shows "No VODs found" until Refresh VODs is clicked.
- Retry temporary Twitch errors automatically. If Twitch still does not respond, the VOD area shows a clear loading error with a Try again button and keeps retrying in the background.
- Keep the existing VOD list visible when a later refresh fails instead of replacing it with an empty list.

## 1.0.44 - 2026-10-13

This update improves downloads from ongoing public VODs, makes download and MP4-writing progress clearer, and adds video thumbnails to the archive.

### Downloads and MP4 output

- Improve 1440p/HEVC downloads from ongoing public Twitch VODs, including anonymous access where Twitch makes the VOD available publicly.
- Respect Full VOD mode when downloading a selected excerpt. An inactive part-length setting no longer splits the output into unintended parts.
- Calculate progress from the actual requested video range and distinguish downloading, writing, optimizing and verifying the MP4 file.
- Show measured MP4-writing progress, video time, written size, speed and remaining time. Optimization and verification show their own status and elapsed time when a reliable percentage is unavailable.

### Archive

- Add local video thumbnails to archive rows, with a neutral fallback for unavailable or unreadable files.
- Load thumbnails only near the visible rows and cache them between sessions. Changed videos receive a new preview, while background work is limited to keep browsing responsive.
- Remove repeated blocking file lookups and show cached archive results while the index refreshes in the background.

### Streamers and live VODs

- Move Add streamer into the sidebar and provide a searchable Twitch-channel dialog with profile images. Close the dialog after a successful addition without rebuilding or flickering the results.
- Place Refresh VODs next to the channel actions and keep the button stationary when clicked.
- Add collapsible live details beside Open on Twitch. New channels start collapsed; transitions, contrast and alignment have been refined.
- Use the current live preview while an ongoing VOD has no cover, then switch to the finished VOD cover when available.
- Show uppercase LIVE badges with a red status dot, readable recording controls and improved profile statistics.
- Show the current stream's running time while live instead of presenting it as the last completed stream.

### Queue and filtering

- Rework download details with readable channel, copyable video URL, actual excerpt duration, date, quality and adjacent file actions.
- Align saved/running status icons and group progress, file details and transfer totals into clearer sections.
- Remove the artificial asterisk from trimmed-download titles.
- Group VOD search, filters and sorting into a consistent bordered toolbar with responsive spacing.
- Center empty VOD states in the available content area.

### Development builds

- Apply supported interface and backend changes automatically while preserving ongoing work and deferring disruptive refreshes when necessary.

### Verification

- Run the complete local release checks and headless Chromium/WebKit interface regressions before packaging.
- Verify the packaged Windows application in an isolated, hidden instance, including real thumbnail extraction and restricted archive file access.

## 1.0.43 - 2026-10-13

This patch simplifies VOD trimming to whole seconds and cleans up two controls.

### VOD trimming

- Show start and end times, handle labels, drag previews and excluded ranges as HH:MM:SS without milliseconds. Twitch downloads are cut on whole seconds and keyframes, so the extra precision did not change the result.
- Snap excerpt and exclusion boundaries to whole seconds. The end of the VOD stays exact, and an excerpt is at least one second long.
- Change the minus and plus buttons and the arrow keys to one-second steps. Typed decimals are rounded, and the shown video length matches the downloaded length.
- The local video cutter keeps its frame-accurate time format.

### Interface

- Remove the dark ring and shadow around the playback knob on the chapter timeline. The keyboard focus ring remains.
- Replace the letter used to remove a streamer with a centred close icon that turns red on hover.

### Verification

- Download real Twitch VOD excerpts with and without an exclusion in an isolated, hidden application instance and check the resulting file lengths.
- Check trimming input, keyboard steps, exclusions and mode switches headless in Chromium in German and English, light and dark themes, and four display scales.
- Run the full release checks and isolated Windows package tests before publication.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.42 - 2026-10-12

This patch makes VOD trimming faster when no ranges are excluded and shows the expected output before a job is queued.

### VOD trimming

- Download a trimmed VOD through the regular clip path when "Exclude ranges" is open but no confirmed exclusion overlaps the excerpt. The selected filename format is kept and no additional assembly step is needed.
- Use the exclusion pipeline only when a confirmed exclusion overlaps the excerpt or an exclusion draft is open.
- Show the resulting number of files, the total length and the part length next to the queue button in larger text, for example "Output: 2 files · 00:01:30 · 1-minute parts".
- Let the I and O keys set the excerpt boundaries in "Exclude ranges" mode, matching the "Set here" buttons. While an exclusion draft is open, they adjust the draft. The keys no longer create a new draft.

### Verification

- Download real Twitch VOD excerpts with and without an exclusion in an isolated, hidden application instance and check the resulting file lengths.
- Check excerpt input, keyboard boundaries, exclusions and mode switches headless in Chromium in German and English, light and dark themes, and four display scales.
- Run the full release checks and isolated Windows package tests before publication.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.41 - 2026-10-12

This patch fixes VOD trimming so the entered time range is downloaded when "Exclude ranges" is active.

### VOD trimming

- Keep the start and end time fields, the "Set here" buttons and the timeline bound to the download excerpt while excluding ranges. Previously, times entered in this mode only changed an unconfirmed exclusion draft, so the queued job covered the whole VOD and was split into many parts.
- Download only the selected excerpt, minus confirmed exclusions, regardless of which editing mode was active when the times were entered.
- Edit exclusion drafts only through their own time fields and red handles. An unconfirmed draft still blocks adding the job to the queue.

### Verification

- Check excerpt input, "Set here", mode switches and open drafts headless in Chromium in German and English, light and dark themes, and four display scales.
- Run the full release checks and isolated Windows package tests before publication.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.40 - 2026-10-12

This patch fixes keyboard handling in dialogs so shortcuts cannot control the video editor behind them.

### Dialog controls

- Keep Space and Tab available to the open dialog, including the recent-project list. Activating Close no longer starts video playback in the background.
- Prevent background editing shortcuts, including undo and cut markers, from changing a project while a native dialog is open.
- Prevent Ctrl+K from opening a hidden quick-search window behind a dialog.
- Let Escape close the visible native dialog before an underlying application dialog.
- Restore normal editor shortcuts after closing the dialog, including after releasing a held Space key.

### Verification

- Check dialog navigation, nested dialogs, clip search and channel rules headless in Chromium and WebKit.
- Run the full release checks and isolated Windows package tests before publication.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.39 - 2026-10-12

This patch improves video playback, restores reliable quick navigation, and protects unsaved work during development updates.

### Playback and trimming

- Resume local video playback without starting an unnecessary seek at the current position. This removes redundant decoder work during repeated play/pause actions.
- Close an open chapter tooltip with Escape before closing the VOD trimming dialog. Existing range-editing and dialog shortcuts remain available.

### Streamers and quick navigation

- Accept existing Twitch channels with short usernames, including names shorter than four characters.
- Include configured streamers in the Ctrl+K quick-navigation search.
- Update only the highlighted search result when moving the pointer or using arrow keys. Hovering no longer repeatedly rebuilds the list or loses clicks.
- Keep the keyboard-selected result visible when scrolling through long result lists.

### Display corrections

- Number alternative video-quality options consecutively when codec information is unavailable.
- Show twelve months instead of zero years for streams from 360–364 days ago.
- Format profile VOD counts according to the selected interface language.

### Development updates

- Wait for clip and merge lists to finish saving before refreshing the interface. Failed saves keep the current work open.
- Prevent older save responses from overriding the result of a newer save.
- Finish saving pending clip metadata when a download completes, so automatic interface updates can resume normally.

### Verification

- Verify the release with unit tests, Chromium/WebKit interface checks, repeated playback tests, and isolated Windows package checks with hidden windows and muted audio.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.38 - 2026-10-12

This update makes VOD trimming easier to read, completes the video-quality loading layout, and improves development-build reliability.

### VOD trimming

- Replace native chapter tooltips with animated speech bubbles showing the category and its time range on separate lines.
- Keep tooltips within the window, including narrow views and long category names, with keyboard focus, Escape dismissal and reduced-motion support.
- Remove milliseconds from chapter tooltips and the video-length card. Cutting precision and download boundaries remain unchanged.
- Prevent clicks on tooltip content from moving the playback position.

### Video quality and empty states

- Show seven aligned loading placeholders with selection circles while available video qualities are being retrieved.
- Hide VOD filters and sorting controls until a streamer is available, and show a centered prompt to add one.

### Development reliability

- Automatically rebuild and refresh changed interface code while preserving the selected view and supported inputs.
- Defer refreshes during open dialogs, editing, playback and active operations to protect ongoing work.
- Serialize overlapping builds and publish player assets atomically, preventing empty player files and blank trimming views.
- Reject empty assets and repair damaged generated assets before publishing the renderer.

### Verification

- Local unit, interface, playback and package checks cover the release; tooltip checks include Chromium and WebKit in light and dark themes.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.37 - 2026-10-12

This patch fixes quality fallback edge cases, keeps queue quality details readable, and makes CI report its actual coverage.

### Video quality

- Use the same alternative variant names as Streamlink (_alt and _alt2) when several codecs share one resolution.
- Reject empty, audio-only or otherwise unusable direct Twitch playlists before caching them, so a retry can request fresh data.
- Preserve the selected quality label with queued downloads.

### Queue and testing

- Show the selected resolution, frame rate and codec in queue details, with a readable fallback for older queue entries.
- Make the queue stress test fail on real overflow at supported application widths.
- Remove ignored local-only checks from the normal GitHub CI path and fail explicitly when a manually requested live gate lacks its required local check.

### Verification

- 967 local unit tests, focused Chromium/WebKit quality-dialog cases, queue stress tests, security checks, build and workflow validation passed.
- The Windows installer remains unsigned, as in previous releases.

## Unreleased

## 1.0.36 - 2026-10-11

This patch speeds up VOD quality selection and keeps the dialog steady while available qualities load.

### Video quality

- Load available qualities directly from Twitch before falling back to Streamlink, avoiding an extra process in the usual case.
- Reuse recent quality results when opening the same VOD again.
- Sort resolutions from highest to lowest, including 1440p Source renditions.
- Show the Source resolution, frame rate and codec beneath its label.

### Interface

- Replace the separate loading spinner with aligned placeholders that preserve the position of the quality options and action buttons.
- Use consistent two-line options with readable text in light and dark themes.
- Rename the dialog to Video quality and clarify the Add to queue action with a green button and queue icon.
- Include editing workflow styles in development live updates.

### Verification

- Check loading, selection, cancellation, errors and retry behavior in Chromium and WebKit, including narrow windows and both themes.
- Verify the Windows package and public update files before completing the release.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.35 - 2026-10-11

This patch prevents accidental text selection on interface buttons, including the VOD download quality dialog.

### Interface

- Prevent button labels such as Cancel and Add to queue from being highlighted while clicking or dragging.
- Apply the same selection behavior to native buttons and controls with the button role.
- Preserve the existing selection rules for input fields and copyable content.

## 1.0.34 - 2026-10-11

This patch makes Windows updates from older Twitch VOD Manager releases reliable on GitHub release assets.

### Updater

- Disable multipart range requests for GitHub release assets, which can reject differential updater requests.
- Use the release directory URL with an explicit trailing slash for deterministic metadata and installer resolution.
- Keep the updater on the verified full installer path for unsigned Windows releases.

### Verification

- The real packaged 1.0.32 to 1.0.33 updater path downloaded and SHA-512 verified the installer.
- The new packaged updater path is verified against the public release assets before publishing.
- The Windows installer remains unsigned, as in previous releases.

## 1.0.33 - 2026-10-11

This patch makes Twitch's hidden Source renditions available for VOD quality selection and download.

### VOD Source quality

- Detect Twitch `unavailable-media` renditions such as 1440p60 HEVC that are hidden from the regular Streamlink quality list.
- Show the actual Source resolution, frame rate and codec in the quality dialog.
- Download Source and explicitly selected high-resolution renditions through the direct Twitch HLS manifest when available, while keeping standard 1080p and lower qualities on the existing Streamlink path.
- Use the same high-resolution Source path for VOD preview playback.

### Verification

- 959 unit tests, build, ESLint and headless VOD/player audits passed.
- VOD 2897060167 verified as a 2560×1440 HEVC 60 fps Source stream through the real HLS path.
- Windows installer remains unsigned, as in previous releases.

## 1.0.32 - 2026-10-10

This patch fixes category selection in the VOD trimming workflow so a selected Twitch chapter is downloaded as the requested range only.

### VOD chapter trimming

- Make “Kategorie zuschneiden” select the chapter as the download excerpt in every editing mode.
- Leave “Bereiche auslassen” when a chapter is selected instead of treating the chapter as content to exclude.
- Preserve exact chapter start and end boundaries in the queue plan, preventing preceding categories from being downloaded accidentally.

### Verification

- 959 unit tests and the release checks passed.
- A deterministic four-hour VOD regression check confirms that a chapter from 03:00:00 to 04:00:00 produces exactly one 03:00:00–04:00:00 download range.
- The Windows installer is unsigned, as in previous releases.

## 1.0.31 - 2026-10-10

- Reorder waiting exports while retaining keyboard focus, remove saved jobs together without deleting files, and see numeric progress.
- Show VOD frame rates and available codec metadata. Repeated quality lookups are cached briefly.
- Preview discovered clips with the shared player and view their duration before downloading.
- Search saved projects by project or source name and sort by date or name.
- Use a supported frame size when detecting hardware encoders, avoiding false negatives on NVIDIA and Intel GPUs.
- Keep shared player menus in the active dialog so clip preview controls stay visible.\r\n\r\n## 1.0.30 - 2026-10-10

This update adds per-VOD quality selection and fixes five interface issues in the video editor, export queue, clip search and statistics.

### VOD quality

- Choose the download quality before adding an individual VOD to the queue or opening it for trimming. Source is selected by default.
- The dialog lists the qualities actually available for that VOD, including 1440p when Twitch provides it. H.264, HEVC and AV1 variants are recognized; availability depends on the recording.
- The chosen quality is retained in the queue, after restarting the app and when downloading or merging parts. An explicitly chosen quality is not silently replaced with another one.
- Failed quality lookups can be retried, and the dialog can be cancelled without adding a download. Bulk and automatic downloads continue to use Source.

### Video editor and export queue

- The timeline and playback controls retain the space they need instead of being cut off when the window is shorter or export jobs are present.
- The editing page can scroll to the cut fields and export jobs. The last job remains reachable in a longer queue.
- Queue export is now visible beside Merge in the merge workspace. Its availability follows the selected files and current operation. Queuing an export and starting it immediately remain separate actions.

### Clip search

- Changing the channel or date range clears results, selections and pagination from the previous search.
- A failed new search can no longer leave clips from another channel available for import or pagination.
- Late responses cannot overwrite a newer search. Closing and reopening the dialog during a search leaves the controls usable.
- A failed request for the next page preserves the matching results already loaded.

### Statistics and interface

- Activity chart tooltips show the complete date range, including the year, when a bar combines several days. The total is no longer attributed to a single day.
- The Update button is vertically centered in the top bar, with consistent text size and spacing.

### Verification

- 949 unit tests and 42 additional checks passed, covering Chromium, WebKit and the native Electron app.
- Targeted checks covered 188 layout states, 88 interaction cases and nine native layout cases. Existing checks also covered editing, queues, project recovery, backups, archive operations and real audio/HDR exports.

The Windows installer is unsigned, as with previous releases.

## 1.0.29 - 2026-10-10

This update fixes an overlapping preview in the video editor that could cover the project name and project actions.

### Video editor

- The project toolbar keeps its full height instead of collapsing beneath the preview.
- The empty preview is centered and sized to fit the available window height while retaining its 16:9 aspect ratio.
- The loaded editing workspace continues to use its flexible layout.

## 1.0.28 - 2026-10-10

This update adds reusable editing projects, a persistent export queue, full application backups, and more precise control over source formats, audio and automated downloads. It also expands the archive, download history and clip browser.

### Video editing and export

- Save named editing projects, create independent variants and reopen recent projects. Projects retain the selected excerpt, omitted ranges, export settings and audio options.
- Move a project together with its source video, or locate a moved source again. File contents are checked before the project is linked to a replacement. Projects and source videos can be stored on different drives.
- Queue video cuts and merges. Export jobs survive restarts and support pause, cancellation and retry. An interrupted export is identified instead of being silently run again.
- Export retains the selected source bit depth and color format where supported. HDR sources no longer silently become 8-bit SDR; explicit SDR conversion is available. The archive profile preserves decoded video and audio without lossy encoding.
- Export all audio tracks or select an individual track. Optional fades and loudness normalization apply to the exported audio.
- A live audio meter shows the preview signal in the local video editor.
- Merging checks codec, resolution, frame rate, color format and audio tracks first. Matching files can keep their original streams; incompatible files require an explicit supported conversion.
- More specific file and export errors explain the next action, with technical details available separately.

### Backups and storage

- Back up settings, the current download queue, download history, editing workspaces, saved projects, export jobs and VOD library entries in one file. Source videos and credentials are not included.
- Preview a backup before restoring it. Restoration validates the data, keeps a safety copy and pauses automation. Saved project documents are restored as separate copies without overwriting their original locations.
- A manual backup includes the current queue even when automatic queue persistence is disabled.
- Storage cleanup runs asynchronously and shows the files to be affected before applying the operation. Files changed after the preview are skipped. Matching chat and event files are handled with their video.
- Archive changes update an incremental index; explicit refreshes and periodic reconciliation still check the full folder.

### Archive, history and statistics

- Filter archive results by date and send selected videos directly to the editor or merge workspace.
- Browse persistent download history by date, type, channel or title, and export it as CSV. Deleting a downloaded file does not erase its history.
- Select time ranges for statistics and export the corresponding download data.

### VODs, clips and automation

- Save VOD filter views and streamer groups for reuse.
- Save timeline markers and complete excerpts, including their omitted ranges, and apply them again.
- Browse a channel’s clips by date and add selected clips to the batch downloader. Previously downloaded clips are identified.
- Set title, duration and age rules per channel for automatic VOD downloads. Preview matching VODs before saving a rule.

### Interface and release checks

- Centered, scroll-bounded project, library and clip dialogs use consistent controls and readable spacing in both themes. Less frequently used download settings are grouped in expandable sections.
- Release packages include only the current renderer assets. Obsolete hashed build files are excluded.
- Publishing now requires a complete local verification record, a matching source fingerprint and a native check of the packaged application. A CI build alone does not count as a verified release.

This Windows release is unsigned, as with previous releases.

## 1.0.27 - 2026-10-09

This update fixes six issues in storage analysis and streamer management.

### Storage

- Large download folders are scanned without blocking the application. In the verified 10,005-file test, the longest main-process pause fell from over 500 ms to under 10 ms.
- Files directly in the download folder are included in file counts and storage totals.
- Chat files in nested folders are included in chat storage totals.
- The storage table stays inside its settings card. Long folder names wrap, and narrow layouts can scroll horizontally without covering nearby controls.
- File counts follow the selected language, including thousands separators.

### Streamer management

- Adding a streamer can be retried after a failed save. The input and previous list are preserved until saving succeeds.
- Removing and reordering streamers use the same recovery behavior. Concurrent list changes are saved in order, and text entered during a pending save is preserved.

### Verification

- 847 automated tests and 20 browser test runs passed, with additional checks in Chromium and WebKit for long names, narrow layouts and failed-save recovery.
- Native checks covered download cancellation, reload and restart recovery, video merging and export.

## 1.0.26 - 2026-10-09

This update removes startup stalls, keeps large download queues responsive, and restores clip and merge workspaces after reopening the app. It also improves error recovery, archive browsing and the video editor.

### Startup and responsiveness

- Tool discovery and Streamlink, FFmpeg and FFprobe checks run asynchronously instead of blocking the main process. Simultaneous checks share their work and have time limits.
- The window appears after the interface has initialized. Navigation and keyboard controls no longer wait for Twitch login or initial network requests.
- Old preview files are cleaned up in the background, while temporary files belonging to an active editor are preserved.
- Large queues update changed rows instead of rebuilding the entire list. Collapsed details are created when opened, reducing startup and update work.

### Download queue

- Changes to titles, dates, durations and output files appear reliably, including updates that do not change download progress.
- Starting a download immediately updates its visible status, progress information and drag availability.
- Removing selected entries updates their selection numbers correctly. The merge action disappears when the queue or eligible selection is empty.
- Unchanged rows remain in place during updates and reordering, preserving their controls and reducing visual disruption.

### Twitch Clips

- Clip lists, metadata and download states are saved and restored. A running download reconnects to the interface after a renderer reload.
- Metadata requests interrupted by a reload restart correctly instead of leaving clips stuck in the loading state.
- Cancel the current clip during preparation, transfer or final saving. Partial files and child processes are cleaned up when cancellation completes.
- Active transfers show downloaded data and speed. Individual clips can be removed, and saved clips can be opened or shown in their folder.
- Saved filenames preserve umlauts and other valid Unicode characters while excluding characters Windows cannot use.
- Missing clips and temporary metadata failures have distinct states. Retry and completion updates no longer rebuild every row in a large batch.

### Joining videos

- Selected files, their order and durations are restored after restarting. Missing files are identified before a merge starts.
- Reorder files with the drag handle or the existing move actions. The workspace shows individual and total durations.
- Failed file selection, output selection or merge requests release the controls so the operation can be retried. Rapid duplicate clicks do not start overlapping operations.
- Retrying after an invalid or protected output location keeps access to the original input files.

### Archive and video editor

- Browse archive results in pages instead of being limited to the first 200 matches. Filter changes return to the first page, and late responses cannot replace a newer search.
- Repeated archive queries reuse a short-lived inventory. Explicit refreshes and completed downloads update the inventory when needed.
- Failed page changes keep the last successful results and allow another attempt.
- The local editor has a more compact file header and more readable controls. Timeline labels remain visible below the audio waveform, including compact layouts.
- VOD cards show two-line titles. Top workspace actions are aligned consistently to the right, and file sizes follow the selected language.

### Settings and automation

- Failed setting changes display a persistent retry action. New edits made while a save is in progress are saved afterwards instead of being lost.
- Theme, language and download-folder changes use the same save and recovery flow.
- Auto-VOD and live-recording scans distinguish provider failures from a successful scan with no new videos or live channels. Automation status is localized.
- Diagnostics refresh only while their relevant section is visible. A successful log request restores the output after an earlier failure, even if the log content has not changed.
- Redundant descriptions and duplicate headings have been reduced; diagnostics are collapsible and fixed Source quality is shown directly.

### Development builds

- Stylesheet changes update the running interface without restarting playback or clearing editor state. Invalid styles leave the last valid appearance in place.
- Changes to application logic still require a restart and are identified separately by the development status indicator.

### Verification

- The changes were checked with 841 automated tests, Chromium and WebKit interface suites, and 1,000 queue combination steps.
- Additional checks covered isolated startup stress, clip cancellation, Unicode output, reload recovery, real video merging and cutter export. These checks do not imply compatibility with every codec, device or network condition.

## 1.0.25 - 2026-10-09

This update rebuilds Twitch Clips for batch downloads, preserves download statistics when files are removed, and simplifies navigation and settings. Twitch downloads and previews now consistently use Source quality.

### Twitch Clips for single links and large batches

- Paste up to 200 Twitch clip links, one per line, into a centered workspace. The separate Clips sidebar and duplicate toolbar have been removed.
- Clip titles and streamer names load as links are added. The list shows the actual clip information instead of the URL identifier, before a download starts.
- Both Twitch clip URL formats are supported, including links with additional query parameters. Duplicate links to the same clip are recognized even when their URL format differs.
- Public clip lookup works without a connected Twitch account. Missing clips and connection failures are handled separately instead of reporting every lookup problem as “Clip not found.”
- Each entry shows its download state. Failed clips can be retried without downloading successful entries again; stopping a batch finishes the current clip and leaves the remaining entries available to continue.
- A new loading indicator and green completion icon make states easier to distinguish. Updating progress or clip information preserves existing rows and their animations.
- The input area, results list and surrounding controls stay in place as clips are added. Long lists scroll internally, and existing text and icons no longer shift when a separator or scrollbar appears.
- Messages appear without moving the workspace and disappear after five seconds. Completion messages use the correct singular or plural and omit unnecessary zero counts.

### Download statistics that remain available

- VOD, clip and live-recording totals are stored independently of the files currently in the download folder. Removing a video or clearing completed queue entries no longer resets those totals.
- The redesigned Statistics page separates completed downloads and downloaded data from the current folder contents.
- Review activity over the last 30 days, storage by streamer and the size distribution of archived videos. Counts follow the selected interface language.
- Previously saved completed queue entries are included where available. Downloads deleted before a completion record was stored cannot be reconstructed.
- Refresh errors preserve the last available figures and show the relevant status in place.

### A clearer archive

- Archive search uses the full workspace without a redundant sidebar. Search, recording type, streamer and sorting controls are grouped above the results.
- Clip files are assigned to their streamer correctly, and available streamer filters come from the current file inventory.
- Folder scanning runs in the background. Rapid changes to a search keep the latest results, while longer result lists scroll inside a stable area.
- File actions and matching chat or event files remain accessible from each recording.

### Source quality throughout Twitch downloads

- Full VODs, selected VOD ranges, parts, live recordings, clips and the VOD player request Source quality.
- Older saved or imported quality preferences are updated to Source automatically. The setting now displays the fixed quality directly.

### Navigation and VOD controls

- The active navigation tab fills the height of the bar. Labels scale for wider windows, and tab changes use a short fade instead of a sliding selection bar.
- The Streamer and Queue headings, counters and empty states have matching spacing. Streamer entry and title-filter fields use more compact widths.
- Streamer actions are grouped consistently, with a green add button and a single refresh action. The Twitch profile link has a purple button with recognizable icons.
- Sorting controls have visible dropdown arrows, the downloaded filter has clearer contrast, and unwanted click outlines and the bulk-selection tooltip have been removed.
- The merge workspace is centered in the available area. Clips, Statistics and Archive no longer show unnecessary context sidebars.

### Settings with fewer sections

- Settings are grouped into General, Twitch API, Downloads, Automation, Storage & Backup, and System & Diagnostics. Appearance and updates are part of General.
- Shorter labels, more readable text and compact number fields reduce wasted space. Auto-VOD interval and age fields line up with their action buttons.
- Language selection opens in its saved position without an initial slide. Theme controls keep their smooth selection transition.
- System status is easier to read in both themes. Redundant explanatory blocks and permanent success messages have been removed across the application.

### Faster, more reliable development startup

- Verified development builds are reused instead of rebuilding every time the app opens. Changed or incomplete builds are still rebuilt before launch.
- Startup preparation is serialized, duplicate development instances are prevented, and the window is shown after its first render.
- Development builds identify themselves in the window title and application header.

### Verification and distribution

- Validation covers both interface languages, light and dark themes, different window sizes, 200-clip batches, rapid add/remove sequences and preservation of download history after file removal.
- The Windows release includes the installer, blockmap and update metadata for the integrated updater.

## 1.0.24 - 2026-10-09

- Improve frame-accurate VOD trimming with immediate playback controls, current-position omission preview and visible excluded ranges in fine seeking.
- Support multiple non-overlapping exclusions while keeping output parts at the configured length and preserving skipped original part numbers.
- Refine the local cutter with sharper high-resolution audio waveforms, persistent export-profile selection, shared I/O controls and clearer trim-mode icons.
- Clean up the VOD history and omission workspace with a single title presentation, clearer active-history state, compact controls and more readable output summaries.

- Synchronize local cutter time displays with presented video frames, fix adjacent-frame seeking and fractional-rate timecode round-trips, and show frame labels when zoomed. Keep thumbnail widths uniform and render separate audio-channel peaks sharply at the current zoom.

- Reuse the VOD trimming I/O markers and fine-seek preview in the local cutter, replacing duplicate marker rendering and input handling while preserving frame-aligned edits and undo/redo.

- Compact the local cutter export and selection panels, show readable audio-track choices and keep exclusions visible in both edit modes. Route Space to playback after control clicks, suppress control focus rings and Tab traversal outside editable fields, and reset progress for each export.

- Fix broken cutter loading and misplaced navigation after source changes by loading a complete renderer build. Keep single-start development sessions stable and rebuild all assets before restarting watch sessions.

- Rework the local Video Cutter around shared player controls, one thumbnail/waveform timeline, visible excerpt markers, confirmed exclusion edits and a compact export sidebar. Preserve frame stepping, project recovery and undo/redo; improve keyboard boundaries, fine dragging and scrub completion.

- Add the Streamrecorder history sidebar with Twitch game chapters, covers, category filters, direct seeking and one-click selection of a category for trimming. Show VOD time, original date/time, category and available title history when hovering over the player timeline.
- Read matching title-change events from local live-recording logs. Keep the stored VOD title separate when a historical title timeline is unavailable.

- Rebuild VOD trimming around the full Streamrecorder video player, including continuous HLS playback, seeking across the complete VOD, fine seeking, exact timestamps, speed, volume, keyboard controls, cinema mode, fullscreen and picture-in-picture.
- Add draggable start/end markers, I/O shortcuts, selection playback and precise cut-time inputs in a responsive workspace. Keep filename and continuation settings together in the sidebar.
- Fetch only the VOD segments needed for playback through a restricted local media endpoint and stop pending requests when the dialog closes.
- Finalize VOD, trim, live and clip downloads as verified MP4 containers using stream copy, preserving the selected video and audio quality instead of saving raw stream data under an MP4 extension.
- Explain the difference between downloads without re-encoding and re-encoded local video-cutter exports.
- Keep project memory, tests, fixtures and test artifacts local; allow build and packaging from checkouts without local test files.

## 1.0.23 - 2026-09-07

- Start pending downloads in the visible queue order, including manually reordered entries. Retire the automatic short-job prioritization, including for existing configurations.
- Keep transfer size, percentage, speed and remaining time on one compact line below 1 GB as well. Preserve wrapping for error messages and full values in tooltips.

## 1.0.22 - 2026-09-06

- Show small round profile pictures beside streamer names in the sidebar, with an initial fallback when an image is unavailable.

## 1.0.21 - 2026-09-06

- Show the Twitch display name with its original capitalization in queue details and refresh it when profile names load.
- Put queue detail URLs on a separate single line; click or use the keyboard to copy the complete URL with confirmation.
- Keep queue-card titles and content aligned when expanding or collapsing details by reserving scrollbar space.
- Move the queue-card remove button slightly toward the top-right corner while retaining its 32-pixel click target.
- Show a yellow left border on waiting queue cards, matching their status dot.
- Place the queue-card date on the left beside the details arrow and the download status on the right below the progress bar.

## 1.0.20 - 2026-09-06

- Fix automatic media-tool setup in long Windows paths by using the built-in archive extractor. Report extraction failures instead of accepting incomplete installations.
- Make queue cards easier to read with two-line titles, larger dates below the progress bar on the right, and 32-pixel remove and retry buttons.
- Show clearer download states, preserve the progress percentage while paused, and wrap long error messages. Keep the waiting status simple with a yellow dot and no badge background or outline.
- Open and close download details by double-clicking the card surface or using the dedicated keyboard-accessible arrow.
- Animate details smoothly in both directions with a matching arrow rotation. Respond immediately to rapid clicks and keep collapsed file actions out of keyboard navigation.
- Fix the Windows hot-development startup crash caused by looking for the application icon in the packaged resource directory.
- Add isolated queue-card checks for both languages and themes, keyboard controls, animation and rapid clicks; exclude local development data and bundled third-party tools from linting.

## 1.0.19 - 2026-08-14

- Provision managed Streamlink and FFmpeg automatically in the background after installation so first downloads start without tool setup delays.
- Show a dedicated "Preparing download tools" status in the queue while download tools are checked or installed before a download begins.

## 1.0.18 - 2026-08-14

- Install managed Streamlink and FFmpeg successfully on systems whose PowerShell only ships the built-in archive tooling.
- Recover interrupted merged downloads reliably when Windows reports the download folder through an 8.3 short path.
- Keep downloads working through a runnable system-provided Streamlink or FFmpeg even when the managed tool installation cannot be repaired right away.
- Fail managed tool downloads cleanly when the connection breaks mid-transfer instead of leaving the download start waiting indefinitely.
- Show in Settings when downloads remain available through a system installation while a managed tool is missing or unverified.
- Explain failed automatic tool installations consistently across single, live and merged downloads.
- Keep update downloads, progress, errors and changelog controls contained and responsive throughout the complete update flow.
- Preserve System Check results across language changes and keep repeated diagnostics in a clear terminal state.
- Expand Live Debug Log and Runtime Metrics layouts, improve dark-theme controls and make navigation and settings labels easier to read.
- Improve the video cutter with accessible new, open and save actions, unambiguous frame timecodes, multi-audio exports and verified VFR, AV1, HEVC, MKV, TS and AVI handling.
- Make streamer switching, multi-selection and bulk queue operations race-safe while preserving failed selections for retry.
- Keep queue status, progress, health, speed and remaining time accurate across pause, retry, completion and live recording changes.
- Harden sensitive configuration migration, provider error redaction, process shutdown, crash recovery and Windows installer upgrades.
- Add isolated validation for managed media tools, supported cutter media, Windows installation modes, Twitch provider access and published updater downloads.

## 1.0.17 - 2026-08-13

- Keep the loaded video cutter focused at every supported window size and give recovery notices their own layout space.
- Preserve recovered hardware encoder selections until export capabilities finish loading, and reject unsupported cutter files without changing the current project.
- Follow the Windows color scheme when the System theme is selected.
- Fully localize Runtime Metrics in German, including values, counts and error classes.
- Clear stale System Check results after configuration imports while keeping running controls correctly localized.
- Bound child-process shutdown waits so stalled exports cannot keep the application open indefinitely.

## 1.0.16 - 2026-08-13

- Preserve completed System Check results when switching between German and English.
- Relocalize successful and failed diagnostics, health badges and running check controls without stale language state.
- Clear obsolete System Check results after download path, imported configuration or managed tool changes.

## 1.0.15 - 2026-08-13

- Keep update download progress within its popover and make changelog expansion and collapse easier to follow.
- Expand Live Debug Log and Runtime Metrics to use the available Settings workspace.
- Improve dark-theme checkbox contrast with a green selection and dark checkmark.
- Prevent Auto-Cleanup options from being clipped.
- Increase primary navigation label size and improve inactive-label contrast.

## 1.0.14 - 2026-08-12

- Provision the Electron binary with a bounded retry before Windows CI smoke tests.

## 1.0.13 - 2026-08-12

- Apply the Windows CI retry to both directory and installer packaging.

## 1.0.12 - 2026-08-12

- Retry transient Electron download failures once while packaging on Windows CI.

## 1.0.11 - 2026-08-12

- Stabilize the Windows CI secure-storage test without invoking Electron's binary bootstrap outside Electron.

## 1.0.10 - 2026-08-12

- Ignore malformed updater events without a version instead of showing an unusable update prompt.
- Keep the cutter source selection out of the loaded editor layout and render each export profile indicator exactly once.

## 1.0.9 - 2026-08-12

- Waited for managed-tool checksum streams to close before promoting verified installations, preventing intermittent Windows repair failures caused by open file handles.

## 1.0.8 - 2026-08-12

- Updated the Windows CI runtime to Node.js 24.11.1, resolving the SQLite native-module crash that interrupted verification workers on Node.js 22.13.0.
- Corrected the file-capability test expectation for canonical Windows output paths, including 8.3 temporary-directory aliases.

## 1.0.7 - 2026-08-12

- Replaced versioned Windows Start menu shortcuts with one stable application entry, migrated legacy shortcuts during upgrades and refreshed the Windows Shell registration.
- Kept the application icon consistent across the installer, desktop shortcut, Start menu entry, taskbar and relaunch metadata.
- Repaired upgrades after incomplete per-user installations so missing program files are restored before shortcuts are refreshed.
- Fixed the available-update popover so pointer movement from the Update button into its actions remains reliable across the full button width.
- Added a smooth expandable changelog section to the update dialog.

## 1.0.6 - 2026-08-12

- Hardened queue process ownership, persisted state transitions and protected file access across downloads, imports, exports and local media tools.
- Added verified managed tool installation with version pinning, archive checksums, atomic recovery and repair status controls.
- Improved keyboard navigation, dialog focus handling, accessible virtualized chat and event viewers, context menus and command-palette behavior.
- Added cutter project recovery, export profiles, rotation and audio-stream choices, hardware encoder verification and safer media replacement handling.
- Added global download bandwidth limits and configurable download windows that apply consistently across queue and clip jobs.
- Added Windows quality, packaging and security gates, including public-file allowlist validation and packaged-media checks.
- Fixed Windows taskbar identity so development and installed windows publish an explicit application icon and relaunch metadata.

## 1.0.5 - 2026-08-11

- Added a complete local video editor for MP4, M4V, MOV, WebM, MKV, TS and AVI files with frame-accurate trimming, removable ranges, undo and redo, timeline zoom and atomic exports.
- Added a responsive desktop player with smooth scrubbing, keyboard controls, volume interaction, fullscreen playback and synchronized playback state.
- Added high-resolution video thumbnails and a reusable waveform timeline that remain sharp across zoom levels without blocking the first usable view.
- Added precise timeline handles, mouse-wheel zoom anchored to the pointer and smooth navigation for short and long recordings.
- Added safe source validation, cancellable exports and protection against partial or overwritten output files.
- Added a confirmation step before replacing an active edit and reset playback controls correctly when another video is opened.
- Improved editor layout, timestamp readability, metadata alignment, action contrast and language-selection contrast across supported window sizes.

## 1.0.4 - 2026-08-11

- Added smooth entrance and exit motion for the VOD selection action dock, including Windows systems with reduced animations enabled.
- Fixed stale Windows desktop and Start menu icons with version-specific shortcut icon resources and an explicit Shell refresh after installation.
- Kept icon resources available for pinned and copied shortcuts across upgrades while cleaning them up during a full uninstall.
- Updated the public product overview with a real Twitch channel example.

## 1.0.3 - 2026-08-10

- Added animated selection markers across the main navigation, sidebar modes, language control, streamer list and settings pages.
- Reorganized Settings into dedicated pages with a responsive two-column download configuration and clearer public-mode guidance.
- Added startup preloading and silent five-minute background refreshes for configured streamers and their VOD libraries.
- Improved VOD cards with stable one-line titles, localized dates, clearer view counts, persistent duration badges and high-resolution hover previews.
- Added an optional split Streamer and Queue sidebar, compact streamer context actions and space-efficient merge-order selection.
- Improved queue accuracy with real zero-percent starts, stable progress metadata and pause or continue support without restarting the download.
- Added safe partial-file handling so incomplete downloads are removed after cancellation, normal shutdown or crash recovery and final names only appear after verification.
- Replaced Electron branding across the window, taskbar, installer, uninstaller and notifications with the Twitch VOD Manager identity.
- Improved German localization, date formatting, text-selection behavior, responsive navigation labels and update-dialog layout.
- Added a Windows hot-reload development workflow for renderer and main-process changes.
- Updated the public documentation with a complete feature overview, privacy details, setup guidance and an isolated product screenshot.

## 1.0.2 - 2026-08-10

- Redesigned the desktop workspace with compact top navigation, contextual sidebars and dedicated toolbars for all seven areas.
- Added Light, Dark and System appearance modes with improved contrast and responsive layouts from 1280 to 2048 pixels.
- Added a persistent update control with download, postpone and dismiss actions.
- Added searchable settings, synchronized section navigation and clearer empty, queue and busy states.
- Improved German and English localization, including locale-aware dates and accessibility labels.
- Hardened the release test suite with isolated application data, browser profiles, downloads and offline network fixtures.
- Updated the desktop runtime and Windows packaging stack with current security fixes.

## 1.0.1 - 2026-08-05

- New clean public release line based on the complete desktop application.
- Twitch VOD, clip, trim, split, merge, queue, history and automation workflows.
- Streamer profiles, VOD previews, themes, localization and command palette.
- Resumable downloads, integrity checks, secure local storage and SQLite migration.
- Automatic update checks and downloads through GitHub Releases.


