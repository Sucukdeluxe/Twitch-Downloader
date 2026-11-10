#!/usr/bin/env python3
"""Build relocatable, offline tool archives. No user/system Python installation needed."""
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = json.loads((ROOT / 'scripts/macos-tool-sources.json').read_text())
CACHE = ROOT / '.cache/macos-tools'
HOST_ARCH = 'arm64' if platform.machine() == 'arm64' else 'x64'
ARCH = sys.argv[1] if len(sys.argv) > 1 else HOST_ARCH
if sys.platform != 'darwin' or ARCH not in ('arm64', 'x64'):
    raise SystemExit('Run on macOS, with optional architecture arm64 or x64')


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def fetch(name, arch):
    source = SOURCES[arch][name]
    file = CACHE / (f'python-{arch}.tar.gz' if name == 'python' else f'{name}-{arch}.zip')
    if not file.exists() or digest(file) != source['sha256']:
        subprocess.run(['curl', '-fLsS', '--retry', '3', '--max-time', '300', source['url'], '-o', str(file)], check=True)
    if digest(file) != source['sha256']:
        file.unlink()
        raise RuntimeError(f'Checksum mismatch: {name} / {arch}')
    return file


def extract_python(archive, destination):
    # Only a hash-verified upstream archive is unpacked here.
    with tarfile.open(archive) as bundle:
        bundle.extractall(destination)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    output = CACHE / ARCH
    stage = CACHE / f'stage-{ARCH}'
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    output.mkdir(exist_ok=True)
    host = CACHE / f'host-{HOST_ARCH}'
    if not (host / 'python/bin/python3').exists():
        extract_python(fetch('python', HOST_ARCH), host)
    python = host / 'python/bin/python3'

    streamlink = stage / 'streamlink'
    extract_python(fetch('python', ARCH), streamlink)
    site = streamlink / 'python/lib/python3.13/site-packages'
    pip_platform = 'macosx_11_0_arm64' if ARCH == 'arm64' else 'macosx_10_13_x86_64'
    subprocess.run([
        str(python), '-I', '-m', 'pip', 'install', '--disable-pip-version-check',
        '--no-compile', '--only-binary=:all:', '--require-hashes',
        '--platform', pip_platform, '--python-version', '3.13', '--implementation', 'cp', '--abi', 'cp313',
        '--target', str(site), '-r', str(ROOT / 'scripts/macos-requirements.txt'),
    ], check=True)
    shutil.rmtree(site / 'bin', ignore_errors=True)
    # Use paths relative to the launcher, including after install/repair or app relocation.
    launcher = streamlink / 'streamlink'
    launcher.write_text('#!/bin/sh\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/python/bin/python3" -I -m streamlink "$@"\n')
    launcher.chmod(0o755)
    # Python licenses ship in the standalone runtime; Python package licenses in dist-info.
    for directory in streamlink.rglob('__pycache__'):
        shutil.rmtree(directory, ignore_errors=True)
    for directory in site.glob('pip*'):
        if directory.is_dir():
            shutil.rmtree(directory)

    ffmpeg = stage / 'ffmpeg'
    ffmpeg.mkdir()
    for name in ('ffmpeg', 'ffprobe'):
        subprocess.run(['/usr/bin/ditto', '-x', '-k', str(fetch(name, ARCH)), str(ffmpeg)], check=True)
        (ffmpeg / name).chmod(0o755)
    shutil.copy2(ROOT / 'docs/MACOS-THIRD-PARTY.md', ffmpeg / 'THIRD-PARTY.md')
    (ffmpeg / 'sources.json').write_text(json.dumps(SOURCES[ARCH], indent=2) + '\n')

    manifest = {}
    for name, directory in [('streamlink', streamlink), ('ffmpeg', ffmpeg)]:
        archive = output / f'{name}-darwin-{ARCH}.zip'
        archive.unlink(missing_ok=True)
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', str(directory), str(archive)], check=True)
        manifest[name] = {
            'id': name,
            'version': SOURCES[f'{name}Version'],
            'sourceUrl': f'bundled:macos/{ARCH}/{archive.name}',
            'archiveName': archive.name,
            'sha256': digest(archive),
            'executables': ['streamlink', 'python3.13'] if name == 'streamlink' else ['ffmpeg', 'ffprobe'],
        }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Tools ready for {ARCH}: {output}', flush=True)


if __name__ == '__main__':
    main()
