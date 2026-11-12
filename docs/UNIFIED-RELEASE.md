# Shared Windows and macOS releases

`Sucukdeluxe/Twitch-Downloader` is the canonical source. A stable version in
`package.json` and `CHANGELOG.md` has one immutable `vX.Y.Z` tag and one tested
commit. Ordinary Windows and Mac CI run against `main` in that repository.
The same workflow files in the Mac compatibility repository do not rebuild
or publish the canonical product.

## Verification and publication

`.github/workflows/windows-release.yml` is named **Unified verified release**.
It runs on pull requests to `main` and canonical `v*` tag pushes. The
`prepare` job validates the version; `verify-webkit` and `verify-package`
retain the Windows release gate, WebKit receipt and native installer checks.
`verify-macos` and `package-macos` run on both native arm64 and x64 runners,
including signed bundle verification and updates from the original 1.0.10
application. The `publish` job depends on all five jobs. Pull requests cannot
publish and do not receive publishing credentials.

`publish-unified-release.cjs` validates the Windows production receipt,
source SHA, fingerprint and SHA-256/SHA-512 asset hashes. Both Mac builders
record version, commit, Actions run ID/attempt and hashes in
`mac-proof-{arch}.json`; the publisher checks these after artifact transport.
All platform assets come from the same source commit and workflow run.

The public canonical release contains exactly:

- `Twitch-Downloader-Setup-X.Y.Z.exe`, its `.exe.blockmap`, and `latest.yml`;
- `Twitch-VOD-Manager-X.Y.Z-mac-arm64.dmg` and `.zip`;
- `Twitch-VOD-Manager-X.Y.Z-mac-x64.dmg` and `.zip`;
- `unified-release.json`.

The provenance JSON has `schema: 1`, `version`, `commit`, `runId` and
`runAttempt` (decimal strings), `repository`, `workflow` (the workflow file
path), `event: "push"`, and `assets`. Each of the seven asset descriptors
contains `name`, `size` in bytes and lowercase hexadecimal `sha256`. It
contains no credentials. The provenance does not include its own hash.

The publisher prepares a draft, uploads the exact asset set, downloads each
uploaded asset again to verify its hash, then makes the complete release
public with one final API update. An existing draft must match the same
commit, notes and identity. Matching uploads are reused; interrupted or
changed draft uploads can be replaced while the release remains a draft.
Published versions cannot be replaced: retries verify every byte and return
without mutation. An older release can never replace a newer `latest`.

## Mac compatibility feed

The canonical publisher first requires and checks `MAC_RELEASE_DEPLOY_KEY`.
Configure its public half as a write-enabled **deploy key only on
`Sucukdeluxe/Twitch-Downloader-macos`** and its private half as that named
Actions secret in the canonical repository. No PAT is required. This is a
repository-scoped Git write credential, not a tag-only permission. It is
stored temporarily with restrictive permissions and never written to
artifacts, Git configuration or logs.

After canonical publication, `dispatch-macos-release.cjs` pushes exactly the
tested commit to `refs/tags/mac-vX.Y.Z` over SSH. It does not force, delete,
or mirror refs. An existing tag is accepted only if it resolves to the exact
same commit. SSH verifies GitHub's pinned Ed25519 host key using strict host
checking; it never trusts an unverified `ssh-keyscan` result. The pinned
fingerprint is `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.

GitHub documents that [push events include tags and deploy-key pushes](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).
Its [official SSH host keys](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
and [deploy-key scope](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
are the sources for this configuration.

`.github/workflows/macos-release.yml` runs only in the Mac repository. Its
single `relay` job uses the `macos-release` environment and the existing
`MAC_UPDATE_PRIVATE_KEY`. It checks that both repositories' tags and its
checkout identify the same commit, then validates canonical provenance and
the registered canonical workflow path, push event, repository and SHA.
It waits at most ten minutes for that canonical run to succeed. The
canonical workflow finishes immediately after dispatch and never waits for
the relay, avoiding a dependency cycle.

The relay downloads and hashes the four unchanged Mac assets, then invokes
`create-macos-update-manifest.js` from the same source version. The signed
`mac-update.json` retains the original Mac repository download URLs and
pinned signing key for existing clients. Canonical release notes and
publication timestamp produce deterministic manifest bytes across retries.
The complete five-asset Mac draft is verified before publication, with the
same immutability and monotonic `latest` checks.

## Recovery

If canonical publication succeeds but dispatch fails, rerun the failed
canonical job. It verifies and reuses the original published provenance and
assets. The relay accepts a later successful attempt of the same workflow
run, SHA and workflow; it never accepts a different producing run. Provenance
continues to report the attempt that originally produced it.

If the Mac tag already exists at the correct commit, dispatch does not
rewrite it and cannot generate a second push event. Retry a failed relay
run in the Mac repository, or run **macOS compatibility relay** manually
with that exact `mac-vX.Y.Z` tag. If a tag or published asset differs, stop
and release a new version; neither script silently moves a tag or changes a
published release. No recurring schedule or broad cross-repository token is
needed.

Local boundary tests: `node --test scripts/unified-release.test.cjs`.
Native builds and installer/update checks still require their Windows and
Mac runners; passing local script tests does not replace them.
