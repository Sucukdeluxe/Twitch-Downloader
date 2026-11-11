const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : null;
  if (!arch) throw new Error('Build separate arm64 and x64 Mac updates');
  execFileSync(process.execPath, [path.join(__dirname, 'build-macos-updater.js'), '--arch', arch], { stdio: 'inherit' });
};
