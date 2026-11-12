const fs = require('fs');
const path = require('path');

const textExtensions = new Set([
  '', '.cjs', '.css', '.html', '.js', '.jsx', '.json', '.md', '.mjs', '.nsh', '.ps1', '.ts', '.tsx', '.txt', '.vbs', '.yaml', '.yml'
]);

const sensitivePatterns = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['discord-webhook', /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{8,}\/[A-Za-z0-9._-]{20,}/gi],
  ['url-credentials', /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi],
  ['windows-user-path', /\b[A-Za-z]:\\Users\\[^\\/\s]+\\/g]
];

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scanText(relativePath, source) {
  const findings = [];
  for (const header of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    const marker = `-----BEGIN ${header}-----`;
    let index = source.indexOf(marker);
    while (index >= 0) {
      findings.push({ file: relativePath, line: lineNumberAt(source, index), rule: 'private-key' });
      index = source.indexOf(marker, index + marker.length);
    }
  }
  for (const [rule, pattern] of sensitivePatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      findings.push({ file: relativePath, line: lineNumberAt(source, match.index ?? 0), rule });
    }
  }
  return findings;
}

function isContainedPath(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function inspectPublicFiles(root, entries) {
  const findings = [];
  const resolvedRoot = path.resolve(root);
  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').replace(/\\/g, '/');
    const absolutePath = path.resolve(resolvedRoot, ...entry.split('/'));
    if (!entry || path.isAbsolute(entry) || !isContainedPath(resolvedRoot, absolutePath)) {
      findings.push({ file: entry || '<empty>', line: 0, rule: 'manifest-path' });
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
      findings.push({ file: entry, line: 0, rule: 'manifest-missing' });
      continue;
    }
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      findings.push({ file: entry, line: 0, rule: 'manifest-symlink' });
      continue;
    }
    if (!stat.isFile()) {
      findings.push({ file: entry, line: 0, rule: 'manifest-file-type' });
      continue;
    }
    if (!textExtensions.has(path.extname(entry).toLowerCase())) continue;
    findings.push(...scanText(entry, fs.readFileSync(absolutePath, 'utf8')));
  }
  return findings;
}

function inspectLockfile(lockfile) {
  const findings = [];
  if (!Number.isInteger(lockfile?.lockfileVersion) || lockfile.lockfileVersion < 3) {
    findings.push({ file: 'package-lock.json', line: 0, rule: 'lockfile-version' });
  }
  const rootPackage = lockfile?.packages?.[''] || {};
  for (const [name, specifier] of Object.entries({
    ...(rootPackage.dependencies || {}),
    ...(rootPackage.devDependencies || {})
  })) {
    if (/^(?:file:|git(?:\+|:)|https?:)/i.test(String(specifier))) {
      findings.push({ file: 'package-lock.json', line: 0, rule: 'dependency-source', package: name });
    }
  }
  for (const [packagePath, metadata] of Object.entries(lockfile?.packages || {})) {
    if (!packagePath || metadata?.link) continue;
    const resolved = typeof metadata?.resolved === 'string' ? metadata.resolved : '';
    if (/^https:\/\/registry\.npmjs\.org\//i.test(resolved) && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(metadata.integrity || ''))) {
      findings.push({ file: 'package-lock.json', line: 0, rule: 'dependency-integrity', package: packagePath });
    }
    if (resolved && !/^https:\/\/registry\.npmjs\.org\//i.test(resolved)) {
      findings.push({ file: 'package-lock.json', line: 0, rule: 'dependency-source', package: packagePath });
    }
  }
  return findings;
}

function run(root = process.cwd()) {
  const manifestPath = path.join(root, 'scripts', 'public-release-files.json');
  const lockfilePath = path.join(root, 'package-lock.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  return [...inspectPublicFiles(root, entries), ...inspectLockfile(lockfile)];
}

if (require.main === module) {
  try {
    const failures = run();
    console.log(JSON.stringify({ failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { inspectLockfile, inspectPublicFiles, run, scanText };
