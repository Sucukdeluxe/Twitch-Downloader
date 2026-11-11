// Reconstructed Windows publication boundaries; no workflow execution or publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const ordinary = yaml.load(read('.github/workflows/windows-ci.yml'));
const release = yaml.load(read('.github/workflows/windows-release.yml'));
const pkg = JSON.parse(read('package.json'));
const commands = job => (job.steps || []).map(step => step.run || '').join('\n');
const windows = job => /^windows-/.test(String(job['runs-on']));
const publishes = step => /(?:gh\s+release\s+(?:create|upload)|(?:softprops\/action-gh-release|ncipollo\/release-action)@)/i.test(`${step.run || ''}\n${step.uses || ''}`);

assert.ok(ordinary.on && Object.hasOwn(ordinary.on, 'push') && Object.hasOwn(ordinary.on, 'pull_request'), 'Keep ordinary push and PR CI');
assert.ok(Object.values(ordinary.jobs).some(job => windows(job) && /npm ci/.test(commands(job)) && /npm run build/.test(commands(job))), 'Ordinary CI must build on Windows');
assert.ok(!Object.values(ordinary.jobs).some(job => (job.steps || []).some(publishes)), 'Ordinary CI must not publish candidate packages');
assert.ok(release.on && (Object.hasOwn(release.on, 'workflow_dispatch') || release.on.push?.tags), 'Release workflow needs an explicit release trigger');

const buildEntries = Object.entries(release.jobs).filter(([, job]) => /npm run release:build\b/.test(commands(job)));
assert.ok(buildEntries.length > 0, 'Native workflow must run the complete release:build');
assert.match(pkg.scripts['release:build'], /npm run release:verify\s*&&\s*npm run release:package/);
for (const [, job] of buildEntries) {
  assert.ok(windows(job), 'Release gates must run on native Windows');
  assert.ok(!job['continue-on-error'], 'Release verification failures must stop publication');
  for (const step of job.steps) {
    assert.ok(!step['continue-on-error'], 'Release steps must not ignore failed gates');
    assert.doesNotMatch(step.run || '', /(?:--ci-candidate|npm run dist:ci|\|\|\s*(?:true|exit\s+0))/, 'Publication must use a verified noncandidate build');
  }
}

const publishingEntries = Object.entries(release.jobs).filter(([, job]) => (job.steps || []).some(publishes));
assert.ok(publishingEntries.length > 0, 'Release workflow must publish the checked installer');
function ancestors(name, seen = new Set()) {
  assert.ok(release.jobs[name], `Unknown required job ${name}`);
  if (seen.has(name)) return seen;
  seen.add(name);
  const needs = release.jobs[name].needs;
  for (const dependency of (Array.isArray(needs) ? needs : needs ? [needs] : [])) ancestors(dependency, seen);
  return seen;
}
for (const [name, job] of publishingEntries) {
  assert.ok(!job['continue-on-error']);
  assert.doesNotMatch(String(job.if || ''), /always\s*\(/, 'Publishing cannot run after failed dependencies');
  const beforePublish = job.steps.slice(0, job.steps.findIndex(publishes));
  for (const step of beforePublish) {
    assert.ok(!step['continue-on-error'], 'Publication prerequisites must not ignore failures');
  }
  const dependencies = [...ancestors(name)].filter(dependency => dependency !== name);
  const upstream = dependencies.map(dependency => commands(release.jobs[dependency])).join('\n');
  const verifiedCommands = `${upstream}\n${beforePublish.map(step => step.run || '').join('\n')}`;
  assert.match(verifiedCommands, /npm run release:build\b/, 'Publication must depend on the completed native release build');
  assert.match(verifiedCommands, /(?:release[\\/]verification[\\/]package\.json|verification[^\n]*package\.json)/, 'Read the actual packaged verification record');
  assert.match(verifiedCommands, /\.candidate\s*(?:!==?\s*false|-ne\s*\$false)/, 'Reject candidate or missing candidate flags explicitly');
  assert.match(verifiedCommands, /\.(?:verifiedTests|tests)\s*(?:<=\s*0|<\s*1|-le\s*0|-lt\s*1)/, 'Reject records with no verified tests before publishing');
  assert.match(verifiedCommands, /\.fingerprint\s*!==?\s*\w+\.fingerprint/, 'Bind the packaged assets to the verified receipt');
  assert.match(verifiedCommands, /createHash\(['"]sha256['"]\)/, 'Recheck artifact bytes after transport to publication');
  assert.match(verifiedCommands, /(?:throw\b|assert\b|exit\s+1)/, 'Invalid verification metadata must stop publishing');
  assert.doesNotMatch(commands(job), /--ci-candidate|npm run dist:ci/);
  for (const step of job.steps.filter(publishes)) {
    assert.ok(!step['continue-on-error']);
    assert.doesNotMatch(String(step.if || ''), /always\s*\(/);
    const publication = `${step.run || ''}\n${JSON.stringify(step.with || {})}`;
    assert.match(publication, /(?:\.exe|release[\\/]\*|files)/, 'Publish the Windows installer');
    assert.match(publication, /latest\.yml|release[\\/]\*/, 'Publish updater metadata with the installer');
  }
}
console.log('PASS Windows CI contract: ordinary CI retained, native release gates precede verified publication');
