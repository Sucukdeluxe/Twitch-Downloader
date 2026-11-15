'use strict';
require('./release-queue-cases.cjs').run('queue-merge-controls').catch(error => { console.error(error); process.exitCode = 1; });
