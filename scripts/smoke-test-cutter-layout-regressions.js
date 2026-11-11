'use strict';
// Reconstructed public release scenario; see release-cutter-cases.cjs.
require('./release-cutter-cases.cjs').run('layout-regressions').catch(error => {
  console.error(error);
  process.exitCode = 1;
});
