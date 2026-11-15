'use strict';
require('./release-queue-cases.cjs').run('clips-workspace').catch(error => { console.error(error); process.exitCode = 1; });
