const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

assert.equal(pkg.scripts['test:unit'], 'vitest run', 'Unit checks must fail when the suite is missing');
for (const name of ['test:security', 'test:lint-config', 'test:ci-contract', 'test:e2e:release', 'test:mac', 'test:mac-update']) {
  const command = pkg.scripts[name];
  assert(command && !command.includes('run-local-check'), `${name} must run required tests directly`);
}
for (const name of ['macos-ci.yml', 'macos-release.yml']) {
  const source = fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
  for (const command of ['npm ci', 'npm run lint', 'npm run test:unit', 'npm run rebuild:electron', 'npm run security:check', 'npm run test:security', 'npm run test:lint-config', 'npm run test:ci-contract', 'npm run test:mac-update', 'npm run test:mac', 'npm run test:e2e:release', 'npm run dist:mac', 'scripts/smoke-test-macos-update.js']) {
    assert(source.includes(command), `${name} must run ${command}`);
  }
  for (const required of ['macos-15', 'macos-15-intel', "TVM_STRICT_LOCAL_CHECKS: 'true'", 'PACKAGED_APP_PATH:', 'MAC_UPDATE_FROM_APP:']) {
    assert(source.includes(required), `${name} is missing ${required}`);
  }
  assert(!source.includes('continue-on-error: true'), `${name} must fail closed`);
}
for (const directory of ['.github', '.gitea']) {
  const source = fs.readFileSync(path.join(root, directory, 'workflows/windows-ci.yml'), 'utf8');
  for (const command of ['npm run test:unit', 'npm run test:security', 'npm run test:lint-config', 'npm run test:ci-contract', 'npm run rebuild:electron', 'npm run test:e2e:focused']) {
    assert(source.includes(command), `${directory} Windows CI must run ${command}`);
  }
}
for (const command of Object.values(pkg.scripts).filter(value => !value.includes('run-local-check'))) {
  for (const match of command.matchAll(/\b(scripts\/[\w./-]+\.(?:js|mjs))\b/g)) {
    assert(fs.existsSync(path.join(root, match[1])), `Required script is missing: ${match[1]}`);
  }
}
console.log('CI contracts passed: native arm64/x64, required regression tests and original-release update');
