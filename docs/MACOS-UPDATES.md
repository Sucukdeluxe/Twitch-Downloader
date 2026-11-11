# macOS updates without an Apple Developer membership

The macOS app uses its own Ed25519-signed update manifest and architecture-specific
ZIPs hosted in the public
[macOS repository's releases](https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases).
This update verification does not require an Apple Developer membership, an Apple
certificate, an update server, or a token on users' Macs. Windows keeps its existing
updater. The stable manifest is:

```text
https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/latest/download/mac-update.json
```

This signature authenticates updates to an already trusted installation. It is
separate from Apple's Developer ID signing and notarization. The distributed app
is ad-hoc signed; the first downloaded installation can still be blocked by
Gatekeeper. Follow [Apple's instructions for opening an app you trust](https://support.apple.com/en-us/102445).
Do not disable Gatekeeper globally. Developer ID/notarization remains an optional
future distribution improvement requiring the appropriate
[Apple Developer account capabilities](https://developer.apple.com/help/account/basics/about-your-developer-account).

## User behavior

Install the first version containing this updater manually from the DMG and move
it into Applications or another writable local folder. Older installations that
only understand `latest-mac.yml` do not gain this new trust mechanism automatically.
An app running from a mounted disk image cannot replace itself in place.

The app checks automatically shortly after startup and every ten minutes. Updates
can also be checked manually. Download and restart use the existing in-app buttons;
the app never interrupts a running download or editing session by restarting itself.

The updater accepts a newer stable version only after validating its Ed25519
signature against the public key bundled in the app. It downloads the ZIP for
the running app's architecture, checks its signed size and SHA-256 hash, and
uses the bundled native helper to install it after the app exits. User data is
stored separately from the application bundle. Preview releases remain available
for manual installation and are excluded from the stable update feed.

## Release key setup

`build/mac-update-public-key.pem` is the public Ed25519 verification key. It is
safe and necessary to commit and ship it. The matching **private** key must stay
outside this repository, build artifacts, app bundles, and logs.

For a new trust root, generate an Ed25519 private key in secure storage outside
the checkout, and export only its public half to the path above. For example,
using a local OpenSSL installation that supports Ed25519:

```sh
umask 077
openssl genpkey -algorithm ED25519 -out /secure/private/path/mac-update-private-key.pem
openssl pkey -in /secure/private/path/mac-update-private-key.pem \
  -pubout -out build/mac-update-public-key.pem
```

The placeholder directory must already exist. Do this only before the first
trusted release, or as part of a deliberately planned key migration. Replacing
the bundled public key without a migration prevents existing installations from
trusting releases signed by the new key.

Create a GitHub Actions environment named `macos-release`. Store the complete
matching private PEM in its secret `MAC_UPDATE_PRIVATE_KEY`. Environment
restrictions and reviewer protection can be configured separately according to
the repository owner's release policy; the workflow does not assume that they
are already enabled.
Keep an encrypted offline backup. Never paste the key into release notes or
workflow inputs. The generator verifies that the secret is an Ed25519 private
key matching the committed public key and fails if it is missing or different.
No demonstration key or unsigned fallback is accepted by the release workflow.

The key holder and the release workflow can sign executable updates. Protect
both the key and changes to release source/workflows accordingly. The signature
protects against modified manifests/assets; it does not make a malicious release
from the legitimate key holder safe.

## Publishing a complete release

The workflow is `.github/workflows/macos-release.yml`. Bump `package.json` and
`package-lock.json` consistently, then create a tag `mac-vVERSION` pointing at
the intended release commit. The workflow can release a reviewed branch commit
before it is merged; the repository owner controls tag creation. Version numbers
have three numeric components, each at most eight digits and without leading
zeroes. Optional standard SemVer prerelease suffixes are allowed for previews;
build metadata is not used.

- A tag push for `mac-v1.2.3` publishes a **stable** release and updates `latest`.
- A tag push for `mac-v1.2.3-rc.1` publishes a **preview**, never `latest`.
- Manual runs require an existing tag and an explicit channel, defaulting to
  **preview**. A prerelease version cannot be selected for the stable channel.

A manual preview using a stable-looking version is still a GitHub prerelease
and remains outside the stable feed. Once published, it cannot be overwritten
or promoted by rerunning this workflow; use a new release version.

The workflow creates a **draft** first. Native Apple Silicon and Intel runners
then execute the tests and build the app/helper and matching DMG/ZIP. Packaged-app
checks run on fresh runners to isolate Keychain identities from source tests.
Only after both architectures succeed does the signing job download both sets
of immutable workflow artifacts, create `mac-update.json`, and upload exactly:

```text
Twitch-VOD-Manager-VERSION-mac-arm64.dmg
Twitch-VOD-Manager-VERSION-mac-arm64.zip
Twitch-VOD-Manager-VERSION-mac-x64.dmg
Twitch-VOD-Manager-VERSION-mac-x64.zip
mac-update.json
```

It verifies the uploaded names, sizes, and states before changing the complete
draft into a public release. Missing assets, failed tests, or a missing/wrong
signing key leave the release unpublished and the current stable feed intact.
The workflow can resume its own draft for the same commit and channel; it cannot
overwrite a published release. Do not manually publish a failed or incomplete
draft. See [GitHub's release API](https://docs.github.com/en/rest/releases/releases)
for draft, prerelease, and latest-release semantics.

The manifest CLI can also prepare a release locally. Set
`MAC_UPDATE_PRIVATE_KEY` securely in the process environment first, then run:

```sh
node scripts/create-macos-update-manifest.js \
  --version 1.2.3 --tag mac-v1.2.3 \
  --arm64 release/Twitch-VOD-Manager-1.2.3-mac-arm64.zip \
  --x64 release/Twitch-VOD-Manager-1.2.3-mac-x64.zip \
  --notes-file release-notes.txt --output release/mac-update.json
```

The version must match `package.json`. Both ZIPs are mandatory, must be regular
files, and must have the exact version/architecture names shown. The output must
not already exist. `--public-key PATH` overrides the public-key file for isolated
tests; production uses the committed default. `--published-at` optionally accepts
a canonical UTC timestamp such as `2026-11-11T12:00:00.000Z`. Notes are UTF-8 text
limited to 32768 bytes. The private key is read only from the environment.

## Signed wire format

The JSON envelope has exactly these fields:

```json
{"payload":"BASE64_UTF8_JSON","signature":"BASE64_ED25519_SIGNATURE"}
```

The signature is over the **exact decoded payload bytes**, not over a parsed or
reformatted JSON representation. The decoded payload has this schema:

```json
{
  "schema": 1,
  "version": "1.2.3",
  "publishedAt": "2026-11-11T12:00:00.000Z",
  "releaseNotes": "Release notes",
  "artifacts": {
    "arm64": {
      "url": "https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-arm64.zip",
      "size": 12345,
      "sha256": "64 lowercase hexadecimal characters"
    },
    "x64": {
      "url": "https://github.com/Sucukdeluxe/Twitch-Downloader-macos/releases/download/mac-v1.2.3/Twitch-VOD-Manager-1.2.3-mac-x64.zip",
      "size": 23456,
      "sha256": "64 lowercase hexadecimal characters"
    }
  }
}
```

The sizes and hashes above are illustrative. ZIP URLs name immutable release
tags and exact architecture assets, never `latest/download`. The app's stable
verifier rejects prerelease manifests even though the generator can sign them
for separately published previews. Keep published release assets immutable.

Run `npm run test:mac-update` on each native Mac architecture before releasing.
The manifest tests also run on non-Mac systems with
`node --test scripts/test-macos-update-manifest.js`; they check byte signatures,
manifest/asset tampering, wrong keys, missing/swapped assets, version constraints,
and malformed inputs. A hosted release workflow and an update from a real older
installed app are separate acceptance checks; local unit tests alone do not
prove successful public delivery.

## Installation recovery

The native helper waits for successful cutter autosave and orderly shutdown, then
atomically exchanges the two bundles. The replacement must confirm that its
database and renderer initialized. A failed launch or missing health acknowledgment
restores the previous bundle and reopens the same profile. The app reports a failed
installation on the next startup. Both bundles remain available if the operating
system's Launch Services callback itself stalls.

Only one Mac process uses a given profile. The helper also checks for other profiles
running the same app bundle. Such an instance prevents replacement; if independently
launched during recovery, it prevents rollback and the original backup is retained.
The updater never terminates an independent app instance.

Rollback restores application files, not arbitrary database migrations. Future
releases must keep on-disk changes compatible with the previous version or add a
separately tested data migration backup. Ad-hoc signing may cause macOS to ask
for Keychain access again after an update; stored encrypted credentials are retained.

`node scripts/smoke-test-macos-update.js` exercises a synthetic older bundle that
contains this updater against the unmodified current release ZIP. It verifies
the real native swap, relaunch, health handshake and preserved isolated database.
It is not evidence that pre-updater releases can install their own bootstrap.
