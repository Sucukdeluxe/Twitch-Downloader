'use strict';

// Real signed fixture bundles, real atomic exchanges, and Launch Services are
// exercised on macOS. No production executable accepts timing/test overrides.
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');

const root = path.resolve(__dirname, '..');
const enabled = process.platform === 'darwin';
let temporary;
let helper;
let fixture;
const children = new Set();
const fixturePids = new Set();

function run(command, args) {
  execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeJson(file, value) {
  const draft = `${file}.tmp`;
  fs.writeFileSync(draft, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(draft, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function waitFor(condition, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const result = condition();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${message}`);
}

function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

before(() => {
  if (!enabled) return;
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-updater-tests-')));
  helper = path.join(temporary, 'macos-updater-testing');
  fixture = path.join(temporary, 'UpdaterFixture');
  run('/usr/bin/xcrun', ['swiftc', '-D', 'UPDATER_TESTING', '-target', `${process.arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx12.0`,
    path.join(root, 'native/macos-updater.swift'), '-o', helper]);
  const fixtureSource = path.join(temporary, 'fixture.swift');
  fs.writeFileSync(fixtureSource, `import AppKit
import Foundation
import Darwin
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let info = Bundle.main.infoDictionary!
let version = info["CFBundleShortVersionString"] as! String
let marker = info["UpdaterTestMarker"] as! String
let behavior = info["UpdaterTestBehavior"] as! String
let launched: [String: Any] = ["pid": getpid(), "version": version, "arguments": CommandLine.arguments,
                              "inheritedEnvironment": ProcessInfo.processInfo.environment["MACOS_UPDATER_FIXTURE_ENV"] ?? ""]
try JSONSerialization.data(withJSONObject: launched).write(to: URL(fileURLWithPath: marker), options: .atomic)
func argument(_ prefix: String) -> String? {
    CommandLine.arguments.first(where: { $0.hasPrefix(prefix) }).map { String($0.dropFirst(prefix.count)) }
}
if let token = argument("--mac-update-token="), let state = argument("--mac-update-state="), behavior != "no-health" {
    let health: [String: Any] = ["schema": 1, "token": token, "version": version, "pid": behavior == "wrong-pid" ? 1 : getpid()]
    try JSONSerialization.data(withJSONObject: health).write(to: URL(fileURLWithPath: state + "/health-" + token + ".json"), options: .atomic)
}
app.run()
`);
  run('/usr/bin/xcrun', ['swiftc', fixtureSource, '-o', fixture]);
});

after(async () => {
  for (const child of children) stop(child);
  // Include fixture processes from tests that failed before reaching assertions.
  if (temporary) {
    for (const scenario of fs.readdirSync(temporary, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      for (const name of ['launched-1.0.0.json', 'launched-2.0.0.json']) {
        const file = path.join(temporary, scenario.name, name);
        if (fs.existsSync(file)) fixturePids.add(readJson(file).pid);
      }
    }
  }
  for (const pid of fixturePids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* Fixture already stopped. */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

function createScenario(behavior = 'healthy') {
  const directory = fs.mkdtempSync(path.join(temporary, 'case-'));
  const state = path.join(directory, 'state');
  fs.mkdirSync(state, { mode: 0o700 });
  const profile = path.join(directory, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  const token = nodeCrypto.randomBytes(32).toString('hex');
  const bundleId = `io.github.updater-test.${path.basename(directory).toLowerCase()}`;
  const target = path.join(directory, 'Fixture.app');
  const stage = path.join(directory, '.Fixture-update.app');
  const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  function bundle(location, version, mode) {
    fs.mkdirSync(path.join(location, 'Contents/MacOS'), { recursive: true });
    fs.copyFileSync(fixture, path.join(location, 'Contents/MacOS/UpdaterFixture'));
    const fields = {
      CFBundleIdentifier: bundleId, CFBundleName: 'Updater Test Fixture', CFBundlePackageType: 'APPL',
      CFBundleExecutable: 'UpdaterFixture', CFBundleShortVersionString: version, CFBundleVersion: version,
      UpdaterTestBehavior: mode, UpdaterTestMarker: path.join(directory, `launched-${version}.json`),
    };
    fs.writeFileSync(path.join(location, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(fields).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}<key>LSUIElement</key><true/></dict></plist>`);
    run('/usr/bin/codesign', ['--force', '--sign', '-', location]);
  }
  bundle(target, '1.0.0', 'old');
  bundle(stage, '2.0.0', behavior);
  const parent = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  children.add(parent);
  const plan = {
    schema: 1, parentPid: parent.pid, targetApp: target, stagedApp: stage,
    expectedBundleId: bundleId, expectedVersion: '2.0.0', healthToken: token, stateDirectory: state,
    userDataDirectory: profile,
  };
  const planPath = path.join(state, 'plan.json');
  const marker = (name) => path.join(state, `${name}-${token}.json`);
  let worker;
  let stderr = '';
  const launch = () => {
    writeJson(planPath, plan);
    worker = spawn(helper, ['--install', planPath], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MACOS_UPDATER_FIXTURE_ENV: token },
    });
    worker.stderr.on('data', (chunk) => { stderr += chunk; });
    children.add(worker);
    return worker;
  };
  const waitMarker = (name) => waitFor(() => {
    if (fs.existsSync(marker(name))) return readJson(marker(name));
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Helper exited before ${name}: ${stderr}`);
    return false;
  }, `${name} marker`);
  const waitExit = async () => {
    await waitFor(() => worker.exitCode !== null || worker.signalCode !== null, `helper exit (${stderr})`, 25000);
    return worker.exitCode;
  };
  const arm = async () => {
    await waitMarker('ready');
    writeJson(marker('proceed'), { schema: 1, token });
    await waitMarker('armed');
  };
  const versionAt = (location) => {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(location, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  };
  return { directory, state, token, target, stage, parent, plan, marker, launch, arm, waitMarker, waitExit, versionAt };
}

test('native updater completes an atomic install only after armed parent exit and health', { skip: !enabled }, async () => {
  const scenario = createScenario();
  scenario.launch();
  await scenario.arm();
  assert.equal(scenario.versionAt(scenario.target), '1.0.0');
  stop(scenario.parent);
  assert.equal(await scenario.waitExit(), 0);
  const result = readJson(scenario.marker('result'));
  assert.equal(result.status, 'installed', result.message);
  assert.equal(scenario.versionAt(scenario.target), '2.0.0');
  assert.equal(fs.existsSync(scenario.stage), false);
  const health = readJson(scenario.marker('health'));
  const launched = readJson(path.join(scenario.directory, 'launched-2.0.0.json'));
  assert.equal(health.pid, launched.pid);
  assert(launched.arguments.includes(`--user-data-dir=${scenario.plan.userDataDirectory}`));
  assert.equal(launched.inheritedEnvironment, scenario.token);
});

test('parent exit without explicit proceed preserves both bundles', { skip: !enabled }, async () => {
  const scenario = createScenario();
  scenario.launch();
  await scenario.waitMarker('ready');
  stop(scenario.parent);
  assert.equal(await scenario.waitExit(), 1);
  assert.equal(readJson(scenario.marker('result')).status, 'failed');
  assert.equal(scenario.versionAt(scenario.target), '1.0.0');
  assert.equal(scenario.versionAt(scenario.stage), '2.0.0');
});

test('unarmed and armed deadlines never kill the parent or replace the original', { skip: !enabled }, async () => {
  for (const shouldArm of [false, true]) {
    const scenario = createScenario();
    scenario.launch();
    if (shouldArm) await scenario.arm();
    else await scenario.waitMarker('ready');
    assert.equal(await scenario.waitExit(), 1);
    assert.equal(scenario.parent.exitCode, null);
    assert.equal(scenario.parent.signalCode, null);
    assert.equal(scenario.versionAt(scenario.target), '1.0.0');
    stop(scenario.parent);
  }
});

test('missing or foreign-process health causes atomic rollback and original relaunch', { skip: !enabled }, async () => {
  for (const behavior of ['no-health', 'wrong-pid']) {
    const scenario = createScenario(behavior);
    scenario.launch();
    await scenario.arm();
    stop(scenario.parent);
    assert.equal(await scenario.waitExit(), 0);
    const result = readJson(scenario.marker('result'));
    assert.equal(result.status, 'rolled-back', result.message);
    assert.equal(scenario.versionAt(scenario.target), '1.0.0');
    assert.equal(scenario.versionAt(scenario.stage), '2.0.0');
    await waitFor(() => fs.existsSync(path.join(scenario.directory, 'launched-1.0.0.json')), 'original app relaunched');
    assert(readJson(path.join(scenario.directory, 'launched-1.0.0.json')).arguments.includes(`--user-data-dir=${scenario.plan.userDataDirectory}`));
  }
});

test('wrong version, broken signature, symlink stage, and reused nonce fail before readiness', { skip: !enabled }, async () => {
  for (const defect of ['version', 'signature', 'symlink', 'stale-health']) {
    const scenario = createScenario();
    if (defect === 'version') scenario.plan.expectedVersion = '3.0.0';
    if (defect === 'signature') fs.appendFileSync(path.join(scenario.stage, 'Contents/Info.plist'), ' ');
    if (defect === 'symlink') {
      const alias = path.join(scenario.directory, 'StageAlias.app');
      fs.symlinkSync(scenario.stage, alias);
      scenario.plan.stagedApp = alias;
    }
    if (defect === 'stale-health') writeJson(scenario.marker('health'), { schema: 1, token: scenario.token, pid: 1, version: '2.0.0' });
    scenario.launch();
    assert.equal(await scenario.waitExit(), 1, defect);
    assert.equal(fs.existsSync(scenario.marker('ready')), false, defect);
    assert.equal(scenario.versionAt(scenario.target), '1.0.0');
    stop(scenario.parent);
  }
});

test('foreign proceed token cannot authorize exchange', { skip: !enabled }, async () => {
  const scenario = createScenario();
  scenario.launch();
  await scenario.waitMarker('ready');
  writeJson(scenario.marker('proceed'), { schema: 1, token: '0'.repeat(64) });
  assert.equal(await scenario.waitExit(), 1);
  assert.equal(fs.existsSync(scenario.marker('armed')), false);
  assert.equal(scenario.versionAt(scenario.target), '1.0.0');
  stop(scenario.parent);
});

test('unwritable application parent fails before readiness', { skip: !enabled }, async () => {
  const scenario = createScenario();
  fs.chmodSync(scenario.directory, 0o555);
  try {
    scenario.launch();
    assert.equal(await scenario.waitExit(), 1);
    assert.equal(fs.existsSync(scenario.marker('ready')), false);
    assert.equal(scenario.versionAt(scenario.target), '1.0.0');
  } finally {
    fs.chmodSync(scenario.directory, 0o755);
    stop(scenario.parent);
  }
});

test('signature or directory replacement after readiness is rejected before exchange', { skip: !enabled }, async () => {
  for (const mutation of ['signature', 'directory']) {
    const scenario = createScenario();
    scenario.launch();
    await scenario.waitMarker('ready');
    if (mutation === 'signature') fs.appendFileSync(path.join(scenario.stage, 'Contents/Info.plist'), ' ');
    else {
      const temporaryApp = path.join(scenario.directory, 'old.app');
      fs.renameSync(scenario.target, temporaryApp);
      fs.renameSync(scenario.stage, scenario.target);
      fs.renameSync(temporaryApp, scenario.stage);
    }
    const targetBefore = scenario.versionAt(scenario.target);
    const stageBefore = scenario.versionAt(scenario.stage);
    await scenario.arm();
    stop(scenario.parent);
    assert.equal(await scenario.waitExit(), 1);
    assert.equal(scenario.versionAt(scenario.target), targetBefore);
    assert.equal(scenario.versionAt(scenario.stage), stageBefore);
  }
});

test('an independent running instance prevents installation without terminating it', { skip: !enabled }, async () => {
  const scenario = createScenario();
  const launchedMarker = path.join(scenario.directory, 'launched-1.0.0.json');
  run('/usr/bin/open', ['-n', scenario.target, '--args', '--independent-fixture']);
  const independent = await waitFor(() => fs.existsSync(launchedMarker) && readJson(launchedMarker), 'independent old app launch');
  fixturePids.add(independent.pid);
  scenario.launch();
  await scenario.arm();
  stop(scenario.parent);
  assert.equal(await scenario.waitExit(), 1);
  const result = readJson(scenario.marker('result'));
  assert.equal(result.status, 'failed');
  assert.match(result.message, /another application instance is running/);
  assert.equal(scenario.versionAt(scenario.target), '1.0.0');
  assert.equal(scenario.versionAt(scenario.stage), '2.0.0');
  assert.doesNotThrow(() => process.kill(independent.pid, 0));
});

test('an independent launch during the health window prevents rollback and retains the backup', { skip: !enabled }, async () => {
  const scenario = createScenario('no-health');
  const launchedMarker = path.join(scenario.directory, 'launched-2.0.0.json');
  scenario.launch();
  await scenario.arm();
  stop(scenario.parent);
  const owned = await waitFor(() => fs.existsSync(launchedMarker) && readJson(launchedMarker), 'owned replacement launch');
  fixturePids.add(owned.pid);
  run('/usr/bin/open', ['-n', scenario.target, '--args', '--independent-fixture']);
  const independent = await waitFor(() => {
    const launched = readJson(launchedMarker);
    return launched.pid !== owned.pid && launched;
  }, 'independent replacement launch');
  fixturePids.add(independent.pid);
  assert.equal(await scenario.waitExit(), 1);
  const result = readJson(scenario.marker('result'));
  assert.equal(result.status, 'failed');
  assert.match(result.message, /Cannot roll back.*another application instance is running/);
  assert.equal(result.backupApp, scenario.stage);
  assert.equal(scenario.versionAt(scenario.target), '2.0.0');
  assert.equal(scenario.versionAt(scenario.stage), '1.0.0');
  assert.doesNotThrow(() => process.kill(independent.pid, 0));
  assert.equal(fs.existsSync(path.join(scenario.directory, 'launched-1.0.0.json')), false);
});

test('a staged app requiring a future macOS fails before readiness and preserves the original', { skip: !enabled }, async () => {
  const scenario = createScenario();
  run('/usr/bin/plutil', ['-insert', 'LSMinimumSystemVersion', '-string', '999.0', path.join(scenario.stage, 'Contents/Info.plist')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', scenario.stage]);
  scenario.launch();
  assert.equal(await scenario.waitExit(), 1);
  assert.equal(fs.existsSync(scenario.marker('ready')), false);
  assert.equal(scenario.versionAt(scenario.target), '1.0.0');
  assert.equal(scenario.versionAt(scenario.stage), '2.0.0');
  assert.equal(scenario.parent.exitCode, null);
  stop(scenario.parent);
});

test('a staged app with a compatible explicit macOS minimum installs', { skip: !enabled }, async () => {
  const scenario = createScenario();
  run('/usr/bin/plutil', ['-insert', 'LSMinimumSystemVersion', '-string', '12.0', path.join(scenario.stage, 'Contents/Info.plist')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', scenario.stage]);
  scenario.launch();
  await scenario.arm();
  stop(scenario.parent);
  assert.equal(await scenario.waitExit(), 0);
  assert.equal(scenario.versionAt(scenario.target), '2.0.0');
});
