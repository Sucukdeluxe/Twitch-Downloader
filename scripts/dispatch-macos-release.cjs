#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateVersion } = require('./create-macos-update-manifest.js');

const ROOT = path.resolve(__dirname, '..');
const REMOTE = 'git@github.com:Sucukdeluxe/Twitch-Downloader-macos.git';
// Published by GitHub; never discover a trusted host key from the connection itself.
// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
const KNOWN_HOST = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';
const COMMIT = /^[0-9a-f]{40}$/;

function validateRemoteTag(output, { tag, commit }) {
  if (!COMMIT.test(commit) || !/^mac-v[0-9A-Za-z.-]+$/.test(tag)) throw new Error('Invalid release identity.');
  const ref = `refs/tags/${tag}`;
  const refs = new Map();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line);
    if (!match || ![ref, `${ref}^{}`].includes(match[2]) || refs.has(match[2])) {
      throw new Error('Unexpected remote tag response.');
    }
    refs.set(match[2], match[1]);
  }
  if (!refs.size) return false;
  if (!refs.has(ref)) throw new Error('Remote tag is missing its direct reference.');
  if ((refs.get(`${ref}^{}`) || refs.get(ref)) !== commit) {
    throw new Error('Mac release tag already exists at a different commit; it will not be moved.');
  }
  return true;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function dispatchMacRelease({ version, commit, preflight = false }) {
  validateVersion(version);
  if (!COMMIT.test(commit)) throw new Error('Release commit must be an exact lowercase 40-character SHA.');
  if (typeof preflight !== 'boolean') throw new Error('Invalid preflight option.');
  const secret = process.env.MAC_RELEASE_DEPLOY_KEY;
  if (!secret || !secret.trim()) throw new Error('MAC_RELEASE_DEPLOY_KEY is required before publication.');
  const tag = `mac-v${version}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tvm-release-ssh-'));
  fs.chmodSync(directory, 0o700);
  try {
    const keyFile = path.join(directory, 'deploy-key');
    const hostsFile = path.join(directory, 'known_hosts');
    fs.writeFileSync(keyFile, `${secret.trim()}\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(hostsFile, KNOWN_HOST, { mode: 0o600, flag: 'wx' });
    // No tokens, signing keys, SSH agent or caller-provided Git overrides reach children.
    const env = {
      PATH: process.env.PATH,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    try {
      execFileSync('ssh-keygen', ['-y', '-P', '', '-f', keyFile], {
        env, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000,
      });
    } catch {
      throw new Error('MAC_RELEASE_DEPLOY_KEY must be a valid unencrypted SSH private key.');
    }
    env.GIT_SSH_COMMAND = [
      'ssh', '-F', '/dev/null', '-i', keyFile,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hostsFile}`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlgorithms=ssh-ed25519',
      '-o', 'VerifyHostKeyDNS=no', '-o', 'UpdateHostKeys=no',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=20',
    ].map(shellQuote).join(' ');
    const git = (args) => execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', ...args,
    ], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 1024 * 1024 });
    const remoteHasTag = () => {
      let output;
      try { output = git(['ls-remote', '--tags', REMOTE, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]); }
      catch { throw new Error('Mac deploy-key authentication or pinned-host verification failed.'); }
      return validateRemoteTag(output, { tag, commit });
    };
    let localCommit;
    try { localCommit = git(['rev-parse', '--verify', `${commit}^{commit}`]).trim(); }
    catch { throw new Error('The exact release commit is not present locally.'); }
    if (localCommit !== commit) throw new Error('The release SHA does not identify a commit.');
    if (remoteHasTag()) return { tag, commit, existing: true, preflight };
    // A dry run also checks write authorization while leaving the remote untouched.
    try {
      git(['push', ...(preflight ? ['--dry-run'] : []), '--porcelain', REMOTE, `${commit}:refs/tags/${tag}`]);
    } catch {
      // A concurrent identical creation is safe; a different commit always fails closed.
      if (!remoteHasTag()) throw new Error('Mac release tag push failed; no tag was replaced.');
      return { tag, commit, existing: true, preflight };
    }
    if (!preflight && !remoteHasTag()) throw new Error('Mac release tag was not visible after the push.');
    return { tag, commit, existing: false, preflight };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && args[0] !== '--preflight')) throw new Error('Usage: node scripts/dispatch-macos-release.cjs [--preflight]');
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const result = dispatchMacRelease({ version, commit, preflight: args[0] === '--preflight' });
    console.log(`${result.preflight ? 'Validated' : 'Dispatched'} ${result.tag} at ${result.commit}${result.existing ? ' (already present)' : ''}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { dispatchMacRelease, validateRemoteTag };
