'use strict';
require('./release-queue-cases.cjs').run('trim-merge-repair').catch(error => { console.error(error); process.exitCode = 1; });
