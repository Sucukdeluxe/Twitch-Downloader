# macOS runtime tools

The original application is MIT licensed. Bundled external programs run as separate processes.

- **Streamlink 8.6.3**: BSD-2-Clause, https://github.com/streamlink/streamlink/tree/8.6.3.
  The Python package and its dependencies include their original licenses in `*.dist-info`.
- **CPython 3.13.18**: Python Software Foundation license and bundled library licenses,
  distributed by https://github.com/astral-sh/python-build-standalone/releases/tag/20261026.
  The original runtime license files are preserved. The runtime is relocatable and private to this app.
- **FFmpeg / FFprobe 8.1.2**: GPL-3.0-or-later static builds by Martin Riedl,
  https://ffmpeg.martin-riedl.de/.
  Original source: https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.
  Build scripts and dependency source locations: https://git.martin-riedl.de/ffmpeg/build-script.
  Architecture-specific upstream URLs and SHA-256 values are pinned in
  `scripts/macos-tool-sources.json` and copied into the tool archive.

No system-wide packages are installed. The app verifies the complete bundled archive before
extracting tools into its per-user data directory. Repair restores that same bundled version
and does not require a network connection.
