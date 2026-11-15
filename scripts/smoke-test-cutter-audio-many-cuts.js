'use strict';
// Reconstructed public release scenario; see release-cutter-cases.cjs.
require('./release-cutter-cases.cjs').run('audio-many-cuts').catch(error => {
  console.error(error);
  process.exitCode = 1;
});
